'use strict';

/*
 * Tab Tracker Desktop — main process.
 *
 * A frameless always-on-top "pill" that shows which desktop application has
 * focus and how long the user has spent in it today.
 *
 * Time is accrued into the same shape the browser extension uses:
 *
 *     stats[YYYY-MM-DD][appName] = { opens, activeMs }
 *
 * so a combined dashboard can merge desktop apps and browser domains without
 * any translation layer.
 */

const {
  app, BrowserWindow, Menu, Tray, ipcMain,
  screen, shell, dialog, powerMonitor, nativeImage,
} = require('electron');

const path = require('path');
const fs = require('fs');
const readline = require('readline');
const { spawn } = require('child_process');

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const TICK_MS = 1000;              // accrual + UI refresh cadence
const IDLE_THRESHOLD_S = 60;       // mirrors the extension's 60s idle rule
const PERSIST_DEBOUNCE_MS = 10000; // at most one disk write per 10s

/*
 * The helper samples the foreground window 8x/second but only prints a line
 * when it actually changes, so during a long stretch in one app the stream's
 * cadence is set by its heartbeat — NOT by its poll rate. WATCHER_STALE_MS
 * therefore has to be measured against the heartbeat: at 5s it tolerates two
 * consecutive missed beats before it declares the helper dead and stops
 * accruing. Raising the heartbeat above ~2.4s without raising this constant
 * would make the tracker stall every few seconds while sitting in one app.
 */
const WATCHER_HEARTBEAT_MS = 2000; // must match $HEARTBEAT_MS in focus-watcher.ps1
const WATCHER_STALE_MS = 5000;     // no helper line for this long => unknown

/*
 * How long our own window may hold the foreground, with the user not touching
 * it, before we conclude that the app they were in has gone away.
 *
 * This exists because the pill is always-on-top: when the focused application
 * exits, Windows activates the topmost remaining window — which is us. Ignoring
 * our own PID unconditionally (so that clicking the pill does not hijack the
 * timer) therefore used to pin the display, and the accrual, to an application
 * that no longer exists, indefinitely.
 */
const SELF_FOCUS_GRACE_MS = 1000;
/** How long after a click/drag/resize the pill still counts as "in use". */
const PILL_ATTENTION_MS = 2500;

const BRIDGE_STALE_MS = 10000;     // extension domain older than this => ignore
const BRIDGE_PORT = 51314;
const BRIDGE_HOST = '127.0.0.1';   // loopback only, never 0.0.0.0

// Fail loudly at startup rather than silently losing time later if someone
// edits one of the two constants above without the other.
if (WATCHER_STALE_MS < WATCHER_HEARTBEAT_MS * 2) {
  console.warn('[watcher] WATCHER_STALE_MS is too tight for the helper heartbeat; ' +
    'accrual will stall between heartbeats');
}

/*
 * The pill is resized by dragging its right edge. Width is the only stored
 * dimension: height and every internal metric (type, padding, dot) are derived
 * from it, so the capsule keeps its proportions at any size instead of turning
 * into a differently-shaped object.
 *
 * PILL_ASPECT is the original 52/260, and renderer/pill.css derives the same
 * numbers from the same formula — see --scale there.
 */
const PILL_BASE_WIDTH = 260;
const PILL_ASPECT = 52 / 260;
// 200 rather than a rounder 190: Windows will not give a top-level window a
// height below ~39px, so anything narrower would leave the capsule floating
// inside a window taller than itself.
const PILL_MIN_WIDTH = 200;  // 40px tall
const PILL_MAX_WIDTH = 400;  // 80px tall; beyond this it stops reading as a HUD

function pillHeightFor(width) {
  // Must match the identical expression in pill.js, or the capsule and the
  // window it lives in would disagree by a pixel at some widths.
  return Math.round(width * PILL_ASPECT);
}

// Sanity bound on the height the renderer asks for. The renderer is trusted
// local code, but a measurement bug should not be able to create a window
// taller than the screen.
const MAX_PANEL_HEIGHT = 560;

const SCREEN_MARGIN = 24;

// Raw process names (lowercased) whose foreground time may be attributed to a
// web domain reported by the browser extension over the bridge.
const BROWSER_PROCESSES = new Set([
  'chrome', 'msedge', 'firefox', 'brave', 'opera', 'vivaldi', 'arc', 'chromium',
]);

/*
 * Win32 class names of the Windows desktop itself.
 *
 * The desktop belongs to explorer.exe, so going by process name alone it would
 * be reported as "File Explorer" — technically true and practically wrong: a
 * user staring at their wallpaper is not using a file browser, and minutes
 * should not quietly pile up against one. Only the CLASS separates the two:
 * the desktop is Progman (the shell window) or WorkerW (the wallpaper host
 * that takes over when Active Desktop / slideshow is on), while a real
 * Explorer file window is CabinetWClass and keeps tracking normally.
 */
const DESKTOP_WINDOW_CLASSES = new Set(['Progman', 'WorkerW']);

