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

function fmtRel(ts) {
  if (!ts) return 'never';
  const secs = Math.round((Date.now() - ts) / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  return `${hours}h ago`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

/* ───────── To-dos tab ──────────────────────────────────────────────
 * Single combined view: Today + Later sections, items from BOTH the
 * personal and shared lists in one feed, each tagged with a small
 * P/S pill so the kind is obvious without switching tabs. The add
 * row has a kind chip you click to switch between Personal/Shared. */

let widgetKind = 'personal';

const todoInput = document.getElementById('todo-input');
const todoKindBtn = document.getElementById('todo-kind');
const todoAddBtn = document.getElementById('todo-add-btn');
const todoListEl = document.getElementById('todo-list');

function setKind(k) {
  widgetKind = k;
  todoKindBtn.textContent = k === 'shared' ? 'Shared' : 'Personal';
  todoKindBtn.classList.toggle('personal', k === 'personal');
  todoKindBtn.classList.toggle('shared', k === 'shared');
  todoInput.placeholder = k === 'shared' ? 'Add a shared to-do…' : 'Add a personal to-do…';
}
todoKindBtn.addEventListener('click', () => {
  setKind(widgetKind === 'personal' ? 'shared' : 'personal');
});

async function renderTodos() {
  const r = await chrome.storage.local.get(['todos.personal', 'todos.shared']);
  const personal = (r['todos.personal'] || []).map(t => ({ ...t, kind: 'personal' }));
  const shared = (r['todos.shared'] || []).map(t => ({ ...t, kind: 'shared' }));
  const all = [...personal, ...shared];
  const open = all.filter(t => !t.completed);
  const today = open.filter(t => t.bucket !== 'later').sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const later = open.filter(t => t.bucket === 'later').sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const done = all.filter(t => t.completed)
    .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))
    .slice(0, 5);

  function row(t) {
    const pill = t.kind === 'shared'
      ? `<span class="pill s" title="Shared">S</span>`
      : `<span class="pill p" title="Personal">P</span>`;
    const meta = t.createdByName && t.kind === 'shared'
      ? ` <span style="color:#aaa;font-size:10px">by ${escapeHtml(t.createdByName)}</span>` : '';
    const klass = t.completed ? 'item done' : 'item';
    return `
      <div class="${klass}" data-id="${escapeHtml(t.id)}" data-kind="${t.kind}">
        <input type="checkbox" data-action="toggle" ${t.completed ? 'checked' : ''} />
        <div class="txt">${pill}${escapeHtml(t.text)}${meta}</div>
        <div class="actions">
          ${!t.completed ? `<button data-action="bucket" title="${t.bucket === 'later' ? 'Move to today' : 'Move to later'}">${t.bucket === 'later' ? '↑' : '↓'}</button>` : ''}
          <button class="del" data-action="delete" title="Delete">✕</button>
        </div>
      </div>
    `;
  }

  let html = '';
  if (today.length === 0 && later.length === 0 && done.length === 0) {
    html = `<div class="empty">No to-dos yet. Add one above, or use the right-click menu / Cmd-Shift-T.</div>`;
  } else {
    if (today.length > 0) {
      html += `<div class="section-head">Today · ${today.length}</div>` + today.map(row).join('');
    }
    if (later.length > 0) {
      html += `<div class="section-head">Later · ${later.length}</div>` + later.map(row).join('');
    }
    if (done.length > 0) {
      html += `<div class="section-head">Done · ${done.length}</div>` + done.map(row).join('');
    }
  }
  todoListEl.innerHTML = html;
}

async function submitAdd() {
  const text = todoInput.value.trim();
  if (!text) return;
  todoInput.value = '';
  await chrome.runtime.sendMessage({ type: 'addTodo', kind: widgetKind, text });
  renderTodos();
}
todoAddBtn.addEventListener('click', submitAdd);
todoInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); submitAdd(); }
  if (e.key === 'Tab' && e.shiftKey) {
    e.preventDefault();
    setKind(widgetKind === 'personal' ? 'shared' : 'personal');
  }
});

todoListEl.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const itemEl = btn.closest('[data-id]');
  if (!itemEl) return;
  const id = itemEl.dataset.id;
  const kind = itemEl.dataset.kind;
  const action = btn.dataset.action;
  const key = kind === 'shared' ? 'todos.shared' : 'todos.personal';
  const r = await chrome.storage.local.get(key);
  const items = Array.isArray(r[key]) ? r[key] : [];
  const todo = items.find(t => t.id === id);
  if (!todo) return;
  if (action === 'toggle') {
    const next = { ...todo, completed: !todo.completed, completedAt: todo.completed ? undefined : new Date().toISOString() };
    await chrome.runtime.sendMessage({ type: 'patchTodo', kind, todo: next });
  } else if (action === 'delete') {
    await chrome.runtime.sendMessage({ type: 'deleteTodo', kind, id });
  } else if (action === 'bucket') {
    const next = { ...todo, bucket: todo.bucket === 'later' ? 'today' : 'later' };
    await chrome.runtime.sendMessage({ type: 'patchTodo', kind, todo: next });
  }
  renderTodos();
});

