// Test vlastného Redis klienta (lib/redis-client.js) — spusti priamo:
//   node test/redis-client.test.js
//
// Beží proti falošnému Redis serveru, ktorý hovorí protokolom RESP2, takže
// netreba internet ani skutočnú databázu. Overuje presne to, čo appka
// potrebuje: AUTH, GET, SET, EVAL, prácu s rozdelenými paketmi a obnovu
// spojenia po jeho páde (na serverless sa spojenie medzi požiadavkami stráca).
const net = require('net');
const { RedisClient, encode, parse } = require('../lib/redis-client');

let failures = 0;
function check(label, cond, detail) {
  if (cond) console.log('  ok  ' + label);
  else { console.error('  FAIL ' + label + (detail ? ' — ' + detail : '')); failures++; }
}

// --- Falošný Redis server ---------------------------------------------------
const db = new Map();
let prijateAuth = null;
let rozdelovacRezim = false; // posiela odpoveď po bajtoch, aby sa testoval parser

function odpoved(v) {
  if (v === null) return '$-1\r\n';
  if (typeof v === 'number') return `:${v}\r\n`;
  if (v === 'OK') return '+OK\r\n';
  return `$${Buffer.byteLength(v)}\r\n${v}\r\n`;
}

const server = net.createServer((socket) => {
  let buf = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    // Príkazy chodia ako RESP polia — použijeme na ne ten istý parser.
    for (;;) {
      const p = parse(buf, 0);
      if (!p || p.error) break;
      buf = buf.subarray(p.next);
      const [cmd, ...args] = p.value;
      let out;
      switch (String(cmd).toUpperCase()) {
        case 'AUTH': prijateAuth = args; out = odpoved('OK'); break;
        case 'SET': db.set(args[0], args[1]); out = odpoved('OK'); break;
        case 'GET': out = odpoved(db.has(args[0]) ? db.get(args[0]) : null); break;
        case 'EVAL': {
          // Náš compare-and-swap: [script, '2', DOC, VER, doc, baseVersion]
          const verKey = args[3], novy = args[4], base = args[5];
          const ver = db.has(verKey) ? String(db.get(verKey)) : '0';
          if (ver === String(base)) {
            db.set(args[2], novy);
            db.set(verKey, String(Number(base) + 1));
            out = odpoved(1);
          } else out = odpoved(0);
          break;
        }
        case 'PADNI': socket.destroy(); return; // simulácia výpadku spojenia
        default: out = '-ERR neznámy príkaz\r\n';
      }
      if (rozdelovacRezim) {
        // Pošli odpoveď po jednom bajte s oneskorením — parser musí zvládnuť
        // neúplné dáta.
        const b = Buffer.from(out, 'utf8');
        let i = 0;
        const timer = setInterval(() => {
          if (i >= b.length) return clearInterval(timer);
          socket.write(b.subarray(i, i + 1));
          i++;
        }, 1);
      } else {
        socket.write(out);
      }
    }
  });
  socket.on('error', () => {});
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const client = new RedisClient(`redis://default:tajneheslo@127.0.0.1:${port}`);

  // --- Kódovanie ------------------------------------------------------------
  check('príkaz sa kóduje ako RESP pole',
    encode(['GET', 'kluc']).toString() === '*2\r\n$3\r\nGET\r\n$4\r\nkluc\r\n');

  // --- Základné príkazy -----------------------------------------------------
  check('GET neexistujúceho kľúča vráti null', await client.command(['GET', 'niet']) === null);
  await client.command(['SET', 'a', 'ahoj']);
  check('SET + GET vráti uloženú hodnotu', await client.command(['GET', 'a']) === 'ahoj');
  check('AUTH prebehlo s menom aj heslom',
    Array.isArray(prijateAuth) && prijateAuth[0] === 'default' && prijateAuth[1] === 'tajneheslo',
    JSON.stringify(prijateAuth));

  // --- Diakritika a veľké hodnoty (mená detí, log skenov) -------------------
  const velky = JSON.stringify({ deti: Array.from({ length: 2000 }, (_, i) => ({ meno: `Žofia Ľubomíra ${i}` })) });
  await client.command(['SET', 'velky', velky]);
  const spat = await client.command(['GET', 'velky']);
  check('veľká hodnota s diakritikou prejde bez poškodenia', spat === velky,
    `poslané ${velky.length} znakov, prišlo ${spat ? spat.length : 'null'}`);

  // --- Odpoveď rozsekaná na bajty ------------------------------------------
  rozdelovacRezim = true;
  check('parser zvládne odpoveď prichádzajúcu po častiach',
    await client.command(['GET', 'a']) === 'ahoj');
  rozdelovacRezim = false;

  // --- EVAL (compare-and-swap) ---------------------------------------------
  db.set('doc', '{}'); db.set('doc:version', '3');
  const zle = await client.command(['EVAL', 'skript', '2', 'doc', 'doc:version', '{"x":1}', '2']);
  check('EVAL so zlou verziou nezapíše (vráti 0)', Number(zle) === 0 && db.get('doc') === '{}');
  const dobre = await client.command(['EVAL', 'skript', '2', 'doc', 'doc:version', '{"x":1}', '3']);
  check('EVAL so správnou verziou zapíše a zvýši verziu',
    Number(dobre) === 1 && db.get('doc') === '{"x":1}' && db.get('doc:version') === '4');

  // --- Obnova po páde spojenia ---------------------------------------------
  try { await client.command(['PADNI']); } catch (e) { /* spojenie spadlo, čakané */ }
  check('po páde spojenia sa klient sám znova pripojí',
    await client.command(['GET', 'a']) === 'ahoj');

  // --- Súbežné príkazy (odpovede musia sedieť s požiadavkami) --------------
  await Promise.all([1, 2, 3, 4, 5].map((i) => client.command(['SET', 'k' + i, 'v' + i])));
  const hodnoty = await Promise.all([1, 2, 3, 4, 5].map((i) => client.command(['GET', 'k' + i])));
  check('súbežné príkazy dostanú správne odpovede',
    hodnoty.join(',') === 'v1,v2,v3,v4,v5', hodnoty.join(','));

  client.zavri();
  server.close();
  console.log(failures ? `\n${failures} FAILED` : '\nREDIS KLIENT OK');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('\nCHYBA:', e); process.exit(1); });