/*
 * Raw Windows process name -> human display name. Keys are matched
 * case-insensitively; anything not listed falls back to the raw name with its
 * first letter capitalized, which is already correct for a surprising number
 * of apps (Slack, Discord, Spotify all report a usable ProcessName).
 */
const FRIENDLY_NAMES = new Map(Object.entries({
  chrome: 'Google Chrome',
  msedge: 'Microsoft Edge',
  firefox: 'Firefox',
  brave: 'Brave',
  opera: 'Opera',
  vivaldi: 'Vivaldi',
  arc: 'Arc',
  chromium: 'Chromium',
  code: 'VS Code',
  'code - insiders': 'VS Code Insiders',
  devenv: 'Visual Studio',
  idea64: 'IntelliJ IDEA',
  pycharm64: 'PyCharm',
  webstorm64: 'WebStorm',
  rider64: 'Rider',
  sublime_text: 'Sublime Text',
  windowsterminal: 'Terminal',
  powershell: 'PowerShell',
  pwsh: 'PowerShell',
  cmd: 'Command Prompt',
  conhost: 'Console',
  explorer: 'File Explorer',
  slack: 'Slack',
  discord: 'Discord',
  teams: 'Microsoft Teams',
  'ms-teams': 'Microsoft Teams',
  zoom: 'Zoom',
  notion: 'Notion',
  obsidian: 'Obsidian',
  spotify: 'Spotify',
  steam: 'Steam',
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  figma: 'Figma',
  postman: 'Postman',
  outlook: 'Outlook',
  excel: 'Excel',
  winword: 'Word',
  powerpnt: 'PowerPoint',
  onenote: 'OneNote',
  notepad: 'Notepad',
  'notepad++': 'Notepad++',
  photoshop: 'Photoshop',
  illustrator: 'Illustrator',
  acrobat: 'Acrobat',
  acrord32: 'Acrobat Reader',
  taskmgr: 'Task Manager',
  // Windows shell surfaces. UWP apps are hosted by ApplicationFrameHost, so
  // the PID we get back is the frame host rather than the real app — there is
  // no cheap fix for that without walking child windows, so we at least label
  // it honestly instead of showing "Applicationframehost".
  applicationframehost: 'Windows App',
  searchhost: 'Windows Search',
  shellexperiencehost: 'Windows Shell',
  startmenuexperiencehost: 'Start Menu',
  lockapp: 'Lock Screen',
  electron: 'Electron',
}));

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

let statsPath;   // <userData>/stats.json
let uiStatePath; // <userData>/ui-state.json — pill position, size, opacity, paused

/*
 * In a packaged build the app source lives inside app.asar, and Windows cannot
 * execute a .ps1 from inside that archive. Fall back to the unpacked resources
 * directory, which is where the script must be shipped via extraResources.
 */
function resolveWatcherScript() {
  const inSource = path.join(__dirname, 'focus-watcher.ps1');
  if (!__dirname.includes('app.asar')) return inSource;
  return path.join(process.resourcesPath, 'focus-watcher.ps1');
}

// ---------------------------------------------------------------------------
// Stats store
// ---------------------------------------------------------------------------

/** @type {Record<string, Record<string, { opens: number, activeMs: number }>>} */
let stats = {};
let persistTimer = null;
let dirty = false;

/** Local-date key. Deliberately identical to the extension's todayKey(). */
function todayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function loadStats() {
  try {
    const raw = fs.readFileSync(statsPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      stats = parsed;
      return;
    }
    console.warn('[stats] file was not an object; starting fresh');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // A corrupt file should not stop the app from tracking today. Keep the
      // bad copy around so the user can recover it manually if they care.
      console.warn('[stats] could not read stats.json:', err.message);
      try { fs.renameSync(statsPath, `${statsPath}.corrupt-${Date.now()}`); } catch { /* best effort */ }
    }
  }
  stats = {};
}

/*
 * Atomic write: serialize to a sibling temp file, then rename over the target.
 * rename() is atomic on NTFS (libuv uses MoveFileEx with REPLACE_EXISTING), so
 * a crash or power loss mid-write can only ever leave the previous complete
 * file or the new complete file — never a half-written one.
 */
function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, JSON.stringify(data));
    // Force the bytes to disk before the rename, otherwise the rename can be
    // durable while the contents are still only in the page cache.
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function persistNow() {
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  if (!dirty) return;
  try {
    writeJsonAtomic(statsPath, stats);
    dirty = false;
  } catch (err) {
    console.error('[stats] write failed:', err.message);
  }
}

/** Mark dirty and schedule a write. Never writes on every tick. */
function schedulePersist() {
  dirty = true;
  if (persistTimer) return;
  persistTimer = setTimeout(() => { persistTimer = null; persistNow(); }, PERSIST_DEBOUNCE_MS);
}

function bucketFor(dayKey, appName) {
  const day = stats[dayKey] || (stats[dayKey] = {});
  return day[appName] || (day[appName] = { opens: 0, activeMs: 0 });
}

