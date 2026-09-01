/* Tab Tracker — service worker.
 *
 * Tracks per-domain active time per day, stored locally in chrome.storage.local
 * under `stats[YYYY-MM-DD][domain] = { opens, activeMs }`. Same model as the
 * source extension at C:/Users/ajiba/Videos/Desktop/tab-tracker.
 *
 * Adds: every flush (1-minute alarm + state transitions), if the user has
 * configured an admin URL + token in the options page, POST today's stats to
 * `${adminUrl}/api/tab-stats`. Fire-and-forget. Local storage stays the
 * source of truth; sync is best-effort enrichment so the admin dashboard
 * can show the data from any device.
 */

const IDLE_SECONDS = 60;
/* Stale prayer-alarm window: if a prayer/verse alarm fires more than this
   many ms after its scheduled time, the chrome.alarms dispatcher skips
   it. Catches the post-sleep wake-up case (Chrome re-fires alarms that
   were due while the SW was asleep). The dispatcher uses
   `alarm.scheduledTime` directly, so this also handles the cross-midnight
   case where re-deriving "today's HH:MM" would give a future timestamp. */
const PRAYER_STALE_MS = 10 * 60 * 1000;
const MAX_FLUSH_MS = 5 * 60 * 1000; // sanity cap per flush — guards against sleep
const SYNC_CONFIG_KEY = 'syncConfig';

/* To-do sync + threshold ─────────────────────────────────────────────
 * The extension fetches the user's personal list + the team-wide shared
 * list + the global category-time threshold on startup and every 2 min.
 * Local changes (add/complete/delete/reorder) optimistically update
 * chrome.storage.local and POST to the server. Last-write-wins per
 * item — fine at team scale.
 *
 * Storage keys:
 *   todos.personal  → array of Todo
 *   todos.shared    → array of Todo
 *   thresholdMinutes → number
 */
const TODOS_PERSONAL_KEY = 'todos.personal';
const TODOS_SHARED_KEY = 'todos.shared';
const THRESHOLD_MINUTES_KEY = 'thresholdMinutes';
const DEFAULT_THRESHOLD_MINUTES = 30;

function newTodoId() {
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function todoSyncOnce() {
  try {
    const { [SYNC_CONFIG_KEY]: cfg } = await chrome.storage.local.get(SYNC_CONFIG_KEY);
    if (!cfg || !cfg.adminUrl || !cfg.token || !cfg.userId) {
      console.log('[Tab Tracker] sync skipped — config missing (adminUrl/token/userId)');
      return;
    }
    const url = cfg.adminUrl.replace(/\/+$/, '') + `/api/todos?user=${encodeURIComponent(cfg.userId)}`;
    const res = await fetch(url, { headers: { 'x-tt-token': cfg.token } });
    if (!res.ok) {
      console.log(`[Tab Tracker] sync failed — ${res.status} from ${url}. Check TAB_TRACKER_TOKEN matches between admin and extension.`);
      await chrome.storage.local.set({ lastTodoSyncStatus: `error ${res.status}`, lastTodoSyncAt: Date.now() });
      return;
    }
    const data = await res.json();
    const personalCount = (data.personal ?? []).length;
    const sharedCount = (data.shared ?? []).length;
    const thr = data.thresholdMinutes ?? DEFAULT_THRESHOLD_MINUTES;
    const dur = data.alertDurationSeconds ?? 4;
    const overuseEnabled = data.overuseEnabled !== false;
    const overuseReminder = typeof data.overuseReminder === 'string' ? data.overuseReminder : '';
    const notifyDistractionDomains = Array.isArray(data.notifyDistractionDomains) ? data.notifyDistractionDomains : [];
    const notifyThresholdMinutes = typeof data.notifyThresholdMinutes === 'number' && data.notifyThresholdMinutes > 0
      ? data.notifyThresholdMinutes
      : DEFAULT_THRESHOLD_MINUTES;
    const teammateAlerts = Array.isArray(data.teammateAlerts) ? data.teammateAlerts : [];
    console.log(
      `[Tab Tracker] sync ok: personal=${personalCount} shared=${sharedCount} thresholdMinutes=${thr} notifyThresholdMinutes=${notifyThresholdMinutes} alertDurationSeconds=${dur} overuseEnabled=${overuseEnabled} distractionDomains=${notifyDistractionDomains.length} pendingAlerts=${teammateAlerts.length}`
    );
    await chrome.storage.local.set({
      [TODOS_PERSONAL_KEY]: data.personal ?? [],
      [TODOS_SHARED_KEY]: data.shared ?? [],
      [THRESHOLD_MINUTES_KEY]: thr,
      alertDurationSeconds: dur,
      overuseEnabled,
      overuseReminder,
      notifyDistractionDomains,
      notifyThresholdMinutes,
      lastTodoSyncStatus: 'ok',
      lastTodoSyncAt: Date.now(),
    });
    for (const alert of teammateAlerts) {
      await enqueuePendingAlert(alert);
    }
  } catch (e) {
    console.log('[Tab Tracker] sync threw:', (e && e.message) || e);
    await chrome.storage.local.set({ lastTodoSyncStatus: `error ${(e && e.message) || e}`, lastTodoSyncAt: Date.now() });
  }
}

/* Single pending-alert queue for everything visible the tab-timer might
   render — teammate notifications, self heads-ups, prayer name, prayer
   verse. Pushed by background, pulled one-at-a-time by visible http(s)
   tabs. Survives SW restart because chrome.storage.local persists. */
async function enqueuePendingAlert(alert) {
  if (!alert || typeof alert !== 'object') return;
  try {
    const r = await chrome.storage.local.get('pendingTeammateAlerts');
    const pending = Array.isArray(r.pendingTeammateAlerts) ? r.pendingTeammateAlerts : [];
    const next = [...pending, alert];
    /* Cap at 50 so a long offline stretch can't unbounded-grow. */
    const trimmed = next.length > 50 ? next.slice(next.length - 50) : next;
    await chrome.storage.local.set({ pendingTeammateAlerts: trimmed });
    console.log(`[Tab Tracker] enqueued alert kind=${alert.kind} (queue size: ${trimmed.length})`);
  } catch (e) { console.log('[Tab Tracker] enqueue failed:', e && e.message); }
}

async function postTodo(kind, todo) {
  try {
    const { [SYNC_CONFIG_KEY]: cfg } = await chrome.storage.local.get(SYNC_CONFIG_KEY);
    if (!cfg || !cfg.adminUrl || !cfg.token || !cfg.userId) return;
    const url = cfg.adminUrl.replace(/\/+$/, '') + '/api/todos';
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-tt-token': cfg.token },
      body: JSON.stringify({ kind, userId: cfg.userId, todo }),
    });
  } catch {}
}

/* Offender's tab fires this when its per-site overuse alert crosses a
 * fresh threshold multiple on a distraction-listed site. The admin
 * server fans the popup out to teammates' queues; the offender's heads-
 * up payload comes back on their next /api/todos poll. Fire-and-forget. */
async function postNotifyTeammates(domain, minutes) {
  try {
    const { [SYNC_CONFIG_KEY]: cfg } = await chrome.storage.local.get(SYNC_CONFIG_KEY);
    if (!cfg || !cfg.adminUrl || !cfg.token || !cfg.userId) return;
    const url = cfg.adminUrl.replace(/\/+$/, '') + '/api/notify';
    const body = JSON.stringify({
      senderId: cfg.userId,
      senderName: cfg.name || cfg.userId,
      domain,
      minutes,
    });
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-tt-token': cfg.token },
      body,
    });
    if (res.ok) {
      const data = await res.json().catch(() => null);
      const fanout = data && typeof data.fanout === 'number' ? data.fanout : '?';
      console.log(`[Tab Tracker] teammate notify posted: ${domain} ${minutes}min (fanout=${fanout})`);
    } else {
      console.log(`[Tab Tracker] teammate notify failed: ${res.status}`);
    }
  } catch (e) {
    console.log('[Tab Tracker] teammate notify threw:', (e && e.message) || e);
  }
}

async function deleteTodoRemote(kind, id) {
  try {
    const { [SYNC_CONFIG_KEY]: cfg } = await chrome.storage.local.get(SYNC_CONFIG_KEY);
    if (!cfg || !cfg.adminUrl || !cfg.token || !cfg.userId) return;
    const url = cfg.adminUrl.replace(/\/+$/, '') +
      `/api/todos?kind=${kind}&id=${id}` +
      (kind === 'personal' ? `&user=${encodeURIComponent(cfg.userId)}` : '');
    await fetch(url, { method: 'DELETE', headers: { 'x-tt-token': cfg.token } });
  } catch {}
}

