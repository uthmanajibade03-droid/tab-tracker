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
  tag: document.getElementById('tag'),
  app: document.getElementById('app'),
  domain: document.getElementById('domain'),
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
const ASPECT = 76 / 260;   // two rows; must match PILL_ASPECT in main.js
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

  els.time.textContent = formatDuration(state.activeMs);
}

/*
 * Tracking state, in words. This replaces the coloured dot: the label row was
 * already there to say what the number is, and it can say what the tracker is
 * doing at the same time without a legend.
 *
 * Not part of the cross-fade — state should change the instant it changes,
 * while the fade is about identity.
 */
const TAG = { active: 'In focus', paused: 'Paused', idle: 'Idle' };

function paintStatus(status) {
  els.tag.textContent = TAG[status] || TAG.idle;
  els.tag.dataset.status = status === 'active' || status === 'paused' ? status : 'idle';
}

function applyState(state) {
  latest = state;
  paintStatus(state.status);

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
  answer: document.getElementById('call-answer'),
  decline: document.getElementById('call-decline'),
  audio: document.getElementById('alert-audio'),
};

let alertTimer = null;
/** peerId of the call currently ringing on this card, if any. */
let ringingPeerId = null;

function stopAlertAudio() {
  try {
    alertEls.audio.pause();
    alertEls.audio.removeAttribute('src');
    alertEls.audio.load();
  } catch { /* nothing playing */ }
}

function closeAlert() {
  if (alertTimer) { clearTimeout(alertTimer); alertTimer = null; }
  ringingPeerId = null;
  stopAlertAudio();
  alertEls.root.classList.remove('calling');
  document.body.classList.remove('alert-open');
  // Let the fade finish before collapsing the window, or the card vanishes
  // instantly and the whole thing reads as a glitch rather than a dismissal.
  setTimeout(() => {
    if (document.body.classList.contains('alert-open')) return; // re-opened
    alertEls.root.hidden = true;
    window.tracker.alertClose();
  }, 200);
}

/*
 * The scene is attached lazily and kept: the first verse of the day pays for
 * the decode, every later one reuses it. Which scene comes from the stats
 * window's picker, so the two surfaces never disagree.
 */
let alertScene = null;

function mountAlertScene() {
  if (alertScene || !window.Scene) return;
  const el = document.getElementById('alert-scene');
  if (!el) return;
  window.tracker.sceneContext().then(ctx => {
    alertScene = window.Scene.attach(el, { sceneId: ctx.id, timings: ctx.timings });
  }).catch(() => { /* no scene rather than a broken card */ });
}

if (window.tracker.onSceneChanged) {
  window.tracker.onSceneChanged(id => { if (alertScene) alertScene.setScene(id); });
}

