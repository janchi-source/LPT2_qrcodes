// Úložisko stavu hry s dvoma režimami:
//
//   'file' (default)  — JSON súbory v data/. Pre lokálne nasadenie na tábore:
//                       čitateľné, ručne editovateľné, bez závislostí.
//   'kv'              — Vercel KV / Upstash Redis cez REST (obyčajný fetch,
//                       takže stále nula npm závislostí). Zapne sa sám, keď
//                       sú nastavené premenné KV_REST_API_URL a *_TOKEN.
//
// Prečo to nie je len "vymeň fs za fetch":
// Herná logika v game.js je synchrónna a robí čítaj-uprav-zapíš. Lokálne to
// stačí (Node dobehne požiadavku bez prerušenia), ale na Vercele bežia
// požiadavky v samostatných inštanciách a dvaja animátori skenujúci naraz by
// si prepísali zápis — sken by sa stratil.
//
// Riešenie: v KV režime sa na začiatku požiadavky načíta CELÝ stav do pamäte
// (beginRequest), herná logika beží nad týmto snapshotom synchrónne ako
// doteraz, a na konci sa zapíše jedným atomickým zápisom (commitRequest),
// ktorý prejde len ak sa medzitým stav nezmenil. Pri konflikte sa požiadavka
// zopakuje nad čerstvými dátami — viď withStore() v lib/handler.js.
const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');

// LPT2_DATA_DIR override používajú testy, aby nesiahali na ostré dáta.
const DATA_DIR = process.env.LPT2_DATA_DIR || path.join(__dirname, '..', 'data');

// Hosting môže dať pripojenie k databáze dvoma spôsobmi:
//   REST  — KV_REST_API_URL + KV_REST_API_TOKEN (Vercel KV / Upstash REST)
//   TCP   — REDIS_URL, čiže rediss://user:heslo@host:port (Vercel Marketplace,
//           Redis Cloud, Upstash cez štandardný protokol)
// Podporujeme oboje; keď sú k dispozícii REST údaje, uprednostníme ich
// (na serverless je bezstavové HTTP o niečo spoľahlivejšie než TCP spojenie).
const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const REDIS_URL = process.env.REDIS_URL || process.env.REDIS_TLS_URL || '';

const useREST = !!(KV_URL && KV_TOKEN);
const useTCP = !useREST && !!REDIS_URL;
const useKV = useREST || useTCP;

let tcpClient = null;
function getTcpClient() {
  if (!tcpClient) {
    const { RedisClient } = require('./redis-client');
    tcpClient = new RedisClient(REDIS_URL);
  }
  return tcpClient;
}

const DOC_KEY = process.env.LPT2_KV_KEY || 'lpt2:doc';
const VER_KEY = DOC_KEY + ':version';

// Snapshot NESMIE byť modulová premenná: jedna inštancia (lokálny server aj
// Vercel) obsluhuje viac požiadaviek naraz a tie by si ho navzájom prepísali.
// AsyncLocalStorage dá každej požiadavke vlastný kontext, pričom herná logika
// môže zostať synchrónna.
const als = new AsyncLocalStorage();

// --- Súborový backend -------------------------------------------------------

function filePath(name) {
  return path.join(DATA_DIR, name + '.json');
}

function readFile(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath(name), 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function writeFile(name, obj) {
  const fp = filePath(name);
  const tmp = fp + '.tmp';
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, fp); // atomicky, aby pád procesu nenechal rozbitý súbor
}

// --- KV backend (Upstash REST) ---------------------------------------------

async function redis(cmd) {
  if (useTCP) return getTcpClient().command(cmd);

  const res = await fetch(KV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`KV ${res.status}: ${text.slice(0, 200)}`);
  let json;
  try { json = JSON.parse(text); } catch (e) { throw new Error('KV: neplatná odpoveď'); }
  if (json.error) throw new Error('KV: ' + json.error);
  return json.result;
}

// Zápis prejde len vtedy, keď sa verzia od načítania nezmenila (compare-and-swap).
// Verzia je v samostatnom kľúči, aby sa nemusel v Lua parsovať celý dokument.
const CAS_SCRIPT = `
local ver = redis.call('GET', KEYS[2])
if ver == false then ver = '0' end
if ver == ARGV[2] then
  redis.call('SET', KEYS[1], ARGV[1])
  redis.call('SET', KEYS[2], tostring(tonumber(ARGV[2]) + 1))
  return 1
end
return 0`;

// --- Verejné API ------------------------------------------------------------

const MAX_POKUSOV = 6;
// Strop na celú požiadavku. Serverless funkcia má obmedzený čas — keď ho
// prekročíme, hosting vráti HTML chybovú stránku a prehliadač ohlási len
// „neplatná odpoveď". Radšej to ukončíme sami a vrátime zrozumiteľný JSON.
const LIMIT_TRANSAKCIE_MS = Number(process.env.LPT2_TX_TIMEOUT_MS || 8000);

