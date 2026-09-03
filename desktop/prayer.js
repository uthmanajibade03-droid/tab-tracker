'use strict';

/*
 * Prayer times for the pill.
 *
 * Deliberately independent of the browser extension: prayer reminders should
 * fire whether or not Chrome happens to be open, so the desktop app does its
 * own lookup rather than waiting to be told over the bridge.
 *
 * Three public services, none needing a key or an account:
 *   location → ipwho.is, then geojs.io, then ipapi.co
 *   timings  → api.aladhan.com
 *   verse    → api.alquran.cloud
 *
 * Only verse REFERENCES are bundled here. The Arabic and the translation are
 * fetched and cached rather than transcribed into source — scripture typed
 * from memory is scripture typed wrong.
 */

const fs = require('fs');
const path = require('path');

const PRAYER_NAMES = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];

const { SURAHS } = require('./surahs');

/* Every reciter here was checked against everyayah.com rather than copied from
   a list — a name that 404s would fail silently at prayer time, which is the
   worst possible moment to discover it. */
const RECITERS = [
  { id: 'Husary_128kbps', name: 'Mahmoud Khalil Al-Husary' },
  { id: 'Husary_Muallim_128kbps', name: 'Al-Husary (Muallim)' },
  { id: 'Alafasy_128kbps', name: 'Mishary Rashid Alafasy' },
  { id: 'Abdul_Basit_Murattal_192kbps', name: 'Abdul Basit (Murattal)' },
  { id: 'Minshawy_Murattal_128kbps', name: 'Al-Minshawi (Murattal)' },
  { id: 'Abdurrahmaan_As-Sudais_192kbps', name: 'Abdurrahman As-Sudais' },
  { id: 'Saood_ash-Shuraym_128kbps', name: 'Saud Ash-Shuraim' },
  { id: 'Hudhaify_128kbps', name: 'Ali Al-Hudhaify' },
  { id: 'Muhammad_Ayyoub_128kbps', name: 'Muhammad Ayyoub' },
  { id: 'Ghamadi_40kbps', name: 'Saad Al-Ghamdi' },
];

/* Likewise verified. The custom field means this list is a convenience, not a
   ceiling — any reachable mp3 URL works. */
const ADHANS = [
  { url: 'https://www.islamcan.com/audio/adhan/azan1.mp3', name: 'Adhan 1' },
  // The one the app has always used. Flagged so it stays findable in the list
  // however far someone wanders through the alternatives.
  { url: 'https://www.islamcan.com/audio/adhan/azan2.mp3', name: 'Adhan 2', isDefault: true },
  { url: 'https://www.islamcan.com/audio/adhan/azan3.mp3', name: 'Adhan 3' },
  { url: 'https://www.islamcan.com/audio/adhan/azan4.mp3', name: 'Adhan 4' },
  { url: 'https://www.islamcan.com/audio/adhan/azan5.mp3', name: 'Adhan 5' },
  { url: 'https://www.islamcan.com/audio/adhan/azan6.mp3', name: 'Adhan 6' },
  { url: 'https://www.islamcan.com/audio/adhan/azan7.mp3', name: 'Adhan 7' },
  { url: 'https://www.islamcan.com/audio/adhan/azan8.mp3', name: 'Adhan 8' },
];

const DEFAULT_ADHAN_URL = ADHANS[1].url;

const DEFAULTS = {
  enabled: true,
  nameSeconds: 8,
  verseDelayMinutes: 5,
  verseSeconds: 14,
  adhanUrl: DEFAULT_ADHAN_URL,
  reciter: 'Husary_128kbps',
  /* The verse recited after the call to prayer. Chosen, not rotated —
     24:37 is only a starting point. */
  surah: 24,
  ayah: 37,
  method: 2, // ISNA
};

/** Clamp a surah/ayah pair to something that actually exists. */
function normaliseRef(surah, ayah) {
  const s = Math.min(114, Math.max(1, Math.round(Number(surah) || 1)));
  const maxAyah = SURAHS[s - 1][3];
  const a = Math.min(maxAyah, Math.max(1, Math.round(Number(ayah) || 1)));
  return { surah: s, ayah: a };
}

