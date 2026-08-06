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

// ---------------------------------------------------------------------------
// Načítanie / defaulty
// ---------------------------------------------------------------------------

function defaultSettings() {
  // Stanovištia podľa MANUÁL LPT2 2026 (doobedie, rozdeľovacia hra).
  const stations = [
    { letter: 'A', name: 'Vymenia sa všetci tí', place: 'zasadačka' },
    { letter: 'B', name: 'Vajco', place: 'záhrada' },
    { letter: 'C', name: 'Deka', place: 'pri Panne Márii' },
    { letter: 'D', name: 'Telefón', place: 'obývačka' },
    { letter: 'E', name: 'Červené more', place: 'mantinely' },
    { letter: 'F', name: 'Kreslenie', place: 'oľga' },
    { letter: 'G', name: 'Rómeo a Júlia', place: 'sála' },
    { letter: 'H', name: 'Zoradenie', place: 'pred skautskou' },
    { letter: 'I', name: 'Pantomíma', place: 'tanečná' },
    { letter: 'J', name: 'Hádaj na čo myslím', place: 'čajovňa' },
  ];
  // Počiatočné mapovanie: skupina 1 -> A, 2 -> B, ... (konfigurovateľné v settings).
  const group_start_station = {};
  for (let g = 1; g <= 10; g++) group_start_station[g] = stations[g - 1].letter;
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
    // skupinky — garantuje správne rozdelenie na konci hry. 0 = vypnuté.
    force_home_round: 8,
    // Počiatočné rozdelenie: každé dieťa začne aspoň takto ďaleko od svojej
    // domovskej skupinky (vzdialenosť = počet presunov +1 potrebných domov).
    // 2 = žiadne dieťa nie je vo svojej skupinke počas 1. ani 2. kola
    // (domov dorazí najskôr na začiatok 3. kola). 0 = bez obmedzenia.
    min_start_distance: 2,
  };
}

function defaultState(settings) {
  const groups = {};
  for (let g = 1; g <= settings.num_groups; g++) {
    groups[g] = {
      station: settings.group_start_station[g] || settings.stations[(g - 1) % settings.stations.length].letter,
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
function importChildren(rows) {
  const settings = getSettings();
  const children = getChildren();
  const created = [];
  const errors = [];
  for (const [i, row] of rows.entries()) {
    const name = (row.name || '').trim();
    const home = parseInt(row.home_group, 10);
    if (!name) { errors.push(`riadok ${i + 1}: chýba meno`); continue; }
    if (!(home >= 1 && home <= settings.num_groups)) {
      errors.push(`riadok ${i + 1} (${name}): neplatná home_group "${row.home_group}"`);
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
function distributeChildren(mode) {
  const settings = getSettings();
  const children = getChildren();
  if (children.length === 0) return { error: 'Žiadne deti na rozdelenie' };
  const list = [...children];
  if (mode === 'random') {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
  } else {
    list.sort((a, b) => (a.wristband_number || 0) - (b.wristband_number || 0));
  }
  const g = settings.num_groups;
  const minDist = Math.min(Math.max(settings.min_start_distance || 0, 0), g - 1);

  // Povolené vzdialenosti od domovskej skupiny (počet presunov domov).
  const allowed = [];
  for (let d = minDist; d <= g - 1; d++) allowed.push(d);
  // Náhodný posun cyklu: mení sa, ktoré vzdialenosti sú obsadené dvakrát,
  // takže každá hra vyzerá inak — profil ostáva rovnaký pre všetky domovské
  // skupiny, takže invariant rovnakých veľkostí platí naďalej.
  const offset = Math.floor(Math.random() * allowed.length);

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
  return { ok: true, ...homeGroupBalance() };
}

// Kontrola vyváženosti domovských skupín — veľkosti skupín počas hry ich
// kopírujú, takže nerovnaké domovské skupiny = nerovnaké skupiny v hre.
function homeGroupBalance() {
  const settings = getSettings();
  const counts = {};
  for (let g = 1; g <= settings.num_groups; g++) counts[g] = 0;
  for (const c of getChildren()) {
    if (counts[c.home_group] !== undefined) counts[c.home_group]++;
  }
  const values = Object.values(counts);
  const min = Math.min(...values);
  const max = Math.max(...values);
  return { home_counts: counts, home_min: min, home_max: max, home_balanced: max - min <= 1 };
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

  // Dieťa fyzicky stojí v tejto skupine — ak si appka myslela niečo iné
  // (utieklo, chyba pri minulom skene), veríme realite a opravíme stav.
  let corrected = false;
  if (child.current_group !== groupNum) {
    child.history.push(childHistoryEntry(round, stationLetter, 'correction', child.current_group, groupNum));
    child.current_group = groupNum;
    child.rounds_in_wrong_group = 0;
    child.bait_delay = null;
    corrected = true;
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
    corrected,
    ts: new Date().toISOString(),
  });

  store.save('children', children);
  store.save('state', state);
  return { child: publicChild(child, settings, state), result, moved_to: movedTo, forced_home: forcedHome, corrected };
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
  return { settings, state, children, balance: homeGroupBalance() };
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
