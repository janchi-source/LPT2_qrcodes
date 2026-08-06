// Simulácia celej hry — spusti: npm test
// Overuje: import, rozdelenie, sken (home/bait/move), rotáciu staníc,
// posun kôl, korekcie a edge case "nestihne domov".
process.env.LPT2_DATA_DIR = require('path').join(__dirname, 'tmp-data');
const fs = require('fs');
fs.rmSync(process.env.LPT2_DATA_DIR, { recursive: true, force: true });

const game = require('../lib/game');

let failures = 0;
function check(label, cond) {
  if (cond) { console.log('  ok  ' + label); }
  else { console.error('  FAIL ' + label); failures++; }
}

// --- Import 105 detí, home_group rovnomerne ---
const rows = [];
for (let i = 1; i <= 105; i++) {
  rows.push({ name: `Dieťa ${i}`, home_group: ((i - 1) % 10) + 1, wristband_number: i });
}
let r = game.importChildren(rows);
check('import 105 detí bez chýb', r.created.length === 105 && r.errors.length === 0);

r = game.importChildren([{ name: 'Duplikát', home_group: 1, qr_code: 'D001' }]);
check('duplicitný QR odmietnutý', r.errors.length === 1);
game.deleteChild(game.getChildren().find((c) => c.name === 'Duplikát')?.id); // pre istotu

// --- Rozdelenie + štart (legacy správanie: bloky, deti môžu začať doma) ---
game.saveSettings({ min_start_distance: 0 });
game.distributeChildren('wristband');
let kids = game.getChildren();
const sizes = {};
for (const c of kids) sizes[c.current_group] = (sizes[c.current_group] || 0) + 1;
check('veľkosti skupín 10–11', Object.values(sizes).every((n) => n === 10 || n === 11) && Object.keys(sizes).length === 10);

check('sken pred štartom odmietnutý', !!game.processScan('D001', 1, 'A').error);
game.startGame();
let st = game.getState();
check('hra beží, kolo 1', st.status === 'running' && st.current_round === 1);
check('skupina 1 na stanici A', st.groups[1].station === 'A');
check('skupina 10 na stanici J', st.groups[10].station === 'J');

// --- Jeden ručný sken: dieťa doma ---
kids = game.getChildren();
const homeKid = kids.find((c) => c.current_group === 1 && c.home_group === 1);
r = game.processScan(homeKid.qr_code, 1, 'A');
check('dieťa doma -> home', r.result === 'home');
r = game.processScan(homeKid.qr_code, 1, 'A');
check('duplicitný sken v kole detegovaný', r.duplicate === true);

// --- Dieťa mimo domu: default prah 1 -> presun hneď ---
const awayKid = kids.find((c) => c.current_group === 1 && c.home_group !== 1);
r = game.processScan(awayKid.qr_code, 1, 'A');
check('dieťa mimo -> move do sk. 2 (prah 1)', r.result === 'move' && r.moved_to === 2);

// --- Prah 2: prvý sken bait, druhý move ---
game.saveSettings({ bait: { mode: 'fixed', delay_rounds: 2, random_min: 0, random_max: 2 } });
const baitKid = kids.find((c) => c.current_group === 2 && c.home_group !== 2 && c.home_group !== 3);
r = game.processScan(baitKid.qr_code, 2, 'B');
check('prah 2: 1. sken -> bait (ostáva)', r.result === 'bait');
check('counter = 1', game.getChildren().find((c) => c.id === baitKid.id).rounds_in_wrong_group === 1);

// posuň kolo, aby sa dal skenovať znova
game.forceAdvanceRound();
st = game.getState();
check('kolo 2', st.current_round === 2);
check('skupina 1 sa posunula A->B', st.groups[1].station === 'B');
r = game.processScan(baitKid.qr_code, 2, 'C');
check('prah 2: 2. sken -> move do sk. 3', r.result === 'move' && r.moved_to === 3);

// --- Korekcia: dieťa fyzicky v inej skupine, než appka eviduje ---
const strayKid = game.getChildren().find((c) => c.current_group === 5 && c.home_group === 5);
r = game.processScan(strayKid.qr_code, 7, 'X'); // naskenované v skupine 7
check('korekcia zaznamenaná', r.corrected === true);
check('po korekcii platí logika novej skupiny', r.result === 'move' || r.result === 'bait');

// --- Ukončenie kola skupinou ---
r = game.finishGroupRound(1);
check('finish-round posunie stanicu', r.ok && game.getState().groups[1].station === 'C');
r = game.finishGroupRound(1);
check('druhý finish-round v tom istom kole odmietnutý', !!r.error);

