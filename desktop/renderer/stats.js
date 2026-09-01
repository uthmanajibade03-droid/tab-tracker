'use strict';

/*
 * Stats window renderer.
 *
 * Reads everything through `window.stats` (see preload.js) — no Node, no IPC of
 * its own. Builds the DOM with createElement rather than innerHTML: app names
 * and domains come from the OS and from web pages respectively, so neither is
 * trusted as markup.
 */

const daySelect = document.getElementById('day');
const pausedFlag = document.getElementById('paused-flag');
const elTotal = document.getElementById('t-total');
const elApps = document.getElementById('t-apps');
const elTop = document.getElementById('t-top');
const appsChart = document.getElementById('apps-chart');
const appsEmpty = document.getElementById('apps-empty');
const appsNote = document.getElementById('apps-note');
const sitesChart = document.getElementById('sites-chart');
const sitesEmpty = document.getElementById('sites-empty');
const sitesNote = document.getElementById('sites-note');
const footNote = document.getElementById('foot-note');

let payload = null;
let selectedDay = null;

/** `1h 23m`, `12m 04s`, `48s` — matching the pill's formatting. */
function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

/** "Today", "Yesterday", or "Mon 25 Aug". */
function fmtDay(key, today) {
  if (key === today) return 'Today';
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yKey = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
  if (key === yKey) return 'Yesterday';
  return date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

/** {name, activeMs} rows, biggest first, zero-time entries dropped. */
function toRows(bucket) {
  if (!bucket) return [];
  return Object.entries(bucket)
    .map(([name, v]) => ({ name, activeMs: (v && v.activeMs) || 0 }))
    .filter(r => r.activeMs > 0)
    .sort((a, b) => b.activeMs - a.activeMs);
}

/*
 * Bars are scaled against the largest value in the set, not the total, so the
 * top bar always fills the track and smaller ones stay legible. Percentages in
 * the label are still share-of-total, which is the number people actually want.
 */
function renderChart(container, rows, emptyEl, noteEl, limit = 12) {
  container.replaceChildren();
  if (!rows.length) {
    emptyEl.hidden = false;
    noteEl.textContent = '';
    return;
  }
  emptyEl.hidden = true;

  const total = rows.reduce((sum, r) => sum + r.activeMs, 0);
  const max = rows[0].activeMs;
  const shown = rows.slice(0, limit);

  for (const r of shown) {
    const share = total > 0 ? (r.activeMs / total) * 100 : 0;

    const row = document.createElement('div');
    row.className = 'row';
    // The bar is decoration over text that already states both figures.
    row.title = `${r.name} — ${fmtDuration(r.activeMs)} (${share.toFixed(1)}%)`;

    const name = document.createElement('div');
    name.className = 'row-name';
    name.textContent = r.name;

    const value = document.createElement('div');
    value.className = 'row-value';
    value.textContent = `${fmtDuration(r.activeMs)} · ${share.toFixed(1)}%`;

    const track = document.createElement('div');
    track.className = 'row-track';
    const fill = document.createElement('div');
    fill.className = 'row-fill';
    fill.style.width = `${Math.max(0.5, (r.activeMs / max) * 100)}%`;
    track.appendChild(fill);

    row.append(name, value, track);
    container.appendChild(row);
  }

  // Never silently truncate — say what was left out.
  const hidden = rows.length - shown.length;
  noteEl.textContent = hidden > 0
    ? `top ${shown.length} of ${rows.length}`
    : `${rows.length} tracked`;
}

function render() {
  if (!payload) return;
  const day = selectedDay;
  const appRows = toRows(payload.apps[day]);
  const siteRows = toRows(payload.sites[day]);

  const totalMs = appRows.reduce((sum, r) => sum + r.activeMs, 0);
  elTotal.textContent = totalMs > 0 ? fmtDuration(totalMs) : '—';
  elApps.textContent = appRows.length || '—';
  elTop.textContent = appRows.length ? appRows[0].name : '—';
  elTop.title = appRows.length ? appRows[0].name : '';

  pausedFlag.hidden = !payload.paused;

  renderChart(appsChart, appRows, appsEmpty, appsNote);
  renderChart(sitesChart, siteRows, sitesEmpty, sitesNote);

  footNote.textContent = siteRows.length
    ? 'Applications tracked by this app; websites by the browser extension.'
    : 'Applications tracked by this app.';
}

function fillDays() {
  daySelect.replaceChildren();
  for (const key of payload.days) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = fmtDay(key, payload.today);
    daySelect.appendChild(opt);
  }
  // Keep the user's chosen day across refreshes; fall back to the newest.
  if (!selectedDay || !payload.days.includes(selectedDay)) {
    selectedDay = payload.days[0] || payload.today;
  }
  daySelect.value = selectedDay;
}

