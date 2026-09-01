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

const VERSE_REFERENCES = [
  '2:153', '2:186', '2:286', '3:200', '4:103',
  '13:28', '17:78', '20:14', '23:2', '24:37',
  '29:45', '33:41', '62:9', '65:3', '87:15', '94:6',
];

const DEFAULT_ADHAN_URL = 'https://www.islamcan.com/audio/adhan/azan2.mp3';

const DEFAULTS = {
  enabled: true,
  nameSeconds: 8,
  verseDelayMinutes: 5,
  verseSeconds: 14,
  adhanUrl: DEFAULT_ADHAN_URL,
  method: 2, // ISNA
};

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

function verseRefForToday() {
  return VERSE_REFERENCES[Math.floor(Date.now() / 86400000) % VERSE_REFERENCES.length];
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

/** Husary recitation for "S:A" — same source the extension uses. */
function recitationUrl(ref) {
  const m = String(ref).match(/(\d{1,3})\s*:\s*(\d{1,3})/);
  if (!m) return '';
  const surah = String(parseInt(m[1], 10)).padStart(3, '0');
  const ayah = String(parseInt(m[2], 10)).padStart(3, '0');
  return `https://everyayah.com/data/Husary_128kbps/${surah}${ayah}.mp3`;
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
  });
  // The verse is a separate, later moment — not a second page of the same card.
  const delayMs = Math.max(1000, (store.alert.verseDelayMinutes ?? 5) * 60000);
  timers.push(setTimeout(() => fireVerse(name), Math.min(delayMs, MAX_TIMEOUT_MS)));
}

async function fireVerse(name) {
  let verse = null;
  try {
    verse = await fetchVerse(verseRefForToday());
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
  for (const name of PRAYER_NAMES) {
    const raw = timings[name];
    if (typeof raw !== 'string') continue;
    // Aladhan can append a zone suffix, e.g. "05:05 (EDT)".
    const m = raw.match(/^(\d{1,2}):(\d{2})/);
    if (!m) continue;
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
    demo: true,
  });
  // Long enough to read the name card, short enough to not be a wait.
  timers.push(setTimeout(async () => {
    let verse = null;
    try { verse = await fetchVerse(verseRefForToday()); } catch { /* handled below */ }
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

module.exports = { init, stop, runDemo, schedule, status, PRAYER_NAMES };
