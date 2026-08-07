// Minimalistický Redis klient (protokol RESP2) cez zabudované net/tls.
//
// Prečo vlastný a nie npm balík: celý projekt je zámerne bez závislostí, aby
// sa dal na tábore spustiť bez internetu a `npm install`. Potrebujeme presne
// tri príkazy (GET, SET, EVAL), na to je RESP dosť jednoduchý.
//
// Používa sa, keď hosting dá pripojenie ako REDIS_URL (rediss://user:heslo@host:port).
// Keď sú k dispozícii REST údaje (KV_REST_API_URL + token), store.js uprednostní tie.
const net = require('net');
const tls = require('tls');

const CRLF = '\r\n';

// --- Kódovanie príkazu -----------------------------------------------------
function encode(args) {
  let out = `*${args.length}${CRLF}`;
  for (const a of args) {
    const s = Buffer.from(String(a));
    out += `$${s.length}${CRLF}${s.toString('binary')}${CRLF}`;
  }
  return Buffer.from(out, 'binary');
}

// --- Dekódovanie odpovede --------------------------------------------------
// Vráti { value, next } alebo null, keď v buffere ešte nie je celá odpoveď.
function parse(buf, i) {
  if (i >= buf.length) return null;
  const type = buf[i];
  const konicKriadku = buf.indexOf('\r\n', i, 'binary');
  if (konicKriadku === -1) return null;
  const riadok = buf.toString('utf8', i + 1, konicKriadku);
  const poRiadku = konicKriadku + 2;

  if (type === 0x2b) return { value: riadok, next: poRiadku };                     // +OK
  if (type === 0x3a) return { value: Number(riadok), next: poRiadku };             // :123
  if (type === 0x2d) return { error: riadok, next: poRiadku };                     // -ERR
  if (type === 0x24) {                                                            // $bulk
    const dlzka = Number(riadok);
    if (dlzka === -1) return { value: null, next: poRiadku };
    const koniec = poRiadku + dlzka;
    if (buf.length < koniec + 2) return null;
    return { value: buf.toString('utf8', poRiadku, koniec), next: koniec + 2 };
  }
  if (type === 0x2a) {                                                            // *array
    const pocet = Number(riadok);
    if (pocet === -1) return { value: null, next: poRiadku };
    const polozky = [];
    let pos = poRiadku;
    for (let k = 0; k < pocet; k++) {
      const p = parse(buf, pos);
      if (!p) return null;
      if (p.error) return { error: p.error, next: p.next };
      polozky.push(p.value);
      pos = p.next;
    }
    return { value: polozky, next: pos };
  }
  return { error: 'neznámy typ odpovede: ' + String.fromCharCode(type), next: poRiadku };
}

class RedisClient {
  constructor(url) {
    const u = new URL(url);
    this.tls = u.protocol === 'rediss:';
    this.host = u.hostname;
    this.port = Number(u.port || 6379);
    this.username = decodeURIComponent(u.username || '');
    this.password = decodeURIComponent(u.password || '');
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.cakajuce = []; // fronta rozpracovaných príkazov (Redis odpovedá v poradí)
    this.pripajanie = null;
  }

  async pripoj() {
    if (this.socket && !this.socket.destroyed) return;
    if (this.pripajanie) return this.pripajanie;

    this.pripajanie = new Promise((resolve, reject) => {
      const opts = { host: this.host, port: this.port };
      const socket = this.tls
        ? tls.connect({ ...opts, servername: this.host }, () => resolve())
        : net.connect(opts, () => resolve());

      socket.setNoDelay(true);
      socket.setTimeout(15000);

      socket.on('data', (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        this.spracujBuffer();
      });
      // Musí reagovať na 'error' AJ na 'close': keď protistrana spojenie
      // len zavrie (serverless inštancia po zmrazení, reštart databázy),
      // chybová udalosť nepríde a rozpracované príkazy by čakali donekonečna.
      const zlyhalo = (err) => {
        const e = err || new Error('Redis: spojenie sa zavrelo');
        this.socket = null;
        this.buffer = Buffer.alloc(0);
        for (const p of this.cakajuce.splice(0)) p.reject(e);
        reject(e);
      };
      socket.on('error', zlyhalo);
      socket.on('close', () => zlyhalo());
      socket.on('timeout', () => { socket.destroy(new Error('Redis: vypršal čas spojenia')); });

      this.socket = socket;
    }).finally(() => { this.pripajanie = null; });

    await this.pripajanie;

    // Prihlásenie. Upstash aj Redis Cloud posielajú heslo v URL.
    if (this.password) {
      await this.posli(this.username ? ['AUTH', this.username, this.password] : ['AUTH', this.password]);
    }
  }

  spracujBuffer() {
    while (this.cakajuce.length) {
      const p = parse(this.buffer, 0);
      if (!p) return; // odpoveď ešte nie je celá
      this.buffer = this.buffer.subarray(p.next);
      const cakajuci = this.cakajuce.shift();
      if (p.error) cakajuci.reject(new Error('Redis: ' + p.error));
      else cakajuci.resolve(p.value);
    }
  }

  posli(args) {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) return reject(new Error('Redis: nie je spojenie'));
      this.cakajuce.push({ resolve, reject });
      this.socket.write(encode(args));
    });
  }

  // Serverless inštancia môže byť medzi požiadavkami zmrazená a spojenie
  // medzitým odumrie — preto jeden opakovaný pokus s čerstvým spojením.
  async command(args) {
    for (let pokus = 1; pokus <= 2; pokus++) {
      try {
        await this.pripoj();
        return await this.posli(args);
      } catch (e) {
        if (this.socket) { this.socket.destroy(); this.socket = null; }
        if (pokus === 2) throw e;
      }
    }
  }

  zavri() {
    if (this.socket) { this.socket.destroy(); this.socket = null; }
  }
}

module.exports = { RedisClient, encode, parse };
