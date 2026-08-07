// Spoločné helpery pre všetky stránky.
async function api(path, method = 'GET', body = null) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);

  let res;
  try {
    res = await fetch(path, opts);
  } catch (e) {
    return { error: 'Server neodpovedá — skontroluj pripojenie na sieť.' };
  }

  const text = await res.text().catch(() => '');
  try {
    const data = text ? JSON.parse(text) : {};
    if (!res.ok && !data.error) data.error = `HTTP ${res.status}`;
    return data;
  } catch (e) {
    // Neprišiel JSON — takmer vždy chybová stránka hostingu (vypršal čas
    // funkcie, pád, zlá cesta). Bez stavového kódu a útržku textu sa to
    // ladí len hádaním, preto ich vraciame do hlášky.
    const utrzok = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140);
    const kde = res.status === 504 || res.status === 408
      ? 'Server nestihol odpovedať (pravdepodobne nedostupná databáza).'
      : res.status === 404
        ? 'Server túto adresu nenašiel (zle nasadené API).'
        : `Server vrátil chybu HTTP ${res.status}.`;
    return { error: `${kde} Skús otvoriť /api/db-test.` + (utrzok ? ` [${utrzok}]` : '') };
  }
}

function el(id) { return document.getElementById(id); }

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function stationLabel(settings, letter) {
  const st = settings.stations.find((s) => s.letter === letter);
  return st ? `${st.letter} — ${st.name} (${st.place})` : letter || '—';
}

function statusLabel(status) {
  return { not_started: 'nezačatá', running: 'beží', paused: 'pozastavená', finished: 'ukončená' }[status] || status;
}
