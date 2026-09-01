'use strict';

/*
 * Pill renderer. No Node, no Electron — everything arrives through the
 * `tracker` API that preload.js put on window.
 *
 * Four responsibilities:
 *   1. paint the pill from tracker:state pushes,
 *   2. scale every metric from the current window width,
 *   3. own the move and resize gestures (the pill is no longer an app-region
 *      drag surface, because on Windows those never deliver clicks),
 *   4. run the settings panel, including measuring it so the main process
 *      knows how far to grow the window.
 */

const els = {
  pill: document.getElementById('pill'),
  grip: document.getElementById('grip'),
  content: document.getElementById('content'),
  dot: document.getElementById('dot'),
  app: document.getElementById('app'),
  domain: document.getElementById('domain'),
  domainSep: document.getElementById('domain-sep'),
  time: document.getElementById('time'),

  panel: document.getElementById('panel'),
  pause: document.getElementById('pause'),
  pauseLabel: document.getElementById('pause-label'),
  reset: document.getElementById('reset'),
  resetConfirm: document.getElementById('reset-confirm'),
  resetCancel: document.getElementById('reset-cancel'),
  resetGo: document.getElementById('reset-go'),
  openStats: document.getElementById('open-stats'),
  quit: document.getElementById('quit'),
};

const SWAP_MS = 180;        // must stay in step with the .content transition
const PANEL_ANIM_MS = 140;  // must stay in step with the .panel transition
const DRAG_THRESHOLD_PX = 3;

// These four MUST match PILL_BASE_WIDTH / PILL_ASPECT / PILL_MIN_WIDTH /
// PILL_MAX_WIDTH in main.js: both sides derive the pill's height from the
// width independently, and a mismatch would leave the capsule not quite
// filling the window it lives in.
const BASE_WIDTH = 260;
const ASPECT = 52 / 260;
const MIN_WIDTH = 200;
const MAX_WIDTH = 400;
const KEY_STEP_PX = 10;

function reducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// ---------------------------------------------------------------------------
// Scaling
// ---------------------------------------------------------------------------

/*
 * window.innerWidth is the pill's width by definition (the window is exactly
 * as wide as the capsule plus its insets), and Chromium fires `resize` for
 * every step of a live drag — so this is both the source of truth and the
 * feedback channel. Nothing about the size has to travel over IPC.
 */
function applyScale() {
  const width = window.innerWidth || BASE_WIDTH;
  document.body.style.setProperty('--scale', String(width / BASE_WIDTH));
  document.body.style.setProperty('--pill-h', `${Math.round(width * ASPECT)}px`);
  els.grip.setAttribute('aria-valuemin', String(MIN_WIDTH));
  els.grip.setAttribute('aria-valuemax', String(MAX_WIDTH));
  els.grip.setAttribute('aria-valuenow', String(width));
  els.grip.setAttribute('aria-valuetext', `${width} pixels wide`);
}

window.addEventListener('resize', applyScale);

// ---------------------------------------------------------------------------
// Pill painting
// ---------------------------------------------------------------------------

/** `12m 04s` below an hour, `1h 23m` at or above it. */
function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours >= 1) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

/*
 * The most recent state from the main process. Held separately from the render
 * because a cross-fade defers painting by SWAP_MS, and when it lands we want
 * the newest values — not the stale ones that happened to trigger the fade.
 */
let latest = { app: null, domain: null, activeMs: 0, status: 'idle' };

/** Identity of what is on screen; a change to this is what triggers a fade. */
let renderedIdentity = null;
let swapTimer = null;

function identityOf(state) {
  return `${state.app || ''} ${state.domain || ''}`;
}

function paint(state) {
  els.app.textContent = state.app || 'No focus';

  const hasDomain = Boolean(state.domain);
  els.domain.textContent = hasDomain ? state.domain : '';
  els.domain.hidden = !hasDomain;
  els.domainSep.hidden = !hasDomain;

  els.time.textContent = formatDuration(state.activeMs);
}

function paintDot(status) {
  // The dot reflects tracking state, not identity, so it never cross-fades —
  // it has its own colour transition and should react immediately.
  els.dot.classList.remove('active', 'paused', 'idle');
  els.dot.classList.add(status === 'active' || status === 'paused' ? status : 'idle');
}

