'use strict';

/*
 * Stubs the chrome.* surface the extension's pages use, so popup.html and
 * dashboard.html can be rendered — and screenshotted — outside a real
 * extension. Runs as an Electron preload, which executes before page scripts,
 * so `chrome` exists by the time popup.js looks for it.
 *
 * Everything below is the REAL UI reading REAL code paths. Only the storage
 * behind it is seeded, so a screenshot shows a plausible day rather than an
 * empty state.
 */


function todayKey(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() - offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const mins = (m) => m * 60 * 1000;

const STORE = {
  stats: {
    [todayKey(0)]: {
      'github.com':          { opens: 24, activeMs: mins(96) },
      'figma.com':           { opens: 9,  activeMs: mins(61) },
      'docs.google.com':     { opens: 12, activeMs: mins(38) },
      'youtube.com':         { opens: 7,  activeMs: mins(27) },
      'stackoverflow.com':   { opens: 18, activeMs: mins(14) },
      'mail.google.com':     { opens: 21, activeMs: mins(11) },
      'news.ycombinator.com':{ opens: 5,  activeMs: mins(6) },
      'linear.app':          { opens: 4,  activeMs: mins(5) },
    },
    [todayKey(1)]: {
      'github.com':      { opens: 31, activeMs: mins(142) },
      'docs.google.com': { opens: 14, activeMs: mins(52) },
      'figma.com':       { opens: 6,  activeMs: mins(23) },
    },
    [todayKey(2)]: {
      'linear.app':  { opens: 19, activeMs: mins(74) },
      'github.com':  { opens: 12, activeMs: mins(44) },
    },
  },

  'todos.personal': [
    { id: 't1', text: 'Finish the onboarding copy', bucket: 'today', order: 1, completed: false, createdAt: new Date().toISOString() },
    { id: 't2', text: 'Review the pull request from Kemi', bucket: 'today', order: 2, completed: false, createdAt: new Date().toISOString() },
    { id: 't3', text: 'Book the flights for next month', bucket: 'later', order: 3, completed: false, createdAt: new Date().toISOString() },
    { id: 't4', text: 'Reply to the design feedback', bucket: 'today', order: 4, completed: true, completedAt: new Date().toISOString() },
  ],
  'todos.shared': [
    { id: 's1', text: 'Ship the pricing page', bucket: 'today', order: 1, completed: false, createdByName: 'Kemi', createdAt: new Date().toISOString() },
    { id: 's2', text: 'Agree the launch date', bucket: 'later', order: 2, completed: false, createdByName: 'Rasheed', createdAt: new Date().toISOString() },
  ],

  thresholdMinutes: 30,
  badgeColors: { from: '#4DDB9B', to: '#12603D' },
  todoWidgetUI: { hidden: false },
  lastSyncAt: Date.now() - 42000,
  lastSyncStatus: 'ok',
  desktopAppConnected: false,

  syncConfig: { name: 'Uthman', userId: 'uthman', token: 'demo', voiceUrl: 'https://tabtracker.uthman.xyz' },
  voiceState: { peerId: 'tt-uthman-9k2x', inCallWith: [], ringingFrom: [], hasMic: false },
  voicePresence: [
    { userId: 'kemi', name: 'Kemi', peerId: 'tt-kemi-4b1a', callWith: [] },
    { userId: 'rasheed', name: 'Rasheed', peerId: 'tt-rasheed-77qd', callWith: [] },
  ],
  voiceKnocks: { incoming: [], outgoing: [] },
  voiceIncoming: [],

  salahTimings: { Fajr: '05:05', Dhuhr: '12:57', Asr: '16:38', Maghrib: '19:29', Isha: '20:48' },
  salahAlert: { enabled: true, nameSeconds: 8, verseDelayMinutes: 5, verseSeconds: 14 },
};

function pick(keys) {
  if (keys == null) return { ...STORE };
  const list = Array.isArray(keys) ? keys : [keys];
  const out = {};
  for (const k of list) if (k in STORE) out[k] = STORE[k];
  return out;
}

const chromeStub = {
  storage: {
    local: {
      get: (keys, cb) => {
        const v = pick(typeof keys === 'function' ? null : keys);
        if (typeof keys === 'function') return keys(v);
        if (cb) return cb(v);
        return Promise.resolve(v);
      },
      set: (obj, cb) => { Object.assign(STORE, obj); if (cb) cb(); return Promise.resolve(); },
      remove: (k, cb) => { (Array.isArray(k) ? k : [k]).forEach(x => delete STORE[x]); if (cb) cb(); return Promise.resolve(); },
    },
    onChanged: { addListener() {} },
  },
  runtime: {
    sendMessage: () => Promise.resolve({ ok: true, ms: 0 }),
    getURL: p => p,
    openOptionsPage() {},
    onMessage: { addListener() {} },
    lastError: null,
  },
  tabs: { create() {}, query: () => Promise.resolve([]) },
  alarms: { create() {}, clear: () => Promise.resolve(true), onAlarm: { addListener() {} } },
  idle: { setDetectionInterval() {}, queryState: () => Promise.resolve('active'), onStateChanged: { addListener() {} } },
  windows: { getLastFocused: () => Promise.resolve({ id: 1, focused: true }), onFocusChanged: { addListener() {} } },
  contextMenus: { create() {}, removeAll(cb) { if (cb) cb(); }, onClicked: { addListener() {} } },
  commands: { onCommand: { addListener() {} } },
  action: {},
};

/* Assigned straight onto window rather than through contextBridge: that
   boundary clones values, which mangled the seeded storage and left every
   page rendering an empty state. This harness is local and trusted. */
window.chrome = chromeStub;
