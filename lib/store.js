// Jednoduché JSON úložisko na disku.
// Každá entita = jeden súbor v data/. Zápis je atomický (tmp + rename),
// aby pád procesu nenechal rozbitý súbor. Štruktúra je navrhnutá tak,
// aby sa dala neskôr 1:1 preklopiť do SQLite tabuliek
// (children -> tabuľka children, state.scans -> tabuľka scans, atď.).
const fs = require('fs');
const path = require('path');

// LPT2_DATA_DIR override používajú testy, aby nesiahali na ostré dáta.
const DATA_DIR = process.env.LPT2_DATA_DIR || path.join(__dirname, '..', 'data');

function filePath(name) {
  return path.join(DATA_DIR, name + '.json');
}

function load(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath(name), 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function save(name, obj) {
  const fp = filePath(name);
  const tmp = fp + '.tmp';
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, fp);
}

module.exports = { load, save, DATA_DIR };