function applyState(state) {
  latest = state;
  paintDot(state.status);

  const identity = identityOf(state);

  // First paint: no fade, there is nothing to fade from.
  if (renderedIdentity === null) {
    renderedIdentity = identity;
    paint(state);
    return;
  }

  if (identity !== renderedIdentity) {
    renderedIdentity = identity;
    els.content.classList.add('swapping');

    // Restarting the timer coalesces rapid alt-tabbing into a single fade
    // rather than queuing one animation per switch.
    clearTimeout(swapTimer);
    swapTimer = setTimeout(() => {
      swapTimer = null;
      paint(latest);
      els.content.classList.remove('swapping');
    }, reducedMotion() ? 0 : SWAP_MS);
    return;
  }

  // Same app: this is just the once-a-second timer update. Skip it mid-fade so
  // the outgoing text does not visibly change while it is on its way out.
  if (!swapTimer) paint(state);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const settings = { paused: false };

function applyPaused(paused) {
  settings.paused = paused;
  els.pauseLabel.textContent = paused ? 'Resume tracking' : 'Pause tracking';
}

// ---------------------------------------------------------------------------
// Settings panel
// ---------------------------------------------------------------------------

const panel = { open: false, sentHeight: -1 };
let panelTimer = null;

function cssVarPx(name) {
  const raw = getComputedStyle(document.body).getPropertyValue(name);
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : 0;
}

/*
 * How much taller the window has to be to hold the panel.
 *
 * The layout is [inset-y][pill][inset-y][panel][inset-y] (or the mirror of it
 * when the panel opens upward), and the closed window is already
 * inset-y + pill + inset-y tall — so the extra is the panel's own box plus one
 * more inset. Measuring here rather than hardcoding in main.js is what lets
 * the reset confirmation expand the panel without either side guessing.
 */
function panelExtraHeight() {
  return Math.ceil(els.panel.offsetHeight + cssVarPx('--inset-y'));
}

/** Re-measure and tell the main process, if the answer changed. */
function syncPanelHeight() {
  if (!panel.open) return;
  const height = panelExtraHeight();
  if (height === panel.sentHeight) return;
  panel.sentHeight = height;
  window.tracker.panelOpen(height);
}

/*
 * Anything that changes the panel's height has to reach the main process, and
 * there are several routes to it: the reset confirmation expanding, and the
 * window getting wider or narrower as the pill is resized (which rescales the
 * panel's type and can re-wrap the confirmation text). Observing the element
 * covers all of them, including the ones that only settle a frame later.
 */
if (typeof ResizeObserver === 'function') {
  new ResizeObserver(() => syncPanelHeight()).observe(els.panel);
}

function openPanel() {
  if (panel.open) return;
  panel.open = true;
  panel.sentHeight = -1;

  clearTimeout(panelTimer);
  panelTimer = null;

  els.panel.hidden = false;
  els.pill.setAttribute('aria-expanded', 'true');

  // Measure while the window is still pill-sized. The panel is laid out but
  // transparent, so nothing is visible hanging outside the window bounds.
  syncPanelHeight();
}

function closePanel() {
  if (!panel.open) return;
  panel.open = false;
  panel.sentHeight = -1;

  document.body.classList.remove('panel-open');
  els.pill.setAttribute('aria-expanded', 'false');
  hideResetConfirm();

  // Let the fade finish before the window snaps back to pill size, otherwise
  // the panel would be clipped away mid-animation.
  clearTimeout(panelTimer);
  panelTimer = setTimeout(() => {
    panelTimer = null;
    els.panel.hidden = true;
    document.body.classList.remove('panel-up');
    window.tracker.panelClose();
  }, reducedMotion() ? 0 : PANEL_ANIM_MS);
}

function togglePanel() {
  if (panel.open) closePanel();
  else openPanel();
}

// The main process resized the window and picked a side; now show the panel.
window.tracker.onPanelLayout(({ direction } = {}) => {
  document.body.classList.toggle('panel-up', direction === 'up');
  if (!panel.open) return;
  // One frame of delay so the transition has a "from" state to animate out of.
  requestAnimationFrame(() => {
    if (panel.open) document.body.classList.add('panel-open');
  });
});

// The window lost focus — the user clicked into another app.
window.tracker.onPanelDismiss(() => closePanel());

// ---------------------------------------------------------------------------
// Reset confirmation
// ---------------------------------------------------------------------------

function showResetConfirm() {
  if (!els.resetConfirm.hidden) return;
  els.resetConfirm.hidden = false;
  els.reset.setAttribute('aria-expanded', 'true');
  syncPanelHeight(); // the panel just got taller
  els.resetCancel.focus();
}

function hideResetConfirm() {
  if (els.resetConfirm.hidden) return;
  els.resetConfirm.hidden = true;
  els.reset.setAttribute('aria-expanded', 'false');
  syncPanelHeight();
}

// ---------------------------------------------------------------------------
// Move and resize gestures
// ---------------------------------------------------------------------------

/*
 * A -webkit-app-region: drag element is hit-tested by Windows as window
 * caption, so the renderer never sees mousedown/click on it — the pill could
 * be moved but not clicked, which the settings panel needs. So both gestures
 * are reimplemented here.
 *
 * event.screenX is a screen-absolute coordinate, independent of where the
 * window currently is, which is what makes "origin + delta" stable even though
 * the window is moving underneath the cursor as the delta is applied.
 */
const gesture = { pointerId: null, mode: null, startX: 0, startY: 0, startWidth: 0, moved: false };
let frame = 0;
let pendingMove = null;
let pendingWidth = 0;

function flush() {
  frame = 0;
  if (pendingMove) {
    window.tracker.dragMove(pendingMove.dx, pendingMove.dy);
    pendingMove = null;
  }
  if (pendingWidth) {
    window.tracker.resize(pendingWidth);
    pendingWidth = 0;
  }
}

function schedule() {
  if (!frame) frame = requestAnimationFrame(flush);
}

function beginGesture(event, mode, target) {
  if (event.button !== 0 || gesture.pointerId !== null) return;
  gesture.pointerId = event.pointerId;
  gesture.mode = mode;
  gesture.startX = event.screenX;
  gesture.startY = event.screenY;
  gesture.startWidth = window.innerWidth;
  gesture.moved = false;
  try { target.setPointerCapture(event.pointerId); } catch { /* not capturable */ }
  if (mode === 'move') window.tracker.dragStart();
  else document.body.classList.add('resizing');
  event.preventDefault();
  event.stopPropagation();
}

function endGesture(event, target) {
  if (event.pointerId !== gesture.pointerId) return;
  const { mode, moved } = gesture;

  if (frame) { cancelAnimationFrame(frame); flush(); }
  try { target.releasePointerCapture(gesture.pointerId); } catch { /* already released */ }
  gesture.pointerId = null;
  gesture.mode = null;
  gesture.moved = false;

  if (mode === 'move') {
    window.tracker.dragEnd();
    // A press that never passed the threshold is a click, not a drag.
    if (!moved && event.type === 'pointerup') togglePanel();
  } else {
    document.body.classList.remove('resizing');
    window.tracker.resizeEnd();
  }
  event.stopPropagation();
}

// ---- move: anywhere on the capsule ----

els.pill.addEventListener('pointerdown', (event) => beginGesture(event, 'move', els.pill));

els.pill.addEventListener('pointermove', (event) => {
  if (event.pointerId !== gesture.pointerId || gesture.mode !== 'move') return;
  const dx = event.screenX - gesture.startX;
  const dy = event.screenY - gesture.startY;

  if (!gesture.moved) {
    if (Math.abs(dx) < DRAG_THRESHOLD_PX && Math.abs(dy) < DRAG_THRESHOLD_PX) return;
    gesture.moved = true;
  }

  // Coalesce to one window update per frame; pointermove fires far faster than
  // the window can actually be moved.
  pendingMove = { dx, dy };
  schedule();
});

els.pill.addEventListener('pointerup', (event) => endGesture(event, els.pill));
els.pill.addEventListener('pointercancel', (event) => endGesture(event, els.pill));

// ---- resize: the right edge ----

els.grip.addEventListener('pointerdown', (event) => beginGesture(event, 'resize', els.grip));

els.grip.addEventListener('pointermove', (event) => {
  if (event.pointerId !== gesture.pointerId || gesture.mode !== 'resize') return;
  const width = gesture.startWidth + (event.screenX - gesture.startX);
  // Clamped here as well as in the main process so the pointer does not have
  // to travel back through the dead zone before the pill starts responding.
  pendingWidth = Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width)));
  schedule();
});

