// Testy KV režimu (Vercel) — spusti: node test/store.test.js
//
// Toto je najdôležitejší test pri nasadení na Vercel: tam bežia požiadavky
// v samostatných inštanciách, takže dvaja animátori skenujúci naraz môžu
// zapisovať súčasne. Overujeme, že sa žiadny sken nestratí.
//
// Beží proti falošnému Upstash Redisu (podvrhnutý fetch), takže netreba
// internet ani skutočnú databázu.

process.env.KV_REST_API_URL = 'http://falosne-kv.local';
process.env.KV_REST_API_TOKEN = 'test-token';
process.env.LPT2_KV_KEY = 'test:doc';

let failures = 0;
function check(label, cond, detail) {
  if (cond) console.log('  ok  ' + label);
  else { console.error('  FAIL ' + label + (detail ? ' — ' + detail : '')); failures++; }
}

// --- Falošný Redis ----------------------------------------------------------
const db = new Map();
let pocetZapisov = 0;
let predCommitom = null; // hook: simuluje zápis iného animátora medzi begin a commit

global.fetch = async (url, opts) => {
  const cmd = JSON.parse(opts.body);
  const [name, ...args] = cmd;
  let result = null;

  if (name === 'GET') {
    result = db.has(args[0]) ? db.get(args[0]) : null;
  } else if (name === 'SET') {
    db.set(args[0], args[1]);
    result = 'OK';
  } else if (name === 'EVAL') {
    // Náš compare-and-swap skript. args = [script, '2', DOC, VER, doc, baseVersion]
    if (predCommitom) { const f = predCommitom; predCommitom = null; f(); }
    const docKey = args[2], verKey = args[3], novyDoc = args[4], base = args[5];
    const ver = db.has(verKey) ? String(db.get(verKey)) : '0';
    if (ver === String(base)) {
      db.set(docKey, novyDoc);
      db.set(verKey, String(Number(base) + 1));
      pocetZapisov++;
      result = 1;
    } else {
      result = 0; // konflikt — niekto zapísal medzitým
    }
  } else {
    throw new Error('neznámy príkaz ' + name);
  }
  return { ok: true, status: 200, text: async () => JSON.stringify({ result }) };
};

const store = require('../lib/store');
const game = require('../lib/game');
const { route } = require('../lib/handler');

check('store beží v KV režime', store.useKV === true);

// --- Mimo transakcie sa v KV režime nesmie čítať ----------------------------
let hodilo = false;
try { store.load('children', []); } catch (e) { hodilo = true; }
check('čítanie mimo transakcie hlási chybu', hodilo);

// --- Pomocník: jedna požiadavka = jedna transakcia --------------------------
async function poziadavka(fn) {
  const r = await store.runTransaction(fn);
  if (!r.ok) throw new Error('nepodarilo sa zapísať ani na 6 pokusov');
  return { out: r.result, pokusy: r.pokusy };
}

(async () => {
  // --- Príprava hry -------------------------------------------------------
  await poziadavka(() => {
    const rows = [];
    for (let i = 1; i <= 100; i++) rows.push({ name: `Dieťa ${i}`, home_group: ((i - 1) % 10) + 1, wristband_number: i });
    game.importChildren(rows);
    game.saveSettings({ bait: { mode: 'fixed', delay_rounds: 1, random_min: 0, random_max: 2 }, force_home_round: 0, min_start_distance: 2 });
    game.distributeChildren('wristband');
    game.startGame();
  });

  let stav = await poziadavka(() => game.fullState());
  check('stav sa uložil do KV a načítal späť', stav.out.children.length === 100 && stav.out.state.status === 'running');

  // --- Konflikt: medzi načítaním a zápisom zapíše niekto iný ---------------
  // Verzia sa posunie tesne pred KAŽDÝM pokusom o zápis, takže transakcia
  // vyčerpá všetky pokusy — overujeme, že sa nič ticho neprepíše.
  let zabranene = 0;
  const posunVerziu = () => {
    zabranene++;
    db.set('test:doc:version', String(Number(db.get('test:doc:version')) + 1));
    predCommitom = posunVerziu;
  };
  predCommitom = posunVerziu;
  const dokumentPred = db.get('test:doc');
  const konflikt = await store.runTransaction(() => {
    const obet = game.getChildren().find((c) => c.current_group === 1);
    return game.processScan(obet.qr_code, 1, 'A');
  });
  predCommitom = null;
  check('pri trvalom konflikte transakcia neprejde', konflikt.ok === false);
  check('nič sa ticho neprepísalo', db.get('test:doc') === dokumentPred);
  check('zápis sa naozaj pokúšal opakovať', zabranene >= 6, `pokusov: ${zabranene}`);

  // --- Súbeh cez route(): 10 animátorov skenuje naraz ---------------------
  // Každý sken ide cez rovnaký cyklus begin -> logika -> commit s opakovaním,
  // aký používa lib/handler.js. Púšťame ich naraz cez Promise.all.
  const pred = await poziadavka(() => game.fullState());
  const skupiny = {};
  for (const c of pred.out.children) (skupiny[c.current_group] = skupiny[c.current_group] || []).push(c);

  const ulohy = [];
  const ocakavane = [];
  for (let g = 1; g <= 10; g++) {
    const dieta = skupiny[g][0];
    const stanica = pred.out.state.groups[g].station;
    ocakavane.push(dieta.id);
    ulohy.push(poziadavka(() => route('POST', '/api/scan', { qr_code: dieta.qr_code, group: g, station: stanica })));
  }
  const vysledky = await Promise.all(ulohy);
  const chyby = vysledky.filter((v) => v.out.body && v.out.body.error);
  check('10 súbežných skenov prešlo bez chyby', chyby.length === 0,
    chyby.map((c) => c.out.body.error).join(', '));

  const po = await poziadavka(() => game.fullState());
  const zapisane = po.out.state.scans.filter((s) => ocakavane.includes(s.child_id));
  check('všetkých 10 skenov je v logu (žiadny sa nestratil)', zapisane.length === 10,
    `v logu ${zapisane.length}`);
  check('žiadny sken nie je zapísaný dvakrát',
    new Set(zapisane.map((s) => s.child_id)).size === 10);

  const opakovane = vysledky.filter((v) => v.pokusy > 1).length;
  console.log(`  info: ${opakovane} z 10 požiadaviek muselo zápis zopakovať kvôli súbehu`);
  check('mechanizmus opakovania sa naozaj použil (inak test nič nedokazuje)', opakovane > 0);

  // --- Veľkosti skupín ostali konzistentné --------------------------------
  const velkosti = {};
  for (const c of po.out.children) velkosti[c.current_group] = (velkosti[c.current_group] || 0) + 1;
  check('počty detí v skupinách ostali 10/10', Object.values(velkosti).every((n) => n === 10),
    JSON.stringify(velkosti));

  console.log(failures ? `\n${failures} FAILED` : '\nKV REŽIM OK');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('\nCHYBA:', e);
  process.exit(1);
});