/* Context menu — right-click any selected text → "Add to Tab Tracker to-dos".
   Fires only on selection (Chrome enforces via "selection" context). */
function ensureContextMenu() {
  try {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: 'tt-add-todo',
        title: 'Add to Tab Tracker to-dos',
        contexts: ['selection'],
      });
    });
  } catch {}
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'tt-add-todo') return;
  const text = (info.selectionText ?? '').trim().slice(0, 500);
  if (!text) return;
  const todo = {
    id: newTodoId(),
    text,
    bucket: 'today',
    order: Date.now(),
    completed: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sourceUrl: tab && tab.url ? String(tab.url).slice(0, 500) : undefined,
  };
  const r = await chrome.storage.local.get(TODOS_PERSONAL_KEY);
  const list = Array.isArray(r[TODOS_PERSONAL_KEY]) ? r[TODOS_PERSONAL_KEY] : [];
  await chrome.storage.local.set({ [TODOS_PERSONAL_KEY]: [...list, todo] });
  await postTodo('personal', todo);
});

/* Salah prayer-time alerts ─────────────────────────────────────────
 * Once a day (and on startup) the background script refreshes today's
 * prayer times, stores them in chrome.storage.local, and schedules a
 * chrome.alarm for each upcoming prayer. When an alarm fires we enqueue
 * a pending alert; the content script picks it up and runs the centred-
 * badge animation showing the prayer name, then the verse follow-up.
 *
 * Times are HH:MM in local time — Aladhan returns them already adjusted
 * for the coordinates we send. */

const PRAYER_NAMES = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];

/* ─────────── Prayer times — no server required ───────────
 * These used to come from {adminUrl}/api/salah, which made a core
 * feature depend on someone else's backend. They now come straight from
 * public APIs so the extension stands alone:
 *
 *   location  → ipapi.co        (once, then cached; overridable in settings)
 *   timings   → api.aladhan.com (free, no key)
 *   verse     → api.alquran.cloud
 *
 * Only the verse REFERENCES are bundled below. The Arabic and the
 * translation are fetched from a proper Quran source and cached rather
 * than hardcoded here, so the text is always authoritative rather than
 * whatever happened to get typed into this file.
 */

const PRAYER_CONFIG_KEY = 'prayerConfig';
const VERSE_CACHE_KEY = 'verseCache';

/* Call to prayer. Overridable in settings; seeded so the Adhan actually
   sounds out of the box rather than the alert firing silently. */
const DEFAULT_ADHAN_URL = 'https://www.islamcan.com/audio/adhan/azan2.mp3';

/* ─────────── Voice backend ───────────
 * Voice gets its own base URL, separate from `adminUrl`. Historically
 * one server did everything — stats, to-dos, prayer times, voice — so a
 * single `adminUrl` sufficed. Prayer times are local now and to-dos
 * work fine offline, which leaves voice as the only feature that still
 * genuinely needs a server: two browsers cannot discover each other
 * without a rendezvous. Splitting the base means pointing voice at your
 * own Worker doesn't drag the other endpoints along with it.
 *
 * Falls back to `adminUrl` so an existing team setup keeps working. */
const DEFAULT_VOICE_URL = 'https://tabtracker.uthman.xyz';

function voiceBase(syncConfig) {
  const base = (syncConfig && (syncConfig.voiceUrl || syncConfig.adminUrl)) || DEFAULT_VOICE_URL;
  return base.replace(/\/+$/, '');
}

function voiceEndpoint(syncConfig, path) {
  return voiceBase(syncConfig) + path;
}

/* Every voice request must carry the shared token — the Worker answers
   401 without it. The original code omitted this header entirely, which
   worked only because the old backend left these routes unauthenticated. */
function voiceHeaders(syncConfig, extra) {
  return { 'x-tt-token': (syncConfig && syncConfig.token) || '', ...(extra || {}) };
}

/* Voice needs an identity and a token; the URL has a default. */
function voiceConfigured(syncConfig) {
  return !!(syncConfig && syncConfig.userId && syncConfig.token);
}

/* Verses on prayer, remembrance, and patience — one is chosen per day. */
const VERSE_REFERENCES = [
  '2:153', '2:186', '2:286', '3:200', '4:103',
  '13:28', '17:78', '20:14', '23:2', '24:37',
  '29:45', '33:41', '62:9', '65:3', '87:15', '94:6',
];

/* Approximate location from the caller's IP, tried across several
   providers. No single free IP-geolocation service is dependable —
   ipapi.co in particular rate-limits after a couple of requests from a
   shared address — so we fall through a list rather than betting the
   whole prayer feature on one host. Runs once; the result is cached in
   prayerConfig and the settings page can overwrite it by hand. */
const GEO_PROVIDERS = [
  {
    url: 'https://ipwho.is/',
    parse: j => (j && j.success !== false && typeof j.latitude === 'number')
      ? { latitude: j.latitude, longitude: j.longitude, city: j.city, country: j.country }
      : null,
  },
  {
    url: 'https://get.geojs.io/v1/ip/geo.json',
    /* geojs returns the coordinates as strings, not numbers. */
    parse: j => (j && j.latitude)
      ? { latitude: parseFloat(j.latitude), longitude: parseFloat(j.longitude), city: j.city, country: j.country }
      : null,
  },
  {
    url: 'https://ipapi.co/json/',
    parse: j => (j && typeof j.latitude === 'number')
      ? { latitude: j.latitude, longitude: j.longitude, city: j.city, country: j.country_name }
      : null,
  },
];

async function detectLocation() {
  const failures = [];
  for (const provider of GEO_PROVIDERS) {
    try {
      const res = await fetch(provider.url, { cache: 'no-store' });
      if (!res.ok) { failures.push(`${provider.url} → ${res.status}`); continue; }
      const parsed = provider.parse(await res.json());
      if (!parsed || !Number.isFinite(parsed.latitude) || !Number.isFinite(parsed.longitude)) {
        failures.push(`${provider.url} → unusable payload`);
        continue;
      }
      return {
        latitude: parsed.latitude,
        longitude: parsed.longitude,
        city: parsed.city || '',
        country: parsed.country || '',
        /* 2 = ISNA. Aladhan supports many calculation methods; this is a
           sane default and is exposed in settings. */
        method: 2,
        autoDetected: true,
      };
    } catch (e) {
      failures.push(`${provider.url} → ${(e && e.message) || e}`);
    }
  }
  throw new Error(`no geolocation provider responded (${failures.join('; ')})`);
}

async function ensurePrayerConfig() {
  const r = await chrome.storage.local.get(PRAYER_CONFIG_KEY);
  const cfg = r[PRAYER_CONFIG_KEY];
  if (cfg && typeof cfg.latitude === 'number' && typeof cfg.longitude === 'number') {
    return cfg;
  }
  const detected = await detectLocation();
  await chrome.storage.local.set({ [PRAYER_CONFIG_KEY]: detected });
  console.log(`[Tab Tracker] location detected: ${detected.city}, ${detected.country}`);
  return detected;
}

/* Fetch Arabic + English for a reference, caching by reference so the
   same verse is never fetched twice. */
async function fetchVerse(ref) {
  const r = await chrome.storage.local.get(VERSE_CACHE_KEY);
  const cache = r[VERSE_CACHE_KEY] || {};
  if (cache[ref]) return cache[ref];

  const url = `https://api.alquran.cloud/v1/ayah/${encodeURIComponent(ref)}/editions/quran-uthmani,en.sahih`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`verse ${res.status}`);
  const j = await res.json();
  const arabic = j.data.find(e => e.edition.identifier === 'quran-uthmani');
  const english = j.data.find(e => e.edition.identifier === 'en.sahih');
  if (!arabic || !english) throw new Error('verse payload incomplete');

  const verse = {
    arabic: arabic.text,
    english: english.text,
    /* The dispatcher derives the Husary recitation URL from this, so the
       "Quran S:A" shape matters — see husaryUrlForReference(). */
    reference: `Quran ${ref}`,
    surahName: arabic.surah ? arabic.surah.englishName : '',
  };
  cache[ref] = verse;
  await chrome.storage.local.set({ [VERSE_CACHE_KEY]: cache });
  return verse;
}

/* Rotate through the list by day so the verse changes daily but is
   stable within a day (both prayer dispatches show the same one). */