// Spustí synchrónnu hernú logiku nad konzistentným stavom.
//
// Súborový režim: číta a zapisuje priamo na disk, presne ako doteraz. Node je
// jednovláknový a `fn` je celá synchrónna, takže čítaj-uprav-zapíš dobehne bez
// prerušenia inou požiadavkou.
//
// KV režim: načíta celý stav, spustí `fn` nad ním a zapíše ho jedným
// atomickým zápisom. Ak medzitým zapísal niekto iný, zápis neprejde a celé
// `fn` sa zopakuje nad čerstvými dátami.
//
// Vracia { ok, result, pokusy }.
async function runTransaction(fn) {
  if (!useKV) return { ok: true, result: fn(), pokusy: 1 };

  const koniec = Date.now() + LIMIT_TRANSAKCIE_MS;
  for (let pokus = 1; pokus <= MAX_POKUSOV; pokus++) {
    if (Date.now() > koniec) return { ok: false, pokusy: pokus - 1, vyprsalo: true };
    const [doc, ver] = await Promise.all([redis(['GET', DOC_KEY]), redis(['GET', VER_KEY])]);
    const ctx = {
      data: doc ? JSON.parse(doc) : {},
      version: ver == null ? '0' : String(ver),
      dirty: false,
    };

    // `fn` musí byť synchrónna — inak by kontext prežil mimo transakcie.
    const result = als.run(ctx, fn);

    if (!ctx.dirty) return { ok: true, result, pokusy: pokus }; // len čítanie

    const zapisane = await redis([
      'EVAL', CAS_SCRIPT, '2', DOC_KEY, VER_KEY, JSON.stringify(ctx.data), ctx.version,
    ]);
    if (Number(zapisane) === 1) return { ok: true, result, pokusy: pokus };

    // Konflikt — krátka náhodná pauza, nech sa súbežné požiadavky rozostúpia.
    await new Promise((r) => setTimeout(r, 20 + Math.random() * 60));
  }
  return { ok: false, pokusy: MAX_POKUSOV };
}

// Skúška databázy pre /api/db-test. Neoveruje len spojenie, ale celý cyklus,
// ktorý appka počas hry potrebuje — vrátane Lua skriptu (EVAL), na ktorom
// stojí atomický zápis. Niektorí poskytovatelia EVAL zakazujú a prejavilo by
// sa to až pri prvom skene na tábore.
// Píše výhradne do dočasných kľúčov, stavu hry sa nedotkne.
async function ping() {
  if (!useKV) {
    return { ok: false, mode: 'file', chyba: 'Nie je nastavená žiadna databáza (chýba REDIS_URL aj REST údaje).' };
  }
  const mode = useREST ? 'rest' : 'tcp';
  const zaciatok = Date.now();
  const kluc = DOC_KEY + ':skuska';
  const verKluc = kluc + ':version';
  const kroky = {};
  let krok = 'spojenie (PING)';

  try {
    kroky.ping = String(await redis(['PING']));

    krok = 'zápis (SET)';
    const hodnota = 'skuska-' + Date.now();
    await redis(['SET', kluc, hodnota]);

    krok = 'čítanie (GET)';
    const nacitane = await redis(['GET', kluc]);
    if (nacitane !== hodnota) throw new Error(`prečítalo sa niečo iné, než sa zapísalo (${nacitane})`);
    kroky.zapis_a_citanie = 'OK';

    krok = 'atomický zápis (EVAL)';
    await redis(['SET', verKluc, '0']);
    const preslo = await redis(['EVAL', CAS_SCRIPT, '2', kluc, verKluc, '{}', '0']);
    const zamietnute = await redis(['EVAL', CAS_SCRIPT, '2', kluc, verKluc, '{}', '0']);
    if (Number(preslo) !== 1) throw new Error('skript nezapísal ani pri správnej verzii');
    if (Number(zamietnute) !== 0) throw new Error('skript zapísal aj pri nesprávnej verzii — súbežné skeny by sa strácali');
    kroky.atomicky_zapis = 'OK';

    await redis(['DEL', kluc, verKluc]).catch(() => {});
    return { ok: true, mode, ms: Date.now() - zaciatok, kroky };
  } catch (e) {
    await redis(['DEL', kluc, verKluc]).catch(() => {});
    return {
      ok: false,
      mode,
      ms: Date.now() - zaciatok,
      zlyhalo_na: krok,
      kroky,
      chyba: String((e && e.message) || e),
    };
  }
}

function load(name, fallback) {
  const ctx = als.getStore();
  if (ctx) return Object.prototype.hasOwnProperty.call(ctx.data, name) ? ctx.data[name] : fallback;
  if (useKV) throw new Error('KV režim: čítanie stavu mimo runTransaction()');
  return readFile(name, fallback);
}

function save(name, obj) {
  const ctx = als.getStore();
  if (ctx) { ctx.data[name] = obj; ctx.dirty = true; return; }
  if (useKV) throw new Error('KV režim: zápis stavu mimo runTransaction()');
  writeFile(name, obj);
}

module.exports = {
  load,
  save,
  runTransaction,
  ping,
  useKV,
  // 'rest' | 'tcp' | 'file' — vypisuje sa v /api/server-info na diagnostiku
  mode: useREST ? 'rest' : (useTCP ? 'tcp' : 'file'),
  DATA_DIR,
  // pre migračný skript scripts/push-to-kv.js
  _redis: redis,
  _keys: { DOC_KEY, VER_KEY },
  _readFile: readFile,
};
