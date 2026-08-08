// Zhoda hernej logiky s MANUÁLOM LPT2 2026 — spusti: node test/manual-zhoda.test.js
//
// Tento test NIE JE o tom, či kód robí to, čo si myslí, že robí (to overujú
// ostatné testy). Je o tom, či to, čo robí, zodpovedá MANUÁLU — teda tomu, čo
// budú animátori v nedeľu naozaj robiť v areáli.
//
// Zdroj pravdy je manuál, sekcia DOOBEDIE:
//
//   „Na začiatku aktivity sa deti rozdelia do 10-tich skupín podľa čísel na
//    náramkoch.“
//   „animátor naskenuje QR kódy (po každej aktivite, všetkým deťom!) a každé
//    dieťa čo do danej skupinky nepatrí bude poslané do nasledujúcej skupinky
//    (o číslo vyššej) a zároveň každá skupinka sa posunie o stanovište ďalej.“
//   „MTZkar so skupčou zoberie dieťa, ktoré tam nepatrí a posúva sa aj on do
//    ďalšej skupiny.“
//   „Aktivita prebieha až pokým sa skupinky nerozdelia (absolvujú všetkých 10
//    stanovíšť).“
//   „STANOVIŠTIA IDÚ DO KRUHU PO AREÁLI.“
//
// Plus tabuľka časového harmonogramu (strana 4), ktorá je najtvrdší zdroj —
// hovorí presne, ktorá skupina je o 9:15 kde a kam sa posúva.

process.env.LPT2_DATA_DIR = require('path').join(__dirname, 'tmp-manual');
const fs = require('fs');
fs.rmSync(process.env.LPT2_DATA_DIR, { recursive: true, force: true });

const game = require('../lib/game');

let failures = 0;
const nalezy = [];
function check(label, cond, detail) {
  if (cond) { console.log('  ok  ' + label); return true; }
  console.error('  NEZHODA  ' + label + (detail ? '\n           ' + detail : ''));
  nalezy.push({ label, detail });
  failures++;
  return false;
}

// ---------------------------------------------------------------------------
// Manuál ako dáta
// ---------------------------------------------------------------------------

// Stanovištia zo strany 2–3 manuálu: písmeno = aktivita = miesto.
const MANUAL_STANOVISTIA = [
  { letter: 'A', name: 'Vymenia sa všetci tí', place: 'zasadačka' },
  { letter: 'B', name: 'Signál', place: 'záhrada' },
  { letter: 'C', name: 'Duangango', place: 'pri Panne Márii' },
  { letter: 'D', name: 'Toaleťák', place: 'mantinely' },
  { letter: 'E', name: 'Zoradenie', place: 'pred skautskou' },
  { letter: 'F', name: 'Telefón', place: 'obývačka' },
  { letter: 'G', name: 'Pantomíma', place: 'tanečná' },
  { letter: 'H', name: 'Kreslenie', place: 'oľga' },
  { letter: 'I', name: 'Hádaj na čo myslím', place: 'čajovňa' },
  { letter: 'J', name: 'Rómeo a Júlia', place: 'sála' },
];

// Harmonogram zo strany 4 manuálu: riadok = kolo, stĺpec = skupina 1..10.
// Prepísané doslovne, vrátane poradia stĺpcov.
const MANUAL_HARMONOGRAM = [
  ['zasadačka', 'sála', 'čajovňa', 'oľga', 'tanečná', 'obývačka', 'skautská', 'Panna Mária', 'mantinely', 'záhrada'],
  ['záhrada', 'zasadačka', 'sála', 'čajovňa', 'oľga', 'tanečná', 'obývačka', 'skautská', 'Panna Mária', 'mantinely'],
  ['mantinely', 'záhrada', 'zasadačka', 'sála', 'čajovňa', 'oľga', 'tanečná', 'obývačka', 'skautská', 'Panna Mária'],
  ['Panna Mária', 'mantinely', 'záhrada', 'zasadačka', 'sála', 'čajovňa', 'oľga', 'tanečná', 'obývačka', 'skautská'],
  ['skautská', 'Panna Mária', 'mantinely', 'záhrada', 'zasadačka', 'sála', 'čajovňa', 'oľga', 'tanečná', 'obývačka'],
  ['obývačka', 'skautská', 'Panna Mária', 'mantinely', 'záhrada', 'zasadačka', 'sála', 'čajovňa', 'oľga', 'tanečná'],
  ['tanečná', 'obývačka', 'skautská', 'Panna Mária', 'mantinely', 'záhrada', 'zasadačka', 'sála', 'čajovňa', 'oľga'],
  ['oľga', 'tanečná', 'obývačka', 'skautská', 'Panna Mária', 'mantinely', 'záhrada', 'zasadačka', 'sála', 'čajovňa'],
  ['čajovňa', 'oľga', 'tanečná', 'obývačka', 'skautská', 'Panna Mária', 'mantinely', 'záhrada', 'zasadačka', 'sála'],
  ['sála', 'čajovňa', 'oľga', 'tanečná', 'obývačka', 'skautská', 'Panna Mária', 'mantinely', 'záhrada', 'zasadačka'],
];

