// Kontrola pred štartom — spusti: node test/kontrola.test.js
//
// Zmyslom je, že sa hra, ktorá by matematicky nedopadla, VÔBEC nespustí.
// Chyba v nastaveniach sa inak prejaví až na tábore, keď v areáli stojí 106
// detí a je 11:40 — vtedy sa už nedá spraviť nič.
//
// Každý prípad nižšie je konkrétny spôsob, ako sa to dá pokaziť.
process.env.LPT2_DATA_DIR = require('path').join(__dirname, 'tmp-kontrola');
const fs = require('fs');
fs.rmSync(process.env.LPT2_DATA_DIR, { recursive: true, force: true });

const game = require('../lib/game');

let failures = 0;
function check(label, cond, detail) {
  if (cond) console.log('  ok  ' + label);
  else { console.error('  FAIL ' + label + (detail ? ' — ' + detail : '')); failures++; }
}

// Čistý štart pre každý prípad: 100 detí, 10 domovských skupín po 10.
function pripravDeti(pocet = 100) {
  fs.rmSync(process.env.LPT2_DATA_DIR, { recursive: true, force: true });
  const rows = [];
  for (let i = 1; i <= pocet; i++) {
    rows.push({ name: `Dieťa ${i}`, home_group: ((i - 1) % 10) + 1, wristband_number: i });
  }
  game.importChildren(rows);
}

function maChybu(vzor) {
  return game.preflight().chyby.some((x) => vzor.test(x));
}

// Dohrá hru do konca a povie, či sú na konci všetky deti doma.
function dohrajHru() {
  if (game.startGame().error) return false;
  let guard = 0;
  while (game.getState().status === 'running' && guard++ < 40) game.simulateRound();
  return game.getState().status === 'finished'
    && game.getChildren().every((c) => c.current_group === c.home_group);
}

// --- Zdravá zostava musí prejsť ---------------------------------------------
pripravDeti();
game.distributeChildren('wristband', 'ZDRAVA');
let p = game.preflight();
check('zdravá zostava prejde bez chýb', p.ok === true, JSON.stringify(p.chyby));
check('výpočty sedia: 9 posunov × 1 kolo = 9 z 10 kôl',
  p.vypocty.najvacsia_vzdialenost === 9 && p.vypocty.kol_na_presun === 1
  && p.vypocty.potrebnych_kol === 9 && p.vypocty.rezerva_kol === 1,
  JSON.stringify(p.vypocty));
check('hra sa spustí', !game.startGame().error);

// --- Menej kôl => rozdelenie sa stiahne bližšie k domovu ----------------------
// Kratšia hra nie je chyba, len sa deti nesmú umiestniť tak ďaleko.
pripravDeti();
game.saveSettings({ max_rounds: 5 });
let r = game.distributeChildren('wristband', 'MALOKOL');
check('pri 5 kolách sa strop vzdialenosti stiahne na 5', r.distribution.max_start_distance === 5,
  JSON.stringify(r.distribution));
check('kontrola nehlási chybu', game.preflight().ok === true,
  JSON.stringify(game.preflight().chyby));
check('a všetci sú za 5 kôl doma', dohrajHru() === true);
game.saveSettings({ max_rounds: 10 });

// --- Pomalší bait prah sa RIEŠI rozdelením, nie odmietnutím --------------------
// Počet kôl je daný harmonogramom, takže sa mu prispôsobí rozdelenie: pri prahu
// 2 trvá posun 2 kolá, za 10 kôl teda dieťa stihne 5 posunov a ďalej ako 5 sa
// nikto neumiestni. Hra vyjde z konštrukcie a kontrola nemá čo hlásiť.
pripravDeti();
game.saveSettings({ bait: { mode: 'fixed', delay_rounds: 2, random_min: 0, random_max: 2 } });
r = game.distributeChildren('wristband', 'PRAH2');
check('pri prahu 2 si rozdelenie zníži strop na 5', r.distribution.max_start_distance === 5,
  JSON.stringify(r.distribution));
p = game.preflight();
check('a kontrola nehlási žiadnu chybu', p.ok === true, JSON.stringify(p.chyby));
check('potrebných kôl sa zmestí do 10', p.vypocty.potrebnych_kol <= 10,
  JSON.stringify(p.vypocty));
check('hra sa spustí a dohrá so všetkými doma', dohrajHru() === true);

// Náhodný režim sa musí posudzovať podľa NAJHORŠIEHO možného prahu — inak by
// hra vyšla len vtedy, keď sa pošťastí.
pripravDeti();
game.saveSettings({ bait: { mode: 'random', delay_rounds: 1, random_min: 0, random_max: 2 } });
r = game.distributeChildren('wristband', 'NAHODNY');
check('náhodný prah sa počíta z najhoršieho prípadu (max 2 => strop 5)',
  r.distribution.kol_na_presun === 2 && r.distribution.max_start_distance === 5,
  JSON.stringify(r.distribution));
check('a hra aj tak dohrá so všetkými doma', dohrajHru() === true);
game.saveSettings({ bait: { mode: 'fixed', delay_rounds: 1, random_min: 0, random_max: 2 } });

