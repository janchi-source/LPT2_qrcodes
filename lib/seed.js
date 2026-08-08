// Deterministický generátor náhodných čísel.
//
// Prečo nie Math.random(): rozdelenie detí do skupín sa robí RAZ pred hrou
// a musí sa dať spätne dohľadať aj zopakovať — keď sa niečo pokazí (spadne
// databáza, niekto omylom prerozdelí), potrebujeme vedieť z toho istého seedu
// vyrobiť presne to isté rozdelenie. S Math.random() by bolo rozdelenie
// nenávratne stratené.
//
// Algoritmus je mulberry32 — 32-bitový, krátky, bez závislostí a s dostatočne
// dobrým rozložením na to, čo od neho chceme (zamiešať poradie detí).

// Text -> 32-bitové číslo (FNV-1a). Vďaka tomu môže byť seed čitateľný reťazec,
// ktorý sa dá napísať na papier, a nie len číslo.
function seedZTextu(text) {
  let h = 0x811c9dc5;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Vráti funkciu, ktorá dáva čísla z intervalu <0, 1) — rovnaké rozhranie ako
// Math.random(), takže sa dá priamo dosadiť.
function generator(seed) {
  let a = (typeof seed === 'number' ? seed : seedZTextu(seed)) >>> 0;
  return function nahodne() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Nový seed na zapísanie. Zámerne krátky a bez znakov, ktoré sa dajú zameniť
// (0/O, 1/I), nech sa dá bez chyby prepísať z obrazovky na papier a späť.
const ZNAKY = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
function novySeed() {
  let out = '';
  for (let i = 0; i < 8; i++) {
    if (i === 4) out += '-';
    out += ZNAKY[Math.floor(Math.random() * ZNAKY.length)];
  }
  return out;
}

// Zamiešanie poľa (Fisher-Yates) daným generátorom. Na mieste, vracia to isté
// pole — volajúci si ho už predtým skopíroval.
function zamiesaj(pole, nahodne) {
  for (let i = pole.length - 1; i > 0; i--) {
    const j = Math.floor(nahodne() * (i + 1));
    [pole[i], pole[j]] = [pole[j], pole[i]];
  }
  return pole;
}

module.exports = { generator, seedZTextu, novySeed, zamiesaj };
