'use strict';

/*
 * The only channel between the main process and the pill UI.
 *
 * The renderer runs with nodeIntegration disabled and contextIsolation on, so
 * it has no access to Node, Electron, or IPC of its own. Everything it is
 * allowed to do is enumerated here — a fixed list of functions, no raw
 * ipcRenderer, and no way to name a channel the main process did not opt into.
 *
 * Nothing here trusts its arguments: every value is re-validated on the main
 * side. This file's job is to keep the channel surface small, not to police it.
 */

const { contextBridge, ipcRenderer } = require('electron');

/**
 * @typedef {Object} TrackerState
 * @property {string|null} app       Friendly app name, or null when unknown.
 * @property {string|null} domain    Domain from the browser extension, if fresh.
 * @property {number}      activeMs  Today's total for `app`, in milliseconds.
 * @property {'active'|'paused'|'idle'} status
 */

/**
 * @typedef {Object} PillSettings
 * @property {boolean} paused
 */

/**
 * Subscribe to a main→renderer push.
 *
 * Deliberately drops the IpcRendererEvent argument: handing the renderer an
 * event object would leak `sender`, and with it a path back to IPC that this
 * API is meant to be the only door through.
 */
function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('tracker', {
  /** Which ambient scene to show behind the verse card, and where the sun is. */
  sceneContext() { return ipcRenderer.invoke('scene:get'); },

  /** Fired when the stats window changes the scene. */
  onSceneChanged(callback) { return subscribe('scene:changed', callback); },

  // ---- pushes from the main process ----

  /**
   * Tracker state (~1Hz, plus an immediate push on every focus change).
   * @param {(state: TrackerState) => void} callback
   * @returns {() => void} unsubscribe
   */
  onState(callback) { return subscribe('tracker:state', callback); },

  /**
   * Current settings, pushed on ready and whenever one of them changes.
   * @param {(settings: PillSettings) => void} callback
   */
  onSettings(callback) { return subscribe('pill:settings', callback); },

  /**
   * Which side of the pill the panel ended up on: `{ direction: 'up'|'down' }`.
   * Sent in reply to panelOpen(), once the window has actually been resized.
   */
  onPanelLayout(callback) { return subscribe('pill:panel-layout', callback); },

  /** The window lost focus (the user clicked away); close the panel. */
  onPanelDismiss(callback) { return subscribe('pill:panel-dismiss', callback); },

  // ---- lifecycle ----

  /** Tell the main process the UI is mounted and wants an initial push. */
  ready() { ipcRenderer.send('pill:ready'); },

  /** Ask the main process to pop up the pill's right-click menu. */
  showContextMenu() { ipcRenderer.send('pill:context-menu'); },

  /** Today's total and the few apps the panel lists. */
  today() { return ipcRenderer.invoke('pill:today'); },

  // ---- window dragging ----
  //
  // The pill is no longer a -webkit-app-region: drag surface (that would eat
  // the clicks the settings panel needs), so the renderer drives the drag and
  // reports a cursor delta in DIPs relative to where the gesture started.

  dragStart() { ipcRenderer.send('pill:drag-start'); },
  dragMove(dx, dy) { ipcRenderer.send('pill:drag-move', dx, dy); },
  dragEnd() { ipcRenderer.send('pill:drag-end'); },

  // ---- resizing ----
  //
  // The pill's right edge is a grab handle. The renderer sends the width it
  // wants; the main process clamps it, derives the height, and re-clamps the
  // whole capsule to the display's work area.

  resize(width) { ipcRenderer.send('pill:resize', width); },
  resizeEnd() { ipcRenderer.send('pill:resize-end'); },

  // ---- settings panel ----

  /** Grow the window by `height` px to make room for the panel. */
  panelOpen(height) { ipcRenderer.send('pill:panel-open', height); },

  /** Shrink the window back to just the pill. */
  panelClose() { ipcRenderer.send('pill:panel-close'); },

  // ---- settings ----

  setPaused(paused) { ipcRenderer.send('pill:set-paused', paused); },

  /** Already confirmed in the panel; the main process does not ask again. */
  resetToday() { ipcRenderer.send('pill:reset-today'); },

  quit() { ipcRenderer.send('pill:quit'); },

  /** Open the full stats window (from the pill's settings panel). */
  openStats() { ipcRenderer.send('stats:open'); },

  // ---- prayer alerts ----

  /**
   * A prayer moment to display. Two kinds arrive separately, minutes apart:
   * `prayer-name` at the time itself, then `prayer-verse` as a follow-up.
   */
  onPrayer(callback) { return subscribe('pill:prayer', callback); },

  /** Grow the window by `height` px for the alert card. */
  alertOpen(height) { ipcRenderer.send('pill:alert-open', height); },

  /** Shrink back to the bare pill once the alert has run its course. */
  alertClose() { ipcRenderer.send('pill:alert-close'); },

  // ---- incoming calls ----

  /** `{state: 'ringing', peerId, name}` or `{state: 'ended', peerId}`. */
  onCall(callback) { return subscribe('pill:call', callback); },

  answerCall(peerId) { return ipcRenderer.invoke('voice:accept', peerId); },
  declineCall(peerId) { return ipcRenderer.invoke('voice:decline', peerId); },

  // ---- roster, for the settings panel ----

  voiceSnapshot() { return ipcRenderer.invoke('voice:snapshot'); },
  onVoice(callback) { return subscribe('voice:update', callback); },
  dial(peerId) { return ipcRenderer.invoke('voice:dial', peerId); },
  join(peerIds) { return ipcRenderer.invoke('voice:join', peerIds); },
  hangUp(peerId) { return ipcRenderer.invoke('voice:hangup', peerId); },

  /** Something the user must be told — a denied mic, an unanswered call. */
  onVoiceNotice(callback) { return subscribe('pill:voice-notice', callback); },
});