// Názvy miest v harmonograme sú skratky — zjednotíme ich s názvami stanovíšť.
function normalizujMiesto(m) {
  const s = String(m).toLowerCase().trim();
  if (s.startsWith('panna')) return 'pri panne márii';
  if (s.startsWith('skautsk')) return 'pred skautskou';
  return s;
}
const miestoNaPismeno = {};
for (const st of MANUAL_STANOVISTIA) miestoNaPismeno[normalizujMiesto(st.place)] = st.letter;

// Poradie stanovíšť po kruhu — odvodené z harmonogramu (cesta skupiny 1).
const MANUAL_KRUH = MANUAL_HARMONOGRAM.map((r) => miestoNaPismeno[normalizujMiesto(r[0])]);
// Štartové rozostavenie — prvý riadok harmonogramu.
const MANUAL_START = {};
MANUAL_HARMONOGRAM[0].forEach((m, i) => { MANUAL_START[i + 1] = miestoNaPismeno[normalizujMiesto(m)]; });

// ---------------------------------------------------------------------------

const S = game.defaultSettings();
console.log('\n--- 1. Stanovištia: písmeno = aktivita = miesto -----------------------');

for (const m of MANUAL_STANOVISTIA) {
  const kod = S.stations.find((s) => s.letter === m.letter);
  const zhodaMiesta = kod && normalizujMiesto(kod.place) === normalizujMiesto(m.place);
  const zhodaNazvu = kod && kod.name.toLowerCase() === m.name.toLowerCase();
  check(`stanovište ${m.letter} = ${m.name} (${m.place})`,
    zhodaMiesta && zhodaNazvu,
    kod ? `appka má: ${m.letter} = ${kod.name} (${kod.place})` : 'v appke chýba');
}

console.log('\n--- 2. Poradie rotácie po kruhu (z harmonogramu) ----------------------');

// Ako rotuje appka: nextStation ide po poli stations dokola.
const KOD_KRUH = S.stations.map((s) => s.letter);
check('poradie stanovíšť v rotácii zodpovedá kruhu po areáli',
  KOD_KRUH.join(',') === MANUAL_KRUH.join(','),
  `manuál: ${MANUAL_KRUH.join(' → ')}\n           appka:  ${KOD_KRUH.join(' → ')}`);

// To isté vyjadrené miestami — to je to, čo animátor reálne vidí.
const kruhMiestManual = MANUAL_KRUH.map((l) => MANUAL_STANOVISTIA.find((s) => s.letter === l).place);
const kruhMiestKod = S.stations.map((s) => s.place);
check('poradie MIEST v rotácii zodpovedá kruhu po areáli',
  kruhMiestManual.map(normalizujMiesto).join(',') === kruhMiestKod.map(normalizujMiesto).join(','),
  `manuál: ${kruhMiestManual.join(' → ')}\n           appka:  ${kruhMiestKod.join(' → ')}`);

console.log('\n--- 3. Štartové rozostavenie skupín -----------------------------------');

for (let g = 1; g <= 10; g++) {
  const kod = S.group_start_station[g];
  check(`skupina ${g} štartuje na ${MANUAL_START[g]} (${MANUAL_HARMONOGRAM[0][g - 1]})`,
    kod === MANUAL_START[g],
    `appka má: ${kod}`);
}

