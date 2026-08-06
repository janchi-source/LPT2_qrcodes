// Simulácia hry, kde VŠETKO VYCHÁDZA (happy path) — spusti: npm run simulacia
//
// Scenár: 105 detí, home_group rovnomerne 1–10, rozdelenie podľa náramkov,
// bait prah 1 (presun hneď pri prvom nesúhlasnom skene). Pri tomto nastavení
// je matematicky garantované, že každé dieťa dôjde domov najneskôr za 9 kôl
// (max. vzdialenosť je 9 skupín, posun +1 skupina/kolo), takže po 10 kolách
// musí byť hra "dokonale rozdelená".
//
// Každé kolo: všetky skupiny naskenujú všetky svoje deti a ukončia kolo.
// Test vypíše priebeh kolo po kole a overí všetky invarianty hry.
process.env.LPT2_DATA_DIR = require('path').join(__dirname, 'tmp-data-sim');
const fs = require('fs');
fs.rmSync(process.env.LPT2_DATA_DIR, { recursive: true, force: true });

const game = require('../lib/game');

const POCET_DETI = 105;
const POCET_SKUPIN = 10;

let failures = 0;
function check(label, cond, detail) {
  if (cond) { console.log('  ok  ' + label); }
  else { console.error('  FAIL ' + label + (detail ? ' — ' + detail : '')); failures++; }
}

// --- Príprava ---------------------------------------------------------------
const rows = [];
for (let i = 1; i <= POCET_DETI; i++) {
  rows.push({ name: `Dieťa ${i}`, home_group: ((i - 1) % POCET_SKUPIN) + 1, wristband_number: i });
}
const imp = game.importChildren(rows);
check(`import ${POCET_DETI} detí`, imp.created.length === POCET_DETI && imp.errors.length === 0);

// Poistka rovno-domov vypnutá — táto simulácia ukazuje čistú +1 dynamiku,
// ktorá konverguje aj sama (prah 1). Porotovanie zapnuté (min_start_distance 2):
// nikto nesmie byť doma počas 1. ani 2. kola.
game.saveSettings({ bait: { mode: 'fixed', delay_rounds: 1, random_min: 0, random_max: 2 }, force_home_round: 0, min_start_distance: 2 });
game.distributeChildren('wristband');
check('na štarte nie je nikto vo svojej domovskej skupine',
  game.getChildren().every((c) => c.current_group !== c.home_group));
game.startGame();

const startStations = {};
for (const [g, info] of Object.entries(game.getState().groups)) startStations[g] = info.station;

// --- Simulácia --------------------------------------------------------------
console.log('\n  kolo | doma | presunov v kole | veľkosti skupín');
console.log('  -----+------+-----------------+----------------');

let prevHome = 0;
let homeMonotonne = true; // počet detí doma nesmie nikdy klesnúť (prah 1)
let vsetkySkenyOK = true;
let homePoKole1 = null; // koľko detí je doma počas 2. kola (má byť 0)
const videneVelkosti = new Set(); // multimnožina veľkostí skupín po každom kole
let guard = 0;

while (game.getState().status === 'running' && guard++ < 15) {
  const state = game.getState();
  const round = state.current_round;
  let movesThisRound = 0;

  // Snapshot zloženia skupín na ZAČIATKU kola: dieťa presunuté počas kola
  // fyzicky dobehne do novej skupiny až na ďalšie stanovište, takže ho
  // nová skupina v tomto kole už neskenuje.
  const roster = {};
  for (const c of game.getChildren()) {
    (roster[c.current_group] = roster[c.current_group] || []).push(c);
  }

  for (let g = 1; g <= POCET_SKUPIN; g++) {
    const station = state.groups[g].station;
    for (const c of roster[g] || []) {
      const r = game.processScan(c.qr_code, g, station);
      if (r.error || r.duplicate) {
        vsetkySkenyOK = false;
        console.error(`  FAIL sken ${c.id} v kole ${round}: ${r.error || 'duplicate'}`);
      }
      if (r.result === 'move') movesThisRound++;
    }
    const fin = game.finishGroupRound(g);
    if (fin.error) { vsetkySkenyOK = false; console.error(`  FAIL finish sk. ${g}: ${fin.error}`); }
  }

  const kids = game.getChildren();
  const home = kids.filter((c) => c.current_group === c.home_group).length;
  const sizes = {};
  for (const c of kids) sizes[c.current_group] = (sizes[c.current_group] || 0) + 1;
  const sizesStr = Object.keys(sizes).sort((a, b) => a - b).map((k) => sizes[k]).join(',');
  // Veľkosti sa smú po kruhu posúvať, ale ich multimnožina musí byť stále
  // rovnaká — z každej skupiny odíde toľko detí, koľko do nej príde.
  videneVelkosti.add(Object.values(sizes).sort((a, b) => a - b).join(','));
  console.log(`  ${String(round).padStart(4)} | ${String(home).padStart(4)} | ${String(movesThisRound).padStart(15)} | ${sizesStr}`);

  if (home < prevHome) homeMonotonne = false;
  prevHome = home;
  if (round === 1) homePoKole1 = home;
}
console.log('');