function activeMsFor(appName) {
  const day = stats[todayKey()];
  const entry = day && day[appName];
  return entry ? entry.activeMs : 0;
}

// ---------------------------------------------------------------------------
// UI state store (ui-state.json) — position, size, opacity, paused
// ---------------------------------------------------------------------------

const DEFAULT_UI_STATE = { x: null, y: null, width: PILL_BASE_WIDTH, paused: false };

/** @type {{x: number|null, y: number|null, width: number, paused: boolean}} */
let uiState = { ...DEFAULT_UI_STATE };

function clampWidth(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return PILL_BASE_WIDTH;
  return Math.min(PILL_MAX_WIDTH, Math.max(PILL_MIN_WIDTH, n));
}

function pillSize() {
  const width = clampWidth(uiState.width);
  return { width, height: pillHeightFor(width) };
}

function loadUiState() {
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(uiStatePath, 'utf8')); } catch { saved = null; }
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) saved = {};

  // Every field is validated independently, so a file written by an older
  // version (which only had x/y) upgrades cleanly instead of being discarded.
  uiState = {
    x: Number.isFinite(saved.x) ? Math.round(saved.x) : null,
    y: Number.isFinite(saved.y) ? Math.round(saved.y) : null,
    width: Number.isFinite(saved.width) ? clampWidth(saved.width) : PILL_BASE_WIDTH,
    paused: saved.paused === true,
  };
}

let uiSaveTimer = null;

/** Persist ui-state.json. Debounced, because 'move' fires all through a drag. */
function saveUiState({ immediate = false } = {}) {
  const write = () => {
    uiSaveTimer = null;
    try { writeJsonAtomic(uiStatePath, uiState); } catch { /* non-critical */ }
  };
  if (uiSaveTimer) { clearTimeout(uiSaveTimer); uiSaveTimer = null; }
  if (immediate) write();
  else uiSaveTimer = setTimeout(write, 500);
}

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

const state = {
  /** Friendly display name of the focused app, or null when unknown. */
  appName: null,
  /** Raw lowercased process name — used for the browser check. */
  rawName: null,
  /** Wall-clock ms of the last accrual, used to compute each delta. */
  lastAccrualAt: Date.now(),
  /** Wall-clock ms of the last helper line (change OR heartbeat). */
  lastTickAt: 0,
  paused: false,
  idle: false,
  currentDay: todayKey(),
  /** Latest domain reported by the extension, with its arrival time. */
  bridgeDomain: null,
  bridgeDomainAt: 0,
};

let mainWindow = null;
let tray = null;
let watcher = null;
let watcherRestarts = 0;
let watcherRestartTimer = null;
let bridgeServer = null;
let tickTimer = null;
let isQuitting = false;

/** Settings-panel geometry. `panelExtra` is the height added to the window. */
let panelOpen = false;
let panelExtra = 0;
/** 'down' = panel below the pill, 'up' = above it (pill sits near the bottom). */
let panelDirection = 'down';
/** True while a native menu or modal owns focus, so blur must not close the panel. */
let menuOpen = false;
/** Window position captured at the start of a renderer-driven drag. */
let dragOrigin = null;
/** When our own window first became the foreground window; 0 when it is not. */
let selfFocusSince = 0;
/** Deadline until which the user is considered to still be using the pill. */
let pillInteractionUntil = 0;

/** Called from every gesture the renderer reports, to extend the grace above. */
function notePillInteraction() {
  pillInteractionUntil = Date.now() + PILL_ATTENTION_MS;
}

/** True while the pill plausibly has the user's deliberate attention. */
function pillHasAttention() {
  return panelOpen || dragOrigin !== null || Date.now() < pillInteractionUntil;
}

/**
 * True when our window has been the foreground one for longer than the grace
 * period without the user touching it — i.e. Windows handed us the foreground
 * because the application they were actually in disappeared.
 */
function selfFocusOrphaned(now = Date.now()) {
  if (selfFocusSince === 0) return false;
  if (pillHasAttention()) return false;
  return (now - selfFocusSince) > SELF_FOCUS_GRACE_MS;
}

/** The domain to display, or null when there is nothing fresh and relevant. */
function liveDomain() {
  if (!state.rawName || !BROWSER_PROCESSES.has(state.rawName)) return null;
  if (!state.bridgeDomain) return null;
  if (Date.now() - state.bridgeDomainAt > BRIDGE_STALE_MS) return null;
  return state.bridgeDomain;
}

function statusOf() {
  if (state.paused) return 'paused';
  if (state.idle || !state.appName) return 'idle';
  return 'active';
}

