// Routovanie na hostingu — spusti: node test/routovanie.test.js
//
// Prečo samostatný test: Vercel interpretoval catch-all `api/[...path].js`,
// akoby sa volal `[path].js`, teda púšťal len JEDEN segment. /api/state
// fungovalo, ale všetko dvojsegmentové (/api/children/<id>, /api/game/start,
// /api/round/advance) končilo na 404 od Vercelu a k funkcii sa vôbec
// nedostalo. Navonok to vyzeralo, že „mazanie nefunguje“, pritom nefungovalo
// aj spustenie hry, reset a import.
//
// Odvtedy cestu odovzdáva rewrite vo vercel.json v query parametri `cesta`
// a nespoliehame sa na odhad podľa názvu súboru. Tento test drží obe cesty:
// aj lokálnu (req.url), aj hostingovú (req.query.cesta).
const { Readable } = require('stream');

process.env.LPT2_DATA_DIR = require('path').join(__dirname, 'tmp-routovanie');
const fs = require('fs');
fs.rmSync(process.env.LPT2_DATA_DIR, { recursive: true, force: true });

const game = require('../lib/game');
const { handler } = require('../lib/handler');

let failures = 0;
function check(label, cond, detail) {
  if (cond) console.log('  ok  ' + label);
  else { console.error('  FAIL ' + label + (detail ? ' — ' + detail : '')); failures++; }
}

// Požiadavka tak, ako ju vidí funkcia na Verceli po rewrite: req.url ukazuje
// na cieľ funkcie, pôvodná cesta je v query.
function poziadavkaVercel(method, cesta) {
  const req = new Readable({ read() {} });
  req.method = method;
  req.url = '/api/index?cesta=' + cesta;
  req.query = { cesta };
  req.headers = {};
  req.body = undefined;
  return req;
}

function poziadavkaLokalne(method, url) {
  const req = new Readable({ read() {} });
  req.method = method;
  req.url = url;
  req.headers = {};
  req.body = undefined;
  return req;
}

function posli(req, limitMs = 3000) {
  return new Promise((resolve, reject) => {
    const casovac = setTimeout(() => reject(new Error('požiadavka sa zasekla')), limitMs);
    const res = {
      writeHead(status) { this._status = status; },
      end(telo) {
        clearTimeout(casovac);
        let data = null;
        try { data = JSON.parse(telo); } catch (e) { /* nie JSON */ }
        resolve({ status: this._status, body: data });
      },
    };
    handler(req, res);
  });
}

(async () => {
  game.importChildren([
    { name: 'Anička', home_group: 1, wristband_number: 1 },
    { name: 'Miško', home_group: 2, wristband_number: 2 },
  ]);
  const deti = game.getChildren();

  // --- Dvojsegmentové cesty cez rewrite (to, čo na Verceli padalo) --------
  const zmazanie = await posli(poziadavkaVercel('DELETE', 'children/' + deti[0].id));
  check('DELETE /api/children/<id> sa trafí do routovania',
    zmazanie.status === 200 && zmazanie.body && zmazanie.body.ok === true,
    JSON.stringify(zmazanie.body));
  check('dieťa je naozaj preč',
    !game.getChildren().some((c) => c.id === deti[0].id));

  const start = await posli(poziadavkaVercel('POST', 'game/start'));
  check('POST /api/game/start sa trafí do routovania',
    start.status === 200 && !(start.body && start.body.error),
    JSON.stringify(start.body));

  const kolo = await posli(poziadavkaVercel('POST', 'round/advance'));
  check('POST /api/round/advance sa trafí do routovania', kolo.status === 200,
    JSON.stringify(kolo.body));

  // Trojsegmentová cesta — /api/group/<n>/finish-round
  const doKola = await posli(poziadavkaVercel('POST', 'group/1/finish-round'));
  check('trojsegmentová cesta sa tiež trafí', doKola.status === 200,
    JSON.stringify(doKola.body));

  // --- Jednosegmentové cesty musia fungovať ďalej -------------------------
  const stav = await posli(poziadavkaVercel('GET', 'state'));
  check('GET /api/state cez rewrite', stav.status === 200 && !!stav.body.settings);

  // --- Lokálny server (bez rewrite) ---------------------------------------
  const lokalne = await posli(poziadavkaLokalne('GET', '/api/state'));
  check('GET /api/state lokálne (bez query)', lokalne.status === 200 && !!lokalne.body.settings);

  const lokalneDve = await posli(poziadavkaLokalne('POST', '/api/game/pause'));
  check('dvojsegmentová cesta lokálne', lokalneDve.status === 200,
    JSON.stringify(lokalneDve.body));

  // --- Diakritika v ceste sa nesmie rozbiť --------------------------------
  const zakodovane = await posli(poziadavkaVercel('DELETE', 'children/' + encodeURIComponent('Dž Q')));
  check('zakódovaný segment sa dekóduje (nie 404 na neznámu cestu)',
    zakodovane.status === 400 && /nenájden/i.test(zakodovane.body.error || ''),
    JSON.stringify(zakodovane.body));

  // --- Neznáma cesta stále vracia diagnostiku -----------------------------
  const nezname = await posli(poziadavkaVercel('GET', 'nieco/ine'));
  check('neznáma cesta vráti 404 s videnou cestou',
    nezname.status === 404 && nezname.body.videna_cesta === '/api/nieco/ine',
    JSON.stringify(nezname.body));

  fs.rmSync(process.env.LPT2_DATA_DIR, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILED` : '\nROUTOVANIE OK');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('\nCHYBA:', e);
  process.exit(1);
});