/*
 * The stats window's own surface. Separate object because it is a different
 * document with a different job — the pill has no business calling these, and
 * the stats window has no business dragging or resizing the pill.
 */
contextBridge.exposeInMainWorld('stats', {
  /** Which ambient scene to show, and where the sun is. */
  sceneContext() { return ipcRenderer.invoke('scene:get'); },

  /** Change it. Persists, and tells the pill. */
  setScene(id) { return ipcRenderer.invoke('scene:set', id); },

  /** Full payload: day list, per-app totals, per-site totals. */
  load() { return ipcRenderer.invoke('stats:load'); },

  /** Fired when the extension pushes fresh browser data. */
  onChanged(callback) { return subscribe('stats:changed', callback); },

  openFolder() { ipcRenderer.send('stats:open-folder'); },

  // ---- updates ----

  /** Current version plus whether one is downloading or waiting to install. */
  updateStatus() { return ipcRenderer.invoke('app:update-status'); },

  onUpdateStatus(callback) { return subscribe('app:update-status', callback); },

  /** Restart into the downloaded version. */
  installUpdate() { ipcRenderer.send('app:install-update'); },

  // ---- voice ----

  voiceSnapshot() { return ipcRenderer.invoke('voice:snapshot'); },
  onVoice(callback) { return subscribe('voice:update', callback); },
  saveVoiceConfig(cfg) { return ipcRenderer.invoke('voice:set-config', cfg); },
  dial(peerId) { return ipcRenderer.invoke('voice:dial', peerId); },
  join(peerIds) { return ipcRenderer.invoke('voice:join', peerIds); },
  hangUp(peerId) { return ipcRenderer.invoke('voice:hangup', peerId); },

  // ---- prayer ----

  /** Current values plus the lists to choose from (reciters, adhans, surahs). */
  prayerSettings() { return ipcRenderer.invoke('prayer:settings'); },

  /** Partial update; returns the settings as they ended up. */
  savePrayer(settings) { return ipcRenderer.invoke('prayer:save', settings); },

  /** Load the chosen verse's text so it can be seen before it ever fires. */
  previewVerse() { return ipcRenderer.invoke('prayer:preview-verse'); },

  /** Today's five times, for display. */
  prayerTimes() { return ipcRenderer.invoke('prayer:times'); },

  /** Run the full name → verse sequence on the pill, now. */
  previewPrayer() { ipcRenderer.send('prayer:demo'); },
});

/*
 * The hidden voice window's surface. Exposed on every window because they
 * share one preload file, but only voice.html ever calls it — and the main
 * process ignores these channels from any other sender by construction, since
 * nothing else knows a pending request id.
 */
contextBridge.exposeInMainWorld('voiceBridge', {
  ready() { ipcRenderer.send('voice:ready'); },
  state(s) { ipcRenderer.send('voice:state', s); },
  ring(peerId) { ipcRenderer.send('voice:ring', peerId); },
  ringEnded(peerId) { ipcRenderer.send('voice:ring-ended', peerId); },
  notify(msg) { ipcRenderer.send('voice:notify', msg); },
  result(id, payload) { ipcRenderer.send('voice:result', id, payload); },
  onCommand(callback) { return subscribe('voice:command', callback); },
});