els.grip.addEventListener('pointerup', (event) => endGesture(event, els.grip));
els.grip.addEventListener('pointercancel', (event) => endGesture(event, els.grip));

// Keyboard resize, so the grip is not a mouse-only control.
els.grip.addEventListener('keydown', (event) => {
  const step = event.key === 'ArrowRight' || event.key === 'ArrowUp' ? KEY_STEP_PX
    : event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -KEY_STEP_PX
      : event.key === 'Home' ? MIN_WIDTH - window.innerWidth
        : event.key === 'End' ? MAX_WIDTH - window.innerWidth : 0;
  if (!step) return;
  event.preventDefault();
  event.stopPropagation();
  const width = Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, window.innerWidth + step)));
  window.tracker.resize(width);
  window.tracker.resizeEnd();
});

// The grip sits inside the pill, so its own Enter/Space must not also be read
// as "click the pill".
els.grip.addEventListener('click', (event) => event.stopPropagation());

// Keyboard equivalent of clicking the pill.
els.pill.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  if (event.target === els.grip) return;
  event.preventDefault();
  togglePanel();
});

// ---------------------------------------------------------------------------
// Panel controls
// ---------------------------------------------------------------------------

els.pause.addEventListener('click', () => {
  applyPaused(!settings.paused);
  window.tracker.setPaused(settings.paused);
});

