const SYNC_CONFIG_KEY = 'syncConfig';

/* Voice server. This is the ONLY thing the extension still needs a
   server for — prayer times come straight from public APIs, and to-dos
   and statistics are stored locally — so the field configures the
   rendezvous Worker that lets teammates find each other, nothing else. */
const DEFAULT_VOICE_URL = 'https://tabtracker.uthman.xyz';

const nameInput = document.getElementById('name');
const urlInput = document.getElementById('url');
const tokInput = document.getElementById('tok');
const statusEl = document.getElementById('status');

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = `status ${cls}`;
}

/* Slugify a display name to a stable URL-safe userId. The slug is what
   gets used as the Redis key; the display name is what the dashboard shows.
   We store both so a name change doesn't silently retire the old user. */
function slugify(name) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

async function load() {
  const r = await chrome.storage.local.get(SYNC_CONFIG_KEY);
  const cfg = r[SYNC_CONFIG_KEY] || {};
  nameInput.value = cfg.name ?? '';
  urlInput.value = cfg.voiceUrl || DEFAULT_VOICE_URL;
  tokInput.value = cfg.token ?? '';

  if (!cfg.name || !cfg.token) {
    setStatus('Enter your name and the team token, then Save. Everything else already works without this.', 'muted');
  } else {
    setStatus(`Set up as "${cfg.name}" (userId: ${cfg.userId}). Teammates can reach you for calls.`, 'ok');
  }
}

function readForm() {
  const name = nameInput.value.trim();
  const voiceUrl = urlInput.value.trim().replace(/\/+$/, '');
  const token = tokInput.value.trim();
  const userId = slugify(name);
  return { name, userId, voiceUrl, token };
}

function validate({ name, userId, voiceUrl, token }) {
  if (!name) return 'Your name is required.';
  if (!userId) return 'Your name must contain at least one letter or number.';
  if (!voiceUrl) return 'Voice server URL is required.';
  if (!token) return 'Team token is required.';
  try { new URL(voiceUrl); } catch { return 'Voice server URL is malformed.'; }
  return null;
}

document.getElementById('save').addEventListener('click', async () => {
  const cfg = readForm();
  const err = validate(cfg);
  if (err) return setStatus(err, 'err');
  await chrome.storage.local.set({ [SYNC_CONFIG_KEY]: cfg });
  setStatus(`Saved as "${cfg.name}" (userId: ${cfg.userId}). Sync will run on the next flush tick (within ~1 minute).`, 'ok');
});

/* Checks the voice server two ways: /api/health proves it's reachable and
   has a token configured, then a real authenticated heartbeat proves the
   token you typed is the right one. Health alone would pass with a wrong
   token, which is exactly the mistake this button exists to catch. */
document.getElementById('test').addEventListener('click', async () => {
  const cfg = readForm();
  const err = validate(cfg);
  if (err) return setStatus(err, 'err');
  await chrome.storage.local.set({ [SYNC_CONFIG_KEY]: cfg });
  setStatus('Testing connection…', 'muted');
  const base = cfg.voiceUrl.replace(/\/+$/, '');
  try {
    const health = await fetch(base + '/api/health', { cache: 'no-store' });
    if (!health.ok) {
      return setStatus(`Server unreachable (HTTP ${health.status}). Check the URL.`, 'err');
    }
    const h = await health.json();
    if (!h.tokenConfigured) {
      return setStatus('Server is up but has no token set. Run: wrangler secret put TT_TOKEN', 'err');
    }
    const res = await fetch(base + '/api/admin/presence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-tt-token': cfg.token },
      body: JSON.stringify({
        userId: cfg.userId,
        name: cfg.name,
        peerId: `pending-${cfg.userId}`,
        callWith: [],
      }),
    });
    if (res.status === 401) {
      return setStatus("Server reachable, but that token was rejected. Check it matches the team's token.", 'err');
    }
    if (!res.ok) {
      return setStatus(`Server returned HTTP ${res.status}.`, 'err');
    }
    const j = await res.json();
    setStatus(`Connected. You're online as "${cfg.name}" — ${j.online} ${j.online === 1 ? 'person' : 'people'} on the roster.`, 'ok');
  } catch (e) {
    setStatus(`Couldn't reach ${base}: ${e.message}`, 'err');
  }
});

document.getElementById('clear').addEventListener('click', async () => {
  if (!confirm('Clear sync configuration? The extension will go back to local-only mode.')) return;
  await chrome.storage.local.remove(SYNC_CONFIG_KEY);
  nameInput.value = '';
  urlInput.value = '';
  tokInput.value = '';
  setStatus('Sync configuration cleared.', 'muted');
});

/* ───── Back link ─────
 * Opens dashboard.html in a new tab. Options page is itself in a tab
 * (open_in_tab: true in manifest), so users don't have an obvious way
 * back without this. */
document.getElementById('back').addEventListener('click', e => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
});

/* ───── Timer badge color ─────
 * Stored under chrome.storage.local.badgeColors = { from, to }.
 * tab-timer.js reads this on every page and applies a linear-gradient
 * background. Live-updates via chrome.storage.onChanged in tab-timer.js
 * so changing colors here repaints every open tab's badge immediately. */
const BADGE_KEY = 'badgeColors';
const BADGE_DEFAULT = { from: '#4DDB9B', to: '#12603D' };

const fromInput = document.getElementById('badgeFrom');
const toInput = document.getElementById('badgeTo');
const preview = document.getElementById('badgePreview');

function applyPreview(from, to) {
  preview.style.background = `linear-gradient(135deg, ${from} 0%, ${to} 100%)`;
}

async function loadBadge() {
  const r = await chrome.storage.local.get(BADGE_KEY);
  const cfg = { ...BADGE_DEFAULT, ...(r[BADGE_KEY] ?? {}) };
  fromInput.value = cfg.from;
  toInput.value = cfg.to;
  applyPreview(cfg.from, cfg.to);
}

async function saveBadge() {
  const from = fromInput.value;
  const to = toInput.value;
  await chrome.storage.local.set({ [BADGE_KEY]: { from, to } });
  applyPreview(from, to);
}

fromInput.addEventListener('input', saveBadge);
toInput.addEventListener('input', saveBadge);

document.getElementById('badgeReset').addEventListener('click', async () => {
  fromInput.value = BADGE_DEFAULT.from;
  toInput.value = BADGE_DEFAULT.to;
  await saveBadge();
});

load();
loadBadge();
