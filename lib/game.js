// Herná logika rozdeľovacej hry (LPT2, doobedie).
//
// Pravidlá (podľa manuálu + zadania):
// - 10 skupín, 10 stanovíšť v kruhu (A→B→...→J→A).
// - Po icebreakri animátor naskenuje QR všetkých detí v skupine.
// - Zhoda home_group == aktuálna skupina  -> dieťa ostáva, counter sa nuluje.
// - Nezhoda -> counter rounds_in_wrong_group++ ; kým je counter POD prahom
//   (bait_delay), dieťa ostáva ako "bait"; po DOSIAHNUTÍ prahu sa presunie
//   do nasledujúcej skupiny (číslo +1, wrap) a counter sa nuluje.
//   POZN.: pri tejto sémantike (increment -> porovnaj) sa prah 0 a 1 správajú
//   rovnako (presun hneď pri prvom nesúhlasnom skene); prah 2 = dieťa ostane
//   1 kolo navyše. Presné pravidlo sa dá doladiť v computeBaitDelay().
// - Po skenovaní sa celá skupina posunie na ďalšie stanovište
//   (tlačidlo "Ukončiť kolo pre túto skupinu").
const store = require('./store');
const nahoda = require('./seed');

// ---------------------------------------------------------------------------
// Načítanie / defaulty
// ---------------------------------------------------------------------------

function defaultSettings() {
  // Stanovištia podľa MANUÁL LPT2 2026 (doobedie, rozdeľovacia hra).
  //
  // POZOR na poradie poľa: NIE JE abecedné podľa písmen, ale kopíruje FYZICKÝ
  // KRUH PO AREÁLI („STANOVIŠTIA IDÚ DO KRUHU PO AREÁLI“). Písmená sú len
  // menovky aktivít; rotácia ide po tomto poli (viď nextStation), takže poradie
  // poľa musí sedieť s harmonogramom na strane 4 manuálu:
  //
  //   zasadačka → záhrada → mantinely → Panna Mária → pred skautskou →
  //   obývačka → tanečná → oľga → čajovňa → sála → (späť na zasadačku)
  //
  // Preto je D pred C — v manuáli to tak naozaj je.
  const stations = [
    { letter: 'A', name: 'Vymenia sa všetci tí', place: 'zasadačka' },
    { letter: 'B', name: 'Signál', place: 'záhrada' },
    { letter: 'D', name: 'Toaleťák', place: 'mantinely' },
    { letter: 'C', name: 'Duangango', place: 'pri Panne Márii' },
    { letter: 'E', name: 'Zoradenie', place: 'pred skautskou' },
    { letter: 'F', name: 'Telefón', place: 'obývačka' },
    { letter: 'G', name: 'Pantomíma', place: 'tanečná' },
    { letter: 'H', name: 'Kreslenie', place: 'oľga' },
    { letter: 'I', name: 'Hádaj na čo myslím', place: 'čajovňa' },
    { letter: 'J', name: 'Rómeo a Júlia', place: 'sála' },
  ];
  // Štartové rozostavenie: skupina g+1 je o jedno stanovište VPRED pred
  // skupinou g (sk.1 → A, sk.2 → B, sk.3 → D … čiže po poradí kruhu).
  //
  // POZOR — toto je VEDOMÁ odchýlka od harmonogramu na strane 4 manuálu.
  // Dôvod: harmonogram a pravidlo „dieťa ide o skupinku vyššie" si protirečia.
  // V rozostavení z manuálu je skupina g+1 o stanovište POZADU, takže príde
  // presne tam, kde dieťa už stojí — dieťa síce mení skupinku každé kolo, ale
  // stanovište nikdy. Odohralo by tú istú aktivitu všetkých 10 kôl.
  //
  // Matematicky sa tomu pri posune o +1 vyhnúť nedá: 10 skupín obsadzuje 10
  // stanovíšť a všetky sa posúvajú naraz, takže poloha dieťaťa je určená
  // rozostavením. Buď platí tabuľka zo strany 4, alebo sa dieťa posúva —
  // nie oboje. Rozhodnutie padlo na to druhé: dieťa sa každé kolo posunie
  // o dve stanovištia dopredu a zažije 5 rôznych aktivít namiesto jednej.
  //
  // Dôsledok: tabuľka na strane 4 manuálu neplatí, animátori idú podľa
  // rozpisu z appky (/rozpis.html).
  const group_start_station = {};
  for (let g = 1; g <= 10; g++) {
    group_start_station[g] = stations[(g - 1) % stations.length].letter;
  }
  return {
    num_groups: 10,
    max_rounds: 10,
    stations,
    group_start_station,
    // bait = zámerné zdržanie dieťaťa v nesprávnej skupine.
    // mode: 'fixed'  -> vždy delay_rounds
    //       'random' -> pri každom novom nesprávnom zaradení náhodne
    //                   z intervalu <random_min, random_max>
    bait: { mode: 'fixed', delay_rounds: 1, random_min: 0, random_max: 2 },
    // Logistická poistka: od tohto kola (vrátane) sa bait aj posun +1
    // ignorujú a nesúhlasiace dieťa ide pri skene ROVNO do svojej domovskej
    // skupinky. 0 = vypnuté, a vypnuté to má aj zostať:
    // manuál pozná VÝHRADNE posun o jednu skupinku vyššie, takže skok cez pol
    // areálu by animátor v teréne nezvládol. Zároveň nie je potrebná — pri
    // min_start_distance 2 je najväčšia vzdialenosť 9 skupín, teda 9 kôl z 10.
    force_home_round: 0,
    // Počiatočné rozdelenie: každé dieťa začne aspoň takto ďaleko od svojej
    // domovskej skupinky (vzdialenosť = počet presunov +1 potrebných domov).
    // 2 = žiadne dieťa nie je vo svojej skupinke počas 1. ani 2. kola
    // (domov dorazí najskôr na začiatok 3. kola). 0 = bez obmedzenia.
    min_start_distance: 2,
    // Strop na počet detí v jednej skupine. Vynucuje sa na DOMOVSKEJ skupine,
    // a to zámerne: veľkosti skupín počas hry kopírujú veľkosti domovských
    // skupín (viď distributeChildren), takže obmedziť sa dá len tam. Keby sa
    // strop kontroloval až pri rozdeľovaní, bolo by neskoro — počty sú vtedy
    // už dané tým, koľko detí má ktorú domovskú skupinu.
    // 0 = bez obmedzenia.
    max_group_size: 11,
  };
}