// --- Protirečivé požiadavky sa riešiť nedajú — tie sa musia ohlásiť -----------
pripravDeti();
game.saveSettings({ bait: { mode: 'fixed', delay_rounds: 6, random_min: 0, random_max: 2 }, min_start_distance: 2 });
check('min. vzdialenosť, ktorá sa nedá prejsť, sa odhalí', maChybu(/Min. vzdialenosť od domova je 2/));
const odmietnute = game.distributeChildren('wristband', 'NEDA');
check('a rozdelenie to odmietne spraviť', !!odmietnute.error, JSON.stringify(odmietnute).slice(0, 140));

pripravDeti();
game.saveSettings({ bait: { mode: 'fixed', delay_rounds: 11, random_min: 0, random_max: 2 }, min_start_distance: 0 });
check('prah dlhší než celá hra sa odhalí', maChybu(/nezmestí sa ani jeden/));
game.saveSettings({ bait: { mode: 'fixed', delay_rounds: 1, random_min: 0, random_max: 2 }, min_start_distance: 2 });

// --- Poistka „rovno domov" cestu skráti ---------------------------------------
pripravDeti();
game.saveSettings({ bait: { mode: 'fixed', delay_rounds: 2, random_min: 0, random_max: 2 }, force_home_round: 8 });
game.distributeChildren('wristband', 'POISTKA');
p = game.preflight();
check('so zapnutou poistkou prejde aj pomalý prah', p.ok === true, JSON.stringify(p.chyby));
check('ale poistka sa vypíše ako varovanie',
  p.varovania.some((x) => /rovno domov/.test(x)), JSON.stringify(p.varovania));
game.saveSettings({ bait: { mode: 'fixed', delay_rounds: 1, random_min: 0, random_max: 2 }, force_home_round: 0 });

// --- Duplicitné QR ------------------------------------------------------------
pripravDeti();
const deti = game.getChildren();
deti[5].qr_code = deti[0].qr_code;
require('../lib/store').save('children', deti);
check('duplicitný QR sa odhalí', maChybu(/Duplicitné QR/));
check('a hra sa nespustí', !!game.startGame().error);

// --- Domovská skupina mimo rozsahu --------------------------------------------
pripravDeti();
const deti2 = game.getChildren();
deti2[3].home_group = 99;
require('../lib/store').save('children', deti2);
check('domovská skupina mimo rozsahu sa odhalí', maChybu(/mimo rozsahu/));

// --- Viac skupín než stanovíšť -------------------------------------------------
pripravDeti();
game.saveSettings({ num_groups: 12 });
check('viac skupín než stanovíšť sa odhalí', maChybu(/stanovíšť len 10/));
game.saveSettings({ num_groups: 10 });
game.resetManualSettings();

// --- Dve skupiny na tom istom stanovišti ---------------------------------------
pripravDeti();
const mapovanie = { ...game.getSettings().group_start_station, 3: 'A' }; // sk.1 už má A
game.saveSettings({ group_start_station: mapovanie });
check('kolízia štartových stanovíšť sa odhalí', maChybu(/štartuje viac skupín/));
game.resetManualSettings();

// --- Deti sa nezmestia pod strop ------------------------------------------------
pripravDeti();
game.saveSettings({ max_group_size: 5 });
check('nedostatočná kapacita sa odhalí', maChybu(/nezmestí do 10 skupín po 5/));
game.saveSettings({ max_group_size: 11 });

// --- Žiadne deti ------------------------------------------------------------------
fs.rmSync(process.env.LPT2_DATA_DIR, { recursive: true, force: true });
check('prázdny zoznam detí sa odhalí', maChybu(/žiadne deti/i));

// --- Nevyvážené domovské skupiny sú VAROVANIE, nie chyba --------------------------
// Presne toto je reálny stav na tábore (106 detí = 6× 11 + 4× 10) — hra dopadne,
// len skupiny nebudú úplne rovnaké. Blokovať štart by tu bola chyba.
pripravDeti(106);
game.distributeChildren('wristband', 'REALNY');
p = game.preflight();
check('106 detí (6× 11 + 4× 10) hru nezablokuje', p.ok === true, JSON.stringify(p.chyby));
check('rozdiel 1 dieťa sa nehlási — je nevyhnutný a hre nevadí',
  !p.varovania.some((x) => /nie sú rovnako veľké/.test(x)), JSON.stringify(p.varovania));
check('a hra sa naozaj spustí', !game.startGame().error);

// Naozaj nevyvážené skupiny (rozdiel 2 a viac) už varovanie dostanú — hra
// dobehne, ale počty v skupinách budú počas nej kolísať.
game.saveSettings({ max_group_size: 0 });
game.importChildren([
  { name: 'Nadpočetný 1', home_group: 1 },
  { name: 'Nadpočetný 2', home_group: 1 },
  { name: 'Nadpočetný 3', home_group: 1 },
]);
p = game.preflight();
check('výrazne nevyvážené domovské skupiny sa ohlásia ako varovanie',
  p.varovania.some((x) => /nie sú rovnako veľké/.test(x)), JSON.stringify(p.varovania));
check('ale ani to hru nezablokuje — je to rozhodnutie vedúcich',
  p.ok === true, JSON.stringify(p.chyby));

fs.rmSync(process.env.LPT2_DATA_DIR, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : '\nKONTROLA PRED ŠTARTOM OK');
process.exit(failures ? 1 : 0);