// --- Plná simulácia do konca hry (prah 1, bez poistky rovno-domov) ---
game.saveSettings({ bait: { mode: 'fixed', delay_rounds: 1, random_min: 0, random_max: 2 }, force_home_round: 0 });
game.resetGame();
game.distributeChildren('wristband');
game.startGame();
let guard = 0;
while (game.getState().status === 'running' && guard++ < 20) {
  const state = game.getState();
  const round = state.current_round;
  for (let g = 1; g <= 10; g++) {
    const inGroup = game.getChildren().filter((c) => c.current_group === g);
    for (const c of inGroup) {
      const res = game.processScan(c.qr_code, g, state.groups[g].station);
      if (res.error) { check('sken bez chyby (' + res.error + ')', false); guard = 99; }
    }
    game.finishGroupRound(g);
  }
}
st = game.getState();
kids = game.getChildren();
const homeCount = kids.filter((c) => c.current_group === c.home_group).length;
console.log(`  info: po ${st.current_round} kolách je doma ${homeCount}/${kids.length} detí, status=${st.status}`);
check('hra skončila po max_rounds', st.status === 'finished');
// Pri prahu 1 a 10 kolách: dieťa začínajúce vo vzdialenosti d sa presúva každé
// kolo o +1, takže domov dôjde každé (d <= 9 < 10 kôl) — všetci doma.
check('všetky deti doma (prah 1, 10 kôl)', homeCount === kids.length);

// --- Edge case: dieťa čo to nestihne (prah 2 spomalí presuny, poistka vypnutá) ---
game.resetGame();
game.saveSettings({ bait: { mode: 'fixed', delay_rounds: 2, random_min: 0, random_max: 2 }, force_home_round: 0 });
game.distributeChildren('wristband');
game.startGame();
guard = 0;
while (game.getState().status === 'running' && guard++ < 20) {
  const state = game.getState();
  for (let g = 1; g <= 10; g++) {
    for (const c of game.getChildren().filter((x) => x.current_group === g)) {
      game.processScan(c.qr_code, g, state.groups[g].station);
    }
    game.finishGroupRound(g);
  }
}
kids = game.getChildren();
const notHome = kids.filter((c) => c.current_group !== c.home_group).length;
console.log(`  info: s prahom 2 skončilo mimo domova ${notHome}/${kids.length} detí (očakávané > 0)`);
check('edge case existuje: nie všetci doma pri prahu 2', notHome > 0);

// --- Logistická poistka force_home_round: od daného kola rovno domov ---
game.resetGame();
game.saveSettings({ bait: { mode: 'fixed', delay_rounds: 2, random_min: 0, random_max: 2 }, force_home_round: 1 });
game.distributeChildren('wristband');
game.startGame();
// Dieťa ďaleko od domova: s poistkou od kola 1 musí ísť rovno domov, nie +1.
kids = game.getChildren();
const farKid = kids.find((c) => c.current_group != null
  && (c.home_group - c.current_group + 10) % 10 >= 3);
r = game.processScan(farKid.qr_code, farKid.current_group, 'A');
check('poistka: nesúhlasiace dieťa ide rovno do home_group',
  r.result === 'move' && r.moved_to === farKid.home_group && r.forced_home === true);
check('poistka: dieťa je hneď doma',
  game.getChildren().find((c) => c.id === farKid.id).current_group === farKid.home_group);

// S prahom 2 by bez poistky ostalo ~40 detí mimo (viď vyššie); s poistkou
// od kola 8 musia byť na konci VŠETCI doma.
game.resetGame();
game.saveSettings({ bait: { mode: 'fixed', delay_rounds: 2, random_min: 0, random_max: 2 }, force_home_round: 8 });
game.distributeChildren('wristband');
game.startGame();
guard = 0;
while (game.getState().status === 'running' && guard++ < 15) game.simulateRound();
kids = game.getChildren();
check('poistka: prah 2 + force od kola 8 -> všetci doma',
  game.getState().status === 'finished' && kids.every((c) => c.current_group === c.home_group));
const forcedScans = game.getState().scans.filter((s) => s.forced_home);
check('poistka: forced_home skeny existujú a len od kola 8',
  forcedScans.length > 0 && forcedScans.every((s) => s.round >= 8));

// --- min_start_distance: porotovanie na štarte ---
game.resetGame();
game.saveSettings({ bait: { mode: 'fixed', delay_rounds: 1, random_min: 0, random_max: 2 }, force_home_round: 0, min_start_distance: 2 });
game.distributeChildren('wristband');
kids = game.getChildren();
check('porotovanie: nikto neštartuje vo svojej home skupine', kids.every((c) => c.current_group !== c.home_group));
check('porotovanie: každý štartuje aspoň 2 skupiny od domova',
  kids.every((c) => (c.home_group - c.current_group + 10) % 10 >= 2));
const distSizes = {};
for (const c of kids) distSizes[c.current_group] = (distSizes[c.current_group] || 0) + 1;
check('porotovanie: skupiny sú aj tak vyrovnané (10–11)',
  Object.keys(distSizes).length === 10 && Object.values(distSizes).every((n) => n === 10 || n === 11));