// Modulo, ktoré vždy vráti nezáporný výsledok. JS `%` pri zápornom čísle dáva
// záporné (-1 % 10 === -1), čo pri indexovaní poľa vedie na `undefined` a pád.
// Nastáva to, keď je skupín viac než stanovíšť — chybu ohlási preflight(),
// ale appka sa dovtedy nesmie zložiť.
function modulo(n, m) {
  return ((n % m) + m) % m;
}

function defaultState(settings) {
  const groups = {};
  for (let g = 1; g <= settings.num_groups; g++) {
    groups[g] = {
      // Fallback drží to isté pravidlo ako defaultSettings — skupina g+1 je
      // o stanovište vpred, aby sa presunuté dieťa vždy posunulo ďalej.
      station: settings.group_start_station[g]
        || settings.stations[modulo(g - 1, settings.stations.length)].letter,
      finished_round: 0, // posledné kolo, ktoré skupina ukončila
    };
  }
  return {
    status: 'not_started', // not_started | running | paused | finished
    current_round: 0,
    groups,
    scans: [], // log všetkých skenov: {child_id, name, round, station, group, result, moved_to, ts}
  };
}

function getSettings() {
  // Merge s defaultmi: keď pribudne nové nastavenie, staršie settings.json
  // bez neho dostane rozumnú východziu hodnotu.
  const stored = store.load('settings', null);
  return stored ? { ...defaultSettings(), ...stored } : defaultSettings();
}
function getState() {
  return store.load('state', null) || defaultState(getSettings());
}
function getChildren() {
  return store.load('children', []);
}

// ---------------------------------------------------------------------------
// Pomocné funkcie
// ---------------------------------------------------------------------------

function stationIndex(settings, letter) {
  return settings.stations.findIndex((s) => s.letter === letter);
}

function nextStation(settings, letter) {
  const i = stationIndex(settings, letter);
  return settings.stations[(i + 1) % settings.stations.length].letter;
}

function nextGroup(settings, g) {
  return (g % settings.num_groups) + 1;
}

// Prahová hodnota bait zdržania pre dieťa, ktoré PRÁVE vstúpilo do nesprávnej
// skupiny. Jasne oddelená funkcia — presné pravidlo (fixné vs. náhodné)
// sa ladí tu alebo v settings.bait.
function computeBaitDelay(settings) {
  const b = settings.bait || { mode: 'fixed', delay_rounds: 1 };
  if (b.mode === 'random') {
    const min = Number.isInteger(b.random_min) ? b.random_min : 0;
    const max = Number.isInteger(b.random_max) ? b.random_max : 2;
    return min + Math.floor(Math.random() * (max - min + 1));
  }
  return Number.isInteger(b.delay_rounds) ? b.delay_rounds : 1;
}

// Koľko kôl trvá JEDEN posun o skupinu. Pri bait prahu b ostane dieťa b-1 kôl
// ako bait a až potom sa posunie, čiže jeden posun = b kôl. Prah 0 aj 1
// znamenajú posun hneď pri prvom skene, teda 1 kolo.
// Pri náhodnom prahu rátame s najhorším možným prípadom — rozdelenie musí
// vyjsť vždy, nielen keď sa pošťastí.
function kolNaJedenPosun(settings) {
  const b = settings.bait || {};
  return b.mode === 'random'
    ? Math.max(1, parseInt(b.random_max, 10) || 0)
    : Math.max(1, parseInt(b.delay_rounds, 10) || 1);
}

// Najväčšia vzdialenosť od domova, ktorú dieťa ešte STIHNE prejsť za daný
// počet kôl. Toto je strop, podľa ktorého sa rozdeľuje — počet kôl je pevne
// daný harmonogramom, takže sa mu musí prispôsobiť rozdelenie, nie naopak.
function maxVzdialenostDoKonca(settings) {
  const kol = Math.max(0, parseInt(settings.max_rounds, 10) || 0);
  return Math.floor(kol / kolNaJedenPosun(settings));
}