function verseRefForToday() {
  const daysSinceEpoch = Math.floor(Date.now() / 86400000);
  return VERSE_REFERENCES[daysSinceEpoch % VERSE_REFERENCES.length];
}

async function salahSyncOnce() {
  try {
    const cfg = await ensurePrayerConfig();

    const d = new Date();
    const dateStr = `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
    const url = `https://api.aladhan.com/v1/timings/${dateStr}` +
      `?latitude=${cfg.latitude}&longitude=${cfg.longitude}&method=${cfg.method ?? 2}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.log(`[Tab Tracker] prayer times failed — ${res.status}`);
      return;
    }
    const j = await res.json();
    const t = j.data && j.data.timings;
    if (!t) {
      console.log('[Tab Tracker] prayer times payload missing timings');
      return;
    }
    /* Aladhan returns extra entries (Sunrise, Imsak, Midnight…) and can
       append a timezone suffix like "05:05 (EDT)". Keep the five daily
       prayers and normalise to bare HH:MM. */
    const timings = {};
    for (const name of PRAYER_NAMES) {
      const raw = t[name];
      if (typeof raw === 'string') {
        const m = raw.match(/^(\d{1,2}:\d{2})/);
        if (m) timings[name] = m[1];
      }
    }

    /* The verse is best-effort: a network failure here must not stop the
       prayer alert itself from being scheduled. */
    let verse = null;
    try {
      verse = await fetchVerse(verseRefForToday());
    } catch (e) {
      const prev = await chrome.storage.local.get('salahVerse');
      verse = prev.salahVerse || null; // fall back to yesterday's
      console.log('[Tab Tracker] verse fetch failed, reusing cached:', (e && e.message) || e);
    }

    /* Preserve whatever the user has configured; only seed defaults, and
       backfill adhanUrl for installs that predate it having one. */
    const existing = (await chrome.storage.local.get('salahAlert')).salahAlert;
    const salahAlert = {
      enabled: true,
      nameSeconds: 5,
      verseDelayMinutes: 5,
      verseSeconds: 10,
      ...(existing || {}),
    };
    if (!salahAlert.adhanUrl) salahAlert.adhanUrl = DEFAULT_ADHAN_URL;

    await chrome.storage.local.set({
      salahTimings: timings,
      salahDate: j.data.date ? j.data.date.readable : dateStr,
      salahAlert,
      salahVerse: verse,
    });
    console.log(
      `[Tab Tracker] prayer times ok for ${cfg.city || 'your location'}: ` +
      Object.entries(timings).map(([k, v]) => `${k} ${v}`).join(', ')
    );
    await schedulePrayerAlarms();
  } catch (e) {
    console.log('[Tab Tracker] prayer sync threw:', (e && e.message) || e);
  }
}

async function schedulePrayerAlarms() {
  /* Clear any previous prayer alarms first so we don't accumulate
     duplicates after re-fetching mid-day. */
  for (const name of PRAYER_NAMES) {
    try { await chrome.alarms.clear('prayer:' + name); } catch {}
  }
  const r = await chrome.storage.local.get(['salahTimings', 'salahDate', 'salahAlert']);
  const alert = r.salahAlert || {};
  if (alert.enabled === false) return;
  const timings = r.salahTimings;
  if (!timings) return;

  const now = new Date();
  for (const name of PRAYER_NAMES) {
    const t = timings[name];
    if (!t || typeof t !== 'string') continue;
    const m = t.match(/^(\d{1,2}):(\d{2})/);
    if (!m) continue;
    const h = parseInt(m[1], 10);
    const mm = parseInt(m[2], 10);
    const when = new Date(now);
    when.setHours(h, mm, 0, 0);
    if (when.getTime() <= now.getTime() + 5000) continue; // skip past prayers
    try {
      await chrome.alarms.create('prayer:' + name, { when: when.getTime() });
      console.log(`[Tab Tracker] scheduled ${name} at ${when.toLocaleTimeString()}`);
    } catch {}
  }
}

/* Offscreen-document audio dispatcher. Content scripts hit Chrome's
 * autoplay policy when triggered from chrome.alarms (no recent user
 * gesture in the visitor's tab), so audio in tab-timer.js silently
 * rejects with "play() failed because the user didn't interact". The
 * MV3-blessed workaround is an offscreen document with reason
 * AUDIO_PLAYBACK — Chrome treats it as a first-party extension context
 * and skips the gesture requirement. The doc is created lazily and
 * persists across calls; only one offscreen doc is allowed per
 * extension at a time. */
const OFFSCREEN_URL = 'offscreen.html';
let _ensuringOffscreen = null;

async function ensureOffscreenDocument() {
  if (!chrome.offscreen || typeof chrome.offscreen.createDocument !== 'function') {
    /* Chrome < 109 — no offscreen API. Bail; audio won't play. */
    return false;
  }
  /* hasDocument is only on Chrome 116+. On older Chrome the create call
     itself throws if a doc already exists, which we catch below. */
  if (typeof chrome.offscreen.hasDocument === 'function') {
    try { if (await chrome.offscreen.hasDocument()) return true; } catch {}
  }
  /* Serialise concurrent creation attempts so two simultaneous alarms
     don't both try to create the doc (the second would throw). */
  if (_ensuringOffscreen) return _ensuringOffscreen;
  _ensuringOffscreen = (async () => {
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        /* Both reasons declared because the ONE offscreen doc serves
           two use-cases: prayer-time audio playback AND voice-call
           Peer.js + mic. Chrome allows multiple reasons per doc; we get
           away with a single page instead of fighting the "only one
           offscreen doc per extension" limit. */
        reasons: ['AUDIO_PLAYBACK', 'USER_MEDIA'],
        justification: 'Play Adhan and Quran verse recitation for prayer alerts, and hold WebRTC mic + peer connections for team voice chat.',
      });
      return true;
    } catch (e) {
      const msg = (e && e.message) || '';
      if (msg.toLowerCase().includes('only a single offscreen')) return true; // already exists
      console.log('[Tab Tracker] offscreen create failed:', msg);
      return false;
    } finally {
      _ensuringOffscreen = null;
    }
  })();
  return _ensuringOffscreen;
}

async function playAudio(url) {
  if (!url || typeof url !== 'string') return;
  const ok = await ensureOffscreenDocument();
  if (!ok) return;
  try {
    await chrome.runtime.sendMessage({ target: 'offscreen-audio', action: 'play', url });
  } catch (e) {
    console.log('[Tab Tracker] play audio msg failed:', (e && e.message) || e);
  }
}

async function stopAudio() {
  if (!chrome.offscreen) return;
  if (typeof chrome.offscreen.hasDocument === 'function') {
    try { if (!(await chrome.offscreen.hasDocument())) return; } catch {}
  }
  try {
    await chrome.runtime.sendMessage({ target: 'offscreen-audio', action: 'stop' });
  } catch {}
}

/* Husary recitation URL for a verse reference like "Quran 24:37".
 * Mirrors the helper that was inline in tab-timer.js; moved here so
 * the offscreen-audio dispatch can compute it without depending on
 * the content script. */
function husaryUrlForReference(ref) {
  if (typeof ref !== 'string') return '';
  const m = ref.match(/(\d{1,3})\s*:\s*(\d{1,3})/);
  if (!m) return '';
  const surah = String(parseInt(m[1], 10)).padStart(3, '0');
  const ayah = String(parseInt(m[2], 10)).padStart(3, '0');
  return `https://everyayah.com/data/Husary_128kbps/${surah}${ayah}.mp3`;
}

/* Two-stage prayer notification. Step 1 fires AT prayer time and shows
 * just the prayer name. Step 2 is a SEPARATE notification scheduled
 * `verseDelayMinutes` later that shows the Quran verse. The two are
 * decoupled so the visitor sees a quick first ping and then a reflective
 * follow-up after a configurable delay, rather than one long single
 * animation. */
async function dispatchPrayerNameAlert(prayerName) {
  try {
    const r = await chrome.storage.local.get('salahAlert');
    const alert = r.salahAlert || { enabled: true, nameSeconds: 5, verseDelayMinutes: 5, verseSeconds: 10 };
    if (alert.enabled === false) return;
    /* Same pending-queue model the teammate-notify uses. Push instead of
       sendMessage — if the active tab is chrome:// / newtab / Web Store
       (no content script), sendMessage silently drops; the queue waits
       until the visitor focuses an http(s) tab and pulls. */
    /* Play the Adhan via the offscreen document. Fire-and-forget so
       the visual queue still proceeds even if audio fails. */
    const adhanUrl = typeof alert.adhanUrl === 'string' ? alert.adhanUrl.trim() : '';
    if (adhanUrl) playAudio(adhanUrl).catch(() => {});
    await enqueuePendingAlert({
      kind: 'prayer-name',
      prayer: prayerName,
      nameSeconds: alert.nameSeconds,
      adhanUrl,
    });
    /* Schedule the verse follow-up. `when: timestamp` for one-shot
       firing — chrome.alarms refuses periods under 30s on some Chrome
       builds, but explicit `when` works for any future time. A 0-min
       delay still schedules ~1s out to avoid edge-case "fire instantly"
       behaviour. */
    const delayMin = Math.max(0, alert.verseDelayMinutes ?? 5);
    const when = Date.now() + Math.max(1000, delayMin * 60 * 1000);
    try {
      await chrome.alarms.clear('verse:' + prayerName);
      await chrome.alarms.create('verse:' + prayerName, { when });
      console.log(`[Tab Tracker] scheduled verse follow-up for ${prayerName} at ${new Date(when).toLocaleTimeString()}`);
    } catch {}
  } catch (e) {
    console.log('[Tab Tracker] prayer-name dispatch failed:', (e && e.message) || e);
  }
}

async function dispatchVerseAlert(prayerName) {
  try {
    const r = await chrome.storage.local.get(['salahAlert', 'salahVerse']);
    const alert = r.salahAlert || { enabled: true, nameSeconds: 5, verseDelayMinutes: 5, verseSeconds: 10 };
    if (alert.enabled === false) return;
    const verse = r.salahVerse || null;
    /* Play the Husary recitation via offscreen document. URL derived
       from verse.reference (e.g. "Quran 24:37"). */
    if (verse && verse.reference) {
      const audioUrl = husaryUrlForReference(verse.reference);
      if (audioUrl) playAudio(audioUrl).catch(() => {});
    }
    await enqueuePendingAlert({
      kind: 'prayer-verse',
      prayer: prayerName,
      verseSeconds: alert.verseSeconds,
      verse,
    });
  } catch (e) {
    console.log('[Tab Tracker] verse dispatch failed:', (e && e.message) || e);
  }
}

/* Keyboard shortcut — opens the toolbar popup, which presents a prompt
   for adding a personal to-do. Chrome blocks programmatic opening of
   the popup; openPopup() works for MV3 when called from a user gesture
   (the keyboard shortcut counts). On Linux/older Chrome it might be
   unavailable — fall back to opening the dashboard tab. */
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'quick_add_todo') {
    try {
      if (chrome.action && chrome.action.openPopup) {
        await chrome.action.openPopup();
        return;
      }
    } catch {}
    try {
      chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html#quickAdd') });
    } catch {}
    return;
  }
  if (command === 'toggle_todo_widget') {
    /* Flip the persisted hidden flag. Every open tab's content script
       reacts via the storage.onChanged listener — no per-tab message
       needed. */
    try {
      const r = await chrome.storage.local.get('todoWidgetUI');
      const ui = r.todoWidgetUI || {};
      await chrome.storage.local.set({ todoWidgetUI: { ...ui, hidden: !ui.hidden } });
    } catch {}
    return;
  }
});

