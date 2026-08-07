// Úložisko stavu hry v Supabase (Postgres cez PostgREST), obyčajným fetchom.
//
// Prečo práve takto:
//
//   * Atomický zápis robí priamo databáza jedným `UPDATE ... WHERE verzia = N`.
//     Netreba naň Lua skript (EVAL), ktorý časť poskytovateľov Redisu zakazuje
//     a ktorý sa prejaví až pri prvom súbežnom skene na tábore.
//   * Komunikuje sa bezstavovým HTTPS. Odpadá držané TCP spojenie, ktoré sa na
//     serverless prostredí medzi požiadavkami stráca (inštancia sa zmrazí,
//     databáza sa reštartuje) a ktoré treba prácne obnovovať.
//   * Žiadna npm závislosť — celý projekt musí ostať spustiteľný na tábore bez
//     internetu a bez `npm install`.
//
// Celý stav hry je JEDEN riadok s JSON dokumentom, presne ako doteraz. Zámerne
// sa nerozbíja na tabuľky: herná logika v game.js pracuje nad celým stavom
// naraz a takto sa jej nemusíme dotknúť.
//
// Tabuľku vytvorí SQL v README (sekcia „Nasadenie na Vercel“).

const ZAKLAD = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
// service_role kľúč obchádza Row Level Security. Appka beží celá na serveri
// (do prehliadača sa kľúč nikdy nedostane), takže je to správna voľba —
// anon kľúč by pri zapnutom RLS zápis odmietol.
const KLUC = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '';
const TABULKA = process.env.LPT2_SUPABASE_TABLE || 'lpt2_stav';
const RIADOK = process.env.LPT2_SUPABASE_ROW || 'hra';

const dostupne = !!(ZAKLAD && KLUC);

// Serverless funkcia má na odpoveď len pár sekúnd. Keď databáza nestihne,
// radšej rýchlo zlyháme so zrozumiteľnou hláškou, než aby hosting požiadavku
// odstrelil a prehliadaču prišla HTML chybová stránka.
const LIMIT_MS = Number(process.env.LPT2_SUPABASE_TIMEOUT_MS || 5000);

const NAVOD_TABULKA =
  `Tabuľka "${TABULKA}" v databáze neexistuje. Vytvor ju v Supabase (SQL Editor):\n`
  + `create table ${TABULKA} (\n`
  + '  id text primary key,\n'
  + '  doc jsonb not null default \'{}\'::jsonb,\n'
  + '  verzia bigint not null default 0\n'
  + ');';

