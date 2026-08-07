// Požiadavky BEZ tela — spusti: node test/bez-tela.test.js
//
// Prečo samostatný test: na hostingu (Vercel) prichádzajú požiadavky bez tela
// tak, že `req.body` nie je nastavené a stream je už spotrebovaný — udalosť
// 'end' teda nikdy nepríde. Kód, ktorý na ňu čakal, sa zasekol až do
// vypršania času funkcie a prehliadaču prišla HTML chybová stránka.
//
// Týka sa to presne tých akcií, ktoré nič neposielajú:
//   POST /api/game/start, /api/game/reset, /api/round/simulate
//   DELETE /api/children/:id
const { Readable } = require('stream');

process.env.LPT2_DATA_DIR = require('path').join(__dirname, 'tmp-bez-tela');
const fs = require('fs');
fs.rmSync(process.env.LPT2_DATA_DIR, { recursive: true, force: true });

const game = require('../lib/game');
const { handler } = require('../lib/handler');

let failures = 0;
function check(label, cond, detail) {
  if (cond) console.log('  ok  ' + label);
  else { console.error('  FAIL ' + label + (detail ? ' — ' + detail : '')); failures++; }
}

// Požiadavka tak, ako ju vidí funkcia na hostingu: telo nerozparsované
// a stream, ktorý sa nikdy neskončí (už ho spotreboval hosting).
function poziadavkaBezTela(method, url) {
  const req = new Readable({ read() { /* zámerne nikdy nič nepošle */ } });
  req.method = method;
  req.url = url;
  req.headers = {};      // žiadne content-length
  req.body = undefined;  // hosting telo nerozparsoval
  return req;
}

function posli(req, limitMs = 3000) {
  return new Promise((resolve, reject) => {
    const casovac = setTimeout(() => reject(new Error('požiadavka sa zasekla (' + limitMs + ' ms)')), limitMs);
    const res = {
      writeHead(status) { this._status = status; },
      end(telo) {
        clearTimeout(casovac);
        let data = null;
        try { data = JSON.parse(telo); } catch (e) { /* nie JSON */ }
        resolve({ status: this._status, body: data, raw: telo });
      },
    };
    handler(req, res);
  });
}

(async () => {
  // Príprava: pár detí, aby bolo čo mazať.
  game.importChildren([
    { name: 'Prvé dieťa', home_group: 1, wristband_number: 1 },
    { name: 'Druhé dieťa', home_group: 2, wristband_number: 2 },
  ]);
  check('príprava: dve deti', game.getChildren().length === 2);

  // --- POST bez tela: spustenie hry ---------------------------------------
  const start = await posli(poziadavkaBezTela('POST', '/api/game/start'));
  check('POST /api/game/start bez tela neostane visieť', start.status === 200, JSON.stringify(start.body));
  check('hra sa naozaj spustila', game.getState().status === 'running');

  // --- DELETE bez tela: vymazanie dieťaťa ---------------------------------
  const id = game.getChildren()[0].id;
  const zmaz = await posli(poziadavkaBezTela('DELETE', '/api/children/' + id));
  check('DELETE /api/children/:id bez tela neostane visieť', zmaz.status === 200, JSON.stringify(zmaz.body));
  check('dieťa je naozaj vymazané',
    game.getChildren().length === 1 && !game.getChildren().some((c) => c.id === id));

  // --- DELETE neexistujúceho dieťaťa vráti zrozumiteľnú chybu -------------
  const chyba = await posli(poziadavkaBezTela('DELETE', '/api/children/NEEXISTUJE'));
  check('mazanie neexistujúceho dieťaťa hlási chybu, nezasekne sa',
    chyba.status === 400 && chyba.body && chyba.body.error === 'Dieťa nenájdené');

  // --- Ďalšie akcie bez tela ----------------------------------------------
  for (const cesta of ['/api/round/simulate', '/api/game/pause', '/api/game/resume', '/api/game/reset']) {
    const r = await posli(poziadavkaBezTela('POST', cesta));
    check(`POST ${cesta} bez tela odpovie`, r.status === 200, JSON.stringify(r.body));
  }

  // --- Požiadavka S telom musí fungovať naďalej ---------------------------
  const sTelom = new Readable({
    read() { this.push(JSON.stringify({ mode: 'wristband' })); this.push(null); },
  });
  sTelom.method = 'POST';
  sTelom.url = '/api/distribute';
  sTelom.headers = { 'content-length': String(JSON.stringify({ mode: 'wristband' }).length) };
  const rozdel = await posli(sTelom);
  check('POST s telom sa stále číta správne', rozdel.status === 200 && rozdel.body.ok === true,
    JSON.stringify(rozdel.body));

  fs.rmSync(process.env.LPT2_DATA_DIR, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILED` : '\nPOŽIADAVKY BEZ TELA OK');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('\nCHYBA:', e.message);
  fs.rmSync(process.env.LPT2_DATA_DIR, { recursive: true, force: true });
  process.exit(1);
});
