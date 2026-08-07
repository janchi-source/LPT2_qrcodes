// Nahrá lokálne dáta z data/*.json do databázy (Supabase alebo Redis).
//
// Použitie:
//   vercel env pull .env.local
//   node --env-file=.env.local scripts/push-to-kv.js
//
// Pozor: prepíše stav hry, ktorý je v databáze. Spúšťaj to pred hrou (napr.
// keď máš deti naimportované lokálne a chceš ich dostať na hosting), nie
// počas nej.
const store = require('../lib/store');

if (!store._backend) {
  console.error('Appka nevidí žiadnu databázu — nahrávať niet kam.');
  console.error('Nastav SUPABASE_URL a SUPABASE_SERVICE_ROLE_KEY (nájdeš ich');
  console.error('v Supabase: Project Settings -> API), alebo REDIS_URL.');
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
  console.log(`Nahrávam do režimu "${store.mode}": ${pocet} detí, `
    + `settings=${!!doc.settings}, state=${!!doc.state}`);

  // Zapisuje sa cez tú istú cestu ako počas hry (compare-and-swap), takže sa
  // nedá omylom prepísať zápis, ktorý medzitým spravil niekto iný.
  const { version } = await store._backend.nacitaj();
  if (!(await store._backend.zapis(doc, version))) {
    throw new Error('do databázy medzitým zapísal niekto iný — skús to znova');
  }

  const spat = await store._backend.nacitaj();
  console.log(`Hotovo. V databáze je teraz ${(spat.data.children || []).length} detí.`);
})().catch((e) => {
  console.error('Chyba pri nahrávaní:', e.message);
  process.exit(1);
});
