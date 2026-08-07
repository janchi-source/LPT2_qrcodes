// Testy Supabase režimu — spusti: node test/supabase.test.js
//
// Toto je najdôležitejší test pri nasadení na Vercel: tam bežia požiadavky
// v samostatných inštanciách, takže dvaja animátori skenujúci naraz môžu
// zapisovať súčasne. Overujeme, že sa žiadny sken nestratí.
//
// Beží proti falošnému PostgRESTu (podvrhnutý fetch), takže netreba internet
// ani skutočnú databázu. Falošný server napodobňuje presne tú vlastnosť, na
// ktorej celý atomický zápis stojí: UPDATE s podmienkou na verziu zmení riadok
// len vtedy, keď verzia sedí, a inak nevráti nič.

process.env.SUPABASE_URL = 'https://falosne.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

let failures = 0;
function check(label, cond, detail) {
  if (cond) console.log('  ok  ' + label);
  else { console.error('  FAIL ' + label + (detail ? ' — ' + detail : '')); failures++; }
}

// --- Falošný PostgREST ------------------------------------------------------
const riadky = new Map(); // id -> { id, doc, verzia }
let predZapisom = null;   // hook: simuluje zápis iného animátora tesne pred UPDATE
let tabulkaChyba = false; // na overenie hlášky, keď tabuľka neexistuje
let poslednyKluc = null;

function odpoved(telo, status = 200) {
  return { ok: status < 400, status, text: async () => JSON.stringify(telo) };
}

global.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const metoda = (opts.method || 'GET').toUpperCase();
  poslednyKluc = (opts.headers && opts.headers.apikey) || null;

  if (tabulkaChyba) {
    return {
      ok: false,
      status: 404,
      text: async () => JSON.stringify({ code: 'PGRST205', message: 'relation "lpt2_stav" does not exist' }),
    };
  }

  // Filtre v tvare ?id=eq.hra&verzia=eq.3
  const filtre = {};
  for (const [k, v] of u.searchParams) {
    if (k === 'select') continue;
    const m = /^eq\.(.*)$/.exec(v);
    if (m) filtre[k] = m[1];
  }
  const sedi = (r) => Object.entries(filtre).every(([k, v]) => String(r[k]) === v);
  const prefer = (opts.headers && opts.headers.Prefer) || '';
  const telo = opts.body ? JSON.parse(opts.body) : null;

  if (metoda === 'GET') return odpoved([...riadky.values()].filter(sedi));

  if (metoda === 'POST') {
    if (riadky.has(telo.id)) {
      // resolution=ignore-duplicates => nič sa neprepíše a nič sa nevráti
      if (/ignore-duplicates/.test(prefer)) return odpoved([]);
      return odpoved({ code: '23505', message: 'duplicate key' }, 409);
    }
    riadky.set(telo.id, { ...telo });
    return odpoved([{ ...telo }]);
  }

  if (metoda === 'PATCH') {
    if (predZapisom) { const f = predZapisom; predZapisom = null; f(); }
    const zasiahnute = [...riadky.values()].filter(sedi);
    for (const r of zasiahnute) Object.assign(r, telo);
    return odpoved(zasiahnute.map((r) => ({ ...r })));
  }

  if (metoda === 'DELETE') {
    for (const r of [...riadky.values()].filter(sedi)) riadky.delete(r.id);
    return odpoved([]);
  }

  throw new Error('neznáma metóda ' + metoda);
};

const store = require('../lib/store');
const game = require('../lib/game');
const { route } = require('../lib/handler');

check('store beží v Supabase režime', store.useKV === true && store.mode === 'supabase',
  `useKV=${store.useKV} mode=${store.mode}`);

// --- Mimo transakcie sa v databázovom režime nesmie čítať -------------------
let hodilo = false;
try { store.load('children', []); } catch (e) { hodilo = true; }
check('čítanie mimo transakcie hlási chybu', hodilo);

async function poziadavka(fn) {
  const r = await store.runTransaction(fn);
  if (!r.ok) throw new Error('nepodarilo sa zapísať ani na 6 pokusov');
  return { out: r.result, pokusy: r.pokusy };
}