function childHistoryEntry(round, station, action, fromGroup, toGroup) {
  return { round, station, action, from_group: fromGroup, to_group: toGroup, ts: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Deti: pridávanie, import, override
// ---------------------------------------------------------------------------

function nextChildId(children) {
  let max = 0;
  for (const c of children) {
    const m = /^D(\d+)$/.exec(c.id);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return 'D' + String(max + 1).padStart(3, '0');
}

// Jediné miesto, kadiaľ vchádzajú deti do systému. Sem sa neskôr napojí
// Excel import — stačí rozparsovať xlsx na riadky
// [{name, home_group, wristband_number?, qr_code?}] a zavolať túto funkciu.
// Strop na veľkosť skupiny; Infinity keď je vypnutý (0).
function stropSkupiny(settings) {
  const n = parseInt(settings.max_group_size, 10);
  return n > 0 ? n : Infinity;
}

// Koľko detí má práve teraz ktorá domovská skupina.
function poctyVDomovskych(children, numGroups) {
  const pocty = {};
  for (let g = 1; g <= numGroups; g++) pocty[g] = 0;
  for (const c of children) if (pocty[c.home_group] !== undefined) pocty[c.home_group]++;
  return pocty;
}

function importChildren(rows) {
  const settings = getSettings();
  const children = getChildren();
  const created = [];
  const errors = [];
  const strop = stropSkupiny(settings);
  // Počty sa priebežne zvyšujú, takže strop platí aj v rámci JEDNÉHO importu —
  // inak by sa dal obísť nahratím celej skupiny naraz.
  const pocty = poctyVDomovskych(children, settings.num_groups);

  for (const [i, row] of rows.entries()) {
    const name = (row.name || '').trim();
    const home = parseInt(row.home_group, 10);
    if (!name) { errors.push(`riadok ${i + 1}: chýba meno`); continue; }
    if (!(home >= 1 && home <= settings.num_groups)) {
      errors.push(`riadok ${i + 1} (${name}): neplatná home_group "${row.home_group}"`);
      continue;
    }
    if (pocty[home] >= strop) {
      errors.push(`riadok ${i + 1} (${name}): domovská skupina ${home} je plná `
        + `(${pocty[home]}/${strop} detí)`);
      continue;
    }
    const id = row.id || nextChildId(children);
    const qr = (row.qr_code || '').trim() || id;
    if (children.some((c) => c.qr_code === qr || c.id === id)) {
      errors.push(`riadok ${i + 1} (${name}): duplicitné ID/QR "${qr}"`);
      continue;
    }
    let wristband = parseInt(row.wristband_number, 10);
    if (!Number.isInteger(wristband)) {
      wristband = children.reduce((m, c) => Math.max(m, c.wristband_number || 0), 0) + 1;
    }
    const child = {
      id,
      name,
      wristband_number: wristband,
      qr_code: qr,
      home_group: home,
      current_group: null, // priradí sa pri rozdelení / štarte hry
      rounds_in_wrong_group: 0,
      bait_delay: null, // prah zdržania pridelený pri vstupe do nesprávnej skupiny
      history: [],
    };
    children.push(child);
    created.push(child);
    pocty[home]++;
  }
  store.save('children', children);
  return { created, errors };
}

function updateChild(id, patch) {
  const children = getChildren();
  const child = children.find((c) => c.id === id);
  if (!child) return { error: 'Dieťa nenájdené' };
  const state = getState();
  const settings = getSettings();

  // Manuálny override skupiny (admin) — reset countera, zápis do histórie.
  if (patch.current_group !== undefined && patch.current_group !== child.current_group) {
    const to = patch.current_group === null ? null : parseInt(patch.current_group, 10);
    if (to !== null && !(to >= 1 && to <= settings.num_groups)) return { error: 'Neplatná skupina' };
    child.history.push(childHistoryEntry(
      state.current_round,
      to !== null && state.groups[to] ? state.groups[to].station : null,
      'manual',
      child.current_group,
      to
    ));
    child.current_group = to;
    child.rounds_in_wrong_group = 0;
    child.bait_delay = null;
  }
  // Zmena domovskej skupiny mení veľkosti skupín počas celej hry, takže sa
  // na ňu vzťahuje ten istý strop ako na import.
  if (patch.home_group !== undefined) {
    const nova = parseInt(patch.home_group, 10);
    if (!(nova >= 1 && nova <= settings.num_groups)) return { error: 'Neplatná domovská skupina' };
    if (nova !== child.home_group) {
      const strop = stropSkupiny(settings);
      const pocet = poctyVDomovskych(children, settings.num_groups)[nova];
      if (pocet >= strop) {
        return { error: `Domovská skupina ${nova} je plná (${pocet}/${strop} detí)` };
      }
    }
  }

  for (const key of ['name', 'home_group', 'wristband_number', 'qr_code']) {
    if (patch[key] !== undefined) child[key] = key === 'name' || key === 'qr_code' ? patch[key] : parseInt(patch[key], 10);
  }
  store.save('children', children);
  return { child };
}

function deleteChild(id) {
  const children = getChildren();
  const i = children.findIndex((c) => c.id === id);
  if (i === -1) return { error: 'Dieťa nenájdené' };
  children.splice(i, 1);
  store.save('children', children);
  return { ok: true };
}

// Rozdelenie detí do skupín pred štartom hry.
//
// KĽÚČOVÁ VLASTNOSŤ: veľkosti skupín ostávajú počas celej hry konštantné.
// Keďže dieťa sa vždy posúva len o +1 skupinu, veľkosť skupiny sa nemení
// práve vtedy, keď z nej v každom kole odíde presne toľko detí, koľko do nej
// príde z predchádzajúcej skupiny. To je splnené, keď má každá domovská
// skupina rovnaký "profil" počiatočných vzdialeností — teda rovnako veľa
// svojich detí štartuje 2 skupiny od domova, rovnako veľa 3 skupiny atď.
// Preto sa vzdialenosti prideľujú cyklicky v rámci každej domovskej skupiny,
// nie náhodne na skupiny.
//
// mode 'wristband' = poradie podľa čísel náramkov (podľa manuálu; rozhoduje,
//                    ktoré dieťa dostane ktorú vzdialenosť)
// mode 'random'    = náhodné poradie detí
//
// min_start_distance obmedzuje povolené vzdialenosti (2 = nikto neštartuje
// doma ani sa domov nedostane počas 1. a 2. kola).
//
// Pozn.: veľkosti skupín kopírujú veľkosti domovských skupín — ak má 5
// domovských skupín 11 detí a 5 desať, budú aj skupiny počas hry 11/10
// (rovnako ako na konci hry). Úplne rovnaký počet vo všetkých skupinách je
// možný len vtedy, keď sú rovnako veľké aj domovské skupiny.
// `seed` je voliteľný. Keď sa nezadá, vyrobí sa nový a uloží — vďaka tomu sa
// dá to isté rozdelenie kedykoľvek presne zopakovať (zadaním toho istého seedu)
// a spätne overiť. Rozdelenie sa robí RAZ pred hrou, takže keď sa čokoľvek
// pokazí, seed je jediné, čo treba mať poznačené.
function distributeChildren(mode, seed) {
  const settings = getSettings();
  const children = getChildren();
  if (children.length === 0) return { error: 'Žiadne deti na rozdelenie' };

  const pouzitySeed = (seed && String(seed).trim()) || nahoda.novySeed();
  const nahodne = nahoda.generator(pouzitySeed);

  const list = [...children];
  if (mode === 'random') {
    nahoda.zamiesaj(list, nahodne);
  } else {
    list.sort((a, b) => (a.wristband_number || 0) - (b.wristband_number || 0));
  }
  const g = settings.num_groups;
  const minDist = Math.min(Math.max(settings.min_start_distance || 0, 0), g - 1);

  // Strop vzdialenosti sa dopočíta z počtu kôl: počet kôl je daný
  // harmonogramom (10 stanovíšť = 10 kôl), takže sa mu musí prispôsobiť
  // rozdelenie. Žiadne dieťa nedostane skupinu, z ktorej by to domov
  // nestihlo — hra tak vyjde už z konštrukcie, nie náhodou.
  //
  // Príklad: pri bait prahu 2 trvá jeden posun 2 kolá, takže za 10 kôl stihne
  // dieťa 5 posunov. Najväčšia štartová vzdialenosť je teda 5, nie 9.
  const kolNaPresun = kolNaJedenPosun(settings);
  const stropVzdialenosti = Math.min(g - 1, maxVzdialenostDoKonca(settings));

  if (stropVzdialenosti < 1) {
    return {
      error: `Jeden posun trvá ${kolNaPresun} kôl, ale hra má len ${settings.max_rounds} — `
        + 'nezmestí sa ani jeden posun. Zníž bait prah alebo zvýš počet kôl.',
    };
  }
  if (minDist > stropVzdialenosti) {
    return {
      error: `Min. vzdialenosť od domova je ${minDist}, na to treba ${minDist * kolNaPresun} kôl, `
        + `ale hra má ${settings.max_rounds}. Zníž min. vzdialenosť na ${stropVzdialenosti} `
        + (kolNaPresun > 1 ? 'alebo bait prah na 1.' : 'alebo zvýš počet kôl.'),
    };
  }

  // Povolené vzdialenosti od domovskej skupiny (počet presunov domov).
  const allowed = [];
  for (let d = minDist; d <= stropVzdialenosti; d++) allowed.push(d);
  // Posun cyklu: mení sa, ktoré vzdialenosti sú obsadené dvakrát, takže každá
  // hra vyzerá inak — profil ostáva rovnaký pre všetky domovské skupiny, takže
  // invariant rovnakých veľkostí platí naďalej.
  const offset = Math.floor(nahodne() * allowed.length);

  const poradieVDomovskej = {};
  for (const c of list) {
    const i = poradieVDomovskej[c.home_group] = (poradieVDomovskej[c.home_group] ?? -1) + 1;
    const d = allowed[(i + offset) % allowed.length];
    // Skupina vzdialená d presunov pred domovskou (skupiny sú 1..g).
    c.current_group = ((c.home_group - d - 1 + g) % g) + 1;
    c.rounds_in_wrong_group = 0;
    c.bait_delay = null;
  }
  store.save('children', children);

  const rozdelenie = {
    seed: pouzitySeed,
    mode: mode === 'random' ? 'random' : 'wristband',
    min_start_distance: minDist,
    // Podľa čoho sa strop dopočítal — nech je spätne vidno, prečo deti
    // štartujú práve takto ďaleko.
    max_start_distance: stropVzdialenosti,
    kol_na_presun: kolNaPresun,
    max_rounds: settings.max_rounds,
    num_groups: g,
    pocet_deti: children.length,
    created_at: new Date().toISOString(),
  };
  store.save('distribution', rozdelenie);

  return { ok: true, distribution: rozdelenie, ...homeGroupBalance() };
}

// Údaje o poslednom rozdelení (seed, režim, čas) — pre tlačový rozpis
// a pre spätné overenie. null, kým sa nerozdeľovalo.
function getDistribution() {
  return store.load('distribution', null);
}

// Porovnanie ULOŽENÝCH nastavení s manuálom.
//
// Prečo to treba: getSettings() prekrýva defaulty tým, čo je uložené. Keď sa
// teda opravia defaulty (stanovištia, rozostavenie), nasadenie, ktoré už má
// nastavenia uložené, ostane na starých hodnotách a nikto si to nevšimne.
// Preto sa rozdiel hlási v Nastaveniach a dá sa jedným klikom zrovnať.
function manualCheck() {
  const s = getSettings();
  const d = defaultSettings();
  const rozdiely = [];

  const kluc = (st) => `${st.letter}|${String(st.name).trim().toLowerCase()}|${String(st.place).trim().toLowerCase()}`;
  const teraz = (s.stations || []).map(kluc).join(' → ');
  const podlaManualu = d.stations.map(kluc).join(' → ');
  if (teraz !== podlaManualu) {
    rozdiely.push('stanovištia alebo ich poradie v rotácii nesedia s manuálom');
  }

  for (let g = 1; g <= d.num_groups; g++) {
    if ((s.group_start_station || {})[g] !== d.group_start_station[g]) {
      rozdiely.push(`skupina ${g} má štartovať na ${d.group_start_station[g]}, `
        + `nastavené je ${(s.group_start_station || {})[g] || '—'}`);
    }
  }

  if (s.force_home_round) {
    rozdiely.push(`poistka „rovno domov" je zapnutá (od kola ${s.force_home_round}) — `
      + 'manuál pozná výhradne posun o jednu skupinku vyššie');
  }

  return { ok: rozdiely.length === 0, rozdiely };
}

// Prepíše nastavenia, ktoré určuje manuál, na hodnoty z manuálu. Ostatné
// (počet skupín, kôl, bait, min_start_distance, strop skupiny) ostávajú —
// tie sú na rozhodnutí vedúcich, manuál ich nepredpisuje.
function resetManualSettings() {
  const d = defaultSettings();
  return saveSettings({
    stations: d.stations,
    group_start_station: d.group_start_station,
    force_home_round: d.force_home_round,
  });
}

// Kontrola vyváženosti domovských skupín — veľkosti skupín počas hry ich
// kopírujú, takže nerovnaké domovské skupiny = nerovnaké skupiny v hre.
function homeGroupBalance() {
  const settings = getSettings();
  const counts = poctyVDomovskych(getChildren(), settings.num_groups);
  const values = Object.values(counts);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const strop = stropSkupiny(settings);
  // Skupiny nad stropom. Vzniknúť môžu, keď sa strop zníži až po importe —
  // vtedy sa deti nemažú, len sa to nahlási v Nastaveniach.
  const nadStrop = Object.keys(counts)
    .filter((g) => counts[g] > strop)
    .map(Number);
  return {
    home_counts: counts,
    home_min: min,
    home_max: max,
    home_balanced: max - min <= 1,
    max_group_size: strop === Infinity ? 0 : strop,
    over_limit: nadStrop,
  };
}

// ---------------------------------------------------------------------------
// Kontrola pred štartom
// ---------------------------------------------------------------------------

// Dokáže DOPREDU, že hra vyjde — alebo presne povie, čo tomu bráni.
//
// Prečo je to potrebné: chyba v nastaveniach sa inak prejaví až na tábore, keď
// stojí 106 detí v areáli. Napríklad pri bait prahu 2 potrebuje najvzdialenejšie
// dieťa 18 kôl, ale hra ich má 10 — časť detí by sa domov nikdy nedostala
// a zistilo by sa to až o 11:40.
//
// `chyby` = hra by preukázateľne nedopadla; startGame() ju nespustí.
// `varovania` = hra dobehne, ale niečo nebude ideálne (napr. nerovnaké skupiny).
function preflight() {
  const settings = getSettings();
  const children = getChildren();
  const g = settings.num_groups;
  const chyby = [];
  const varovania = [];

  // --- Deti ----------------------------------------------------------------
  if (!children.length) chyby.push('Nie sú naimportované žiadne deti.');

  const mimoRozsah = children.filter((c) => !(c.home_group >= 1 && c.home_group <= g));
  if (mimoRozsah.length) {
    chyby.push(`${mimoRozsah.length} detí má domovskú skupinu mimo rozsahu 1–${g} `
      + `(napr. ${mimoRozsah[0].name}). Oprav ich v zozname detí.`);
  }

  // Duplicitný QR = sken by pripísal výsledok nesprávnemu dieťaťu.
  const videne = new Set();
  const duplicitne = new Set();
  for (const c of children) {
    if (videne.has(c.qr_code)) duplicitne.add(c.qr_code);
    videne.add(c.qr_code);
  }
  if (duplicitne.size) {
    chyby.push(`Duplicitné QR kódy (${duplicitne.size}): ${[...duplicitne].slice(0, 3).join(', ')}`
      + ' — sken by priradil výsledok nesprávnemu dieťaťu.');
  }

  // --- Stanovištia ---------------------------------------------------------
  if (settings.stations.length < g) {
    chyby.push(`Skupín je ${g}, ale stanovíšť len ${settings.stations.length} — `
      + 'dve skupiny by museli byť naraz na tom istom mieste.');
  }

  const obsadenost = {};
  for (let x = 1; x <= g; x++) {
    const st = (settings.group_start_station || {})[x];
    if (st) (obsadenost[st] = obsadenost[st] || []).push(x);
  }
  const kolizie = Object.entries(obsadenost).filter(([, sk]) => sk.length > 1);
  if (kolizie.length) {
    chyby.push('Na jednom stanovišti štartuje viac skupín: '
      + kolizie.map(([st, sk]) => `${st} → skupiny ${sk.join(', ')}`).join('; '));
  }

  // --- Kapacita ------------------------------------------------------------
  const strop = stropSkupiny(settings);
  if (strop !== Infinity && children.length > g * strop) {
    chyby.push(`${children.length} detí sa nezmestí do ${g} skupín po ${strop} `
      + `(max ${g * strop}). Zvýš strop alebo počet skupín.`);
  }
  const bilancia = homeGroupBalance();
  if (bilancia.over_limit.length) {
    varovania.push(`Skupiny nad strop ${strop}: ${bilancia.over_limit.join(', ')}.`);
  }

  // --- Počet kôl vs. najdlhšia cesta domov ---------------------------------
  // Rozdelenie si strop vzdialenosti dopočítava samo (viď distributeChildren),
  // takže tu už nejde o to, či sa to „náhodou zmestí". Kontrolujú sa len tri
  // veci, ktoré si rozdelenie prispôsobiť NEVIE.
  const kolNaPresun = kolNaJedenPosun(settings);
  const stropVzdialenosti = Math.min(g - 1, maxVzdialenostDoKonca(settings));
  const minDist = Math.min(Math.max(settings.min_start_distance || 0, 0), g - 1);

  // Vzdialenosť = počet posunov, ktoré dieťa potrebuje domov. Keď sú deti už
  // rozdelené, počítame zo skutočnosti; inak zo stropu, ktorý rozdelenie použije.
  const rozdelene = children.length > 0 && children.every((c) => c.current_group != null);
  const najvacsiaVzdialenost = rozdelene
    ? Math.max(...children.map((c) => (c.home_group - c.current_group + g) % g))
    : Math.max(0, stropVzdialenosti);
  const potrebnychKol = najvacsiaVzdialenost * kolNaPresun;

  // Poistka „rovno domov" cestu skráti — keď je zapnutá a stihne sa, dôjdu všetci.
  const poistka = parseInt(settings.force_home_round, 10) || 0;
  const poistkaPlati = poistka >= 1 && poistka <= settings.max_rounds;

  if (!poistkaPlati) {
    if (stropVzdialenosti < 1) {
      // Ani jeden posun sa nezmestí — to sa rozdelením zachrániť nedá.
      chyby.push(`Jeden posun trvá ${kolNaPresun} kôl, ale hra má len ${settings.max_rounds} — `
        + 'nezmestí sa ani jeden. Zníž bait prah alebo zvýš počet kôl.');
    } else if (minDist > stropVzdialenosti) {
      // Požiadavky si protirečia: min. vzdialenosť je väčšia, než sa dá prejsť.
      chyby.push(`Min. vzdialenosť od domova je ${minDist}, na to treba `
        + `${minDist * kolNaPresun} kôl, ale hra má ${settings.max_rounds}. `
        + `Zníž min. vzdialenosť na ${stropVzdialenosti}`
        + (kolNaPresun > 1 ? ' alebo bait prah na 1.' : ' alebo zvýš počet kôl.'));
    } else if (potrebnychKol > settings.max_rounds) {
      // Rozdelenie vzniklo pri INÝCH nastaveniach a odvtedy sa niečo zmenilo.
      chyby.push(`Rozdelenie detí je z iných nastavení — najvzdialenejšie dieťa `
        + `potrebuje ${potrebnychKol} kôl, ale hra má ${settings.max_rounds}. `
        + 'Rozdeľ deti nanovo (Admin → Rozdelenie), prepočíta sa to na aktuálne nastavenia.');
    }
  }

  // --- Veci, ktoré hru nezhodia, ale stoja za zmienku ----------------------
  if (!bilancia.home_balanced) {
    varovania.push(`Domovské skupiny nie sú rovnako veľké (${bilancia.home_min}–${bilancia.home_max} detí). `
      + 'Veľkosti skupín počas hry ich kopírujú, takže úplne rovnaké počty nie sú možné.');
  }
  if ((settings.bait || {}).mode === 'random') {
    varovania.push('Náhodný bait režim rozsynchronizuje deti — počty v skupinách počas hry kolíšu. '
      + `Rozdelenie preto ráta s najhorším prahom (${kolNaPresun} kôl na posun).`);
  }
  if (poistka >= 1) {
    varovania.push(`Poistka „rovno domov" je zapnutá od kola ${poistka}. `
      + 'Manuál pozná len posun o jednu skupinku vyššie.');
  }

  return {
    ok: chyby.length === 0,
    chyby,
    varovania,
    // Čísla, z ktorých kontrola vychádza — nech je vidno, na čom to stojí.
    vypocty: {
      deti: children.length,
      skupiny: g,
      kola: settings.max_rounds,
      rozdelene,
      najvacsia_vzdialenost: najvacsiaVzdialenost,
      strop_vzdialenosti: stropVzdialenosti,
      kol_na_presun: kolNaPresun,
      potrebnych_kol: potrebnychKol,
      rezerva_kol: settings.max_rounds - potrebnychKol,
      domovske_min: bilancia.home_min,
      domovske_max: bilancia.home_max,
    },
  };
}

// ---------------------------------------------------------------------------
// Priebeh hry
// ---------------------------------------------------------------------------

function startGame() {
  const settings = getSettings();
  const children = getChildren();
  if (children.length === 0) return { error: 'Najprv pridaj deti (Settings)' };
  if (children.some((c) => c.current_group == null)) {
    // Nerozdelené deti — automaticky rozdeliť podľa náramkov.
    distributeChildren('wristband');
  }

  // Až po rozdelení — kontrola tak počíta zo skutočných vzdialeností, nie
  // z najhoršieho možného prípadu. Hru, ktorá by preukázateľne nedopadla,
  // radšej vôbec nespustíme: na tábore by sa na to prišlo až o 11:40.
  const kontrola = preflight();
  if (!kontrola.ok) {
    return {
      error: 'Hra sa nedá spustiť, nevyšla by:\n• ' + kontrola.chyby.join('\n• '),
      preflight: kontrola,
    };
  }
  const state = defaultState(settings);
  state.status = 'running';
  state.current_round = 1;
  // Čistý štart: vynulovať herné polia detí (home_group a current_group ostávajú).
  const kids = getChildren();
  for (const c of kids) {
    c.rounds_in_wrong_group = 0;
    c.bait_delay = null;
    c.history = [];
  }
  store.save('children', kids);
  store.save('state', state);
  return { ok: true };
}

function setStatus(status) {
  const state = getState();
  state.status = status;
  store.save('state', state);
  return { ok: true };
}

function resetGame() {
  const settings = getSettings();
  const state = defaultState(settings);
  store.save('state', state);
  // Reset ruší priradenie do skupín, takže údaje o rozdelení (aj seed) už
  // nepopisujú realitu — zmažú sa, nech sa nedá vytlačiť neplatný rozpis.
  store.save('distribution', null);
  const children = getChildren();
  for (const c of children) {
    c.current_group = null;
    c.rounds_in_wrong_group = 0;
    c.bait_delay = null;
    c.history = [];
  }
  store.save('children', children);
  return { ok: true };
}

// Sken jedného dieťaťa animátorom na stanovišti.
// groupNum = skupina, s ktorou animátor práve je; stationLetter = stanovište.
function processScan(qr, groupNum, stationLetter) {
  const settings = getSettings();
  const state = getState();
  const children = getChildren();

  if (state.status !== 'running') return { error: 'Hra nebeží (spusti ju v admin stránke)' };

  // Animátor má stanovište aj skupinku uložené v telefóne. Keď si vyberie
  // nesprávne, skenoval by deti pod cudzím stanovišťom a celý log by klamal —
  // preto sa nezhoda zachytí hneď, pred prvým skenom.
  const mojaSkupina = state.groups[groupNum];
  if (!mojaSkupina) return { error: `Neznáma skupinka ${groupNum}` };
  if (stationLetter && mojaSkupina.station !== stationLetter) {
    const spravne = settings.stations.find((s) => s.letter === mojaSkupina.station);
    return {
      error: `Skupinka ${groupNum} je v tomto kole na stanovišti ${mojaSkupina.station}`
        + (spravne ? ` (${spravne.place})` : '') + `, nie na ${stationLetter}. `
        + 'Skontroluj, aké stanovište a skupinku máš v telefóne nastavené.',
      zle_stanoviste: true,
      spravne_stanoviste: mojaSkupina.station,
    };
  }

  const child = children.find((c) => c.qr_code === qr || c.id === qr);
  if (!child) return { error: `Neznámy QR kód: ${qr}` };

  const round = state.current_round;
  const dup = state.scans.find((s) => s.child_id === child.id && s.round === round);
  if (dup) {
    return {
      duplicate: true,
      child: publicChild(child, settings, state),
      result: dup.result,
      moved_to: dup.moved_to,
      message: `${child.name} už bol(a) v tomto kole naskenovaný(á)`,
    };
  }

  // Na stanovište sa smú skenovať LEN deti, ktoré tam podľa appky naozaj sú.
  //
  // Predtým sa appka pri nezhode prispôsobila realite a dieťaťu potichu
  // prepísala skupinku. Znelo to rozumne, ale znamenalo to, že sa omyl nikdy
  // neprejavil: animátor naskenoval cudzie dieťa, appka to prijala a nikto sa
  // nedozvedel, že niekde nastala chyba. Teraz sken neprejde a animátor rovno
  // vidí, kam dieťa patrí a kde tú skupinku hľadať.
  //
  // Keď je appka naozaj mimo (napr. sa vynechal sken), skupinku prepíše admin
  // ručne v Admin stránke — vedome a so záznamom, nie potichu pri skenovaní.
  if (child.current_group == null) {
    return {
      error: `${child.name} ešte nie je rozdelené do skupinky, takže sem nemôže patriť. `
        + 'Rozdeľ deti v Admin stránke.',
      nepatri: true,
      child: publicChild(child, settings, state),
    };
  }
  if (child.current_group !== groupNum) {
    const kde = state.groups[child.current_group];
    const st = kde && settings.stations.find((s) => s.letter === kde.station);
    return {
      error: `${child.name} sem nepatrí — je v skupinke ${child.current_group}`
        + (st ? `, ktorá je teraz na stanovišti ${st.letter} (${st.place}).` : '.'),
      nepatri: true,
      child: publicChild(child, settings, state),
      patri_do_skupinky: child.current_group,
      patri_na_stanoviste: st ? { letter: st.letter, place: st.place } : null,
    };
  }

  let result;
  let movedTo = null;
  let forcedHome = false;
  const forceRound = settings.force_home_round;
  if (child.home_group === groupNum) {
    // Zhoda — dieťa je doma, ostáva, counter sa nuluje.
    result = 'home';
    child.rounds_in_wrong_group = 0;
    child.bait_delay = null;
  } else if (forceRound >= 1 && round >= forceRound) {
    // Logistická poistka: od kola force_home_round ide nesúhlasiace dieťa
    // rovno do svojej domovskej skupinky (žiadny bait, žiadne +1).
    result = 'move';
    movedTo = child.home_group;
    forcedHome = true;
    child.current_group = movedTo;
    child.rounds_in_wrong_group = 0;
    child.bait_delay = null;
  } else {
    if (child.bait_delay == null) child.bait_delay = computeBaitDelay(settings);
    child.rounds_in_wrong_group += 1;
    if (child.rounds_in_wrong_group >= child.bait_delay) {
      // Prah dosiahnutý — presun do nasledujúcej skupiny (+1, wrap).
      result = 'move';
      movedTo = nextGroup(settings, groupNum);
      child.current_group = movedTo;
      child.rounds_in_wrong_group = 0;
      child.bait_delay = null;
    } else {
      // Ostáva ako "bait" — zámerné zdržanie.
      result = 'bait';
    }
  }

  child.history.push(childHistoryEntry(round, stationLetter, result, groupNum, movedTo ?? groupNum));
  state.scans.push({
    child_id: child.id,
    name: child.name,
    round,
    station: stationLetter,
    group: groupNum,
    result,
    moved_to: movedTo,
    forced_home: forcedHome,
    ts: new Date().toISOString(),
  });

  store.save('children', children);
  store.save('state', state);
  return { child: publicChild(child, settings, state), result, moved_to: movedTo, forced_home: forcedHome };
}

// Animátor ukončil kolo pre svoju skupinu -> skupina sa posúva na ďalšie
// stanovište. Keď skončia všetky skupiny, kolo sa posunie automaticky.
function finishGroupRound(groupNum) {
  const settings = getSettings();
  const state = getState();
  if (state.status !== 'running') return { error: 'Hra nebeží' };
  const grp = state.groups[groupNum];
  if (!grp) return { error: 'Neznáma skupina' };
  if (grp.finished_round >= state.current_round) {
    return { error: `Skupina ${groupNum} už má kolo ${state.current_round} ukončené` };
  }
  grp.finished_round = state.current_round;
  grp.station = nextStation(settings, grp.station);
  maybeAdvanceRound(settings, state);
  store.save('state', state);
  return { ok: true, next_station: grp.station };
}

// Admin: vynútiť ďalšie kolo aj keď niektoré skupiny nestihli skenovať.
function forceAdvanceRound() {
  const settings = getSettings();
  const state = getState();
  if (state.status !== 'running') return { error: 'Hra nebeží' };
  for (const g of Object.keys(state.groups)) {
    const grp = state.groups[g];
    if (grp.finished_round < state.current_round) {
      grp.finished_round = state.current_round;
      grp.station = nextStation(settings, grp.station);
    }
  }
  maybeAdvanceRound(settings, state);
  store.save('state', state);
  return { ok: true, current_round: state.current_round, status: state.status };
}

// Admin: odsimulovať celé kolo jedným klikom — naskenuje všetky deti vo
// všetkých skupinách (ako keby to spravili animátori) a ukončí kolo každej
// skupine. Deti už naskenované v tomto kole sa preskočia, skupiny s už
// ukončeným kolom tiež, takže sa to dá bezpečne kombinovať s reálnym
// skenovaním v teréne.
function simulateRound() {
  const settings = getSettings();
  const state = getState();
  if (state.status !== 'running') return { error: 'Hra nebeží' };
  const round = state.current_round;

  // Snapshot zloženia skupín na začiatku kola — dieťa presunuté počas kola
  // fyzicky dobehne do novej skupiny až v ďalšom kole, neskenuje sa 2×.
  const roster = {};
  for (const c of getChildren()) {
    if (c.current_group != null) (roster[c.current_group] = roster[c.current_group] || []).push(c.qr_code);
  }

  let scanned = 0;
  let moves = 0;
  let alreadyScanned = 0;
  for (let g = 1; g <= settings.num_groups; g++) {
    const grp = getState().groups[g];
    if (!grp) continue;
    for (const qr of roster[g] || []) {
      const r = processScan(qr, g, grp.station);
      if (r.duplicate) { alreadyScanned++; continue; }
      if (r.error) continue;
      scanned++;
      if (r.result === 'move') moves++;
    }
    if (getState().groups[g].finished_round < round) finishGroupRound(g);
  }

  const after = getState();
  const kids = getChildren();
  return {
    ok: true,
    simulated_round: round,
    scanned,
    moves,
    already_scanned: alreadyScanned,
    current_round: after.current_round,
    status: after.status,
    home: kids.filter((c) => c.current_group === c.home_group).length,
    total: kids.length,
  };
}

function maybeAdvanceRound(settings, state) {
  const allDone = Object.values(state.groups).every((g) => g.finished_round >= state.current_round);
  if (!allDone) return;
  if (state.current_round >= settings.max_rounds) {
    state.status = 'finished';
  } else {
    state.current_round += 1;
  }
}

// ---------------------------------------------------------------------------
// Prehľad (odvodené údaje pre admin/scan UI — nič z toho sa neukladá)
// ---------------------------------------------------------------------------

function publicChild(child, settings, state) {
  const grp = child.current_group != null ? state.groups[child.current_group] : null;
  const isHome = child.current_group != null && child.current_group === child.home_group;
  // Koľko presunov (+1 skupina) ešte dieťa potrebuje na cestu domov.
  const dist = child.current_group == null
    ? null
    : (child.home_group - child.current_group + settings.num_groups) % settings.num_groups;
  const roundsRemaining = state.status === 'finished' ? 0 : settings.max_rounds - state.current_round + 1;
  return {
    ...child,
    current_station: grp ? grp.station : null,
    is_home: isHome,
    moves_count: child.history.filter((h) => h.action === 'move' || h.action === 'manual').length,
    distance_to_home: dist,
    // Aj keby sa presúvalo každé kolo bez bait zdržania, domov to už nestihne.
    // Ak je zapnutá poistka force_home_round v rámci hry, stihne to každý
    // (od toho kola idú deti pri skene rovno domov).
    wont_make_it: !isHome && dist != null && state.status === 'running' && dist > roundsRemaining
      && !(settings.force_home_round >= 1 && settings.force_home_round <= settings.max_rounds),
  };
}

function fullState() {
  const settings = getSettings();
  const state = getState();
  const children = getChildren().map((c) => publicChild(c, settings, state));
  return {
    settings, state, children,
    balance: homeGroupBalance(),
    distribution: getDistribution(),
    manual_check: manualCheck(),
    preflight: preflight(),
  };
}

function saveSettings(patch) {
  const current = getSettings();
  const updated = { ...current, ...patch };
  store.save('settings', updated);
  // Ak hra ešte nezačala, premietni zmeny (počty skupín, štartové stanovištia)
  // do východzieho stavu.
  const state = getState();
  if (state.status === 'not_started') {
    store.save('state', defaultState(updated));
  }
  return { ok: true, settings: updated };
}

module.exports = {
  getSettings,
  getState,
  getChildren,
  fullState,
  saveSettings,
  importChildren,
  updateChild,
  deleteChild,
  distributeChildren,
  getDistribution,
  manualCheck,
  resetManualSettings,
  preflight,
  homeGroupBalance,
  startGame,
  setStatus,
  resetGame,
  processScan,
  finishGroupRound,
  forceAdvanceRound,
  simulateRound,
  computeBaitDelay,
  defaultSettings,
};