function friendlyName(raw) {
  if (!raw) return null;
  const key = raw.toLowerCase();
  const mapped = FRIENDLY_NAMES.get(key);
  if (mapped) return mapped;
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

// ---------------------------------------------------------------------------
// Accrual tick
// ---------------------------------------------------------------------------

function tick() {
  const now = Date.now();
  const delta = now - state.lastAccrualAt;
  state.lastAccrualAt = now;

  // Roll over at local midnight. Recomputing the key each tick means the
  // rollover is automatic; the only thing needing explicit handling is the
  // visit count, so an app focused across midnight still shows one open today.
  const day = todayKey();
  if (day !== state.currentDay) {
    state.currentDay = day;
    if (state.appName) bucketFor(day, state.appName).opens += 1;
    schedulePersist();
  }

  // powerMonitor reports seconds since the last input event system-wide, which
  // is exactly the signal the extension gets from chrome.idle.
  let idleSeconds = 0;
  try { idleSeconds = powerMonitor.getSystemIdleTime(); } catch { idleSeconds = 0; }
  state.idle = idleSeconds >= IDLE_THRESHOLD_S;

  /*
   * If the helper has gone quiet we genuinely do not know what is focused, so
   * attributing time to the last-known app would be a lie. Drop to unknown.
   *
   * Note this is entirely heartbeat-driven now: the helper stays silent while
   * the foreground window is unchanged, so `lastTickAt` advances every ~2s
   * rather than every second. That is exactly what WATCHER_STALE_MS is sized
   * against — accrual continues normally between heartbeats because it is the
   * TICK_MS interval, not the helper, that credits time.
   */
  const watcherStale = state.lastTickAt !== 0 && (now - state.lastTickAt) > WATCHER_STALE_MS;
  if (watcherStale) {
    // Clear rawName alongside appName: leaving a browser rawName behind would
    // let liveDomain() keep showing a domain next to "No focus" if the
    // extension is still reporting while the helper is down.
    state.appName = null;
    state.rawName = null;
  }

  /*
   * Same orphan rule as onFocusSample, applied on the tick rather than waiting
   * for the helper's next line. Without this the pill would sit on a closed
   * application until the next heartbeat — up to two more seconds — and would
   * credit that time to it. Clearing before the accrual below means the tick
   * in which we notice is dropped rather than misattributed.
   */
  if (selfFocusOrphaned(now) && state.appName) {
    state.appName = null;
    state.rawName = null;
    state.bridgeDomain = null;
    state.bridgeDomainAt = 0;
    broadcastFocus();
  }

  const canAccrue = !state.paused && !state.idle && state.appName && !watcherStale;
  if (canAccrue) {
    /*
     * Clamp the delta. If the machine sleeps or the event loop stalls, `delta`
     * can be minutes or hours; crediting all of it to whatever happened to be
     * focused would badly corrupt the day's totals. A few dropped seconds
     * around a resume is the cheaper error.
     *
     * Note the accepted imprecision at the idle boundary: up to
     * IDLE_THRESHOLD_S of genuinely idle time is credited before we notice.
     * The extension has the same characteristic, and matching it keeps the two
     * data sets comparable.
     */
    const credited = Math.min(Math.max(delta, 0), TICK_MS * 5);
    bucketFor(day, state.appName).activeMs += credited;
    schedulePersist();
  }

  pushState();
}

function pushState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('tracker:state', {
    app: state.appName,
    domain: liveDomain(),
    activeMs: state.appName ? activeMsFor(state.appName) : 0,
    status: statusOf(),
  });
}

// ---------------------------------------------------------------------------
// Focus watcher (PowerShell helper)
// ---------------------------------------------------------------------------

function onFocusSample(sample) {
  // Every line proves the helper is alive — a heartbeat just as much as a
  // change — so the staleness clock is reset before any early return below.
  state.lastTickAt = Date.now();
  // A helper tick proves the process is healthy; stop escalating the backoff.
  watcherRestarts = 0;

  /*
   * Our own pill in the foreground means one of two very different things.
   *
   * Usually the user just clicked or dragged it, and the timer must NOT jump
   * to "Electron" — that is what this guard has always been for.
   *
   * But the pill is always-on-top, so Windows also activates it when the app
   * the user was in exits. Holding the previous app in that case leaves a dead
   * application on screen accruing time forever. selfFocusOrphaned() tells the
   * two apart: deliberate attention (a gesture, or the settings panel being
   * open) holds the previous app; silence past the grace period falls through
   * below and clears it.
   */
  if (sample.pid && sample.pid === process.pid) {
    if (selfFocusSince === 0) selfFocusSince = Date.now();
    if (!selfFocusOrphaned()) return;
  } else {
    selfFocusSince = 0;
  }

  /*
   * The desktop reads as "no focus", not as File Explorer. Resolving it here
   * rather than in friendlyName() keeps the decision where the window class is
   * available, and makes it identical to the helper reporting app:null — so
   * the pill drops to its idle state and accrual stops, instead of banking
   * time against a file browser the user never opened.
   */
  const onDesktop = typeof sample.cls === 'string' && DESKTOP_WINDOW_CLASSES.has(sample.cls);

  // selfFocusSince is still set here only on the orphaned path above, where
  // the honest answer is "nothing", not "Electron".
  const raw = (onDesktop || selfFocusSince !== 0) ? null : (sample.app || null);
  const display = friendlyName(raw);

  if (display === state.appName) return; // no transition

  // Settle the elapsed time against the outgoing app before switching, so the
  // partial second in progress is not silently handed to the incoming one.
  tick();

  state.appName = display;
  state.rawName = raw ? raw.toLowerCase() : null;

  // A domain from the previous focus must not leak onto the next app.
  state.bridgeDomain = null;
  state.bridgeDomainAt = 0;

  if (display) {
    // `opens` counts focus transitions into an app, matching how the extension
    // counts a domain "visit".
    bucketFor(todayKey(), display).opens += 1;
    schedulePersist();
  }

  broadcastFocus();
  pushState();
}