/* ─────────── Desktop pill bridge ───────────
 * The companion desktop app (see desktop/) runs a WebSocket server on
 * loopback and shows which *application* has focus. It can't see inside
 * the browser, so we push the current domain over and it renders
 * "Google Chrome · github.com" instead of just "Google Chrome".
 *
 * Strictly optional and strictly additive: if the desktop app isn't
 * running the connection simply fails, we back off, and nothing else in
 * the extension is affected. */
const BRIDGE_URL = 'ws://127.0.0.1:51314';
const BRIDGE_RETRY_MIN_MS = 5000;
const BRIDGE_RETRY_MAX_MS = 60000;

let bridgeSocket = null;
let bridgeRetryMs = BRIDGE_RETRY_MIN_MS;
let bridgeRetryTimer = null;

function bridgeConnect() {
  if (bridgeSocket &&
      (bridgeSocket.readyState === WebSocket.OPEN || bridgeSocket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  let sock;
  try {
    sock = new WebSocket(BRIDGE_URL);
  } catch {
    bridgeScheduleRetry();
    return;
  }
  bridgeSocket = sock;
  sock.addEventListener('open', () => {
    bridgeRetryMs = BRIDGE_RETRY_MIN_MS; // reset backoff after a success
    console.log('[Tab Tracker] desktop pill bridge connected');
    /* Send history straight away so a window opened before the browser was
       running doesn't sit empty until the next throttle window. */
    bridgeSendStats(true);
  });
  sock.addEventListener('close', () => {
    if (bridgeSocket === sock) bridgeSocket = null;
    bridgeScheduleRetry();
  });
  /* 'error' always fires before 'close', so let close own the retry —
     otherwise every failed attempt schedules two. Swallowing it also
     keeps the console clean when the desktop app just isn't running. */
  sock.addEventListener('error', () => {});
}

function bridgeScheduleRetry() {
  if (bridgeRetryTimer) return;
  const wait = bridgeRetryMs;
  bridgeRetryMs = Math.min(bridgeRetryMs * 2, BRIDGE_RETRY_MAX_MS);
  bridgeRetryTimer = setTimeout(() => {
    bridgeRetryTimer = null;
    bridgeConnect();
  }, wait);
}

function bridgeSendDomain(domain, activeMs) {
  if (!domain) return;
  if (!bridgeSocket || bridgeSocket.readyState !== WebSocket.OPEN) {
    bridgeConnect(); // lazily (re)connect; this tick's value is dropped
    return;
  }
  try {
    bridgeSocket.send(JSON.stringify({ type: 'domain', domain, activeMs }));
  } catch { /* socket died mid-send; close handler will reconnect */ }
}

/* Push the full per-day history so the desktop app's stats window can show
   sites beside applications. Sent on connect and then throttled — this is a
   whole-history payload, not a heartbeat, and it only has to be fresh enough
   that a window someone is looking at isn't visibly stale. */
const BRIDGE_STATS_INTERVAL_MS = 30000;
let bridgeStatsSentAt = 0;

async function bridgeSendStats(force) {
  if (!bridgeSocket || bridgeSocket.readyState !== WebSocket.OPEN) return;
  if (!force && Date.now() - bridgeStatsSentAt < BRIDGE_STATS_INTERVAL_MS) return;
  bridgeStatsSentAt = Date.now();
  try {
    const { stats = {} } = await chrome.storage.local.get('stats');
    bridgeSocket.send(JSON.stringify({ type: 'browserStats', stats }));
  } catch { /* not worth retrying; the next tick will try again */ }
}

bridgeConnect();

let state = {
  activeTabId: null,
  activeDomain: null,
  activeStart: null,
  windowFocused: true,
  userActive: true
};
let tabDomains = {};

chrome.idle.setDetectionInterval(IDLE_SECONDS);

async function loadState() {
  const r = await chrome.storage.local.get(['state', 'tabDomains']);
  if (r.state) state = { ...state, ...r.state, activeStart: null };
  if (r.tabDomains) tabDomains = r.tabDomains;
  await pruneClosedTabs();
  await syncCurrentState();
}

async function pruneClosedTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    const live = new Set(tabs.map(t => t.id));
    for (const id of Object.keys(tabDomains)) if (!live.has(Number(id))) delete tabDomains[id];
  } catch {}
}

async function syncCurrentState() {
  try {
    const idleState = await chrome.idle.queryState(IDLE_SECONDS);
    state.userActive = idleState === 'active';
    const win = await chrome.windows.getLastFocused({ populate: false }).catch(() => null);
    state.windowFocused = !!(win && win.focused);
    let domain = null, tabId = null;
    if (state.windowFocused && win) {
      const [active] = await chrome.tabs.query({ active: true, windowId: win.id });
      if (active) {
        domain = domainOf(active.url);
        tabId = active.id;
      }
    }
    await startTracking(tabId, domain);
  } catch (e) {
    console.warn('syncCurrentState failed', e);
  }
}

loadState();