// --- Kontroly ---------------------------------------------------------------
const state = game.getState();
const kids = game.getChildren();

check('žiadna chyba ani duplicita pri skenoch', vsetkySkenyOK);
check('hra skončila (status finished)', state.status === 'finished', `status=${state.status}`);
check('prebehlo presne 10 kôl', state.current_round === 10, `current_round=${state.current_round}`);

// Dokonalé rozdelenie: všetci doma.
const mimo = kids.filter((c) => c.current_group !== c.home_group);
check(`všetkých ${POCET_DETI} detí je vo svojej domovskej skupine`, mimo.length === 0,
  mimo.slice(0, 5).map((c) => `${c.id}: sk.${c.current_group}≠dom.${c.home_group}`).join(', '));

// Veľkosti skupín na konci: home_group je rovnomerné, takže presne 10–11.
const finalSizes = {};
for (const c of kids) finalSizes[c.current_group] = (finalSizes[c.current_group] || 0) + 1;
check('veľkosti skupín na konci sú 10–11', Object.values(finalSizes).every((n) => n === 10 || n === 11));

// Počet detí doma nikdy neklesol (pri prahu 1 sa dieťa z domu nikdy nepohne).
check('počet detí doma rástol monotónne', homeMonotonne);

// Porotovanie (min_start_distance 2): nikto nie je doma počas 1. ani 2. kola —
// deti vo vzdialenosti 2 dorazia domov najskôr na začiatok 3. kola.
check('počas 1. a 2. kola nie je nikto vo svojej domovskej skupine', homePoKole1 === 0,
  `doma počas 2. kola: ${homePoKole1}`);

// Počty detí v skupinách sa počas hry nemenia (dieťa ide vždy len o +1).
// Pri 105 deťoch má 5 domovských skupín 11 detí a 5 desať, takže rozloženie
// je vždy 5× 10 a 5× 11 — nikdy 13, 14 či 6.
check('veľkosti skupín sú v každom kole rovnaké (5× 10 + 5× 11)',
  videneVelkosti.size === 1 && [...videneVelkosti][0] === '10,10,10,10,10,11,11,11,11,11',
  [...videneVelkosti].join(' | '));

// Každé dieťa bolo naskenované presne raz v každom kole.
check(`log skenov má ${POCET_DETI * 10} záznamov (dieťa × kolo)`, state.scans.length === POCET_DETI * 10,
  `scans=${state.scans.length}`);

// Rotácia staníc: po 10 kolách (10 posunov po kruhu 10 staníc) je každá
// skupina späť na svojej štartovej stanici a navštívila všetkých 10.
let rotaciaOK = true;
let navstiveneOK = true;
for (const [g, info] of Object.entries(state.groups)) {
  if (info.station !== startStations[g]) rotaciaOK = false;
  const stanice = new Set(state.scans.filter((s) => s.group === parseInt(g, 10)).map((s) => s.station));
  if (stanice.size !== 10) navstiveneOK = false;
}
check('každá skupina sa po 10 kolách vrátila na štartovú stanicu', rotaciaOK);
check('na každej skupine sa skenovalo na všetkých 10 staniciach', navstiveneOK);

// Kto je raz doma, doma aj ostane (prah 1): v histórii po prvom 'home'
// nesmie nasledovať 'move' ani 'correction'.
let domaOstavaOK = true;
for (const c of kids) {
  const prveDoma = c.history.findIndex((h) => h.action === 'home');
  if (prveDoma === -1) { domaOstavaOK = false; continue; } // každý sa musel dostať domov
  if (c.history.slice(prveDoma).some((h) => h.action === 'move' || h.action === 'correction')) domaOstavaOK = false;
}
check('dieťa, ktoré je raz doma, už neodíde', domaOstavaOK);

// Konzistencia histórie: reťaz presunov na seba nadväzuje a končí doma.
let historiaOK = true;
for (const c of kids) {
  let ocakavana = null; // skupina, v ktorej má byť dieťa pri ďalšom skene
  for (const h of c.history) {
    if (ocakavana !== null && h.from_group !== ocakavana) historiaOK = false;
    ocakavana = h.to_group;
  }
  if (ocakavana !== c.home_group) historiaOK = false;
}
check('história každého dieťaťa je súvislá reťaz končiaca doma', historiaOK);

// Counter po skončení: nikto nie je "na odchode".
check('všetky countere rounds_in_wrong_group sú 0', kids.every((c) => c.rounds_in_wrong_group === 0));

fs.rmSync(process.env.LPT2_DATA_DIR, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : '\nVŠETKO VYCHÁDZA — SIMULÁCIA PREŠLA');
process.exit(failures ? 1 : 0);