function startWatcher() {
  const script = resolveWatcherScript();
  if (!fs.existsSync(script)) {
    console.error('[watcher] focus-watcher.ps1 not found at', script);
    return;
  }

  watcher = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

  watcher.stdout.setEncoding('utf8');

  // readline handles the partial-line buffering that a raw 'data' handler
  // would otherwise have to reimplement (a chunk boundary can land mid-JSON).
  const rl = readline.createInterface({ input: watcher.stdout });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      onFocusSample(JSON.parse(trimmed));
    } catch {
      // Never let one malformed line take down tracking.
      console.warn('[watcher] unparseable line:', trimmed.slice(0, 120));
    }
  });

  watcher.stderr.setEncoding('utf8');
  watcher.stderr.on('data', (d) => console.warn('[watcher] stderr:', d.trim()));

  watcher.on('exit', (code, signal) => {
    watcher = null;
    if (isQuitting) return;
    console.warn(`[watcher] exited (code=${code} signal=${signal}); restarting`);
    scheduleWatcherRestart();
  });

  watcher.on('error', (err) => {
    console.error('[watcher] spawn error:', err.message);
    watcher = null;
    if (!isQuitting) scheduleWatcherRestart();
  });
}

/*
 * Exponential backoff. If PowerShell is broken or blocked by policy the helper
 * will fail instantly and forever; retrying at 1Hz would burn CPU indefinitely,
 * so back off to a 30s ceiling.
 */
function scheduleWatcherRestart() {
  if (watcherRestartTimer) return;
  const delay = Math.min(30000, 1000 * Math.pow(2, watcherRestarts));
  watcherRestarts += 1;
  watcherRestartTimer = setTimeout(() => {
    watcherRestartTimer = null;
    if (!isQuitting) startWatcher();
  }, delay);
}

function stopWatcher() {
  if (watcherRestartTimer) { clearTimeout(watcherRestartTimer); watcherRestartTimer = null; }
  if (watcher) {
    try { watcher.kill(); } catch { /* already gone */ }
    watcher = null;
  }
}

// ---------------------------------------------------------------------------
// WebSocket bridge (optional; the app is fully functional without it)
// ---------------------------------------------------------------------------

function broadcastFocus() {
  if (!bridgeServer) return;
  const msg = JSON.stringify({
    type: 'focus',
    app: state.appName,
    activeMs: state.appName ? activeMsFor(state.appName) : 0,
  });
  for (const client of bridgeServer.clients) {
    if (client.readyState === 1 /* OPEN */) {
      try { client.send(msg); } catch { /* client is going away */ }
    }
  }
}

function startBridge() {
  let WebSocketServer;
  try {
    ({ WebSocketServer } = require('ws'));
  } catch (err) {
    console.warn('[bridge] ws module unavailable; continuing without bridge:', err.message);
    return;
  }

  const server = new WebSocketServer({ host: BRIDGE_HOST, port: BRIDGE_PORT });

  /*
   * The bridge is purely additive, so any failure to bind must degrade rather
   * than crash — most commonly EADDRINUSE from a second copy of this app or an
   * unrelated process squatting the port.
   */
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`[bridge] ${BRIDGE_HOST}:${BRIDGE_PORT} already in use; continuing without bridge`);
    } else {
      console.warn('[bridge] error; continuing without bridge:', err.message);
    }
    bridgeServer = null;
    try { server.close(); } catch { /* nothing to close */ }
  });

  server.on('listening', () => {
    bridgeServer = server;
    console.log(`[bridge] listening on ws://${BRIDGE_HOST}:${BRIDGE_PORT}`);
  });

  server.on('connection', (socket) => {
    // Send current focus immediately so a freshly connected extension does not
    // have to wait for the next focus change to learn the state.
    try {
      socket.send(JSON.stringify({
        type: 'focus',
        app: state.appName,
        activeMs: state.appName ? activeMsFor(state.appName) : 0,
      }));
    } catch { /* socket died during handshake */ }

    socket.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (!msg || msg.type !== 'domain') return;
      if (typeof msg.domain !== 'string' || !msg.domain) return;

      // Timestamp on arrival rather than trusting a clock we do not control;
      // liveDomain() uses this to decide whether the report is still fresh.
      state.bridgeDomain = msg.domain;
      state.bridgeDomainAt = Date.now();
      pushState();
    });

    socket.on('error', () => { /* connection-level noise is not actionable */ });
  });
}