async function refresh() {
  payload = await window.stats.load();
  fillDays();
  render();
}

daySelect.addEventListener('change', () => {
  selectedDay = daySelect.value;
  render();
});

document.getElementById('open-folder').addEventListener('click', () => {
  window.stats.openFolder();
});

window.stats.onChanged(() => { refresh(); });

// ---------------------------------------------------------------------------
// Version + update state
// ---------------------------------------------------------------------------

const versionEl = document.getElementById('version');
const updateLine = document.getElementById('update-line');
const updateBtn = document.getElementById('update-install');

function renderUpdate(s) {
  if (!s) return;
  versionEl.textContent = `v${s.current}`;

  if (s.state === 'downloading') {
    // A percentage only helps if it moves; below 1% it reads as stuck.
    updateLine.textContent = s.percent > 0
      ? `Downloading ${s.version ?? 'update'}… ${s.percent}%`
      : `Downloading ${s.version ?? 'update'}…`;
    updateBtn.hidden = true;
    return;
  }

  if (s.state === 'ready') {
    updateLine.textContent = `Version ${s.version} is ready.`;
    updateBtn.hidden = false;
    return;
  }

  // 'idle', 'checking', or a failed check — say nothing. There is no action
  // for the user to take, and a permanent "up to date" label is just noise.
  updateLine.textContent = '';
  updateBtn.hidden = true;
}

updateBtn.addEventListener('click', () => window.stats.installUpdate());
window.stats.onUpdateStatus(renderUpdate);
window.stats.updateStatus().then(renderUpdate);

// ---------------------------------------------------------------------------
// Voice
// ---------------------------------------------------------------------------

const voiceStatus = document.getElementById('voice-status');
const voiceRoster = document.getElementById('voice-roster');
const voiceEmpty = document.getElementById('voice-empty');
const voiceSetup = document.getElementById('voice-setup');
const vName = document.getElementById('v-name');
const vServer = document.getElementById('v-server');
const vToken = document.getElementById('v-token');
const vSave = document.getElementById('v-save');
const vSaved = document.getElementById('v-saved');

let voiceSnap = null;
// Don't overwrite what someone is mid-way through typing.
let editingSettings = false;

[vName, vServer, vToken].forEach(el => {
  el.addEventListener('focus', () => { editingSettings = true; });
  el.addEventListener('blur', () => { editingSettings = false; });
});

function peerRow(p, inCallPeerIds) {
  const row = document.createElement('div');
  row.className = 'peer';

  const dot = document.createElement('span');
  dot.className = 'peer-dot';
  const talking = inCallPeerIds.has(p.peerId);
  if (!p.reachable) dot.classList.add('away');
  else if (p.busy && !talking) dot.classList.add('busy');

  const name = document.createElement('span');
  name.className = 'peer-name';
  name.textContent = p.name;

  const state = document.createElement('span');
  state.className = 'peer-state';
  if (talking) state.textContent = 'in call with you';
  else if (!p.reachable) state.textContent = 'connecting…';
  else if (p.busy) state.textContent = 'in a call';

  const btn = document.createElement('button');
  if (talking) {
    btn.textContent = 'Hang up';
    btn.className = 'hangup';
    btn.addEventListener('click', () => window.stats.hangUp(p.peerId));
  } else {
    btn.textContent = 'Call';
    btn.disabled = !p.reachable;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Calling…';
      const r = await window.stats.dial(p.peerId);
      if (r && r.ok === false) {
        btn.textContent = 'Failed';
        setTimeout(() => renderVoice(voiceSnap), 1500);
      }
    });
  }

  row.append(dot, name, state, btn);
  return row;
}