/*
 * setTimeout stores its delay in a 32-bit int, so anything beyond ~24.8 days
 * fires immediately. Prayer times are always within a day, but a wrong clock
 * or a stale schedule could still produce a huge delay — cap and re-arm.
 */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/* A prayer whose moment passed while the machine was asleep should be let go,
   not fired hours late. Matches the extension's 10-minute window. */
const STALE_MS = 10 * 60 * 1000;

const GEO_PROVIDERS = [
  {
    url: 'https://ipwho.is/',
    parse: j => (j && j.success !== false && typeof j.latitude === 'number')
      ? { latitude: j.latitude, longitude: j.longitude, city: j.city, country: j.country }
      : null,
  },
  {
    url: 'https://get.geojs.io/v1/ip/geo.json',
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

let store = { config: null, verses: {}, alert: { ...DEFAULTS } };
let storePath = null;
/* Today's five times, kept from the last successful fetch so the settings
   window can show them without asking Aladhan again on every open. */
let lastTimings = null;
let lastTimingsDate = null;
let onAlert = () => {};
let timers = [];
let refreshTimer = null;

function log(...args) { console.log('[prayer]', ...args); }

function save() {
  if (!storePath) return;
  try {
    const tmp = `${storePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store));
    fs.renameSync(tmp, storePath);
  } catch (err) {
    log('could not save:', err.message);
  }
}

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      store = {
        config: parsed.config || null,
        verses: parsed.verses || {},
        alert: { ...DEFAULTS, ...(parsed.alert || {}) },
      };
      return;
    }
  } catch (err) {
    if (err.code !== 'ENOENT') log('could not read store:', err.message);
  }
  store = { config: null, verses: {}, alert: { ...DEFAULTS } };
}

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
        method: DEFAULTS.method,
      };
    } catch (err) {
      failures.push(`${provider.url} → ${err.message}`);
    }
  }
  throw new Error(`no geolocation provider responded (${failures.join('; ')})`);
}

async function ensureConfig() {
  if (store.config && Number.isFinite(store.config.latitude)) return store.config;
  store.config = await detectLocation();
  save();
  log(`location: ${store.config.city || '?'}, ${store.config.country || '?'}`);
  return store.config;
}

/** The verse the user has chosen to hear after the call to prayer. */
function chosenRef() {
  const { surah, ayah } = normaliseRef(store.alert.surah, store.alert.ayah);
  return `${surah}:${ayah}`;
}

async function fetchVerse(ref) {
  if (store.verses[ref]) return store.verses[ref];
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
    reference: ref,
    surahName: arabic.surah ? arabic.surah.englishName : '',
  };
  store.verses[ref] = verse;
  save();
  return verse;
}

/** Recitation URL for "S:A" in the configured reciter's voice. */
function recitationUrl(ref) {
  const m = String(ref).match(/(\d{1,3})\s*:\s*(\d{1,3})/);
  if (!m) return '';
  const surah = String(parseInt(m[1], 10)).padStart(3, '0');
  const ayah = String(parseInt(m[2], 10)).padStart(3, '0');
  const reciter = RECITERS.some(r => r.id === store.alert.reciter)
    ? store.alert.reciter
    : DEFAULTS.reciter;
  return `https://everyayah.com/data/${reciter}/${surah}${ayah}.mp3`;
}

function clearTimers() {
  for (const t of timers) clearTimeout(t);
  timers = [];
}

function fireName(name) {
  onAlert({
    kind: 'prayer-name',
    prayer: name,
    seconds: store.alert.nameSeconds,
    audioUrl: store.alert.adhanUrl || '',
    // Already in memory — an alert can only be scheduled from a day's timings.
    timings: lastTimings || null,
  });
  // The verse is a separate, later moment — not a second page of the same card.
  const delayMs = Math.max(1000, (store.alert.verseDelayMinutes ?? 5) * 60000);
  timers.push(setTimeout(() => fireVerse(name), Math.min(delayMs, MAX_TIMEOUT_MS)));
}

async function fireVerse(name) {
  let verse = null;
  try {
    verse = await fetchVerse(chosenRef());
  } catch (err) {
    log('verse fetch failed:', err.message);
    const cached = Object.values(store.verses)[0];
    if (!cached) return; // nothing to show; skip rather than show an empty card
    verse = cached;
  }
  onAlert({
    kind: 'prayer-verse',
    prayer: name,
    seconds: store.alert.verseSeconds,
    verse,
    audioUrl: recitationUrl(verse.reference),
  });
}

async function schedule() {
  clearTimers();
  if (!store.alert.enabled) return;

  let cfg;
  try {
    cfg = await ensureConfig();
  } catch (err) {
    log('cannot schedule without a location:', err.message);
    return;
  }

  const d = new Date();
  const dateStr = `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
  let timings;
  try {
    const url = `https://api.aladhan.com/v1/timings/${dateStr}` +
      `?latitude=${cfg.latitude}&longitude=${cfg.longitude}&method=${cfg.method ?? 2}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    timings = j.data && j.data.timings;
    if (!timings) throw new Error('no timings in payload');
  } catch (err) {
    log('could not fetch prayer times:', err.message);
    return;
  }

  const now = Date.now();
  const scheduled = [];
  const parsed = {};
  for (const name of PRAYER_NAMES) {
    const raw = timings[name];
    if (typeof raw !== 'string') continue;
    // Aladhan can append a zone suffix, e.g. "05:05 (EDT)".
    const m = raw.match(/^(\d{1,2}):(\d{2})/);
    if (!m) continue;
    parsed[name] = `${m[1].padStart(2, '0')}:${m[2]}`;
    const when = new Date();
    when.setHours(Number(m[1]), Number(m[2]), 0, 0);
    const delay = when.getTime() - now;
    if (delay <= 0) continue;                 // already passed today
    if (delay > MAX_TIMEOUT_MS) continue;     // absurd clock; the daily refresh re-arms
    timers.push(setTimeout(() => {
      // Re-check on fire: the machine may have slept through the moment.
      if (Date.now() - when.getTime() > STALE_MS) {
        log(`skipping stale ${name}`);
        return;
      }
      fireName(name);
    }, delay));
    scheduled.push(`${name} ${m[1]}:${m[2]}`);
  }
  /* Keep all five regardless of how many are still upcoming — the settings
     window shows the whole day, not just what is left of it. */
  lastTimings = parsed;
  lastTimingsDate = dateStr;
  log(scheduled.length ? `scheduled — ${scheduled.join(', ')}` : 'nothing left today');
}

/** Fire the full sequence now, with short delays, so it can be watched. */
async function runDemo() {
  const name = 'Asr';
  onAlert({
    kind: 'prayer-name',
    prayer: name,
    seconds: 8,
    audioUrl: store.alert.adhanUrl || '',
    // The preview should look like the real thing, times included.
    timings: lastTimings || null,
    demo: true,
  });
  // Long enough to read the name card, short enough to not be a wait.
  timers.push(setTimeout(async () => {
    let verse = null;
    try { verse = await fetchVerse(chosenRef()); } catch { /* handled below */ }
    if (!verse) verse = Object.values(store.verses)[0] || null;
    if (!verse) { log('demo: no verse available'); return; }
    onAlert({
      kind: 'prayer-verse',
      prayer: name,
      seconds: 16,
      verse,
      audioUrl: recitationUrl(verse.reference),
      demo: true,
    });
  }, 11000));
}

function init({ userDataPath, onAlert: cb }) {
  storePath = path.join(userDataPath, 'prayer.json');
  onAlert = typeof cb === 'function' ? cb : () => {};
  load();
  schedule().catch(err => log('initial schedule failed:', err.message));
  // Re-derive hourly: catches midnight rollover and a machine that slept.
  refreshTimer = setInterval(() => {
    schedule().catch(err => log('refresh failed:', err.message));
  }, 60 * 60 * 1000);
}

function stop() {
  clearTimers();
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
}

function status() {
  return {
    enabled: store.alert.enabled,
    city: store.config ? store.config.city : null,
    scheduled: timers.length,
  };
}

/** Everything the settings UI needs: current values plus the available choices. */
function getSettings() {
  const { surah, ayah } = normaliseRef(store.alert.surah, store.alert.ayah);
  return {
    enabled: store.alert.enabled !== false,
    nameSeconds: store.alert.nameSeconds,
    verseDelayMinutes: store.alert.verseDelayMinutes,
    verseSeconds: store.alert.verseSeconds,
    adhanUrl: store.alert.adhanUrl || DEFAULT_ADHAN_URL,
    reciter: store.alert.reciter || DEFAULTS.reciter,
    surah,
    ayah,
    city: store.config ? store.config.city : null,
    reciters: RECITERS,
    adhans: ADHANS,
    surahs: SURAHS,
  };
}

/**
 * Apply settings. Every field is optional and independently validated, so a
 * form that only changed one control cannot reset the others, and a nonsense
 * value falls back to the current one rather than corrupting the schedule.
 */
function setSettings(next) {
  if (!next || typeof next !== 'object') return getSettings();
  const a = store.alert;

  if (typeof next.enabled === 'boolean') a.enabled = next.enabled;

  const num = (v, lo, hi, cur) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n >= lo && n <= hi ? n : cur;
  };
  if (next.nameSeconds !== undefined) a.nameSeconds = num(next.nameSeconds, 2, 120, a.nameSeconds);
  if (next.verseSeconds !== undefined) a.verseSeconds = num(next.verseSeconds, 2, 300, a.verseSeconds);
  if (next.verseDelayMinutes !== undefined) {
    // 0 is meaningful: the verse follows immediately after the Adhan.
    a.verseDelayMinutes = num(next.verseDelayMinutes, 0, 120, a.verseDelayMinutes);
  }

  if (typeof next.reciter === 'string' && RECITERS.some(r => r.id === next.reciter)) {
    a.reciter = next.reciter;
  }

  /* Any https mp3 is allowed, not just the listed ones — but it must at least
     be a URL, or the alert would fail silently at prayer time. */
  if (typeof next.adhanUrl === 'string' && next.adhanUrl.trim()) {
    const url = next.adhanUrl.trim();
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') a.adhanUrl = url;
    } catch { /* keep the existing one */ }
  }

  if (next.surah !== undefined || next.ayah !== undefined) {
    const ref = normaliseRef(
      next.surah !== undefined ? next.surah : a.surah,
      next.ayah !== undefined ? next.ayah : a.ayah,
    );
    a.surah = ref.surah;
    a.ayah = ref.ayah;
  }

  save();
  // Durations and the verse take effect on the next alert, but enabling or
  // disabling changes whether alarms should exist at all.
  schedule().catch(err => log('reschedule after settings failed:', err.message));
  return getSettings();
}

/** Fetch the chosen verse now, so the settings UI can show what was picked. */
async function previewVerse() {
  const ref = chosenRef();
  try {
    const verse = await fetchVerse(ref);
    return { ok: true, verse, audioUrl: recitationUrl(ref) };
  } catch (err) {
    return { ok: false, error: (err && err.message) || 'could not load that verse' };
  }
}

/** Today's times. Re-fetches if the schedule has not run for today yet. */
async function getTimings() {
  const d = new Date();
  const today = `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
  if (!lastTimings || lastTimingsDate !== today) {
    await schedule().catch(() => {});
  }
  return { timings: lastTimings || {}, city: store.config ? store.config.city : null };
}

module.exports = {
  init, stop, runDemo, schedule, status, PRAYER_NAMES,
  getSettings, setSettings, previewVerse, getTimings,
};
