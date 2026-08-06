// Vstupný bod pre Vercel — všetky /api/* požiadavky idú sem.
// Statické súbory (public/) servuje Vercel sám, tie sa sem nedostanú.
//
// Stav hry musí byť v KV (Upstash Redis) — na Vercele je súborový systém
// len na čítanie, takže JSON súbory v data/ by sa nedali zapisovať.
const { handler } = require('../lib/handler');
const store = require('../lib/store');

module.exports = (req, res) => {
  // /api/server-info musí fungovať aj bez databázy — je to diagnostika,
  // ktorou sa dá overiť, či je pripojenie nastavené správne.
  // Zámerne `includes` a nie `startsWith` — keby Vercel cestu prepísal,
  // diagnostika musí byť dostupná tak či tak.
  const jeDiagnostika = (req.url || '').includes('server-info');

  if (!store.useKV && !jeDiagnostika) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      error: 'Nie je pripojená databáza, takže sa stav hry nedá ukladať. '
        + 'V nastaveniach projektu na Vercele priraď Upstash Redis a znova nasaď projekt.',
      ocakavane_premenne: [
        'KV_REST_API_URL + KV_REST_API_TOKEN',
        'alebo UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN',
      ],
      diagnostika: '/api/server-info',
    }));
    return;
  }
  handler(req, res);
};
