/* Full local dashboard. Same shape as the source extension:
 * day picker, sortable table, export JSON, clear. Reads from
 * chrome.storage.local so the data shown is whatever this browser
 * has accumulated — NOT the synced server view. For the cross-device
 * server view, open the admin dashboard. */

let allStats = {};
let currentDay = null;
let sortKey = 'activeMs';
let sortDir = -1;

function fmtTime(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function load() {
  const r = await chrome.storage.local.get('stats');
  allStats = r.stats || {};
  const days = Object.keys(allStats).sort().reverse();
  const today = todayKey();
  if (!days.includes(today)) days.unshift(today);
  const sel = document.getElementById('day');
  sel.innerHTML = '';
  for (const d of days) {
    const opt = document.createElement('option');
    opt.value = d;
    opt.textContent = d === today ? `${d} (today)` : d;
    sel.appendChild(opt);
  }
  currentDay = today;
  sel.value = today;
  render();
}

function render() {
  const data = allStats[currentDay] || {};
  const rows = Object.entries(data).map(([domain, v]) => ({ domain, ...v }));
  rows.sort((a, b) => {
    const av = a[sortKey], bv = b[sortKey];
    if (typeof av === 'string') return sortDir * av.localeCompare(bv);
    return sortDir * (av - bv);
  });

  const totalMs = rows.reduce((s, r) => s + r.activeMs, 0);
  const totalOpens = rows.reduce((s, r) => s + r.opens, 0);
  document.getElementById('s-sites').textContent = rows.length;
  document.getElementById('s-visits').textContent = totalOpens;
  document.getElementById('s-active').textContent = fmtTime(totalMs);

  document.querySelectorAll('th[data-sort]').forEach(th => {
    const arrow = th.querySelector('.arrow');
    arrow.textContent = th.dataset.sort === sortKey ? (sortDir === -1 ? '▼' : '▲') : '';
  });

  const tbody = document.querySelector('#tbl tbody');
  tbody.innerHTML = '';
  if (rows.length === 0) {
    document.getElementById('tbl').hidden = true;
    document.getElementById('empty').hidden = false;
    return;
  }
  document.getElementById('tbl').hidden = false;
  document.getElementById('empty').hidden = true;

  const maxMs = Math.max(...rows.map(r => r.activeMs), 1);
  for (const r of rows) {
    const share = totalMs > 0 ? (r.activeMs / totalMs) * 100 : 0;
    const tr = document.createElement('tr');
    const barWidth = Math.max(2, Math.round((r.activeMs / maxMs) * 80));
    tr.innerHTML = `
      <td>${r.domain}</td>
      <td class="num">${r.opens}</td>
      <td class="num">${fmtTime(r.activeMs)}</td>
      <td class="num">${share.toFixed(1)}%<span class="bar" style="width:${barWidth}px"></span></td>
    `;
    tbody.appendChild(tr);
  }
}

document.getElementById('day').addEventListener('change', e => {
  currentDay = e.target.value;
  render();
});

document.querySelectorAll('th[data-sort]').forEach(th => {
  th.addEventListener('click', () => {
    const k = th.dataset.sort;
    if (sortKey === k) sortDir = -sortDir;
    else { sortKey = k; sortDir = k === 'domain' ? 1 : -1; }
    render();
  });
});

document.getElementById('export').addEventListener('click', async () => {
  const r = await chrome.storage.local.get('stats');
  const blob = new Blob([JSON.stringify(r.stats || {}, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `tab-tracker-${todayKey()}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById('opts').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

document.getElementById('clear').addEventListener('click', async () => {
  if (!confirm('Delete all locally tracked data? This cannot be undone. (Synced server data is not affected.)')) return;
  await chrome.storage.local.remove('stats');
  await load();
});

/* ───── Sync row ─────
 * Renders the last-sync metadata + a manual "Sync now" trigger. The
 * background script does its own ~1-min flush + sync; this button is
 * for the "I just need it to land NOW" case (e.g. before closing the
 * laptop, before showing the dashboard to a teammate). */

function fmtRel(ts) {
  if (!ts) return 'never';
  const secs = Math.round((Date.now() - ts) / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

async function renderSyncRow(overrideBusyText) {
  const row = document.getElementById('sync-row');
  const { syncConfig, lastSyncAt, lastSyncStatus } = await chrome.storage.local.get([
    'syncConfig', 'lastSyncAt', 'lastSyncStatus'
  ]);
  if (overrideBusyText) {
    row.innerHTML = `<span class="status-busy">${overrideBusyText}</span>`;
    return;
  }
  if (!syncConfig || !syncConfig.adminUrl || !syncConfig.token || !syncConfig.userId) {
    row.innerHTML = `<span>Sync: not configured.</span> <a id="cfg" href="#">Set up →</a>`;
    document.getElementById('cfg').addEventListener('click', e => {
      e.preventDefault();
      chrome.runtime.openOptionsPage();
    });
    return;
  }
  const cls = (lastSyncStatus && lastSyncStatus.startsWith('error')) ? 'status-err' : 'status-ok';
  const detail = lastSyncStatus && lastSyncStatus !== 'ok' ? ` (${lastSyncStatus})` : '';
  row.innerHTML = `<span>Synced as <b>${syncConfig.name ?? syncConfig.userId}</b></span><span class="${cls}">· Last sync: ${fmtRel(lastSyncAt)}${detail}</span>`;
}

document.getElementById('sync').addEventListener('click', async () => {
  const btn = document.getElementById('sync');
  btn.classList.add('spin');
  btn.disabled = true;
  await renderSyncRow('Syncing now…');
  try {
    await chrome.runtime.sendMessage({ type: 'syncNow' });
  } catch { /* surfaced in status row */ }
  await renderSyncRow();
  btn.classList.remove('spin');
  btn.disabled = false;
});

/* Re-render sync row when storage changes (background updates lastSyncAt). */
chrome.storage.onChanged.addListener(changes => {
  if (changes.lastSyncAt || changes.lastSyncStatus || changes.syncConfig) {
    renderSyncRow();
  }
  if (changes.thresholdMinutes && typeof changes.thresholdMinutes.newValue === 'number') {
    const el = document.getElementById('threshold');
    if (el) el.value = String(changes.thresholdMinutes.newValue);
  }
});

/* Threshold control in the header — saves to both chrome.storage.local
 * (so the content script reacts immediately) and the admin server (so
 * other devices pick it up on next sync). */
async function loadThreshold() {
  const r = await chrome.storage.local.get('thresholdMinutes');
  const el = document.getElementById('threshold');
  if (el) el.value = String(r.thresholdMinutes ?? 30);
}
async function saveThreshold() {
  const el = document.getElementById('threshold');
  if (!el) return;
  const n = parseInt(el.value, 10);
  if (!Number.isFinite(n) || n < 1 || n > 1440) {
    el.value = '30';
    return;
  }
  await chrome.storage.local.set({ thresholdMinutes: n });
  try {
    const { syncConfig: cfg } = await chrome.storage.local.get('syncConfig');
    if (cfg && cfg.adminUrl && cfg.token) {
      await fetch(cfg.adminUrl.replace(/\/+$/, '') + '/api/todos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tt-token': cfg.token },
        body: JSON.stringify({ thresholdMinutes: n }),
      });
    }
  } catch {}
  const saved = document.getElementById('threshold-saved');
  if (saved) {
    saved.style.display = 'inline';
    setTimeout(() => { saved.style.display = 'none'; }, 1800);
  }
}
const thresholdInput = document.getElementById('threshold');
if (thresholdInput) {
  thresholdInput.addEventListener('blur', saveThreshold);
  thresholdInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); thresholdInput.blur(); }
  });
}

load();
renderSyncRow();
loadThreshold();