console.log('\n--- 4. Celý harmonogram: kolo × skupina -------------------------------');

// Odsimulujeme len pohyb stanovíšť (deti naň nemajú vplyv) a porovnáme
// s tabuľkou z manuálu.
function harmonogramAppky(settings) {
  const poradie = settings.stations.map((s) => s.letter);
  const tab = [];
  const teraz = {};
  for (let g = 1; g <= settings.num_groups; g++) teraz[g] = settings.group_start_station[g];
  for (let kolo = 1; kolo <= settings.max_rounds; kolo++) {
    tab.push(Array.from({ length: settings.num_groups }, (_, i) => teraz[i + 1]));
    for (let g = 1; g <= settings.num_groups; g++) {
      teraz[g] = poradie[(poradie.indexOf(teraz[g]) + 1) % poradie.length];
    }
  }
  return tab;
}

const tabKod = harmonogramAppky(S);
const tabManual = MANUAL_HARMONOGRAM.map((r) => r.map((m) => miestoNaPismeno[normalizujMiesto(m)]));
let nesedi = 0;
const ukazky = [];
for (let k = 0; k < 10; k++) {
  for (let g = 0; g < 10; g++) {
    if (tabKod[k][g] !== tabManual[k][g]) {
      nesedi++;
      if (ukazky.length < 4) {
        ukazky.push(`kolo ${k + 1}, sk.${g + 1}: manuál ${tabManual[k][g]}, appka ${tabKod[k][g]}`);
      }
    }
  }
}
check('celý harmonogram (100 políčok) sedí s manuálom', nesedi === 0,
  `nesedí ${nesedi} zo 100 · napr. ${ukazky.join(' · ')}`);

console.log('\n--- 5. Kľúčový dôsledok: presunuté dieťa nemá kam chodiť --------------');

// Manuál: dieťa, ktoré do skupinky nepatrí, ide „do nasledujúcej skupinky".
// V harmonograme to funguje preto, že skupina g+1 príde PRESNE tam, kde bola
// skupina g — dieťa teda ostáva fyzicky stáť a počká na ďalšiu skupinu.
// Overíme to najprv na manuáli (musí platiť), potom na appke.
function dietaOstavaStat(tab, numGroups) {
  const chyby = [];
  for (let k = 0; k + 1 < tab.length; k++) {
    for (let g = 1; g <= numGroups; g++) {
      const dalsia = (g % numGroups) + 1;
      if (tab[k][g - 1] !== tab[k + 1][dalsia - 1]) {
        chyby.push(`kolo ${k + 1}: sk.${g} je na ${tab[k][g - 1]}, ale sk.${dalsia} príde v ďalšom kole na ${tab[k + 1][dalsia - 1]}`);
      }
    }
  }
  return chyby;
}

const chybyManual = dietaOstavaStat(tabManual, 10);
check('(kontrola samotného manuálu) skupina g+1 prichádza tam, kde bola skupina g',
  chybyManual.length === 0, chybyManual.slice(0, 2).join(' · '));

const chybyKod = dietaOstavaStat(tabKod, 10);
check('appka: presunuté dieťa ostáva stáť a počká na ďalšiu skupinu',
  chybyKod.length === 0,
  `porušené ${chybyKod.length}× · napr. ${chybyKod.slice(0, 2).join(' · ')}`);

console.log('\n--- 6. Pravidlo presunu: nesúhlasiace dieťa ide o skupinu vyššie ------');

const rows = [];
for (let i = 1; i <= 100; i++) rows.push({ name: `Dieťa ${i}`, home_group: ((i - 1) % 10) + 1, wristband_number: i });
game.importChildren(rows);
game.distributeChildren('wristband');
game.startGame();

const st1 = game.getState();
const pokus = game.getChildren().find((c) => c.current_group !== c.home_group);
const predSkupina = pokus.current_group;
const r1 = game.processScan(pokus.qr_code, predSkupina, st1.groups[predSkupina].station);
check('nesúhlasiace dieťa sa presunie hneď pri prvom skene (bez zdržania)',
  r1.result === 'move', `výsledok: ${r1.result}`);