chrome.runtime.onStartup.addListener(() => { loadState(); salahSyncOnce(); });
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('flush', { periodInMinutes: 1 });
  /* 1-min sync (was 2) so threshold edits in admin reach the extension
     fast enough that the visitor feels them. Network cost is trivial — a
     few hundred bytes per minute. */
  chrome.alarms.create('todoSync', { periodInMinutes: 1 });
  /* Salah refresh: once an hour is plenty since prayer times only
     change at midnight. Catches the date rollover and any config edits
     in admin within the hour. */
  chrome.alarms.create('salahSync', { periodInMinutes: 60 });
  /* Voice presence: post our own {peerId, callWith} heartbeat every
     ~24s. Voice roster: poll everyone's presence + our knock inbox
     every ~6s so the mini-panel feels live without the panel itself
     hammering the admin from every open tab. */
  chrome.alarms.create('voicePresence', { periodInMinutes: 0.4 });
  chrome.alarms.create('voiceRoster', { periodInMinutes: 0.1 });
  /* Classify any new domain the visitor has touched today. 5 min cadence
     is a sweet spot — slow enough that we don't spam Claude, fast enough
     and any config edits in admin within the hour. */
  ensureContextMenu();
  loadState();
  todoSyncOnce();
  salahSyncOnce();
});
chrome.alarms.create('flush', { periodInMinutes: 1 });
chrome.alarms.create('todoSync', { periodInMinutes: 1 });
chrome.alarms.create('salahSync', { periodInMinutes: 60 });
chrome.alarms.create('voicePresence', { periodInMinutes: 0.4 });
chrome.alarms.create('voiceRoster', { periodInMinutes: 0.1 });
ensureContextMenu();
todoSyncOnce();
salahSyncOnce();

/* Bring the voice stack up IMMEDIATELY (don't wait ~24s for the first
   heartbeat alarm) so the user's own peerId flips from "pending-*" to
   a real Peer.js ID within a few seconds of extension load. Otherwise
   Call buttons stay disabled for up to a minute while everyone's
   waiting on their offscreen doc to come up. */
(async () => {
  try {
    const { syncConfig } = await chrome.storage.local.get('syncConfig');
    if (!syncConfig || !syncConfig.userId) return;
    /* Wipe the previous session's peerId — it's dead now that the
       extension has restarted. Peer.js will write a fresh one when it
       reconnects; the storage listener below fires an immediate
       heartbeat on that write so teammates see the real ID within
       ~1-3 seconds instead of up to 24. */
    await chrome.storage.local.remove('voicePeerId');
    /* Any ring recorded before this restart is dead — its Peer.js call
       object died with the old offscreen doc, so Accept would dangle. */
    await chrome.storage.local.remove('voiceIncoming');
    await chrome.storage.local.set({ voiceState: { peerId: null, inCallWith: [], ringingFrom: [], hasMic: false } });
    await ensureOffscreenDocument();
    /* Fire first heartbeat (with pending-* peerId — the real one lands
       on the next tick, driven by the storage listener) + roster. */
    sendVoicePresence().catch(e => console.error('[tab-tracker-voice] startup heartbeat', e));
    pollVoiceRoster().catch(e => console.error('[tab-tracker-voice] startup roster', e));
  } catch (e) {
    console.warn('[tab-tracker-voice] startup bring-up failed', e);
  }
})();

/* When the offscreen doc writes voicePeerId (Peer.js has connected to
   the broker), fire an immediate presence heartbeat so teammates see
   our real peerId right away instead of waiting up to 24s for the next
   alarm. Also refresh our own roster so our OWN Call buttons enable
   promptly against teammates who just reconnected. */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.voicePeerId && changes.voicePeerId.newValue) {
    console.log('[tab-tracker-voice] peerId ready:', changes.voicePeerId.newValue, '— posting heartbeat');
    sendVoicePresence().catch(() => {});
  }
});

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function domainOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

async function persist() {
  await chrome.storage.local.set({ state, tabDomains });
}

async function flushActive() {
  if (!state.activeStart) return;
  let elapsed = Date.now() - state.activeStart;
  state.activeStart = null;
  if (elapsed <= 0) return;
  if (elapsed > MAX_FLUSH_MS) elapsed = MAX_FLUSH_MS;
  if (state.activeDomain) {
    const key = todayKey();
    const { stats = {}, dayMeta = {} } = await chrome.storage.local.get(['stats', 'dayMeta']);
    stats[key] = stats[key] || {};
    const dom = stats[key][state.activeDomain] || { opens: 0, activeMs: 0 };
    dom.activeMs += elapsed;
    stats[key][state.activeDomain] = dom;
    /* Day meta — earliest "first active" + latest "last active" stamps,
       persisted alongside stats and synced to admin so the dashboard
       can render a clock-in/clock-out span. */
    const flushEndedAt = Date.now();
    const flushStartedAt = flushEndedAt - elapsed;
    const meta = dayMeta[key] || {};
    if (!meta.firstActiveAt || flushStartedAt < meta.firstActiveAt) {
      meta.firstActiveAt = flushStartedAt;
    }
    if (!meta.lastActiveAt || flushEndedAt > meta.lastActiveAt) {
      meta.lastActiveAt = flushEndedAt;
    }
    dayMeta[key] = meta;
    await chrome.storage.local.set({ stats, dayMeta });
  }
}

async function recordOpen(domain) {
  if (!domain) return;
  const key = todayKey();
  const { stats = {} } = await chrome.storage.local.get('stats');
  stats[key] = stats[key] || {};
  const dom = stats[key][domain] || { opens: 0, activeMs: 0 };
  dom.opens += 1;
  stats[key][domain] = dom;
  await chrome.storage.local.set({ stats });
}

async function startTracking(tabId, domain) {
  state.activeTabId = tabId || null;
  state.activeDomain = domain || null;
  state.activeStart = (tabId && domain && state.windowFocused && state.userActive) ? Date.now() : null;
  await persist();
}

async function transitionTo(tabId, domain) {
  await flushActive();
  await startTracking(tabId, domain);
}

/* Heartbeat from a content script: handles post-sleep wake-up where
   chrome.idle/onActivated events may not have fired. Queries the real
   idle state instead of assuming the user is active just because a
   content script is ticking — otherwise time keeps accumulating on a
   visible tab the user walked away from. */
async function heartbeat(tab) {
  if (!tab || !tab.id) return;
  const domain = domainOf(tab.url);
  if (!domain) return;
  try {
    const win = await chrome.windows.get(tab.windowId);
    if (!win.focused || !tab.active) return;
    state.windowFocused = true;
    const idleState = await chrome.idle.queryState(IDLE_SECONDS);
    state.userActive = idleState === 'active';
    if (!state.userActive) {
      await flushActive();
      return;
    }
    if (state.activeTabId !== tab.id || state.activeDomain !== domain || !state.activeStart) {
      await transitionTo(tab.id, domain);
    }
  } catch {}
}

async function domainElapsedToday(domain) {
  if (!domain) return 0;
  const key = todayKey();
  const { stats = {} } = await chrome.storage.local.get('stats');
  let ms = (stats[key] && stats[key][domain] && stats[key][domain].activeMs) || 0;
  if (state.activeDomain === domain && state.activeStart) {
    ms += Date.now() - state.activeStart;
  }
  return ms;
}

/* ─────────── Sync to admin server ───────────
 *
 * Reads {adminUrl, token} from chrome.storage.local.syncConfig. Sends a full
 * snapshot of TODAY's stats as a single POST. The admin endpoint overwrites
 * today's row, so re-sending the same data is idempotent (last write wins).
 *
 * We don't sync history beyond today on each tick — the admin gets each day's
 * final state from the last tick of that day. If you need to backfill on a
 * fresh device, the dashboard.html "Export JSON" → admin "Import JSON" path
 * covers it (manual one-time).
 *
 * Failures are logged and ignored. Local storage remains authoritative. */

let lastSyncedDigest = null;