function showAlert(payload) {
  if (alertTimer) { clearTimeout(alertTimer); alertTimer = null; }
  ringingPeerId = null;
  alertEls.root.classList.remove('calling');
  alertEls.dismiss.hidden = false;
  alertEls.answer.hidden = true;
  alertEls.decline.hidden = true;
  stopAlertAudio();

  const isVerse = payload.kind === 'prayer-verse';
  const verse = payload.verse || null;
  // Lets the stylesheet tell the two cards apart: on a verse card the name is
  // the source and steps back; on a prayer card it is the headline.
  alertEls.root.classList.toggle('verse', isVerse);
  if (isVerse) mountAlertScene();

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
    /* A notice supplies its own line; a prayer name card always says the same
       thing. Empty message means "show no second line at all". */
    const body = payload.kind === 'notice'
      ? (payload.message || '')
      : 'It is time for prayer.';
    alertEls.english.textContent = body;
    alertEls.english.hidden = !body;
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

/*
 * Incoming calls reuse the same card. The difference is that a call waits on
 * a decision rather than expiring on a timer — no auto-close here; the hidden
 * voice client declines after 30s and that arrives as state 'ended'.
 */
function showIncomingCall({ peerId, name }) {
  if (alertTimer) { clearTimeout(alertTimer); alertTimer = null; }
  stopAlertAudio();
  ringingPeerId = peerId;

  alertEls.root.classList.add('calling');
  alertEls.name.textContent = name || 'Someone';
  alertEls.arabic.hidden = true;
  alertEls.ref.hidden = true;
  alertEls.english.textContent = 'is calling you';
  alertEls.english.hidden = false;

  alertEls.dismiss.hidden = true;
  alertEls.answer.hidden = false;
  alertEls.decline.hidden = false;

  alertEls.root.hidden = false;
  const height = Math.ceil(alertEls.root.offsetHeight + cssVarPx('--inset-y'));
  window.tracker.alertOpen(height);
  requestAnimationFrame(() => document.body.classList.add('alert-open'));
}

alertEls.answer.addEventListener('click', async () => {
  const peerId = ringingPeerId;
  if (!peerId) return;
  stopRinging();
  // Close first: the card's job ends the moment the decision is made, and
  // leaving it up through the microphone prompt reads as if nothing happened.
  closeAlert();
  const r = await window.tracker.answerCall(peerId);
  /*
   * A failure here already surfaced as a notice from the voice client, which
   * knows WHY it failed. Not silently swallowed — just not reported twice.
   */
  if (r && r.ok === false) console.warn('[pill] answer failed:', r.error);
});

alertEls.decline.addEventListener('click', () => {
  const peerId = ringingPeerId;
  stopRinging();
  closeAlert();
  if (peerId) window.tracker.declineCall(peerId);
});

// ---------------------------------------------------------------------------
// Ringtone
//
// Synthesised rather than shipped as an mp3: nothing to bundle, nothing to
// fetch, and it cannot fail because a file was missing from a build. Two short
// bursts every three seconds — the familiar cadence.
//
// A ringing call with no sound is a missed call. The card alone is not enough
// when the pill may be sitting in the corner of a screen nobody is looking at.
// ---------------------------------------------------------------------------

let ringCtx = null;
let ringTimer = null;

function ringBurst(ctx, at) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(480, at);
  // Ramped rather than switched, so it reads as a chirp instead of a click.
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(0.18, at + 0.02);
  gain.gain.setValueAtTime(0.18, at + 0.32);
  gain.gain.linearRampToValueAtTime(0, at + 0.4);
  osc.connect(gain).connect(ctx.destination);
  osc.start(at);
  osc.stop(at + 0.42);
}

function startRinging() {
  if (ringTimer) return; // already ringing for someone
  try {
    if (!ringCtx) ringCtx = new AudioContext();
    // An AudioContext can start suspended; without this the ring is silent.
    if (ringCtx.state === 'suspended') ringCtx.resume().catch(() => {});
    const cycle = () => {
      const now = ringCtx.currentTime;
      ringBurst(ringCtx, now);
      ringBurst(ringCtx, now + 0.6);
    };
    cycle();
    ringTimer = setInterval(cycle, 3000);
  } catch (err) {
    console.warn('[pill] ringtone unavailable:', err && err.message);
  }
}

function stopRinging() {
  if (ringTimer) { clearInterval(ringTimer); ringTimer = null; }
}

// ---------------------------------------------------------------------------
// Voice notices
//
// Reuses the alert card. A failed call must say why — "your microphone was
// blocked" is actionable, a card that silently disappears is not.
// ---------------------------------------------------------------------------

const NOTICE_TEXT = {
  'mic-denied': ['Microphone blocked', 'Allow microphone access for Tab Tracker in your system settings, then try again.'],
  'mic-missing': ['No microphone', 'No microphone was found. Plug one in and try again.'],
  'mic-failed': ['Microphone unavailable', "Your microphone couldn't be opened. Another app may be using it."],
  'no-answer': ['No answer', null],
  declined: ['Call declined', null],
  'missed-call': ['Missed call', null],
  'peer-unavailable': ['Not reachable', "They're not online any more."],
  'call-failed': ['Call failed', 'The connection dropped.'],
  'call-ended': ['Call ended', null],
};

