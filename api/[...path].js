// Zámerná poistka, nie duplicita.
//
// Routovanie na Vercel zabezpečuje rewrite vo vercel.json, ktorý všetky
// /api/* cesty posiela na api/index.js. Tento súbor tu ostáva preto, že
// jednosegmentové cesty (/api/state, /api/db-test) sa doň trafia aj priamo
// cez súborové routovanie — teda aj vtedy, keby rewrite z akéhokoľvek dôvodu
// neplatil. Bez neho by prípadná chyba v konfigurácii zhodila celú appku.
//
// Prečo to bolo treba: Vercel tento catch-all interpretoval, akoby sa volal
// [path].js — čiže púšťal len JEDEN segment. /api/state fungovalo, ale
// /api/children/<id> aj /api/game/start končili na 404 od Vercelu a k funkcii
// sa vôbec nedostali. Preto sa cesta odovzdáva explicitne (viď zistiCestu
// v lib/handler.js) a nespoliehame sa na odhad podľa názvu súboru.
module.exports = require('./index.js');
