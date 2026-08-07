// LPT2 rozdeľovacia hra — lokálny server (tábor, notebook bez internetu).
//
// Zámerne čistý Node.js bez npm závislostí: stačí skopírovať priečinok
// a spustiť `node server.js` — žiadny npm install, žiadny internet.
//
// HTTP  na porte 3000 (admin na notebooku).
// HTTPS na porte 3443, AK existujú certs/key.pem + certs/cert.pem
// (vygeneruj cez scripts/gen-certs.sh). HTTPS je NUTNÉ pre skenovanie
// kamerou z mobilov — prehliadače nepovolia kameru cez http:// na LAN IP.
//
// Routovanie je v lib/handler.js, aby ho vedel použiť aj Vercel
// (api/[...path].js). Tento súbor sa na Vercele vôbec nespúšťa.
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { handler, lanAddresses } = require('./lib/handler');
const store = require('./lib/store');

const HTTP_PORT = process.env.PORT || 3000;
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;

const keyPath = path.join(__dirname, 'certs', 'key.pem');
const certPath = path.join(__dirname, 'certs', 'cert.pem');
const httpsEnabled = fs.existsSync(keyPath) && fs.existsSync(certPath);

const POPIS_ULOZISKA = {
  supabase: 'Supabase (Postgres cez HTTPS)',
  rest: 'Redis cez REST (Vercel KV / Upstash)',
  tcp: 'Redis cez TCP (REDIS_URL)',
};
console.log(store.useKV
  ? `Úložisko: ${POPIS_ULOZISKA[store.mode]}`
  : `Úložisko: JSON súbory v ${store.DATA_DIR}`);

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
