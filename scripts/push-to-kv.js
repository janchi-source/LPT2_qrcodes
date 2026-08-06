// Nahrá lokálne dáta z data/*.json do KV (Vercel KV / Upstash).
//
// Použitie:
//   KV_REST_API_URL=... KV_REST_API_TOKEN=... node scripts/push-to-kv.js
//
// Pozor: prepíše stav hry, ktorý je v KV. Spúšťaj to pred hrou (napr. keď
// máš deti naimportované lokálne a chceš ich dostať na hosting), nie počas nej.
const store = require('../lib/store');

if (!store.useKV) {
  console.error('Chýbajú premenné KV_REST_API_URL a KV_REST_API_TOKEN.');
  console.error('Nájdeš ich na Vercele: projekt -> Storage -> Upstash Redis -> .env.local');
  process.exit(1);
}

(async () => {
  const doc = {
    settings: store._readFile('settings', null),
    state: store._readFile('state', null),
    children: store._readFile('children', []),
  };
  for (const k of Object.keys(doc)) {
    if (doc[k] === null) delete doc[k]; // nech si appka doplní default
  }

  const pocet = (doc.children || []).length;
  console.log(`Nahrávam: ${pocet} detí, settings=${!!doc.settings}, state=${!!doc.state}`);

  await store._redis(['SET', store._keys.DOC_KEY, JSON.stringify(doc)]);
  await store._redis(['SET', store._keys.VER_KEY, '1']);

  const spat = JSON.parse(await store._redis(['GET', store._keys.DOC_KEY]));
  console.log(`Hotovo. V KV je teraz ${(spat.children || []).length} detí.`);
})().catch((e) => {
  console.error('Chyba pri nahrávaní:', e.message);
  process.exit(1);
});
