'use strict';

/*
 * Voice, main-process side.
 *
 * Splits the work the way the platform forces: this file talks HTTP to the
 * rendezvous server (presence, roster, join requests), while the hidden
 * renderer/voice.html holds the things only a browser has — WebRTC peer
 * connections and the microphone.
 *
 * The server never carries audio. It answers exactly one question: who is
 * online right now and what is their peer id.
 *
 * Identity is a display name plus a slug derived from it, matching the
 * extension so the same person looks the same to teammates from either.
 */

const fs = require('fs');
const path = require('path');

const PRESENCE_INTERVAL_MS = 24000; // server expires an entry after ~60s
const ROSTER_INTERVAL_MS = 6000;
const DEFAULT_SERVER = 'https://tabtracker.uthman.xyz';

let configPath = null;
let config = { name: '', userId: '', token: '', serverUrl: DEFAULT_SERVER, enabled: true };

let state = { peerId: null, inCallWith: [], ringingFrom: [], hasMic: false };
let roster = [];
let lastError = null;

let presenceTimer = null;
let rosterTimer = null;

let sendToClient = () => {};   // → hidden voice window
let onEvent = () => {};        // → main.js, for UI updates

function log(...args) { console.log('[voice]', ...args); }

/** Same rule as the extension's options page, so both produce one identity. */
function slugify(name) {
  return String(name).trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function configured() {
  return !!(config.enabled && config.name && config.userId && config.token && config.serverUrl);
}

function base() {
  return String(config.serverUrl || DEFAULT_SERVER).replace(/\/+$/, '');
}

function headers(extra) {
  return { 'x-tt-token': config.token, ...(extra || {}) };
}

function loadConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      config = { ...config, ...parsed };
      config.userId = config.userId || slugify(config.name);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') log('could not read config:', err.message);
  }
}

function saveConfig() {
  try {
    const tmp = `${configPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(config));
    fs.renameSync(tmp, configPath);
  } catch (err) {
    log('could not save config:', err.message);
  }
}

function getConfig() {
  // The token is a shared secret; hand the UI a flag, not the value.
  return {
    name: config.name,
    userId: config.userId,
    serverUrl: config.serverUrl || DEFAULT_SERVER,
    enabled: config.enabled,
    hasToken: !!config.token,
  };
}

function setConfig(next) {
  if (!next || typeof next !== 'object') return getConfig();
  if (typeof next.name === 'string') {
    config.name = next.name.trim().slice(0, 40);
    config.userId = slugify(config.name);
  }
  if (typeof next.serverUrl === 'string' && next.serverUrl.trim()) {
    config.serverUrl = next.serverUrl.trim().replace(/\/+$/, '');
  }
  // An empty string means "leave it alone", so saving the form without
  // retyping the token does not wipe it.
  if (typeof next.token === 'string' && next.token.trim()) {
    config.token = next.token.trim();
  }
  if (typeof next.enabled === 'boolean') config.enabled = next.enabled;
  saveConfig();
  lastError = null;
  if (configured()) {
    sendToClient({ action: 'init', userId: config.userId });
    heartbeat().catch(() => {});
    pollRoster().catch(() => {});
  }
  emit();
  return getConfig();
}

async function heartbeat() {
  if (!configured()) return;
  try {
    const res = await fetch(`${base()}/api/admin/presence`, {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        userId: config.userId,
        name: config.name,
        // Advertise ourselves before the broker has assigned an id, so a
        // teammate at least sees we are here rather than nothing at all.
        peerId: state.peerId || `pending-${config.userId}`,
        callWith: peerIdsToUserIds(state.inCallWith),
      }),
    });
    if (!res.ok) {
      lastError = res.status === 401 ? 'Token rejected' : `Server error ${res.status}`;
      emit();
      return;
    }
    if (lastError) { lastError = null; emit(); }
  } catch (err) {
    lastError = 'Cannot reach the voice server';
    emit();
  }
}

function peerIdsToUserIds(peerIds) {
  return peerIds
    .map(pid => { const r = roster.find(x => x.peerId === pid); return r ? r.userId : null; })
    .filter(Boolean);
}

async function pollRoster() {
  if (!configured()) return;
  try {
    const res = await fetch(`${base()}/api/admin/presence`, { headers: headers(), cache: 'no-store' });
    if (!res.ok) return;
    const j = await res.json();
    const next = Array.isArray(j.online) ? j.online : [];
    // Never list ourselves as someone to call.
    roster = next.filter(p => p.userId !== config.userId);
    emit();
  } catch {
    // Transient; the next tick tries again. lastError is set by the heartbeat,
    // which runs against the same host and is the better signal.
  }
}

/** Roster + our own call state, shaped for the UI. */
function snapshot() {
  const byPeer = new Map(roster.map(p => [p.peerId, p]));
  return {
    configured: configured(),
    config: getConfig(),
    peerId: state.peerId,
    connected: !!state.peerId,
    hasMic: state.hasMic,
    error: lastError,
    inCallWith: state.inCallWith.map(pid => {
      const p = byPeer.get(pid);
      return { peerId: pid, name: p ? p.name : 'Someone', userId: p ? p.userId : null };
    }),
    ringingFrom: state.ringingFrom.map(pid => {
      const p = byPeer.get(pid);
      return { peerId: pid, name: p ? p.name : 'Someone', userId: p ? p.userId : null };
    }),
    roster: roster.map(p => ({
      userId: p.userId,
      name: p.name,
      peerId: p.peerId,
      // A "pending-" id means their client is up but the broker has not
      // assigned them an id yet; calling it would fail.
      reachable: typeof p.peerId === 'string' && !p.peerId.startsWith('pending-'),
      busy: Array.isArray(p.callWith) && p.callWith.length > 0,
    })),
  };
}

function emit() { onEvent(snapshot()); }

// -- called by main.js when the hidden client reports ------------------------

function onClientState(next) {
  const wasRinging = state.ringingFrom.length;
  state = { ...state, ...next };
  // A fresh peer id should reach teammates now, not up to 24 seconds later.
  if (next.peerId && configured()) heartbeat().catch(() => {});
  if (state.ringingFrom.length !== wasRinging) emit();
  else emit();
}

function init({ userDataPath, send, onUpdate }) {
  configPath = path.join(userDataPath, 'voice.json');
  sendToClient = typeof send === 'function' ? send : () => {};
  onEvent = typeof onUpdate === 'function' ? onUpdate : () => {};
  loadConfig();

  if (configured()) {
    sendToClient({ action: 'init', userId: config.userId });
    heartbeat().catch(() => {});
    pollRoster().catch(() => {});
  }
  presenceTimer = setInterval(() => { heartbeat().catch(() => {}); }, PRESENCE_INTERVAL_MS);
  rosterTimer = setInterval(() => { pollRoster().catch(() => {}); }, ROSTER_INTERVAL_MS);
}

function stop() {
  if (presenceTimer) { clearInterval(presenceTimer); presenceTimer = null; }
  if (rosterTimer) { clearInterval(rosterTimer); rosterTimer = null; }
}

/** Look up the display name behind a peer id, for the pill's ring card. */
function nameForPeer(peerId) {
  const p = roster.find(x => x.peerId === peerId);
  return p ? p.name : 'Someone';
}

module.exports = {
  init, stop, setConfig, getConfig, snapshot, emit,
  onClientState, nameForPeer, configured, heartbeat, pollRoster,
};
