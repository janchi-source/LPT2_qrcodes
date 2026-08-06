// LPT2 rozdeľovacia hra — server.
//
// Zámerne čistý Node.js bez npm závislostí: na tábore stačí skopírovať
// priečinok a spustiť `node server.js` — žiadny npm install, žiadny internet.
//
// HTTP  na porte 3000 (admin na notebooku).
// HTTPS na porte 3443, AK existujú certs/key.pem + certs/cert.pem
// (vygeneruj cez scripts/gen-certs.sh). HTTPS je NUTNÉ pre skenovanie
// kamerou z mobilov — prehliadače nepovolia kameru cez http:// na LAN IP.
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const game = require('./lib/game');

const HTTP_PORT = process.env.PORT || 3000;
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
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

// API routing: metóda + cesta -> handler(body, params)
async function handleApi(req, res, pathname) {
  const body = req.method === 'GET' ? {} : await readBody(req);
  const seg = pathname.split('/').filter(Boolean); // ['api', ...]

  // GET /api/state — kompletný stav pre všetky stránky
  if (req.method === 'GET' && pathname === '/api/state') return sendJSON(res, 200, game.fullState());

  // POST /api/scan {qr_code, group, station}
  if (req.method === 'POST' && pathname === '/api/scan') {
    const group = parseInt(body.group, 10);
    if (!body.qr_code || !group || !body.station) return sendJSON(res, 400, { error: 'Chýba qr_code / group / station' });
    const r = game.processScan(String(body.qr_code).trim(), group, body.station);
    return sendJSON(res, r.error ? 400 : 200, r);
  }

  // POST /api/group/:num/finish-round
  if (req.method === 'POST' && seg[1] === 'group' && seg[3] === 'finish-round') {
    const r = game.finishGroupRound(parseInt(seg[2], 10));
    return sendJSON(res, r.error ? 400 : 200, r);
  }

  // Ovládanie hry
  if (req.method === 'POST' && pathname === '/api/game/start') return sendJSON(res, 200, game.startGame());
  if (req.method === 'POST' && pathname === '/api/game/pause') return sendJSON(res, 200, game.setStatus('paused'));
  if (req.method === 'POST' && pathname === '/api/game/resume') return sendJSON(res, 200, game.setStatus('running'));
  if (req.method === 'POST' && pathname === '/api/game/finish') return sendJSON(res, 200, game.setStatus('finished'));
  if (req.method === 'POST' && pathname === '/api/game/reset') return sendJSON(res, 200, game.resetGame());
  if (req.method === 'POST' && pathname === '/api/round/advance') return sendJSON(res, 200, game.forceAdvanceRound());
  if (req.method === 'POST' && pathname === '/api/round/simulate') return sendJSON(res, 200, game.simulateRound());
  if (req.method === 'POST' && pathname === '/api/distribute') return sendJSON(res, 200, game.distributeChildren(body.mode || 'wristband'));

  // Deti
  if (req.method === 'POST' && pathname === '/api/children/import') {
    if (!Array.isArray(body.rows)) return sendJSON(res, 400, { error: 'Očakávam {rows: [...]}' });
    const r = game.importChildren(body.rows);
    return sendJSON(res, 200, { created: r.created.length, errors: r.errors });
  }
  if (req.method === 'POST' && pathname === '/api/children') {
    const r = game.importChildren([body]);
    if (r.errors.length) return sendJSON(res, 400, { error: r.errors.join('; ') });
    return sendJSON(res, 200, { child: r.created[0] });
  }
  if (seg[1] === 'children' && seg[2]) {
    if (req.method === 'PUT') {
      const r = game.updateChild(seg[2], body);
      return sendJSON(res, r.error ? 400 : 200, r);
    }
    if (req.method === 'DELETE') {
      const r = game.deleteChild(seg[2]);
      return sendJSON(res, r.error ? 400 : 200, r);
    }
  }

  // Info o serveri — scan.html z toho zisťuje, na akú https adresu sa má
  // animátor prepnúť, keď omylom otvorí http:// (tam kamera nefunguje).
  if (req.method === 'GET' && pathname === '/api/server-info') {
    return sendJSON(res, 200, {
      http_port: Number(HTTP_PORT),
      https_port: Number(HTTPS_PORT),
      https_enabled: httpsEnabled,
      addresses: lanAddresses(),
    });
  }

  // Settings
  if (req.method === 'GET' && pathname === '/api/settings') return sendJSON(res, 200, game.getSettings());
  if (req.method === 'PUT' && pathname === '/api/settings') return sendJSON(res, 200, game.saveSettings(body));

  return sendJSON(res, 404, { error: 'Neznáma API cesta' });
}

// Stiahnutie certifikačnej autority do telefónu. Content-Type je dôležitý —
// iOS podľa neho ponúkne inštaláciu profilu.
function serveCA(res) {
  const ca = path.join(__dirname, 'certs', 'ca.pem');
  fs.readFile(ca, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Certifikát CA neexistuje — spusti: bash scripts/gen-certs.sh');
    }
    res.writeHead(200, {
      'Content-Type': 'application/x-x509-ca-cert',
      'Content-Disposition': 'attachment; filename="LPT2-tabor-CA.crt"',
    });
    res.end(data);
  });
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
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
    handleApi(req, res, pathname).catch((e) => sendJSON(res, 500, { error: String(e.message || e) }));
  } else {
    serveStatic(req, res, pathname);
  }
}

function lanAddresses() {
  const out = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}

const keyPath = path.join(__dirname, 'certs', 'key.pem');
const certPath = path.join(__dirname, 'certs', 'cert.pem');
const httpsEnabled = fs.existsSync(keyPath) && fs.existsSync(certPath);

http.createServer(handler).listen(HTTP_PORT, () => {
  console.log(`HTTP  beží na http://localhost:${HTTP_PORT}   (admin, nastavenia)`);
  for (const ip of lanAddresses()) console.log(`      v sieti: http://${ip}:${HTTP_PORT}`);
});

if (httpsEnabled) {
  https.createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, handler)
    .listen(HTTPS_PORT, () => {
      console.log('');
      console.log(`HTTPS beží na https://localhost:${HTTPS_PORT}`);
      for (const ip of lanAddresses()) {
        console.log(`      MOBILY (kamera!):  https://${ip}:${HTTPS_PORT}/scan.html`);
        console.log(`      návod pre telefón: https://${ip}:${HTTPS_PORT}/pomoc.html`);
      }
      console.log('');
      console.log('Kamera na mobile funguje LEN cez https a len keď telefón verí certifikátu.');
      console.log('Na každom telefóne raz otvor /pomoc.html a nainštaluj certifikát podľa návodu.');
    });
} else {
  console.log('');
  console.log('HTTPS vypnuté — chýbajú certs/key.pem a certs/cert.pem.');
  console.log('BEZ TOHO NEBUDE FUNGOVAŤ KAMERA NA MOBILOCH.');
  console.log('Spusti: bash scripts/gen-certs.sh  a reštartuj server.');
}