// ---------------------------------------------------------------------------
// Window geometry
//
// Two rectangles matter and they are not the same once the settings panel is
// open: the WINDOW (which grows to hold pill + panel) and the PILL (which is
// what the user actually positions and what gets persisted). When the panel
// opens upward the window's origin is `panelExtra` above the pill's, so every
// read of "where is the pill" has to go through pillOrigin().
// ---------------------------------------------------------------------------

function workAreaAt(x, y, width, height) {
  let display = null;
  try { display = screen.getDisplayMatching({ x, y, width, height }); } catch { display = null; }
  return (display || screen.getPrimaryDisplay()).workArea;
}

/** Clamp a pill origin so the whole capsule stays inside its display's work area. */
function clampPill(x, y) {
  const { width, height } = pillSize();
  const wa = workAreaAt(x, y, width, height);
  return {
    x: Math.round(Math.min(Math.max(x, wa.x), Math.max(wa.x, wa.x + wa.width - width))),
    y: Math.round(Math.min(Math.max(y, wa.y), Math.max(wa.y, wa.y + wa.height - height))),
    workArea: wa,
  };
}

function defaultPosition() {
  const { width, height } = pillSize();
  const { workArea } = screen.getPrimaryDisplay();
  return {
    x: workArea.x + workArea.width - width - SCREEN_MARGIN,
    y: workArea.y + workArea.height - height - SCREEN_MARGIN,
  };
}

/** Where the pill should start, honouring ui-state.json when it is still sane. */
function startPosition() {
  const { width, height } = pillSize();
  if (uiState.x === null || uiState.y === null) return defaultPosition();

  // A saved position can be off-screen after a monitor is unplugged or the
  // resolution changes. Verify it still intersects a display before using it,
  // otherwise the pill would be invisible with no obvious way to recover.
  const visible = screen.getAllDisplays().some(({ workArea: wa }) =>
    uiState.x < wa.x + wa.width && uiState.x + width > wa.x &&
    uiState.y < wa.y + wa.height && uiState.y + height > wa.y);

  return visible ? { x: uiState.x, y: uiState.y } : defaultPosition();
}

/** Screen position of the pill itself, regardless of which way the panel grew. */
function pillOrigin() {
  if (!mainWindow || mainWindow.isDestroyed()) return defaultPosition();
  const [x, y] = mainWindow.getPosition();
  return { x, y: (panelOpen && panelDirection === 'up') ? y + panelExtra : y };
}

/*
 * The window is created with resizable:false so Windows never gives the user a
 * resize border. That also blocks some programmatic size changes on Windows,
 * so lift the flag for the duration of the call and put it straight back.
 */
function setWindowBounds(bounds) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const wasResizable = mainWindow.isResizable();
  if (!wasResizable) mainWindow.setResizable(true);
  try {
    mainWindow.setBounds(bounds);
  } finally {
    if (!wasResizable) mainWindow.setResizable(false);
  }
}

/**
 * Lay the window out for the current size + panel state, keeping the pill at
 * `pillX/pillY` and inside its display's work area. Chooses the panel's growth
 * direction: down normally, up when there is not enough room below.
 */
function applyGeometry(pillX, pillY) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const { width, height } = pillSize();
  const clamped = clampPill(pillX, pillY);
  const wa = clamped.workArea;

  let winY = clamped.y;
  let winHeight = height;

  if (panelOpen && panelExtra > 0) {
    const fitsBelow = clamped.y + height + panelExtra <= wa.y + wa.height;
    panelDirection = fitsBelow ? 'down' : 'up';
    winHeight = height + panelExtra;
    // Opening upward moves the window's top edge; the pill's own top edge
    // stays put, which is what makes the growth look anchored to the pill.
    if (panelDirection === 'up') winY = Math.max(wa.y, clamped.y - panelExtra);
  } else {
    panelDirection = 'down';
  }

  setWindowBounds({ x: clamped.x, y: winY, width, height: winHeight });

  // Persisted position is always the PILL's, never the window's.
  uiState.x = clamped.x;
  uiState.y = (panelOpen && panelDirection === 'up') ? winY + panelExtra : winY;
}

