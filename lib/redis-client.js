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

// Časové limity sú zámerne krátke. Serverless funkcia má na odpoveď len pár
// sekúnd; keby sme čakali dlhšie, hosting požiadavku odstrelí a prehliadaču
// príde HTML chybová stránka namiesto zrozumiteľnej hlášky ("Neplatná
// odpoveď servera"). Radšej rýchlo zlyhať s vysvetlením.
const LIMIT_SPOJENIA_MS = Number(process.env.LPT2_REDIS_TIMEOUT_MS || 4000);
const POCET_POKUSOV = 2;

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
    // Cesta v URL môže niesť číslo databázy (redis://host:6379/2).
    this.db = (u.pathname || '').replace('/', '').trim();
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.cakajuce = []; // fronta rozpracovaných príkazov (Redis odpovedá v poradí)
    this.pripravovanie = null;
    this.pouzitaTls = this.tls;
  }

  // Spojenie je "pripravené" až po AUTH — nie hneď po nadviazaní TCP.
  // Preto je celá príprava jeden zdieľaný sľub: keď ju spustia dva súbežné
  // príkazy naraz, obidva čakajú na to isté a ani jeden neposiela príkaz
  // pred prihlásením.
  pripravSpojenie() {
    if (this.socket && !this.socket.destroyed && this.prihlasene) return Promise.resolve();
    if (!this.pripravovanie) {
      this.pripravovanie = this._pripoj().finally(() => { this.pripravovanie = null; });
    }
    return this.pripravovanie;
  }

  _otvorSocket(pouzitTls) {
    return new Promise((resolve, reject) => {
      const opts = { host: this.host, port: this.port };
      // servername (SNI) sa smie nastaviť len pre doménu, nie pre IP adresu —
      // inak Node spojenie odmietne a zamaskuje skutočnú príčinu chyby.
      const jeIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(this.host) || this.host.includes(':');
      const socket = pouzitTls
        ? tls.connect(jeIp ? opts : { ...opts, servername: this.host }, () => resolve(socket))
        : net.connect(opts, () => resolve(socket));

      socket.setNoDelay(true);
      socket.setTimeout(LIMIT_SPOJENIA_MS);
      // net.connect sám o sebe vie visieť dlho (napr. keď je port filtrovaný),
      // preto vlastný strop aj na nadviazanie spojenia.
      const strop = setTimeout(
        () => socket.destroy(new Error(`spojenie sa nenadviazalo do ${LIMIT_SPOJENIA_MS} ms`)),
        LIMIT_SPOJENIA_MS,
      );
      socket.once('close', () => clearTimeout(strop));
      socket.once('connect', () => clearTimeout(strop));
      socket.once('secureConnect', () => clearTimeout(strop));

      socket.on('data', (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        this.spracujBuffer();
      });
      // Musí reagovať na 'error' AJ na 'close': keď protistrana spojenie
      // len zavrie (serverless inštancia po zmrazení, reštart databázy),
      // chybová udalosť nepríde a rozpracované príkazy by čakali donekonečna.
      const zlyhalo = (err) => {
        const e = err || new Error('spojenie zavrela protistrana');
        if (this.socket === socket) { this.socket = null; this.prihlasene = false; this.buffer = Buffer.alloc(0); }
        for (const p of this.cakajuce.splice(0)) p.reject(e);
        reject(e);
      };
      socket.on('error', zlyhalo);
      socket.on('close', () => zlyhalo());
      socket.on('timeout', () => socket.destroy(new Error(`spojenie nečinné dlhšie ako ${LIMIT_SPOJENIA_MS} ms`)));
    });
  }

  async _pripoj() {
    this._zahod();
    let socket;
    try {
      socket = await this._otvorSocket(this.pouzitaTls);
    } catch (e) {
      // Časté nedorozumenie: poskytovateľ zverejní adresu ako redis://, ale
      // vyžaduje šifrované spojenie. Skús to teda ešte raz cez TLS.
      if (!this.pouzitaTls) {
        this.pouzitaTls = true;
        socket = await this._otvorSocket(true);
      } else {
        throw e;
      }
    }
    this.socket = socket;

    if (this.password) {
      await this._posliRaw(this.username ? ['AUTH', this.username, this.password] : ['AUTH', this.password]);
    }
    if (this.db && this.db !== '0') await this._posliRaw(['SELECT', this.db]);
    this.prihlasene = true;
  }

  spracujBuffer() {
    while (this.cakajuce.length) {
      const p = parse(this.buffer, 0);
      if (!p) return; // odpoveď ešte nie je celá
      this.buffer = this.buffer.subarray(p.next);
      const cakajuci = this.cakajuce.shift();
      if (p.error) cakajuci.reject(new Error(p.error));
      else cakajuci.resolve(p.value);
    }
  }

  _posliRaw(args) {
    return new Promise((resolve, reject) => {
      const s = this.socket;
      if (!s || s.destroyed) return reject(new Error('spojenie nie je otvorené'));
      this.cakajuce.push({ resolve, reject });
      s.write(encode(args));
    });
  }

  _zahod() {
    if (this.socket) { this.socket.removeAllListeners(); this.socket.destroy(); }
    this.socket = null;
    this.prihlasene = false;
    this.buffer = Buffer.alloc(0);
  }

  // Serverless inštancia môže byť medzi požiadavkami zmrazená a spojenie
  // medzitým odumrie — preto viac pokusov s čerstvým spojením.
  async command(args) {
    let posledna;
    for (let pokus = 1; pokus <= POCET_POKUSOV; pokus++) {
      try {
        await this.pripravSpojenie();
        return await this._posliRaw(args);
      } catch (e) {
        posledna = e;
        this._zahod();
        if (pokus < POCET_POKUSOV) await new Promise((r) => setTimeout(r, 50));
      }
    }
    // Do hlášky patrí adresa aj príčina — bez toho sa chyba na hostingu
    // ladí len hádaním. Heslo sa do nej nikdy nedostane.
    throw new Error(
      `Redis ${this.host}:${this.port} (${this.pouzitaTls ? 'TLS' : 'bez TLS'}): ${posledna && posledna.message}`
    );
  }

  zavri() { this._zahod(); }
}

module.exports = { RedisClient, encode, parse };
