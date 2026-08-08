// Rozdelenie detí pred hrou — spusti: node test/rozdelenie.test.js
//
// Rozdelenie sa robí RAZ pred hrou a musí byť spätne dohľadateľné: z toho
// istého seedu musí vzniknúť presne to isté rozdelenie. Keď sa počas tábora
// čokoľvek pokazí (spadne databáza, niekto omylom klikne na prerozdelenie),
// seed je jediné, čo treba mať poznačené na to, aby sa stav dal obnoviť.
process.env.LPT2_DATA_DIR = require('path').join(__dirname, 'tmp-rozdelenie');
const fs = require('fs');
fs.rmSync(process.env.LPT2_DATA_DIR, { recursive: true, force: true });

const game = require('../lib/game');
const { generator, seedZTextu, novySeed, zamiesaj } = require('../lib/seed');

let failures = 0;
function check(label, cond, detail) {
  if (cond) console.log('  ok  ' + label);
  else { console.error('  FAIL ' + label + (detail ? ' — ' + detail : '')); failures++; }
}

// --- Generátor ---------------------------------------------------------------
const a = generator('TEST-1234');
const b = generator('TEST-1234');
const c = generator('INY-SEED');
const radA = Array.from({ length: 20 }, () => a());
const radB = Array.from({ length: 20 }, () => b());
const radC = Array.from({ length: 20 }, () => c());
check('rovnaký seed dá rovnakú postupnosť', radA.join() === radB.join());
check('iný seed dá inú postupnosť', radA.join() !== radC.join());
check('čísla sú v intervale <0, 1)', radA.every((n) => n >= 0 && n < 1));
check('postupnosť nie je konštantná', new Set(radA).size > 15);
check('seed z textu je stabilný', seedZTextu('abc') === seedZTextu('abc'));

const seedy = new Set(Array.from({ length: 200 }, () => novySeed()));
check('novySeed dáva rôzne seedy', seedy.size > 190, `unikátnych ${seedy.size}/200`);
check('seed neobsahuje zameniteľné znaky (0/O, 1/I)',
  [...seedy].every((s) => !/[01OI]/.test(s)), [...seedy][0]);

const pole = zamiesaj([1, 2, 3, 4, 5, 6, 7, 8], generator('X'));
check('zamiesaj zachová všetky prvky', pole.slice().sort((x, y) => x - y).join() === '1,2,3,4,5,6,7,8');

// --- Rozdelenie detí ---------------------------------------------------------
const rows = [];
for (let i = 1; i <= 100; i++) rows.push({ name: `Dieťa ${i}`, home_group: ((i - 1) % 10) + 1, wristband_number: i });
game.importChildren(rows);

const odtlacok = () => game.getChildren()
  .slice()
  .sort((x, y) => x.wristband_number - y.wristband_number)
  .map((x) => `${x.wristband_number}:${x.current_group}`)
  .join(',');

// Bez seedu: vyrobí sa nový a uloží sa.
const r1 = game.distributeChildren('wristband');
check('rozdelenie bez seedu vyrobí a uloží nový seed',
  !!(r1.distribution && r1.distribution.seed), JSON.stringify(r1.distribution));
check('údaje o rozdelení sa dajú načítať späť',
  game.getDistribution().seed === r1.distribution.seed);
check('rozdelenie si pamätá režim aj počet detí',
  game.getDistribution().mode === 'wristband' && game.getDistribution().pocet_deti === 100);

const prve = odtlacok();

// Ten istý seed musí dať PRESNE to isté rozdelenie.
game.distributeChildren('wristband', r1.distribution.seed);
check('rovnaký seed zopakuje rozdelenie do posledného dieťaťa', odtlacok() === prve);

// Iný seed dá (takmer isto) iné rozdelenie.
game.distributeChildren('wristband', 'UPLNE-INY-SEED');
check('iný seed dá iné rozdelenie', odtlacok() !== prve);

// A späť na pôvodný seed — musí sa vrátiť pôvodný stav.
game.distributeChildren('wristband', r1.distribution.seed);
check('návrat k pôvodnému seedu obnoví pôvodné rozdelenie', odtlacok() === prve);

// To isté musí platiť aj pre náhodný režim.
const rr = game.distributeChildren('random', 'NAHODNY-TEST');
const nahodnePrve = odtlacok();
check('náhodný režim si tiež pamätá seed', rr.distribution.seed === 'NAHODNY-TEST');
game.distributeChildren('random', 'NAHODNY-TEST');
check('náhodný režim je s rovnakým seedom tiež zopakovateľný', odtlacok() === nahodnePrve);

// --- Vlastnosti, ktoré musí rozdelenie spĺňať --------------------------------
game.saveSettings({ min_start_distance: 2 });
game.distributeChildren('wristband', 'KONTROLA');
const deti = game.getChildren();

check('každé dieťa má pridelenú skupinu', deti.every((c) => c.current_group >= 1 && c.current_group <= 10));
check('nikto nezačína vo svojej domovskej skupinke',
  deti.every((c) => c.current_group !== c.home_group));
check('každý štartuje aspoň 2 skupiny od domova (min_start_distance)',
  deti.every((c) => (c.home_group - c.current_group + 10) % 10 >= 2));

const velkosti = {};
for (const c of deti) velkosti[c.current_group] = (velkosti[c.current_group] || 0) + 1;
check('skupiny sú rovnako veľké (10× 10 detí)',
  Object.keys(velkosti).length === 10 && Object.values(velkosti).every((n) => n === 10),
  JSON.stringify(velkosti));

// Najväčšia vzdialenosť určuje, koľko kôl treba — musí sa zmestiť do max_rounds.
// Práve preto nie je potrebná poistka „rovno domov", ktorú manuál nepozná.
const najdalej = Math.max(...deti.map((c) => (c.home_group - c.current_group + 10) % 10));
check('najvzdialenejšie dieťa stihne domov v rámci 10 kôl bez poistky',
  najdalej <= game.getSettings().max_rounds, `najväčšia vzdialenosť ${najdalej}`);

// A naozaj to dohrajme — bez force_home_round.
game.saveSettings({ force_home_round: 0, bait: { mode: 'fixed', delay_rounds: 1, random_min: 0, random_max: 2 } });
game.startGame();
let guard = 0;
while (game.getState().status === 'running' && guard++ < 15) game.simulateRound();
check('hra dohrá a všetky deti sú doma (bez poistky „rovno domov")',
  game.getState().status === 'finished'
  && game.getChildren().every((c) => c.current_group === c.home_group));

// --- Reset ruší rozdelenie ---------------------------------------------------
game.resetGame();
check('reset zmaže údaje o rozdelení (inak by sa dal vytlačiť neplatný rozpis)',
  game.getDistribution() == null, JSON.stringify(game.getDistribution()));

fs.rmSync(process.env.LPT2_DATA_DIR, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : '\nROZDELENIE OK');
process.exit(failures ? 1 : 0);
