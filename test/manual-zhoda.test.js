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

console.log('\n--- 3. Štartové rozostavenie — VEDOMÁ odchýlka od manuálu ----------');

// Harmonogram na strane 4 a pravidlo „dieťa ide o skupinku vyššie" si
// protirečia a nedá sa mať oboje:
//
// V rozostavení z manuálu je skupina g+1 o jedno stanovište POZADU za skupinou
// g, takže príde presne tam, kde presunuté dieťa už stojí. Dieťa síce mení
// skupinku každé kolo, ale stanovište NIKDY — odohralo by tú istú aktivitu
// všetkých 10 kôl. Pri posune o +1 sa tomu vyhnúť nedá: 10 skupín obsadzuje
// 10 stanovíšť a všetky sa posúvajú naraz.
//
// Rozhodnutie: prednosť má to, aby sa dieťa posúvalo. Skupiny sú preto
// rozostavané po poradí kruhu (sk.1 → A, sk.2 → B, sk.3 → D …).
// Tabuľka na strane 4 tým prestáva platiť — animátori idú podľa /rozpis.html.
for (let g = 1; g <= 10; g++) {
  const ocakavane = MANUAL_KRUH[(g - 1) % 10];
  check(`skupina ${g} štartuje na ${ocakavane} (o stanovište vpred pred sk. ${g - 1 || 10})`,
    S.group_start_station[g] === ocakavane, `appka má: ${S.group_start_station[g]}`);
}
check('rozostavenie sa naozaj líši od harmonogramu na strane 4 (vedome)',
  MANUAL_HARMONOGRAM[0].some((m, i) => miestoNaPismeno[normalizujMiesto(m)] !== S.group_start_station[i + 1]));

console.log('\n--- 4. Harmonogram appky musí byť rozumný --------------------------');

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

// Aj keď sa rozostavenie od manuálu líši, tieto dve veci platiť MUSIA:
// na jednom stanovišti nesmú byť dve skupiny naraz a každá skupina musí
// za 10 kôl prejsť všetkých 10 stanovíšť.
let kolizii = 0;
for (const kolo of tabKod) if (new Set(kolo).size !== kolo.length) kolizii++;
check('v žiadnom kole nie sú dve skupiny na tom istom stanovišti', kolizii === 0,
  `kôl s kolíziou: ${kolizii}`);

let neuplne = 0;
for (let g = 0; g < 10; g++) {
  const navstivene = new Set(tabKod.map((kolo) => kolo[g]));
  if (navstivene.size !== 10) neuplne++;
}
check('každá skupina prejde za 10 kôl všetkých 10 stanovíšť', neuplne === 0,
  `skupín s neúplnou trasou: ${neuplne}`);

console.log('\n--- 5. Presunuté dieťa sa MUSÍ posunúť ---------------------------');

// Toto je dôvod celej odchýlky vyššie. Dieťa, ktoré do skupinky nepatrí,
// putuje o skupinku vyššie každé kolo — a pri každom takom presune sa musí
// dostať na INÉ stanovište, inak by hralo tú istú aktivitu dokola.
function trasaDietata(tab, startSkupina) {
  const trasa = [];
  let g = startSkupina;
  for (let kolo = 0; kolo < tab.length; kolo++) {
    trasa.push(tab[kolo][g - 1]);
    g = (g % 10) + 1; // presun o skupinku vyššie
  }
  return trasa;
}

let stojace = 0;
for (let start = 1; start <= 10; start++) {
  const trasa = trasaDietata(tabKod, start);
  for (let i = 1; i < trasa.length; i++) if (trasa[i] === trasa[i - 1]) stojace++;
}
check('dieťa nikdy neostane dve kolá po sebe na tom istom stanovišti', stojace === 0,
  `prípadov státia: ${stojace}`);

const ukazkaTrasy = trasaDietata(tabKod, 2);
check('dieťa zažije viac než jednu aktivitu', new Set(ukazkaTrasy).size > 1,
  `trasa: ${ukazkaTrasy.join(' → ')}`);
console.log(`  info: dieťa štartujúce v sk.2 prejde: ${ukazkaTrasy.join(' → ')} `
  + `(${new Set(ukazkaTrasy).size} rôznych stanovíšť)`);

// Pre porovnanie: v rozostavení z manuálu by stálo na jednom mieste celú hru.
const podlaManualu = { ...S, group_start_station: MANUAL_START };
const trasaManual = trasaDietata(harmonogramAppky(podlaManualu), 2);
check('(dôkaz) v rozostavení z manuálu by dieťa stálo na jednom stanovišti',
  new Set(trasaManual).size === 1, `trasa: ${trasaManual.join(' → ')}`);

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