function rememberPillPosition() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const { x, y } = pillOrigin();
  if (uiState.x === x && uiState.y === y) return;
  uiState.x = x;
  uiState.y = y;
  saveUiState();
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow() {
  const pos = startPosition();
  const { width, height } = pillSize();

  mainWindow = new BrowserWindow({
    width,
    height,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: true,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    hasShadow: false,
    show: false,
    title: 'Tab Tracker',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });

  // 'screen-saver' is the highest normal-app z-order level, and is what keeps
  // the pill visible over fullscreen windows; plain alwaysOnTop is not enough.
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // The renderer scales itself from window.innerWidth, which is already
  // correct on the first frame — nothing about the size has to be sent to it.
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'pill.html'));

  mainWindow.once('ready-to-show', () => {
    // showInactive avoids stealing focus from whatever the user is doing —
    // which would also make our own window the tracked foreground app.
    mainWindow.showInactive();
    pushState();
    pushSettings();
  });

  mainWindow.on('move', rememberPillPosition);

  /*
   * Clicking away is the panel's main dismissal gesture, and "away" for an
   * always-on-top HUD means "into another window" — which is exactly a blur.
   * Native menus and the reset dialog also blur us, hence the menuOpen guard.
   */
  mainWindow.on('blur', () => {
    if (menuOpen || !panelOpen) return;
    mainWindow.webContents.send('pill:panel-dismiss');
  });

  // Nothing in the pill should ever navigate or open a browser window.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());

  mainWindow.on('closed', () => {
    mainWindow = null;
    panelOpen = false;
    panelExtra = 0;
    panelDirection = 'down';
  });
}

function togglePill() {
  if (!mainWindow || mainWindow.isDestroyed()) { createWindow(); return; }
  if (mainWindow.isVisible()) mainWindow.hide();
  else mainWindow.showInactive();
  rebuildTrayMenu();
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Everything the settings panel renders from. */
function settingsPayload() {
  return { paused: state.paused };
}

function pushSettings() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('pill:settings', settingsPayload());
}

/**
 * Live resize, driven by the renderer dragging the pill's right edge.
 * The pill's top-left is the anchor, so it grows rightward and downward; the
 * work-area clamp then slides it back inside if that would push it off screen.
 */
function setPillWidth(width) {
  const next = clampWidth(width);
  if (next === uiState.width) return;
  const origin = pillOrigin();
  uiState.width = next;
  applyGeometry(origin.x, origin.y);
  saveUiState();
}

// ---------------------------------------------------------------------------
// Menu actions
// ---------------------------------------------------------------------------

function setPaused(paused) {
  // Settle time accrued up to this moment before flipping the flag, so the
  // pause takes effect from now rather than from the last tick boundary.
  tick();
  state.paused = paused;
  uiState.paused = paused;
  saveUiState();
  pushState();
  pushSettings();
  rebuildTrayMenu();
}

/** The reset itself. Both confirmation surfaces (dialog and panel) call this. */
function performResetToday() {
  const day = todayKey();
  delete stats[day];

  // Re-open the current app so the timer restarts cleanly from zero rather
  // than showing an app with activeMs but no recorded visit.
  state.lastAccrualAt = Date.now();
  if (state.appName) bucketFor(day, state.appName).opens += 1;

  dirty = true;
  persistNow();
  pushState();
}

function resetTodayWithDialog() {
  const day = todayKey();
  // The modal blurs our window; without this the settings panel would collapse
  // underneath it while the user is still deciding.
  menuOpen = true;
  let choice = 0;
  try {
    choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['Cancel', 'Reset'],
      defaultId: 0,
      cancelId: 0,
      title: 'Reset today',
      message: `Reset today's stats?`,
      detail: `This permanently deletes all tracked time for ${day}. Earlier days are not affected.`,
    });
  } finally {
    menuOpen = false;
  }
  if (choice !== 1) return;
  performResetToday();
}

function openStatsFolder() {
  // showItemInFolder reveals and selects the file. If it does not exist yet
  // (no write has been flushed), create it first so the reveal is not a no-op.
  if (!fs.existsSync(statsPath)) {
    try { writeJsonAtomic(statsPath, stats); } catch { /* fall through */ }
  }
  if (fs.existsSync(statsPath)) shell.showItemInFolder(statsPath);
  else shell.openPath(path.dirname(statsPath));
}

function buildContextMenu() {
  return Menu.buildFromTemplate([
    {
      label: state.paused ? 'Resume tracking' : 'Pause tracking',
      click: () => setPaused(!state.paused),
    },
    { type: 'separator' },
    { label: "Reset today's stats…", click: resetTodayWithDialog },
    { label: 'Open stats folder', click: openStatsFolder },
    { type: 'separator' },
    { label: 'Hide pill', click: togglePill },
    { label: 'Quit', click: () => app.quit() },
  ]);
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

function rebuildTrayMenu() {
  if (!tray) return;
  const visible = !!(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible());
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: visible ? 'Hide pill' : 'Show pill', click: togglePill },
    {
      label: state.paused ? 'Resume tracking' : 'Pause tracking',
      click: () => setPaused(!state.paused),
    },
    { type: 'separator' },
    { label: 'Open stats folder', click: openStatsFolder },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
}