async function syncToAdmin() {
  try {
    const { [SYNC_CONFIG_KEY]: cfg } = await chrome.storage.local.get(SYNC_CONFIG_KEY);
    /* All three required for team-mode sync: name (display), userId (slug),
       adminUrl, token. Missing any → skip (local-only mode). */
    if (!cfg || !cfg.adminUrl || !cfg.token || !cfg.userId || !cfg.name) return;
    const key = todayKey();
    const { stats = {}, dayMeta = {} } = await chrome.storage.local.get(['stats', 'dayMeta']);
    const todayStats = stats[key] || {};
    const todayMeta = dayMeta[key] || {};

    /* Digest includes meta so a fresh first/last stamp re-syncs even if
       per-domain stats haven't moved (e.g., visitor just opened a new
       tab and is still on the same domain). */
    const digest = `${cfg.userId}:${key}:${JSON.stringify(todayStats)}:${todayMeta.firstActiveAt ?? 0}:${todayMeta.lastActiveAt ?? 0}`;
    if (digest === lastSyncedDigest) return;

    const url = cfg.adminUrl.replace(/\/+$/, '') + '/api/tab-stats';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-tt-token': cfg.token },
      body: JSON.stringify({
        userId: cfg.userId,
        name: cfg.name,
        date: key,
        stats: todayStats,
        firstActiveAt: todayMeta.firstActiveAt,
        lastActiveAt: todayMeta.lastActiveAt,
      })
    });
    if (res.ok) {
      lastSyncedDigest = digest;
      await chrome.storage.local.set({ lastSyncAt: Date.now(), lastSyncStatus: 'ok' });
    } else {
      await chrome.storage.local.set({ lastSyncAt: Date.now(), lastSyncStatus: `error ${res.status}` });
    }
  } catch (e) {
    await chrome.storage.local.set({ lastSyncAt: Date.now(), lastSyncStatus: `error ${e.message}` });
  }
}

chrome.tabs.onCreated.addListener(tab => {
  const d = domainOf(tab.url || tab.pendingUrl || '');
  if (d) {
    tabDomains[tab.id] = d;
    recordOpen(d);
  }
  persist();
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (!info.url && info.status !== 'complete') return;
  const d = domainOf(tab.url);
  if (!d) return;
  const domainChanged = tabDomains[tabId] !== d;
  if (domainChanged) {
    if (state.activeTabId === tabId) await flushActive();
    tabDomains[tabId] = d;
    await recordOpen(d);
  }
  if (tab.active) {
    const win = await chrome.windows.get(tab.windowId).catch(() => null);
    if (win && win.focused) await transitionTo(tabId, d);
  }
  await persist();
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    await transitionTo(tabId, domainOf(tab.url));
  } catch {}
});

chrome.tabs.onRemoved.addListener(async tabId => {
  if (state.activeTabId === tabId) {
    await flushActive();
    state.activeTabId = null;
    state.activeDomain = null;
  }
  delete tabDomains[tabId];
  await persist();
});

chrome.windows.onFocusChanged.addListener(async windowId => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    state.windowFocused = false;
    await flushActive();
    await persist();
  } else {
    state.windowFocused = true;
    const [active] = await chrome.tabs.query({ active: true, windowId });
    if (active) await transitionTo(active.id, domainOf(active.url));
  }
});

chrome.idle.onStateChanged.addListener(async newState => {
  if (newState === 'active') {
    state.userActive = true;
    await syncCurrentState();
  } else {
    state.userActive = false;
    await flushActive();
    await persist();
  }
});