els.reset.addEventListener('click', () => {
  if (els.resetConfirm.hidden) showResetConfirm();
  else hideResetConfirm();
});

els.resetCancel.addEventListener('click', () => {
  hideResetConfirm();
  els.reset.focus();
});

els.resetGo.addEventListener('click', () => {
  window.tracker.resetToday();
  hideResetConfirm();
  closePanel();
});

els.openStats.addEventListener('click', () => {
  window.tracker.openStats();
  closePanel();
});

els.quit.addEventListener('click', () => window.tracker.quit());

// ---------------------------------------------------------------------------
// Prayer alerts
//
// Two independent moments, minutes apart: the prayer name at the time itself,
// then a verse as a follow-up. Each grows the window, shows for its own
// duration, and shrinks back. A second alert arriving mid-show replaces the
// first rather than queueing — the newer moment is the relevant one.
// ---------------------------------------------------------------------------

const alertEls = {
  root: document.getElementById('alert'),
  name: document.getElementById('alert-name'),
  arabic: document.getElementById('alert-arabic'),
  english: document.getElementById('alert-english'),
  ref: document.getElementById('alert-ref'),
  dismiss: document.getElementById('alert-dismiss'),
  audio: document.getElementById('alert-audio'),
};

let alertTimer = null;

function stopAlertAudio() {
  try {
    alertEls.audio.pause();
    alertEls.audio.removeAttribute('src');
    alertEls.audio.load();
  } catch { /* nothing playing */ }
}

function closeAlert() {
  if (alertTimer) { clearTimeout(alertTimer); alertTimer = null; }
  stopAlertAudio();
  document.body.classList.remove('alert-open');
  // Let the fade finish before collapsing the window, or the card vanishes
  // instantly and the whole thing reads as a glitch rather than a dismissal.
  setTimeout(() => {
    if (document.body.classList.contains('alert-open')) return; // re-opened
    alertEls.root.hidden = true;
    window.tracker.alertClose();
  }, 200);
}

function showAlert(payload) {
  if (alertTimer) { clearTimeout(alertTimer); alertTimer = null; }
  stopAlertAudio();

  const isVerse = payload.kind === 'prayer-verse';
  const verse = payload.verse || null;

  alertEls.name.textContent = isVerse
    ? (verse && verse.surahName ? verse.surahName : 'Reflection')
    : `${payload.prayer}`;

  if (isVerse && verse) {
    alertEls.arabic.textContent = verse.arabic || '';
    alertEls.arabic.hidden = !verse.arabic;
    alertEls.english.textContent = verse.english || '';
    alertEls.english.hidden = !verse.english;
    alertEls.ref.textContent = verse.reference ? `Quran ${verse.reference}` : '';
    alertEls.ref.hidden = !verse.reference;
  } else {
    alertEls.arabic.hidden = true;
    alertEls.english.textContent = 'It is time for prayer.';
    alertEls.english.hidden = false;
    alertEls.ref.hidden = true;
  }

  // Unhide before measuring — offsetHeight is 0 on a hidden element, and the
  // main process needs the real height to size the window.
  alertEls.root.hidden = false;
  const height = Math.ceil(alertEls.root.offsetHeight + cssVarPx('--inset-y'));
  window.tracker.alertOpen(height);

  requestAnimationFrame(() => document.body.classList.add('alert-open'));

  if (payload.audioUrl) {
    try {
      alertEls.audio.src = payload.audioUrl;
      // Electron's autoplay policy is relaxed for this window; a rejection
      // here is a missing file or no network, and must not break the visual.
      alertEls.audio.play().catch(() => {});
    } catch { /* leave it silent */ }
  }

  const seconds = Number(payload.seconds);
  const ms = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 10000;
  alertTimer = setTimeout(closeAlert, ms);
}

alertEls.dismiss.addEventListener('click', closeAlert);
window.tracker.onPrayer(showAlert);

// ---------------------------------------------------------------------------
// Global gestures
// ---------------------------------------------------------------------------

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !panel.open) return;
  event.preventDefault();
  if (!els.resetConfirm.hidden) { hideResetConfirm(); els.reset.focus(); return; }
  closePanel();
});

// Clicking the transparent margin of our own window is "away" too — a real
// click-away into another app arrives as a blur instead (onPanelDismiss).
document.addEventListener('pointerdown', (event) => {
  if (!panel.open) return;
  if (els.panel.contains(event.target) || els.pill.contains(event.target)) return;
  closePanel();
});

// The pill is the app's only surface, so right-click anywhere is the menu.
window.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  window.tracker.showContextMenu();
});

// A frameless HUD should never accept a dropped file.
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', (event) => event.preventDefault());

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

applyScale();
window.tracker.onState(applyState);
window.tracker.onSettings((next) => { if (next) applyPaused(next.paused === true); });
window.tracker.ready();