check('presúva sa presne o +1 skupinu (s prechodom 10 → 1)',
  r1.moved_to === (predSkupina % 10) + 1,
  `z ${predSkupina} do ${r1.moved_to}`);

const domace = game.getChildren().find((c) => c.current_group === c.home_group);
if (domace) {
  const r2 = game.processScan(domace.qr_code, domace.current_group, st1.groups[domace.current_group].station);
  check('dieťa vo svojej skupinke ostáva', r2.result === 'home', `výsledok: ${r2.result}`);
}

console.log('\n--- 7. Východiskové nastavenia vs. manuál -----------------------------');

check('počet skupín = 10', S.num_groups === 10, `appka: ${S.num_groups}`);
check('počet kôl = 10 (všetkých 10 stanovíšť)', S.max_rounds === 10, `appka: ${S.max_rounds}`);
check('bait (zdržanie dieťaťa) je vypnuté — manuál žiadne nepozná',
  S.bait.mode === 'fixed' && S.bait.delay_rounds <= 1,
  `appka: mode=${S.bait.mode}, delay_rounds=${S.bait.delay_rounds}`);
check('poistka „rovno domov" je vypnutá — manuál pozná len posun o +1',
  !S.force_home_round,
  `appka: force_home_round=${S.force_home_round} (od tohto kola ide dieťa rovno domov, `
  + 'nie o skupinu vyššie — animátor by ho musel viesť cez celý areál)');

console.log('\n--- 8. Uložené nastavenia prekrývajú defaulty --------------------------');

// Toto je zradné miesto: getSettings() prekrýva defaulty tým, čo je ULOŽENÉ.
// Oprava defaultov sa teda na nasadenie, ktoré už raz nastavenia uložilo,
// vôbec nedostane — a nikto si to nevšimne, kým nie sú animátori v areáli.
// Preto sa rozdiel musí hlásiť a musí sa dať jedným krokom zrovnať.
check('čerstvé nastavenia sedia s manuálom', game.manualCheck().ok === true,
  JSON.stringify(game.manualCheck().rozdiely));

// Napodobníme staré uložené nastavenia (presne tie, ktoré boli v appke).
game.saveSettings({
  force_home_round: 8,
  group_start_station: Object.fromEntries(
    Array.from({ length: 10 }, (_, i) => [i + 1, 'ABCDEFGHIJ'[i]]),
  ),
  stations: 'ABCDEFGHIJ'.split('').map((l) => ({ letter: l, name: 'x', place: 'y' })),
});
const zle = game.manualCheck();
check('staré uložené nastavenia sa rozpoznajú ako nezhoda', zle.ok === false);
check('nezhoda vymenuje stanovištia aj poistku',
  zle.rozdiely.some((x) => /stanovištia/.test(x)) && zle.rozdiely.some((x) => /rovno domov/.test(x)),
  JSON.stringify(zle.rozdiely));

// Zrovnanie s manuálom nesmie zmazať to, čo manuál nepredpisuje.
game.saveSettings({ max_group_size: 11, min_start_distance: 2, max_rounds: 10 });
game.resetManualSettings();
const po = game.getSettings();
check('zrovnanie s manuálom odstráni všetky nezhody', game.manualCheck().ok === true,
  JSON.stringify(game.manualCheck().rozdiely));
check('zrovnanie nechá nastavenia, ktoré manuál nepredpisuje',
  po.max_group_size === 11 && po.min_start_distance === 2 && po.max_rounds === 10,
  `max_group_size=${po.max_group_size} min_start_distance=${po.min_start_distance} max_rounds=${po.max_rounds}`);
check('po zrovnaní sedí aj rotácia', po.stations.map((s) => s.letter).join('') === MANUAL_KRUH.join(''),
  po.stations.map((s) => s.letter).join(''));

// ---------------------------------------------------------------------------
fs.rmSync(process.env.LPT2_DATA_DIR, { recursive: true, force: true });
console.log('\n' + '='.repeat(72));
if (failures) {
  console.log(`NÁLEZY: ${failures} nezhôd s manuálom\n`);
  nalezy.forEach((n, i) => console.log(`${i + 1}. ${n.label}`));
} else {
  console.log('ZHODA S MANUÁLOM ÚPLNÁ');
}
process.exit(failures ? 1 : 0);