function createTray() {
  // Shared with the browser extension; read in place, never copied.
  const iconPath = path.join(__dirname, '..', 'icons', '32.png');
  const image = nativeImage.createFromPath(iconPath);

  if (image.isEmpty()) {
    console.warn('[tray] icon missing or unreadable at', iconPath, '- skipping tray');
    return;
  }

  tray = new Tray(image);
  tray.setToolTip('Tab Tracker');
  tray.on('click', togglePill);
  rebuildTrayMenu();
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

// A second instance would double-count every second and fight over stats.json.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.showInactive();
  });

  app.whenReady().then(() => {
    statsPath = path.join(app.getPath('userData'), 'stats.json');
    uiStatePath = path.join(app.getPath('userData'), 'ui-state.json');

    loadStats();
    loadUiState();
    state.paused = uiState.paused;

    createWindow();
    createTray();
    startWatcher();
    startBridge();

    state.lastAccrualAt = Date.now();
    tickTimer = setInterval(tick, TICK_MS);

    // Time cannot have accrued while suspended; reset the baseline so the
    // first post-resume tick does not credit the whole sleep duration.
    powerMonitor.on('resume', () => { state.lastAccrualAt = Date.now(); });
    powerMonitor.on('suspend', () => { tick(); persistNow(); });
  });

  // -- pill lifecycle -------------------------------------------------------

  ipcMain.on('pill:ready', () => { pushState(); pushSettings(); });

  ipcMain.on('pill:context-menu', (event) => {
    notePillInteraction();
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    const menu = buildContextMenu();
    // Popping a native menu blurs the window; keep the panel from collapsing.
    menuOpen = true;
    menu.once('menu-will-close', () => { menuOpen = false; });
    menu.popup({ window: win });
  });

  // -- drag -----------------------------------------------------------------

  /*
   * The pill used to be a -webkit-app-region: drag surface, which on Windows
   * swallows mouse events before the renderer sees them — so it could be
   * dragged but never clicked. Now the renderer owns the gesture: it reports a
   * cursor delta and distinguishes a click from a drag itself.
   */
  ipcMain.on('pill:drag-start', () => {
    notePillInteraction();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const [x, y] = mainWindow.getPosition();
    dragOrigin = { x, y };
  });

  ipcMain.on('pill:drag-move', (event, dx, dy) => {
    notePillInteraction();
    if (!dragOrigin || !mainWindow || mainWindow.isDestroyed()) return;
    const nx = Number(dx);
    const ny = Number(dy);
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) return;
    mainWindow.setPosition(Math.round(dragOrigin.x + nx), Math.round(dragOrigin.y + ny));
  });

  // Fires on every press of the pill, drag or click, so it must be cheap:
  // rememberPillPosition() no-ops when nothing actually moved.
  ipcMain.on('pill:drag-end', () => {
    notePillInteraction();
    dragOrigin = null;
    rememberPillPosition();
  });

  // -- settings panel -------------------------------------------------------

  /*
   * The renderer measures the panel (it is the only side that knows how tall
   * the content actually is) and hands us the extra height. We grow the window,
   * pick a direction, and hand the direction back so the renderer can put the
   * panel on the correct side of the pill before fading it in.
   */
  ipcMain.on('pill:panel-open', (event, rawHeight) => {
    notePillInteraction();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const extra = Math.round(Number(rawHeight));
    if (!Number.isFinite(extra) || extra <= 0) return;

    const origin = pillOrigin();
    panelOpen = true;
    panelExtra = Math.min(extra, MAX_PANEL_HEIGHT);
    applyGeometry(origin.x, origin.y);
    saveUiState();

    mainWindow.webContents.send('pill:panel-layout', { direction: panelDirection });
    // Focus is what makes Escape and click-away (blur) work at all.
    if (!mainWindow.isFocused()) mainWindow.focus();
  });

  ipcMain.on('pill:panel-close', () => {
    notePillInteraction();
    if (!mainWindow || mainWindow.isDestroyed() || !panelOpen) return;
    const origin = pillOrigin();
    panelOpen = false;
    panelExtra = 0;
    panelDirection = 'down';
    applyGeometry(origin.x, origin.y);
    saveUiState();
  });

  // -- settings actions -----------------------------------------------------

  /*
   * Fired continuously while the user drags the pill's right edge. No echo
   * back to the renderer: it derives its own metrics from window.innerWidth,
   * so the resize event Chromium already fires is the feedback channel.
   */
  ipcMain.on('pill:resize', (event, width) => {
    notePillInteraction();
    setPillWidth(width);
  });

  ipcMain.on('pill:resize-end', () => {
    notePillInteraction();
    saveUiState({ immediate: true });
  });

  ipcMain.on('pill:set-paused', (event, paused) => {
    notePillInteraction();
    setPaused(paused === true);
  });

  ipcMain.on('pill:reset-today', () => {
    notePillInteraction();
    // The panel does its own two-step confirmation, so no dialog here.
    performResetToday();
  });

  ipcMain.on('pill:quit', () => app.quit());

  // The pill lives in the tray, so closing its window must not end the app.
  app.on('window-all-closed', () => { /* intentionally empty */ });

  app.on('before-quit', () => {
    isQuitting = true;
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    tick();        // settle the final partial second
    persistNow();  // always flush on quit, debounce notwithstanding
    saveUiState({ immediate: true });
    stopWatcher();
    if (bridgeServer) { try { bridgeServer.close(); } catch { /* ignore */ } }
  });
}