function renderVoice(snap) {
  if (!snap) return;
  voiceSnap = snap;

  if (!editingSettings) {
    vName.value = snap.config.name || '';
    vServer.value = snap.config.serverUrl || '';
    // Never round-trip the secret into the DOM; a placeholder says it's set.
    vToken.placeholder = snap.config.hasToken ? '•••••••• (saved)' : "paste your team's token";
  }

  if (!snap.configured) {
    voiceStatus.textContent = 'not set up';
    voiceRoster.replaceChildren();
    voiceEmpty.hidden = false;
    voiceEmpty.textContent = 'Add your name and team token below to appear online and call teammates.';
    voiceSetup.open = true;
    return;
  }

  if (snap.error) voiceStatus.textContent = snap.error;
  else if (!snap.connected) voiceStatus.textContent = 'connecting…';
  else voiceStatus.textContent = snap.inCallWith.length ? 'in a call' : 'online';

  const inCallPeerIds = new Set(snap.inCallWith.map(c => c.peerId));
  voiceRoster.replaceChildren();
  const people = snap.roster;
  if (!people.length) {
    voiceEmpty.hidden = false;
    voiceEmpty.textContent = 'Nobody else is online right now.';
    return;
  }
  voiceEmpty.hidden = true;
  for (const p of people) voiceRoster.appendChild(peerRow(p, inCallPeerIds));
}

vSave.addEventListener('click', async () => {
  vSaved.textContent = 'Saving…';
  const snap = await window.stats.saveVoiceConfig({
    name: vName.value,
    serverUrl: vServer.value,
    token: vToken.value, // blank leaves the stored one alone
  });
  vToken.value = '';
  editingSettings = false;
  vSaved.textContent = snap && snap.name ? 'Saved' : 'Enter a name first';
  setTimeout(() => { vSaved.textContent = ''; }, 2500);
  window.stats.voiceSnapshot().then(renderVoice);
});

window.stats.onVoice(renderVoice);
window.stats.voiceSnapshot().then(renderVoice);

// ---------------------------------------------------------------------------
// Prayer
// ---------------------------------------------------------------------------

const P = {
  note: document.getElementById('prayer-note'),
  times: document.getElementById('prayer-times'),
  enabled: document.getElementById('p-enabled'),
  adhan: document.getElementById('p-adhan'),
  adhanCustom: document.getElementById('p-adhan-custom'),
  reciter: document.getElementById('p-reciter'),
  surah: document.getElementById('p-surah'),
  ayah: document.getElementById('p-ayah'),
  ayahMax: document.getElementById('p-ayah-max'),
  versePreview: document.getElementById('p-verse'),
  nameSecs: document.getElementById('p-name-secs'),
  delay: document.getElementById('p-delay'),
  verseSecs: document.getElementById('p-verse-secs'),
  save: document.getElementById('p-save'),
  preview: document.getElementById('p-preview'),
  saved: document.getElementById('p-saved'),
};

let prayerSettings = null;
let optionsBuilt = false;

function buildPrayerOptions(s) {
  if (optionsBuilt) return;
  optionsBuilt = true;

  for (const a of s.adhans) {
    const o = document.createElement('option');
    o.value = a.url;
    o.textContent = a.isDefault ? `${a.name} (default)` : a.name;
    P.adhan.appendChild(o);
  }
  // A URL that isn't one of ours still needs somewhere to be selected from.
  const custom = document.createElement('option');
  custom.value = '__custom__';
  custom.textContent = 'Custom URL…';
  P.adhan.appendChild(custom);

  for (const r of s.reciters) {
    const o = document.createElement('option');
    o.value = r.id;
    o.textContent = r.name;
    P.reciter.appendChild(o);
  }

  for (const [num, name, meaning] of s.surahs) {
    const o = document.createElement('option');
    o.value = String(num);
    o.textContent = `${num}. ${name} — ${meaning}`;
    P.surah.appendChild(o);
  }
}

/** Ayah count for the selected surah — the bound on what can be asked for. */
function ayahCount() {
  if (!prayerSettings) return 1;
  const n = Number(P.surah.value);
  const row = prayerSettings.surahs.find(s => s[0] === n);
  return row ? row[3] : 1;
}

function syncAyahBound() {
  const max = ayahCount();
  P.ayah.max = String(max);
  P.ayahMax.textContent = `of ${max}`;
  if (Number(P.ayah.value) > max) P.ayah.value = String(max);
}

