// Vstupný bod pre Vercel — všetky /api/* požiadavky idú sem.
// Statické súbory (public/) servuje Vercel sám, tie sa sem nedostanú.
//
// Stav hry musí byť v KV (Upstash/Vercel KV) — na Vercele je súborový systém
// len na čítanie, takže JSON súbory v data/ by sa nedali zapisovať.
const { handler } = require('../lib/handler');
const store = require('../lib/store');

module.exports = (req, res) => {
  if (!store.useKV) {
    res.status(500).json({
      error: 'Chýba pripojenie k databáze. V nastaveniach projektu na Vercele '
        + 'pridaj KV_REST_API_URL a KV_REST_API_TOKEN (Storage → Upstash Redis).',
    });
    return;
  }
  handler(req, res);
};
