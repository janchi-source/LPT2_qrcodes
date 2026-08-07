// Spoločné spracovanie požiadaviek pre lokálny server (server.js) aj pre
// Vercel (api/[...path].js). Nič tu nepočúva na porte — to je úloha server.js.
const fs = require('fs');
const path = require('path');
const os = require('os');
const game = require('./game');
const store = require('./store');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const HTTP_PORT = process.env.PORT || 3000;
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.ico': 'image/x-icon',
};

function sendJSON(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', // stav hry sa nesmie cachovať
  });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  // Na Vercele býva telo už rozparsované.
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') {
      try { return Promise.resolve(req.body ? JSON.parse(req.body) : {}); } catch (e) { return Promise.reject(e); }
    }
    return Promise.resolve(req.body);
  }
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 5 * 1024 * 1024) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function lanAddresses() {
  if (process.env.VERCEL) return []; // na hostingu nemá LAN adresa zmysel
  const out = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}

function httpsEnabled() {
  if (process.env.VERCEL) return true; // Vercel má vlastný dôveryhodný cert
  return fs.existsSync(path.join(ROOT, 'certs', 'key.pem'))
    && fs.existsSync(path.join(ROOT, 'certs', 'cert.pem'));
}

// --- Routovanie -------------------------------------------------------------
// Vracia { status, body }. Je zámerne SYNCHRÓNNE, aby sa celá herná logika
// stihla vykonať nad jedným snapshotom stavu (viď lib/store.js).
function route(method, pathname, body) {
  const seg = pathname.split('/').filter(Boolean); // ['api', ...]
  const ok = (b) => ({ status: b && b.error ? 400 : 200, body: b });

  if (method === 'GET' && pathname === '/api/state') return ok(game.fullState());

  if (method === 'POST' && pathname === '/api/scan') {
    const group = parseInt(body.group, 10);
    if (!body.qr_code || !group || !body.station) {
      return { status: 400, body: { error: 'Chýba qr_code / group / station' } };
    }
    return ok(game.processScan(String(body.qr_code).trim(), group, body.station));
  }

  if (method === 'POST' && seg[1] === 'group' && seg[3] === 'finish-round') {
    return ok(game.finishGroupRound(parseInt(seg[2], 10)));
  }

  // Ovládanie hry
  if (method === 'POST' && pathname === '/api/game/start') return ok(game.startGame());
  if (method === 'POST' && pathname === '/api/game/pause') return ok(game.setStatus('paused'));
  if (method === 'POST' && pathname === '/api/game/resume') return ok(game.setStatus('running'));
  if (method === 'POST' && pathname === '/api/game/finish') return ok(game.setStatus('finished'));
  if (method === 'POST' && pathname === '/api/game/reset') return ok(game.resetGame());
  if (method === 'POST' && pathname === '/api/round/advance') return ok(game.forceAdvanceRound());
  if (method === 'POST' && pathname === '/api/round/simulate') return ok(game.simulateRound());
  if (method === 'POST' && pathname === '/api/distribute') return ok(game.distributeChildren(body.mode || 'wristband'));

  // Deti
  if (method === 'POST' && pathname === '/api/children/import') {
    if (!Array.isArray(body.rows)) return { status: 400, body: { error: 'Očakávam {rows: [...]}' } };
    const r = game.importChildren(body.rows);
    return { status: 200, body: { created: r.created.length, errors: r.errors } };
  }
  if (method === 'POST' && pathname === '/api/children') {
    const r = game.importChildren([body]);
    if (r.errors.length) return { status: 400, body: { error: r.errors.join('; ') } };
    return { status: 200, body: { child: r.created[0] } };
  }
  if (seg[1] === 'children' && seg[2]) {
    if (method === 'PUT') return ok(game.updateChild(seg[2], body));
    if (method === 'DELETE') return ok(game.deleteChild(seg[2]));
  }

  // Info o serveri — scan.html z toho zisťuje, na akú https adresu sa má
  // animátor prepnúť, keď omylom otvorí http:// (tam kamera nefunguje).
  if (method === 'GET' && pathname === '/api/server-info') {
    return {
      status: 200,
      body: {
        http_port: Number(HTTP_PORT),
        https_port: Number(HTTPS_PORT),
        https_enabled: httpsEnabled(),
        hosted: !!process.env.VERCEL,
        storage: store.useKV ? 'kv' : 'file',
        storage_mode: store.mode, // 'rest' (REST API) | 'tcp' (REDIS_URL) | 'file'
        // Diagnostika pripojenia databázy — len či premenná existuje,
        // nikdy nie jej hodnota (sú to prístupové údaje).
        kv_env: {
          REDIS_URL: !!process.env.REDIS_URL,
          KV_REST_API_URL: !!process.env.KV_REST_API_URL,
          KV_REST_API_TOKEN: !!process.env.KV_REST_API_TOKEN,
          UPSTASH_REDIS_REST_URL: !!process.env.UPSTASH_REDIS_REST_URL,
          UPSTASH_REDIS_REST_TOKEN: !!process.env.UPSTASH_REDIS_REST_TOKEN,
        },
        addresses: lanAddresses(),
      },
    };
  }

  // Settings
  if (method === 'GET' && pathname === '/api/settings') return ok(game.getSettings());
  if (method === 'PUT' && pathname === '/api/settings') return ok(game.saveSettings(body));

  return { status: 404, body: { error: 'Neznáma API cesta' } };
}

// Celá herná logika beží v jednej transakcii — pri súbehu dvoch animátorov
// sa zápis zopakuje nad čerstvými dátami (detaily v lib/store.js).
async function handleApi(req, res, pathname) {
  const body = req.method === 'GET' ? {} : await readBody(req);

  const { ok, result } = await store.runTransaction(() => route(req.method, pathname, body));
  if (!ok) {
    return sendJSON(res, 409, {
      error: 'Server je práve zaneprázdnený (veľa skenov naraz). Skús to ešte raz.',
    });
  }
  return sendJSON(res, result.status, result.body);
}

// Stiahnutie certifikačnej autority do telefónu. Content-Type je dôležitý —
// iOS podľa neho ponúkne inštaláciu profilu. Na Vercele netreba (má vlastný
// dôveryhodný certifikát), preto tam vráti 404.
function serveCA(res) {
  fs.readFile(path.join(ROOT, 'certs', 'ca.pem'), (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Certifikát CA tu nie je potrebný ani dostupný.');
    }
    res.writeHead(200, {
      'Content-Type': 'application/x-x509-ca-cert',
      'Content-Disposition': 'attachment; filename="LPT2-tabor-CA.crt"',
    });
    res.end(data);
  });
}

// Statické súbory servuje lokálny server. Na Vercele ich servuje priamo
// hosting z public/, sem sa takéto požiadavky vôbec nedostanú.
function serveStatic(res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const fp = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!fp.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    res.end(data);
  });
}

function handler(req, res) {
  const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (pathname === '/ca.crt') return serveCA(res);
  if (pathname.startsWith('/api/')) {
    handleApi(req, res, pathname).catch((e) => {
      sendJSON(res, 500, { error: String((e && e.message) || e) });
    });
    return;
  }
  serveStatic(res, pathname);
}

module.exports = { handler, route, lanAddresses, httpsEnabled };