function renderPrayer(s) {
  prayerSettings = s;
  buildPrayerOptions(s);

  P.enabled.checked = s.enabled;
  P.reciter.value = s.reciter;

  const known = s.adhans.some(a => a.url === s.adhanUrl);
  P.adhan.value = known ? s.adhanUrl : '__custom__';
  P.adhanCustom.value = known ? '' : s.adhanUrl;

  P.surah.value = String(s.surah);
  P.ayah.value = String(s.ayah);
  syncAyahBound();

  P.nameSecs.value = String(s.nameSeconds);
  P.delay.value = String(s.verseDelayMinutes);
  P.verseSecs.value = String(s.verseSeconds);

  P.note.textContent = s.enabled
    ? (s.city ? s.city : 'times from your location')
    : 'off';
}

/** Today's five times, with the next one marked. */
async function renderTimes() {
  const t = await window.stats.prayerTimes();
  P.times.replaceChildren();
  if (!t || !t.timings || !Object.keys(t.timings).length) {
    P.times.textContent = '';
    return;
  }
  const now = new Date();
  const entries = Object.entries(t.timings);
  const upcoming = entries.find(([, hhmm]) => {
    const [h, m] = hhmm.split(':').map(Number);
    const when = new Date(now);
    when.setHours(h, m, 0, 0);
    return when > now;
  });

  for (const [name, hhmm] of entries) {
    const cell = document.createElement('div');
    cell.className = 'time-cell' + (upcoming && upcoming[0] === name ? ' next' : '');
    const n = document.createElement('div');
    n.className = 'n';
    n.textContent = name;
    const v = document.createElement('div');
    v.className = 't';
    v.textContent = hhmm;
    cell.append(n, v);
    P.times.appendChild(cell);
  }
}

async function showVersePreview() {
  P.versePreview.hidden = true;
  const r = await window.stats.previewVerse();
  if (!r || !r.ok) {
    P.versePreview.hidden = false;
    P.versePreview.textContent = (r && r.error) || 'Could not load that verse.';
    return;
  }
  P.versePreview.replaceChildren();
  const ar = document.createElement('span');
  ar.className = 'ar';
  ar.textContent = r.verse.arabic;
  const en = document.createElement('span');
  en.className = 'en';
  en.textContent = r.verse.english;
  const rf = document.createElement('span');
  rf.className = 'rf';
  rf.textContent = `Quran ${r.verse.reference}${r.verse.surahName ? ' · ' + r.verse.surahName : ''}`;
  P.versePreview.append(ar, en, rf);
  P.versePreview.hidden = false;
}

P.surah.addEventListener('change', () => { syncAyahBound(); });

P.adhan.addEventListener('change', () => {
  // Choosing a listed recording clears a custom one, so the two controls
  // can never disagree about which will actually play.
  if (P.adhan.value !== '__custom__') P.adhanCustom.value = '';
});

P.save.addEventListener('click', async () => {
  P.saved.textContent = 'Saving…';
  const adhanUrl = P.adhanCustom.value.trim()
    || (P.adhan.value === '__custom__' ? '' : P.adhan.value);
  const next = await window.stats.savePrayer({
    enabled: P.enabled.checked,
    adhanUrl: adhanUrl || undefined,
    reciter: P.reciter.value,
    surah: Number(P.surah.value),
    ayah: Number(P.ayah.value),
    nameSeconds: Number(P.nameSecs.value),
    verseDelayMinutes: Number(P.delay.value),
    verseSeconds: Number(P.verseSecs.value),
  });
  renderPrayer(next);
  P.saved.textContent = 'Saved';
  setTimeout(() => { P.saved.textContent = ''; }, 2500);
  showVersePreview();
  renderTimes();
});

P.preview.addEventListener('click', () => {
  window.stats.previewPrayer();
  P.saved.textContent = 'Playing on the pill…';
  setTimeout(() => { P.saved.textContent = ''; }, 4000);
});

window.stats.prayerSettings().then((s) => {
  renderPrayer(s);
  showVersePreview();
  renderTimes();
});

/*
 * Today's numbers move while the window is open. One second matches the pill's
 * cadence and costs nothing — the payload is a few kilobytes over IPC.
 */
setInterval(() => {
  if (!document.hidden) refresh();
}, 1000);

refresh();