function hlavicky(extra) {
  return {
    apikey: KLUC,
    Authorization: `Bearer ${KLUC}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

// Jedna požiadavka na PostgREST. Vracia rozparsované telo (pole riadkov).
async function ziadost(cesta, opts = {}) {
  let res;
  try {
    res = await fetch(`${ZAKLAD}/rest/v1/${cesta}`, {
      ...opts,
      headers: hlavicky(opts.headers),
      signal: AbortSignal.timeout(LIMIT_MS),
    });
  } catch (e) {
    // Bez adresy sa to na hostingu ladí len hádaním. Kľúč sa do hlášky
    // nikdy nedostane — je v hlavičke, nie v URL.
    const preco = e && e.name === 'TimeoutError'
      ? `neodpovedala do ${LIMIT_MS} ms`
      : String((e && e.message) || e);
    throw new Error(`Supabase ${ZAKLAD}: ${preco}`);
  }

  const text = await res.text();
  if (!res.ok) {
    // PostgREST hlási chýbajúcu tabuľku kódom PGRST205 (staršie: 42P01).
    if (/PGRST205|42P01|does not exist/i.test(text)) throw new Error(NAVOD_TABULKA);
    throw new Error(`Supabase ${res.status}: ${text.slice(0, 200)}`);
  }
  if (!text) return [];
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error('Supabase: odpoveď sa nedá rozparsovať ako JSON');
  }
}

// --- Rozhranie úložiska -----------------------------------------------------

// Načíta celý stav. Keď riadok ešte neexistuje, vráti prázdny dokument
// s verziou 0 — tá je zároveň signál pre zapis(), že sa má riadok založiť.
async function nacitaj(id = RIADOK) {
  const riadky = await ziadost(
    `${TABULKA}?id=eq.${encodeURIComponent(id)}&select=doc,verzia`,
    { method: 'GET' },
  );
  if (!riadky.length) return { data: {}, version: 0 };
  const r = riadky[0];
  return { data: r.doc && typeof r.doc === 'object' ? r.doc : {}, version: Number(r.verzia) || 0 };
}

// Zapíše stav, ale LEN ak sa verzia od načítania nezmenila.
// Vracia true = zapísané, false = medzitým zapísal niekto iný (konflikt).
//
// Podmienka `verzia=eq.N` je súčasťou UPDATE-u, takže porovnanie aj zápis
// robí databáza v jednej operácii — dvaja animátori skenujúci v tej istej
// sekunde si stav prepísať nemôžu.
async function zapis(data, version, id = RIADOK) {
  const telo = JSON.stringify(data);

  if (Number(version) === 0) {
    // Prvý zápis: riadok ešte nie je. `ignore-duplicates` zariadi, že keď ho
    // medzitým založil niekto iný, nič sa neprepíše a vráti sa prázdne pole.
    const vytvorene = await ziadost(TABULKA, {
      method: 'POST',
      headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
      body: JSON.stringify({ id, doc: JSON.parse(telo), verzia: 1 }),
    });
    return vytvorene.length > 0;
  }

  const zmenene = await ziadost(
    `${TABULKA}?id=eq.${encodeURIComponent(id)}&verzia=eq.${Number(version)}`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ doc: JSON.parse(telo), verzia: Number(version) + 1 }),
    },
  );
  // Prázdne pole = žiadny riadok nesedel na verziu, čiže konflikt.
  return zmenene.length > 0;
}

async function zmaz(id) {
  await ziadost(`${TABULKA}?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// Skúška pre /api/db-test. Overuje celý cyklus, ktorý appka počas hry
// potrebuje — vrátane toho, že atomický zápis naozaj ODMIETNE zápis so starou
// verziou. Keby to nefungovalo, súbežné skeny by sa tichto strácali a prišlo
// by sa na to až na tábore. Píše výhradne do skúšobného riadku.
async function skuska() {
  const zaciatok = Date.now();
  const kroky = {};
  const skusobny = RIADOK + ':skuska';
  let krok = 'spojenie a tabuľka';

  try {
    await zmaz(skusobny); // po prípadnej predošlej neúspešnej skúške
    kroky.spojenie = 'OK';

    krok = 'zápis (INSERT)';
    if (!(await zapis({ skuska: true }, 0, skusobny))) {
      throw new Error('riadok sa nepodarilo založiť');
    }

    krok = 'čítanie (SELECT)';
    const nacitane = await nacitaj(skusobny);
    if (!nacitane.data || nacitane.data.skuska !== true) {
      throw new Error(`prečítalo sa niečo iné, než sa zapísalo (${JSON.stringify(nacitane.data)})`);
    }
    kroky.zapis_a_citanie = 'OK';

    krok = 'atomický zápis (UPDATE ... WHERE verzia)';
    const preslo = await zapis({ skuska: true, druhy: true }, nacitane.version, skusobny);
    const zamietnute = await zapis({ skuska: 'nemalo prejsť' }, nacitane.version, skusobny);
    if (!preslo) throw new Error('zápis neprešiel ani pri správnej verzii');
    if (zamietnute) throw new Error('zápis prešiel aj pri starej verzii — súbežné skeny by sa strácali');
    kroky.atomicky_zapis = 'OK';

    await zmaz(skusobny);
    return { ok: true, mode: 'supabase', ms: Date.now() - zaciatok, kroky };
  } catch (e) {
    await zmaz(skusobny).catch(() => {});
    return {
      ok: false,
      mode: 'supabase',
      ms: Date.now() - zaciatok,
      zlyhalo_na: krok,
      kroky,
      chyba: String((e && e.message) || e),
    };
  }
}

module.exports = {
  nazov: 'supabase',
  dostupne,
  nacitaj,
  zapis,
  zmaz,
  skuska,
  _tabulka: TABULKA,
  _riadok: RIADOK,
  NAVOD_TABULKA,
};
