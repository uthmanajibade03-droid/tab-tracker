function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmtTime(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

async function render() {
  const key = todayKey();
  document.getElementById('date').textContent = key;
  const { stats = {} } = await chrome.storage.local.get('stats');
  const today = stats[key] || {};
  const rows = Object.entries(today)
    .map(([domain, v]) => ({ domain, ...v }))
    .sort((a, b) => b.activeMs - a.activeMs);

  const tbody = document.querySelector('#tbl tbody');
  tbody.innerHTML = '';
  if (rows.length === 0) {
    document.getElementById('tbl').hidden = true;
    document.getElementById('empty').hidden = false;
    document.getElementById('totals').textContent = '';
    return;
  }
  document.getElementById('tbl').hidden = false;
  document.getElementById('empty').hidden = true;

  let totalMs = 0, totalOpens = 0;
  for (const r of rows.slice(0, 12)) {
    totalMs += r.activeMs;
    totalOpens += r.opens;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="domain" title="${r.domain}">${r.domain}</td><td class="num">${r.opens}</td><td class="num">${fmtTime(r.activeMs)}</td>`;
    tbody.appendChild(tr);
  }
  const fullTotalMs = rows.reduce((a, r) => a + r.activeMs, 0);
  const fullTotalOpens = rows.reduce((a, r) => a + r.opens, 0);
  document.getElementById('totals').textContent =
    `${rows.length} sites · ${fullTotalOpens} visits · ${fmtTime(fullTotalMs)} active`;
}

document.getElementById('dash').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
});

render();