chrome.alarms.onAlarm.addListener(async a => {
  if (a.name === 'flush') {
    await flushActive();
    await syncCurrentState();
    /* Sync after each flush so the admin sees fresh data within ~1 minute. */
    await syncToAdmin();
    return;
  }
  if (a.name === 'todoSync') {
    await todoSyncOnce();
    return;
  }
  if (a.name === 'salahSync') {
    await salahSyncOnce();
    return;
  }
  if (a.name === 'voicePresence') {
    await sendVoicePresence();
    return;
  }
  if (a.name === 'voiceRoster') {
    try { await pollVoiceRoster(); }
    catch (e) { console.error('[tab-tracker-voice] pollVoiceRoster crashed', e); }
    return;
  }
  if (typeof a.name === 'string' && a.name.startsWith('prayer:')) {
    const name = a.name.split(':')[1];
    /* Stale-alarm guard at the dispatcher: chrome.alarms re-fires alarms
       that were due while the SW was asleep. `a.scheduledTime` is the
       ms-epoch the alarm was MEANT to fire, so this works across midnight
       (where re-deriving "today's HH:MM" gives a future timestamp). */
    if (typeof a.scheduledTime === 'number' && Date.now() - a.scheduledTime > PRAYER_STALE_MS) {
      console.log(`[Tab Tracker] skipped stale ${name} alert: ${Math.round((Date.now() - a.scheduledTime) / 60000)} min late`);
      return;
    }
    console.log(`[Tab Tracker] prayer-name alarm fired: ${name}`);
    await dispatchPrayerNameAlert(name);
    return;
  }
  if (typeof a.name === 'string' && a.name.startsWith('verse:')) {
    const name = a.name.split(':')[1];
    if (typeof a.scheduledTime === 'number' && Date.now() - a.scheduledTime > PRAYER_STALE_MS) {
      console.log(`[Tab Tracker] skipped stale ${name} verse: ${Math.round((Date.now() - a.scheduledTime) / 60000)} min late`);
      return;
    }
    console.log(`[Tab Tracker] verse follow-up alarm fired: ${name}`);
    await dispatchVerseAlert(name);
    return;
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === 'getTabTime') {
    (async () => {
      const tab = sender.tab;
      if (tab) await heartbeat(tab);
      const domain = tab ? domainOf(tab.url) : null;
      const ms = await domainElapsedToday(domain);
      /* Feed the desktop pill. Gated on this being the domain we're
         actually accruing to right now, so a visible-but-unfocused tab
         in another window can't push its domain onto the pill. The
         content script polls once a second, which doubles as the
         heartbeat the pill needs to keep the domain from going stale. */
      if (domain && state.activeDomain === domain && state.activeStart) {
        bridgeSendDomain(domain, ms);
        bridgeSendStats(false); // throttled internally
      }
      sendResponse({ ms });
    })();
    return true; // keep channel open for async sendResponse
  }
  if (msg.type === 'syncNow') {
    /* Manual sync trigger from options page / popup — useful for "test it now". */
    (async () => {
      await syncToAdmin();
      const { lastSyncAt, lastSyncStatus } = await chrome.storage.local.get(['lastSyncAt', 'lastSyncStatus']);
      sendResponse({ lastSyncAt, lastSyncStatus });
    })();
    return true;
  }
  if (msg.type === 'openDashboard') {
    /* From the badge's mini-panel "Open dashboard" link. Content
       scripts can't call chrome.tabs.create themselves — they bounce it
       to the background service worker here. */
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'openOptions') {
    /* From the badge's mini-panel "Settings" button. Same content-script
       limitation as openDashboard — bounce to background. */
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return true;
  }

  /* Force-fire the category alert on the current active tab — used by
     the "Fire test alert" buttons in the popup. Pipes the duration
     override forward so the test reflects whatever value the caller
     fetched fresh from storage (popup does a sync first). */
  if (msg.type === 'forceAlert') {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (tab && tab.id) {
          await chrome.tabs.sendMessage(tab.id, {
            type: 'forceAlert',
            durationOverrideSec: msg.durationOverrideSec,
          });
        }
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e.message || e) });
      }
    })();
    return true;
  }

  /* Add a personal to-do — used by popup quick-add. */
  if (msg.type === 'addTodo') {
    (async () => {
      const text = String(msg.text || '').trim().slice(0, 500);
      if (!text) { sendResponse({ ok: false, error: 'empty' }); return; }
      const kind = msg.kind === 'shared' ? 'shared' : 'personal';
      const todo = {
        id: newTodoId(),
        text,
        bucket: msg.bucket === 'later' ? 'later' : 'today',
        order: Date.now(),
        completed: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const key = kind === 'shared' ? TODOS_SHARED_KEY : TODOS_PERSONAL_KEY;
      const r = await chrome.storage.local.get(key);
      const list = Array.isArray(r[key]) ? r[key] : [];
      await chrome.storage.local.set({ [key]: [...list, todo] });
      await postTodo(kind, todo);
      sendResponse({ ok: true, todo });
    })();
    return true;
  }

  /* Toggle/update a to-do. Caller supplies the full updated record;
     we just persist + sync. */
  if (msg.type === 'patchTodo') {
    (async () => {
      const kind = msg.kind === 'shared' ? 'shared' : 'personal';
      const todo = msg.todo;
      if (!todo || !todo.id) { sendResponse({ ok: false, error: 'missing todo' }); return; }
      const key = kind === 'shared' ? TODOS_SHARED_KEY : TODOS_PERSONAL_KEY;
      const r = await chrome.storage.local.get(key);
      const list = Array.isArray(r[key]) ? r[key] : [];
      const next = list.map(t => (t.id === todo.id ? { ...t, ...todo, updatedAt: new Date().toISOString() } : t));
      const exists = next.some(t => t.id === todo.id);
      const out = exists ? next : [...next, { ...todo, updatedAt: new Date().toISOString() }];
      await chrome.storage.local.set({ [key]: out });
      await postTodo(kind, out.find(t => t.id === todo.id));
      sendResponse({ ok: true });
    })();
    return true;
  }

  /* Delete a to-do. */
  if (msg.type === 'deleteTodo') {
    (async () => {
      const kind = msg.kind === 'shared' ? 'shared' : 'personal';
      const id = String(msg.id || '');
      if (!id) { sendResponse({ ok: false, error: 'missing id' }); return; }
      const key = kind === 'shared' ? TODOS_SHARED_KEY : TODOS_PERSONAL_KEY;
      const r = await chrome.storage.local.get(key);
      const list = Array.isArray(r[key]) ? r[key] : [];
      await chrome.storage.local.set({ [key]: list.filter(t => t.id !== id) });
      await deleteTodoRemote(kind, id);
      sendResponse({ ok: true });
    })();
    return true;
  }

  /* Sync now — manual trigger, lightly used. */
  if (msg.type === 'todoSyncNow') {
    todoSyncOnce().then(() => sendResponse({ ok: true }));
    return true;
  }

  /* Content script reports its per-site overuse alert just fired on a
     distraction-listed domain. Background relays it to /api/notify so
     the server can fan out to teammates. */
  if (msg.type === 'notifyTeammates') {
    const domain = typeof msg.domain === 'string' ? msg.domain : '';
    const minutes = typeof msg.minutes === 'number' && Number.isFinite(msg.minutes) ? msg.minutes : 0;
    if (!domain || minutes <= 0) { sendResponse({ ok: false, error: 'invalid' }); return; }
    postNotifyTeammates(domain, minutes).then(() => sendResponse({ ok: true }));
    return true;
  }

  /* Content script asks for the next pending teammate alert. Returns
     one at a time so the visitor sees a 1-by-1 sequence even when
     several came in the same /api/todos batch. Null when empty. */
  if (msg.type === 'pullTeammateAlert') {
    (async () => {
      try {
        const r = await chrome.storage.local.get('pendingTeammateAlerts');
        const pending = Array.isArray(r.pendingTeammateAlerts) ? r.pendingTeammateAlerts : [];
        if (pending.length === 0) { sendResponse({ alert: null }); return; }
        const [next, ...rest] = pending;
        await chrome.storage.local.set({ pendingTeammateAlerts: rest });
        sendResponse({ alert: next });
      } catch {
        sendResponse({ alert: null });
      }
    })();
    return true;
  }

  /* Content script asks us to stop the currently-playing Adhan or
     verse audio — fires on alert cleanup (timer expiry OR visitor
     tap-to-dismiss after the grace window). Relays to the offscreen
     document. */
  if (msg.type === 'stopAudio') {
    stopAudio().then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }

  /* Content script asks us to start audio playback at a given URL.
     Used by the test-fire path (#ttPrayerTest / #ttAlertTest)
     which fires triggerPrayerNameAlert/triggerVerseAlert directly
     instead of going through dispatchPrayerNameAlert/dispatchVerseAlert
     where the offscreen audio dispatch normally lives. */
  if (msg.type === 'playAudio') {
    const url = typeof msg.url === 'string' ? msg.url : '';
    if (!url) { sendResponse({ ok: false, error: 'missing url' }); return; }
    playAudio(url).then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, error: (e && e.message) || String(e) }));
    return true;
  }

  /* ─── Voice call — offscreen doc broadcasts state ─── */
  if (msg.type === 'voiceState') {
    /* Cache so the mini-panel + popup render immediately on open. */
    chrome.storage.local.set({ voiceState: msg.state });
    return;
  }

  /* ─── Voice call — incoming ring ───
   * The offscreen doc parks an unanswered call and tells us about it.
   * We resolve the caller's peerId to a human name via the last polled
   * roster and persist it, so every surface (floating widget, popup)
   * can render the Accept/Decline prompt from storage alone. */
  if (msg.type === 'voice.incomingRing') {
    (async () => {
      const fromPeerId = msg.peerId;
      const r = await chrome.storage.local.get(['voiceIncoming', 'voicePresence']);
      /* _rosterByPeerId only maps peerId -> userId; the display name lives
         on the full presence records, so resolve against those. */
      const presence = Array.isArray(r.voicePresence) ? r.voicePresence : [];
      const who = presence.find(p => p.peerId === fromPeerId) || null;
      const list = Array.isArray(r.voiceIncoming) ? r.voiceIncoming : [];
      if (!list.some(c => c.peerId === fromPeerId)) {
        list.push({
          peerId: fromPeerId,
          userId: who ? who.userId : null,
          /* Fall back to the raw peerId so an unknown caller still shows
             something rather than "undefined is calling". */
          name: (who && who.name) || fromPeerId,
          at: Date.now(),
        });
        await chrome.storage.local.set({ voiceIncoming: list });
      }
      console.log('[tab-tracker-voice] ringing from', fromPeerId);
    })();
    return;
  }
  if (msg.type === 'voice.ringEnded') {
    (async () => {
      const r = await chrome.storage.local.get('voiceIncoming');
      const list = Array.isArray(r.voiceIncoming) ? r.voiceIncoming : [];
      await chrome.storage.local.set({ voiceIncoming: list.filter(c => c.peerId !== msg.peerId) });
    })();
    return;
  }
  if (msg.type === 'voice.acceptCall') {
    (async () => {
      try {
        const r = await chrome.runtime.sendMessage({ target: 'offscreen-voice', action: 'acceptCall', peerId: msg.peerId });
        sendResponse(r || { ok: false, error: 'no-response' });
      } catch (e) { sendResponse({ ok: false, error: e && e.message }); }
    })();
    return true;
  }
  if (msg.type === 'voice.declineCall') {
    (async () => {
      try {
        const r = await chrome.runtime.sendMessage({ target: 'offscreen-voice', action: 'declineCall', peerId: msg.peerId });
        sendResponse(r || { ok: false });
      } catch (e) { sendResponse({ ok: false, error: e && e.message }); }
    })();
    return true;
  }

  /* ─── Voice call — routing from content script / popup to offscreen ─── */
  if (msg.type === 'voice.startCall') {
    (async () => {
      try {
        await ensureOffscreenDocument();
        const r = await chrome.runtime.sendMessage({ target: 'offscreen-voice', action: 'startCall', peerId: msg.peerId });
        sendResponse(r || { ok: false, error: 'no-response' });
      } catch (e) { sendResponse({ ok: false, error: e && e.message }); }
    })();
    return true;
  }
  if (msg.type === 'voice.endCall') {
    (async () => {
      try {
        const r = await chrome.runtime.sendMessage({ target: 'offscreen-voice', action: 'endCall', peerId: msg.peerId });
        sendResponse(r || { ok: false });
      } catch (e) { sendResponse({ ok: false, error: e && e.message }); }
    })();
    return true;
  }
  if (msg.type === 'voice.endAllCalls') {
    (async () => {
      try {
        const r = await chrome.runtime.sendMessage({ target: 'offscreen-voice', action: 'endAllCalls' });
        sendResponse(r || { ok: false });
      } catch (e) { sendResponse({ ok: false, error: e && e.message }); }
    })();
    return true;
  }
  if (msg.type === 'voice.getState') {
    (async () => {
      try {
        await ensureOffscreenDocument();
        const r = await chrome.runtime.sendMessage({ target: 'offscreen-voice', action: 'getState' });
        sendResponse(r || { peerId: null, inCallWith: [], hasMic: false });
      } catch (e) { sendResponse({ peerId: null, inCallWith: [], hasMic: false, error: e && e.message }); }
    })();
    return true;
  }

  /* Knock / join-meeting — background is the only place that talks to
     the voice backend, so all API state lives in one file. */
  if (msg.type === 'voice.knockRequest') {
    (async () => {
      try {
        const { syncConfig, voicePeerId } = await chrome.storage.local.get(['syncConfig', 'voicePeerId']);
        if (!voiceConfigured(syncConfig)) return sendResponse({ ok: false, error: 'not-configured' });
        if (!voicePeerId) return sendResponse({ ok: false, error: 'peer-not-ready' });
        const r = await fetch(voiceEndpoint(syncConfig, '/api/admin/knock'), {
          method: 'POST',
          headers: voiceHeaders(syncConfig, { 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            fromUserId: syncConfig.userId,
            fromName: syncConfig.name,
            fromPeerId: voicePeerId,
            targets: msg.targets || [],
          }),
        });
        const j = await r.json();
        if (!r.ok) console.warn('[tab-tracker-voice] knock POST failed', r.status, j);
        sendResponse(j);
        pollVoiceRoster().catch(() => {});
      } catch (e) {
        console.error('[tab-tracker-voice] knockRequest exception', e);
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }
  if (msg.type === 'voice.knockAccept') {
    (async () => {
      try {
        const { syncConfig } = await chrome.storage.local.get('syncConfig');
        if (!voiceConfigured(syncConfig)) return sendResponse({ ok: false, error: 'not-configured' });
        const r = await fetch(voiceEndpoint(syncConfig, '/api/admin/knock'), {
          method: 'PATCH',
          headers: voiceHeaders(syncConfig, { 'Content-Type': 'application/json' }),
          body: JSON.stringify({ knockId: msg.knockId, accepterUserId: syncConfig.userId }),
        });
        const j = await r.json();
        if (!r.ok) console.warn('[tab-tracker-voice] knock PATCH failed', r.status, j);
        sendResponse(j);
        pollVoiceRoster().catch(() => {});
      } catch (e) {
        console.error('[tab-tracker-voice] knockAccept exception', e);
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }
  if (msg.type === 'voice.knockCancel') {
    (async () => {
      try {
        const { syncConfig } = await chrome.storage.local.get('syncConfig');
        if (!voiceConfigured(syncConfig)) return sendResponse({ ok: false, error: 'not-configured' });
        await fetch(voiceEndpoint(syncConfig, '/api/admin/knock?id=' + encodeURIComponent(msg.knockId)), {
          method: 'DELETE',
          headers: voiceHeaders(syncConfig),
        });
        sendResponse({ ok: true });
        pollVoiceRoster().catch(() => {});
      } catch (e) {
        console.error('[tab-tracker-voice] knockCancel exception', e);
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }
  if (msg.type === 'voice.pokeRoster') {
    /* Mini-panel calls this on open for immediate freshness. */
    (async () => {
      try { await pollVoiceRoster(); sendResponse({ ok: true }); }
      catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }

});

/* ═══════════════════════════════════════════════════════════════════
 * Voice call — presence heartbeat + roster polling
 * ═══════════════════════════════════════════════════════════════════
 *
 * Presence heartbeat (voicePresence alarm, ~24s):
 *   POST /api/admin/presence { userId, name, peerId, callWith[] }
 *   — advertises "I'm online + my Peer.js ID + who I'm currently talking to"
 *
 * Roster poll (voiceRoster alarm, ~6s):
 *   GET  /api/admin/presence           → who's online now (everyone's entries)
 *   GET  /api/admin/knock?user=me      → my inbox + outbox
 *   — writes results to chrome.storage.local so the mini-panel reads
 *     without hitting admin from every open tab.
 *   — watches our own outbox for knocks that got accepted; when accepted,
 *     dials all participants automatically. */

async function sendVoicePresence() {
  const { syncConfig } = await chrome.storage.local.get('syncConfig');
  if (!voiceConfigured(syncConfig) || !syncConfig.name) return;
  await ensureOffscreenDocument(); // idempotent; brings Peer.js online if not yet
  const { voicePeerId, voiceState } = await chrome.storage.local.get(['voicePeerId', 'voiceState']);
  const remotePeerIds = (voiceState && Array.isArray(voiceState.inCallWith)) ? voiceState.inCallWith : [];
  /* Map remote peerIds → stable userIds using the last polled roster. */
  const callWith = remotePeerIds
    .map(pid => _rosterByPeerId.get(pid))
    .filter(Boolean);
  const url = voiceEndpoint(syncConfig, '/api/admin/presence');
  const body = {
    userId: syncConfig.userId,
    name: syncConfig.name,
    peerId: voicePeerId || `pending-${syncConfig.userId}`,
    callWith,
  };
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: voiceHeaders(syncConfig, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.error('[tab-tracker-voice] presence POST network failed', url, e);
    await chrome.storage.local.set({ voiceLastError: `network: ${e.message}` });
    return;
  }
  if (!res.ok) {
    /* Loud so it's not another silent-failure "nobody online" mystery. */
    let bodyText = '';
    try { bodyText = await res.text(); } catch {}
    console.error('[tab-tracker-voice] presence POST rejected', res.status, url, bodyText);
    await chrome.storage.local.set({ voiceLastError: `HTTP ${res.status}: ${bodyText.slice(0, 200)}` });
    return;
  }
  await chrome.storage.local.set({ voiceLastError: null });
}

let _rosterByUserId = new Map();
let _rosterByPeerId = new Map();
const _knockAcceptsHandled = new Set(); // knockIds we've already dialed on

async function pollVoiceRoster() {
  const { syncConfig } = await chrome.storage.local.get('syncConfig');
  if (!voiceConfigured(syncConfig)) return;
  const headers = voiceHeaders(syncConfig);

  const [presRes, knockRes] = await Promise.allSettled([
    fetch(voiceEndpoint(syncConfig, '/api/admin/presence'), { cache: 'no-store', headers }),
    fetch(voiceEndpoint(syncConfig, '/api/admin/knock?user=' + encodeURIComponent(syncConfig.userId)), { cache: 'no-store', headers }),
  ]);

  let presence = [];
  if (presRes.status === 'fulfilled' && presRes.value.ok) {
    try {
      const j = await presRes.value.json();
      presence = Array.isArray(j.online) ? j.online : [];
    } catch (e) { console.error('[tab-tracker-voice] roster: presence JSON parse failed', e); }
  } else if (presRes.status === 'fulfilled') {
    console.error('[tab-tracker-voice] roster: presence GET rejected', presRes.value.status);
    await chrome.storage.local.set({ voiceLastError: `roster HTTP ${presRes.value.status}` });
  } else {
    console.error('[tab-tracker-voice] roster: presence GET network failed', presRes.reason);
  }

  let knocks = { incoming: [], outgoing: [] };
  if (knockRes.status === 'fulfilled' && knockRes.value.ok) {
    try {
      const j = await knockRes.value.json();
      knocks = {
        incoming: Array.isArray(j.incoming) ? j.incoming : [],
        outgoing: Array.isArray(j.outgoing) ? j.outgoing : [],
      };
    } catch {}
  } else if (knockRes.status === 'fulfilled') {
    console.warn('[tab-tracker-voice] roster: knock GET rejected', knockRes.value.status);
  }

  _rosterByUserId = new Map(presence.map(p => [p.userId, p]));
  _rosterByPeerId = new Map(presence.map(p => [p.peerId, p.userId]));

  /* Watch for accepted outbox knocks — auto-dial all participants. */
  for (const k of knocks.outgoing) {
    if (k.acceptedBy && !_knockAcceptsHandled.has(k.id)) {
      _knockAcceptsHandled.add(k.id);
      handleAcceptedOutgoingKnock(k).catch(e =>
        console.error('[tab-tracker-voice] handleAcceptedOutgoingKnock failed', e));
    }
  }

  await chrome.storage.local.set({
    voicePresence: presence,
    voiceKnocks: knocks,
    voiceRosterAt: Date.now(),
  });
}

async function handleAcceptedOutgoingKnock(k) {
  console.log('[tab-tracker-voice] our knock', k.id, 'was accepted by', k.acceptedBy, '— dialing participants');
  await ensureOffscreenDocument();
  for (const targetUserId of k.targets) {
    const entry = _rosterByUserId.get(targetUserId);
    if (!entry) { console.warn('[tab-tracker-voice] target', targetUserId, 'no longer in roster'); continue; }
    if (String(entry.peerId).startsWith('pending-')) { console.warn('[tab-tracker-voice] target', targetUserId, 'peerId still pending'); continue; }
    try {
      const r = await chrome.runtime.sendMessage({ target: 'offscreen-voice', action: 'startCall', peerId: entry.peerId });
      if (!r || !r.ok) console.warn('[tab-tracker-voice] startCall failed for', targetUserId, r);
    } catch (e) {
      console.error('[tab-tracker-voice] startCall exception for', targetUserId, e);
    }
  }
  /* Clean up the accepted knock — server won't hand it out again. */
  try {
    const { syncConfig } = await chrome.storage.local.get('syncConfig');
    await fetch(voiceEndpoint(syncConfig, '/api/admin/knock?id=' + encodeURIComponent(k.id)), {
      method: 'DELETE',
      headers: voiceHeaders(syncConfig),
    });
  } catch (e) { console.warn('[tab-tracker-voice] knock DELETE failed', e); }
}