/* ───────── Stats tab ──────────────────────────────────────────────── */
async function renderStats() {
  const key = todayKey();
  document.getElementById('date').textContent = key;
  const { stats = {} } = await chrome.storage.local.get(['stats']);
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
  } else {
    document.getElementById('tbl').hidden = false;
    document.getElementById('empty').hidden = true;
    for (const r of rows.slice(0, 12)) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td class="domain" title="${escapeHtml(r.domain)}">${escapeHtml(r.domain)}</td><td class="num">${r.opens}</td><td class="num">${fmtTime(r.activeMs)}</td>`;
      tbody.appendChild(tr);
    }
    const totalMs = rows.reduce((a, r) => a + r.activeMs, 0);
    const totalOpens = rows.reduce((a, r) => a + r.opens, 0);
    document.getElementById('totals').textContent =
      `${rows.length} sites · ${totalOpens} visits · ${fmtTime(totalMs)} active`;
  }

  const { syncConfig, lastSyncAt, lastSyncStatus } = await chrome.storage.local.get([
    'syncConfig', 'lastSyncAt', 'lastSyncStatus'
  ]);
  const syncEl = document.getElementById('sync');
  if (!syncConfig || !syncConfig.adminUrl || !syncConfig.token) {
    syncEl.innerHTML = `<span>Sync: not configured</span><a id="cfg" href="#">Set up →</a>`;
    document.getElementById('cfg').addEventListener('click', e => {
      e.preventDefault();
      chrome.runtime.openOptionsPage();
    });
  } else {
    const cls = (lastSyncStatus && lastSyncStatus.startsWith('error')) ? 'status-err' : 'status-ok';
    syncEl.innerHTML = `<span class="${cls}">Last sync: ${fmtRel(lastSyncAt)}${lastSyncStatus && lastSyncStatus !== 'ok' ? ` (${lastSyncStatus})` : ''}</span>`;
  }
}

/* ───────── Settings tab ───────────────────────────────────────────── */
const thresholdInput = document.getElementById('threshold');
const thresholdSaved = document.getElementById('threshold-saved');
const showWidgetToggle = document.getElementById('show-widget');

async function loadSettings() {
  const r = await chrome.storage.local.get(['thresholdMinutes', 'todoWidgetUI']);
  thresholdInput.value = String(r.thresholdMinutes ?? 30);
  const wui = r.todoWidgetUI || {};
  showWidgetToggle.checked = !wui.hidden;
}

/* Save threshold to BOTH local storage AND the admin server. Local update
   is what the content script reads (instant). Server update is what
   other devices + other extensions in the team see on next sync. */
async function saveThreshold() {
  const n = parseInt(thresholdInput.value, 10);
  if (!Number.isFinite(n) || n < 1 || n > 1440) {
    thresholdInput.value = '30';
    return;
  }
  await chrome.storage.local.set({ thresholdMinutes: n });
  try {
    const { syncConfig: cfg } = await chrome.storage.local.get('syncConfig');
    if (cfg && cfg.adminUrl && cfg.token) {
      const url = cfg.adminUrl.replace(/\/+$/, '') + '/api/todos';
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tt-token': cfg.token },
        body: JSON.stringify({ thresholdMinutes: n }),
      });
    }
  } catch {}
  thresholdSaved.hidden = false;
  setTimeout(() => { thresholdSaved.hidden = true; }, 1800);
}
thresholdInput.addEventListener('blur', saveThreshold);
thresholdInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); thresholdInput.blur(); }
});

showWidgetToggle.addEventListener('change', async () => {
  const r = await chrome.storage.local.get('todoWidgetUI');
  const ui = r.todoWidgetUI || {};
  await chrome.storage.local.set({
    todoWidgetUI: { ...ui, hidden: !showWidgetToggle.checked },
  });
});

document.getElementById('open-shortcuts').addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

document.getElementById('test-alert').addEventListener('click', async () => {
  /* Force a fresh sync first so the latest admin-saved duration is in
     storage before we dispatch. Then pull it and pass as override on
     the forceAlert message — that way the test always reflects what
     admin just typed, not the cached value. */
  try { await chrome.runtime.sendMessage({ type: 'todoSyncNow' }); } catch {}
  const r = await chrome.storage.local.get('alertDurationSeconds');
  const dur = (typeof r.alertDurationSeconds === 'number' && r.alertDurationSeconds > 0)
    ? r.alertDurationSeconds : undefined;
  await chrome.runtime.sendMessage({ type: 'forceAlert', durationOverrideSec: dur });
  window.close();
});

/* ───────── Tab switching + footer ─────────────────────────────────── */
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const which = tab.dataset.tab;
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.tabview').forEach(v => v.classList.toggle('active', v.dataset.view === which));
    if (which === 'todos') renderTodos();
    else if (which === 'stats') renderStats();
    else if (which === 'settings') loadSettings();
  });
});

document.getElementById('dash').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
});
document.getElementById('opts').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

/* Always fire a sync on popup open so the lists reflect the server. */
chrome.runtime.sendMessage({ type: 'todoSyncNow' }).catch(() => {});

renderTodos();
