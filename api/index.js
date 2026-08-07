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
  const url = req.url || '';
  const jeDiagnostika = url.includes('server-info') || url.includes('db-test');

  if (!store.useKV && !jeDiagnostika) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      error: 'Nie je pripojená databáza, takže sa stav hry nedá ukladať. '
        + 'Doplň na Verceli premenné pre Supabase a znova nasaď projekt (Redeploy).',
      ocakavane_premenne: [
        'SUPABASE_URL (https://<id>.supabase.co) + SUPABASE_SERVICE_ROLE_KEY',
        'alebo (staršie nasadenie) REDIS_URL (rediss://...)',
        'alebo KV_REST_API_URL + KV_REST_API_TOKEN',
      ],
      diagnostika: '/api/server-info',
    }));
    return;
  }
  handler(req, res);
};