game.startGame();
game.simulateRound();
check('porotovanie: ani počas 2. kola nie je nikto doma',
  game.getChildren().every((c) => c.current_group !== c.home_group));
guard = 0;
while (game.getState().status === 'running' && guard++ < 15) game.simulateRound();
check('porotovanie: hra aj tak skončí so všetkými doma',
  game.getState().status === 'finished' && game.getChildren().every((c) => c.current_group === c.home_group));

// --- simulateRound (tlačidlo "Odsimulovať kolo" v admine) ---
game.resetGame();
game.saveSettings({ bait: { mode: 'fixed', delay_rounds: 1, random_min: 0, random_max: 2 } });
game.distributeChildren('wristband');
game.startGame();
// Časť detí "naskenujú animátori" ručne — simulácia ich musí preskočiť.
const g1kids = game.getChildren().filter((c) => c.current_group === 1);
for (const c of g1kids) game.processScan(c.qr_code, 1, 'A');
r = game.simulateRound();
check('simulateRound dokončí kolo 1', r.ok && r.simulated_round === 1 && r.current_round === 2);
check('simulateRound preskočí už naskenovaných', r.already_scanned === g1kids.length);
check('simulateRound naskenuje zvyšok', r.scanned + r.already_scanned === game.getChildren().length);
guard = 0;
while (game.getState().status === 'running' && guard++ < 15) game.simulateRound();
kids = game.getChildren();
check('simulateRound dohrá hru do konca a všetci sú doma',
  game.getState().status === 'finished' && kids.every((c) => c.current_group === c.home_group));

// --- Veľkosti skupín ostávajú konštantné počas celej hry ---
// Dieťa sa vždy posúva len o +1, takže z každej skupiny musí v kole odísť
// presne toľko detí, koľko do nej príde z predchádzajúcej. Testuje sa na
// 100 deťoch (rovnako veľké domovské skupiny), kde má byť vo všetkých
// skupinách v každom kole presne 10 detí.
// Pozn.: store číta JSON z disku pri každom volaní, takže stačí vymazať dáta
// a naimportovať novú sadu — netreba prenačítavať modul.
fs.rmSync(process.env.LPT2_DATA_DIR, { recursive: true, force: true });
const rows100 = [];
for (let i = 1; i <= 100; i++) rows100.push({ name: `Rovno ${i}`, home_group: ((i - 1) % 10) + 1, wristband_number: i });
game.importChildren(rows100);

const sizesNow = () => {
  const s = {};
  for (const c of game.getChildren()) s[c.current_group] = (s[c.current_group] || 0) + 1;
  return Array.from({ length: 10 }, (_, i) => s[i + 1] || 0).join(',');
};
const ROVNAKE = Array(10).fill(10).join(',');

for (const cfg of [
  { label: 'prah 1', bait: { mode: 'fixed', delay_rounds: 1, random_min: 0, random_max: 2 }, force: 0 },
  { label: 'prah 2', bait: { mode: 'fixed', delay_rounds: 2, random_min: 0, random_max: 2 }, force: 0 },
  { label: 'poistka od kola 8', bait: { mode: 'fixed', delay_rounds: 1, random_min: 0, random_max: 2 }, force: 8 },
]) {
  for (const mode of ['wristband', 'random']) {
    game.resetGame();
    game.saveSettings({ bait: cfg.bait, force_home_round: cfg.force, min_start_distance: 2 });
    game.distributeChildren(mode);
    const seen = new Set([sizesNow()]);
    game.startGame();
    for (let round = 1; round <= 10; round++) { game.simulateRound(); seen.add(sizesNow()); }
    check(`v každej skupine je vždy presne 10 detí (${cfg.label}, ${mode})`,
      seen.size === 1 && seen.has(ROVNAKE), [...seen].join(' | '));
  }
}
check('homeGroupBalance: rovnaké domovské skupiny = vyvážené', game.homeGroupBalance().home_balanced === true);

// Nerovnaké domovské skupiny sa rozdelením vyrovnať nedajú — appka to hlási.
// (rozdiel 1 dieťa je ešte OK, tu pridávame 3 do jednej domovskej skupiny)
game.importChildren([
  { name: 'Nadpočetný 1', home_group: 1, wristband_number: 991 },
  { name: 'Nadpočetný 2', home_group: 1, wristband_number: 992 },
  { name: 'Nadpočetný 3', home_group: 1, wristband_number: 993 },
]);
const bal = game.homeGroupBalance();
check('homeGroupBalance: nevyvážené domovské skupiny sa detegujú',
  bal.home_balanced === false && bal.home_max === 13 && bal.home_min === 10);

fs.rmSync(process.env.LPT2_DATA_DIR, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : '\nVŠETKY TESTY PREŠLI');
process.exit(failures ? 1 : 0);
