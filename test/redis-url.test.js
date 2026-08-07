// Integračný test pre nasadenie, kde hosting dá REDIS_URL (Vercel Marketplace).
// Spusti: node test/redis-url.test.js
//
// Beží celá appka — herná logika, transakcie aj súbeh — proti falošnému Redis
// serveru cez skutočný TCP protokol RESP. Toto je cesta, ktorá beží na
// Vercele, takže sa tu overuje reálne nasadenie, nie len REST varianta.
const net = require('net');
const { parse } = require('../lib/redis-client');

let failures = 0;
function check(label, cond, detail) {
  if (cond) console.log('  ok  ' + label);
  else { console.error('  FAIL ' + label + (detail ? ' — ' + detail : '')); failures++; }
}

const db = new Map();
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
    for (;;) {
      const p = parse(buf, 0);
      if (!p || p.error) break;
      buf = buf.subarray(p.next);
      const [cmd, ...args] = p.value;
      let out;
      switch (String(cmd).toUpperCase()) {
        case 'AUTH': out = odpoved('OK'); break;
        case 'SET': db.set(args[0], args[1]); out = odpoved('OK'); break;
        case 'GET': out = odpoved(db.has(args[0]) ? db.get(args[0]) : null); break;
        case 'EVAL': {
          const [, , docKey, verKey, novy, base] = args;
          const ver = db.has(verKey) ? String(db.get(verKey)) : '0';
          if (ver === String(base)) {
            db.set(docKey, novy); db.set(verKey, String(Number(base) + 1));
            out = odpoved(1);
          } else out = odpoved(0);
          break;
        }
        default: out = '-ERR neznámy príkaz\r\n';
      }
      socket.write(out);
    }
  });
  socket.on('error', () => {});
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  // Presne taká premenná, akú dáva Vercel Marketplace.
  process.env.REDIS_URL = `redis://default:heslo@127.0.0.1:${port}`;
  process.env.LPT2_KV_KEY = 'lpt2:test';
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;

  const store = require('../lib/store');
  const game = require('../lib/game');
  const { route } = require('../lib/handler');

  check('appka rozpozná REDIS_URL a prepne sa na databázu', store.useKV === true && store.mode === 'tcp',
    `useKV=${store.useKV} mode=${store.mode}`);

  const poziadavka = async (fn) => {
    const r = await store.runTransaction(fn);
    if (!r.ok) throw new Error('zápis sa nepodaril ani na 6 pokusov');
    return r;
  };

  // --- Založenie hry -------------------------------------------------------
  await poziadavka(() => {
    const rows = [];
    for (let i = 1; i <= 100; i++) rows.push({ name: `Dieťa ${i}`, home_group: ((i - 1) % 10) + 1, wristband_number: i });
    game.importChildren(rows);
    game.saveSettings({ bait: { mode: 'fixed', delay_rounds: 1, random_min: 0, random_max: 2 }, force_home_round: 0, min_start_distance: 2 });
    game.distributeChildren('wristband');
    game.startGame();
  });

  const stav = await poziadavka(() => game.fullState());
  check('stav sa uložil do Redisu a načítal späť',
    stav.result.children.length === 100 && stav.result.state.status === 'running');
  check('dáta sú naozaj v databáze, nie na disku', db.has('lpt2:test'));

  // --- Súbeh: 10 animátorov skenuje naraz ----------------------------------
  const skupiny = {};
  for (const c of stav.result.children) (skupiny[c.current_group] = skupiny[c.current_group] || []).push(c);

  const ocakavane = [];
  const ulohy = [];
  for (let g = 1; g <= 10; g++) {
    const dieta = skupiny[g][0];
    ocakavane.push(dieta.id);
    ulohy.push(poziadavka(() => route('POST', '/api/scan', {
      qr_code: dieta.qr_code, group: g, station: stav.result.state.groups[g].station,
    })));
  }
  const vysledky = await Promise.all(ulohy);
  check('10 súbežných skenov prešlo bez chyby',
    vysledky.every((v) => !(v.result.body && v.result.body.error)));

  const po = await poziadavka(() => game.fullState());
  const zapisane = po.result.state.scans.filter((s) => ocakavane.includes(s.child_id));
  check('žiadny sken sa nestratil', zapisane.length === 10, `v logu ${zapisane.length}`);
  check('žiadny sken nie je dvakrát', new Set(zapisane.map((s) => s.child_id)).size === 10);
  console.log(`  info: ${vysledky.filter((v) => v.pokusy > 1).length} z 10 muselo zápis zopakovať kvôli súbehu`);

  // --- Dohranie hry --------------------------------------------------------
  let guard = 0;
  while (guard++ < 15) {
    const r = await poziadavka(() => game.simulateRound());
    if (r.result && r.result.status === 'finished') break;
    const s = await poziadavka(() => game.getState());
    if (s.result.status !== 'running') break;
  }
  const koniec = await poziadavka(() => game.fullState());
  check('hra sa dohrá cez databázu a všetky deti sú doma',
    koniec.result.state.status === 'finished'
    && koniec.result.children.every((c) => c.current_group === c.home_group));

  const velkosti = {};
  for (const c of koniec.result.children) velkosti[c.current_group] = (velkosti[c.current_group] || 0) + 1;
  check('počty detí v skupinách ostali rovnaké (10)',
    Object.values(velkosti).every((n) => n === 10), JSON.stringify(velkosti));

  server.close();
  console.log(failures ? `\n${failures} FAILED` : '\nREDIS_URL REŽIM OK');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('\nCHYBA:', e); process.exit(1); });
