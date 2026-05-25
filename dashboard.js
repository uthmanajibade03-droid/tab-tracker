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

document.getElementById('clear').addEventListener('click', async () => {
  if (!confirm('Delete all tracked data? This cannot be undone.')) return;
  await chrome.storage.local.remove('stats');
  await load();
});

load();
