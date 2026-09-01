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

/*
 * Today's numbers move while the window is open. One second matches the pill's
 * cadence and costs nothing — the payload is a few kilobytes over IPC.
 */
setInterval(() => {
  if (!document.hidden) refresh();
}, 1000);

refresh();
