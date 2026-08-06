// Spoločné helpery pre všetky stránky.
async function api(path, method = 'GET', body = null) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({ error: 'Neplatná odpoveď servera' }));
  if (!res.ok && !data.error) data.error = `HTTP ${res.status}`;
  return data;
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