function showNotice(kind, name) {
  const entry = NOTICE_TEXT[kind];
  if (!entry) return;
  const [title, detail] = entry;
  const byName = {
    'no-answer': name ? `${name} didn't pick up.` : '',
    declined: name ? `${name} declined.` : '',
    'missed-call': name ? `You missed a call from ${name}.` : '',
    'call-ended': name ? `Your call with ${name} ended.` : '',
  }[kind];
  showAlert({
    kind: 'notice',
    prayer: title,
    message: detail || byName || '',
    // A microphone problem needs reading and acting on; the rest are FYI.
    seconds: kind.startsWith('mic-') ? 12 : 6,
  });
}

// ---------------------------------------------------------------------------
// Teammates in the settings panel
//
// The same roster the stats window shows, so placing a call doesn't require
// opening the whole app. Hidden entirely when voice isn't set up, rather than
// showing an empty section that begs a question.
// ---------------------------------------------------------------------------

const peersEls = {
  root: document.getElementById('peers'),
  status: document.getElementById('peers-status'),
  list: document.getElementById('peers-list'),
};

function renderPeers(snap) {
  /* The glow is driven from here because this is where call state arrives.
     It must survive the panel being closed — being on a call is a property of
     the app, not of a menu the user happens to have open. */
  document.body.classList.toggle('in-call', !!(snap && snap.inCall));

  if (!snap || !snap.configured) {
    peersEls.root.hidden = true;
    return;
  }
  peersEls.root.hidden = false;
  peersEls.status.textContent = snap.error ? 'offline'
    : snap.online ? (snap.inCall ? 'in a call' : '') : 'connecting…';

  peersEls.list.replaceChildren();

  if (!snap.roster.length) {
    const empty = document.createElement('div');
    empty.className = 'peers-empty';
    empty.textContent = 'Nobody else online';
    peersEls.list.appendChild(empty);
    return;
  }

  for (const p of snap.roster) {
    const row = document.createElement('div');
    row.className = 'peer-row';

    const dot = document.createElement('span');
    dot.className = 'dot';
    if (!p.reachable) dot.classList.add('away');
    else if (p.busy && !p.withUs) dot.classList.add('busy');

    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = p.name;

    const btn = document.createElement('button');
    btn.type = 'button';

    if (p.withUs) {
      // Already talking to them.
      btn.textContent = 'Hang up';
      btn.className = 'hangup';
      btn.addEventListener('click', () => window.tracker.hangUp(p.peerId));
    } else if (p.ringing) {
      // We dialled and they have not picked up yet.
      btn.textContent = 'Ringing…';
      btn.disabled = true;
    } else if (p.busy) {
      /*
       * They are on a call with someone else. A mesh has no "the call" to be
       * let into — joining means ringing every participant, and each of them
       * gets an ordinary incoming call to accept or decline. That is the
       * notification and consent, with no extra server state to keep in sync.
       */
      btn.textContent = 'Join';
      btn.className = 'join';
      btn.disabled = !p.reachable;
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = 'Ringing…';
        await window.tracker.join(p.party);
      });
    } else {
      // Free. "Add" while we are already in a call — same action, but the word
      // says what it does to the call rather than describing it from scratch.
      btn.textContent = snap.inCall ? 'Add' : 'Call';
      btn.disabled = !p.reachable;
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = 'Ringing…';
        await window.tracker.dial(p.peerId);
      });
    }

    row.append(dot, who, btn);
    peersEls.list.appendChild(row);
  }
}

window.tracker.onVoice((snap) => {
  renderPeers(snap);
  // Someone coming online while the panel is open changes its height; without
  // this the window stays its old size and the new row is clipped off.
  if (panel.open) syncPanelHeight();
});
window.tracker.voiceSnapshot().then(renderPeers);

window.tracker.onCall((msg) => {
  if (!msg) return;
  if (msg.state === 'ringing') { startRinging(); showIncomingCall(msg); return; }
  // 'ended' — they hung up, it timed out, or we answered. Either way the
  // ringing stops; the card only closes if it is still showing that call.
  if (msg.state === 'ended') {
    stopRinging();
    if (ringingPeerId === msg.peerId) closeAlert();
  }
});

window.tracker.onVoiceNotice((n) => {
  if (!n) return;
  stopRinging();
  showNotice(n.kind, n.name);
});

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