(async () => {
  // --- Skúška databázy (/api/db-test) --------------------------------------
  const test = await store.ping();
  check('db-test prejde celý cyklus', test.ok === true, JSON.stringify(test));
  check('db-test overil aj atomický zápis', test.kroky && test.kroky.atomicky_zapis === 'OK');
  check('skúška po sebe nenechala riadok', ![...riadky.keys()].some((k) => k.includes('skuska')),
    [...riadky.keys()].join(','));
  check('posiela sa service_role kľúč', poslednyKluc === 'test-service-role-key');

  // --- Príprava hry --------------------------------------------------------
  await poziadavka(() => {
    const rows = [];
    for (let i = 1; i <= 100; i++) rows.push({ name: `Dieťa ${i}`, home_group: ((i - 1) % 10) + 1, wristband_number: i });
    game.importChildren(rows);
    game.saveSettings({ bait: { mode: 'fixed', delay_rounds: 1, random_min: 0, random_max: 2 }, force_home_round: 0, min_start_distance: 2 });
    game.distributeChildren('wristband');
    game.startGame();
  });

  const stav = await poziadavka(() => game.fullState());
  check('stav sa uložil do databázy a načítal späť',
    stav.out.children.length === 100 && stav.out.state.status === 'running');
  check('dáta sú naozaj v databáze, nie na disku',
    (riadky.get('hra').doc.children || []).length === 100);

  // --- Konflikt: medzi načítaním a zápisom zapíše niekto iný ---------------
  // Verzia sa posunie tesne pred KAŽDÝM pokusom o zápis, takže transakcia
  // vyčerpá všetky pokusy — overujeme, že sa nič ticho neprepíše.
  let zabranene = 0;
  const posunVerziu = () => {
    zabranene++;
    riadky.get('hra').verzia += 1;
    predZapisom = posunVerziu;
  };
  predZapisom = posunVerziu;
  const detiPred = riadky.get('hra').doc.children.length;
  const konflikt = await store.runTransaction(() => {
    const obet = game.getChildren().find((c) => c.current_group === 1);
    return game.processScan(obet.qr_code, 1, 'A');
  });
  predZapisom = null;
  check('pri trvalom konflikte transakcia neprejde', konflikt.ok === false);
  check('nič sa ticho neprepísalo', riadky.get('hra').doc.children.length === detiPred);
  check('zápis sa naozaj pokúšal opakovať', zabranene >= 6, `pokusov: ${zabranene}`);

  // --- Súbeh: 10 animátorov skenuje naraz ----------------------------------
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

  const velkosti = {};
  for (const c of po.out.children) velkosti[c.current_group] = (velkosti[c.current_group] || 0) + 1;
  check('počty detí v skupinách ostali 10/10', Object.values(velkosti).every((n) => n === 10),
    JSON.stringify(velkosti));

  // --- Mazanie dieťaťa cez route() -----------------------------------------
  // Presne to, na čom sa to v praxi zaseklo — nech je to pokryté.
  const obet = po.out.children[0];
  const zmazanie = await poziadavka(() => route('DELETE', `/api/children/${obet.id}`, {}));
  check('mazanie dieťaťa vráti ok', zmazanie.out.status === 200 && zmazanie.out.body.ok === true,
    JSON.stringify(zmazanie.out.body));
  const poMazani = await poziadavka(() => game.fullState());
  check('dieťa je naozaj preč aj v databáze',
    !poMazani.out.children.some((c) => c.id === obet.id)
    && !riadky.get('hra').doc.children.some((c) => c.id === obet.id));

  // --- Chýbajúca tabuľka musí poradiť, čo spustiť --------------------------
  tabulkaChyba = true;
  const bezTabulky = await store.ping();
  tabulkaChyba = false;
  check('pri chýbajúcej tabuľke db-test poradí create table',
    bezTabulky.ok === false && /create table/i.test(bezTabulky.chyba || ''),
    bezTabulky.chyba);

  console.log(failures ? `\n${failures} FAILED` : '\nSUPABASE REŽIM OK');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('\nCHYBA:', e);
  process.exit(1);
});
