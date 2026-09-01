'use strict';

/*
 * PeerJS client for the desktop app — the counterpart to the extension's
 * offscreen document, and for the same reason: the main process has no WebRTC
 * and no microphone, so a DOM has to hold them.
 *
 * This window is never shown. It owns:
 *   - the PeerJS connection to the broker (and therefore our peer id)
 *   - the microphone stream, acquired lazily so merely running the app never
 *     lights up the mic indicator
 *   - one <audio> element per remote participant, so a mesh call plays
 *     everyone at once
 *
 * Incoming calls RING. They are parked unanswered until the user accepts, so
 * the microphone is never opened by someone else's action.
 */

const PEER_HOST = '0.peerjs.com';
const PEER_PORT = 443;
const PEER_KEY = 'peerjs';
const RING_TIMEOUT_MS = 30000;

let peer = null;
let peerId = null;
let localStream = null;

const activeCalls = new Map();     // remotePeerId -> { call, audioEl }
const pendingIncoming = new Map(); // remotePeerId -> { call, timer }

const audioHost = document.getElementById('remote-audio');

function log(...args) { console.log('[voice]', ...args); }

function report() {
  window.voiceBridge.state({
    peerId,
    inCallWith: Array.from(activeCalls.keys()),
    ringingFrom: Array.from(pendingIncoming.keys()),
    hasMic: !!(localStream && localStream.getAudioTracks().some(t => t.readyState === 'live')),
  });
}

async function init(userId) {
  if (peer) return peerId;
  // Random suffix so the same person signed in on two machines does not
  // collide on the broker; "tt-" namespaces us away from unrelated apps.
  const suffix = Math.random().toString(36).slice(2, 10);
  const id = userId ? `tt-${userId}-${suffix}` : undefined;

  peer = new Peer(id, { host: PEER_HOST, port: PEER_PORT, path: '/', key: PEER_KEY, secure: true });

  peer.on('open', (assigned) => {
    peerId = assigned;
    log('connected to broker as', assigned);
    report();
  });

  peer.on('call', (incoming) => {
    log('incoming call from', incoming.peer, '— ringing');
    const timer = setTimeout(() => decline(incoming.peer, 'timeout'), RING_TIMEOUT_MS);
    pendingIncoming.set(incoming.peer, { call: incoming, timer });
    // If the caller gives up mid-ring, stop ringing here too.
    incoming.on('close', () => clearRing(incoming.peer));
    incoming.on('error', () => clearRing(incoming.peer));
    window.voiceBridge.ring(incoming.peer);
    report();
  });

  peer.on('disconnected', () => { log('broker dropped us; reconnecting'); try { peer.reconnect(); } catch { /* gone */ } });
  peer.on('close', () => { peer = null; peerId = null; report(); });
  peer.on('error', (err) => log('peer error', err && err.type));

  return peerId;
}

async function ensureMic() {
  if (localStream && localStream.getAudioTracks().some(t => t.readyState === 'live')) return localStream;
  localStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false,
  });
  return localStream;
}

function releaseMic() {
  if (!localStream) return;
  localStream.getTracks().forEach(t => t.stop());
  localStream = null;
}

function track(call) {
  const audioEl = document.createElement('audio');
  audioEl.autoplay = true;
  audioEl.dataset.peer = call.peer;
  audioHost.appendChild(audioEl);
  activeCalls.set(call.peer, { call, audioEl });

  call.on('stream', (remote) => {
    audioEl.srcObject = remote;
    audioEl.play().catch(err => log('remote playback failed', err && err.message));
  });
  call.on('close', () => {
    const entry = activeCalls.get(call.peer);
    if (entry && entry.audioEl) { entry.audioEl.srcObject = null; entry.audioEl.remove(); }
    activeCalls.delete(call.peer);
    // Holding the mic open with nobody to hear it is what makes an app feel
    // like it is spying on you.
    if (activeCalls.size === 0) releaseMic();
    report();
  });
  call.on('error', (err) => log('call error', err && err.message));
  report();
}

function clearRing(remotePeerId) {
  const entry = pendingIncoming.get(remotePeerId);
  if (!entry) return;
  clearTimeout(entry.timer);
  pendingIncoming.delete(remotePeerId);
  window.voiceBridge.ringEnded(remotePeerId);
  report();
}

async function accept(remotePeerId) {
  const entry = pendingIncoming.get(remotePeerId);
  if (!entry) return { ok: false, error: 'no-such-ring' };
  clearTimeout(entry.timer);
  pendingIncoming.delete(remotePeerId);
  try {
    // The microphone opens HERE — after a person chose to answer.
    const stream = await ensureMic();
    entry.call.answer(stream);
    track(entry.call);
    window.voiceBridge.ringEnded(remotePeerId);
    return { ok: true };
  } catch (err) {
    log('cannot answer:', err && err.message);
    try { entry.call.close(); } catch { /* already gone */ }
    window.voiceBridge.ringEnded(remotePeerId);
    report();
    return { ok: false, error: 'mic-unavailable' };
  }
}

function decline(remotePeerId, reason) {
  const entry = pendingIncoming.get(remotePeerId);
  if (!entry) return { ok: true, notRinging: true };
  clearTimeout(entry.timer);
  pendingIncoming.delete(remotePeerId);
  try { entry.call.close(); } catch { /* already gone */ }
  log('declined', remotePeerId, reason || '');
  window.voiceBridge.ringEnded(remotePeerId);
  report();
  return { ok: true };
}

async function dial(remotePeerId) {
  if (!peer) return { ok: false, error: 'not-connected' };
  if (activeCalls.has(remotePeerId)) return { ok: true, already: true };
  try {
    const stream = await ensureMic();
    const call = peer.call(remotePeerId, stream);
    if (!call) return { ok: false, error: 'call-failed' };
    track(call);

    /*
     * PeerJS gives the caller no "they declined" signal — a callee that closes
     * an unanswered call does not reliably surface as 'close' on this side. So
     * an unanswered call would sit in activeCalls forever, showing us as busy
     * to the whole roster and blocking a retry via the `already` short-circuit.
     *
     * The callee rings for RING_TIMEOUT_MS; give that a little room, and if no
     * media has arrived by then, treat it as unanswered and tear it down.
     */
    const entry = activeCalls.get(remotePeerId);
    let answered = false;
    call.on('stream', () => { answered = true; });
    setTimeout(() => {
      if (answered) return;
      if (activeCalls.get(remotePeerId) !== entry) return; // superseded already
      log('no answer from', remotePeerId, '— giving up');
      try { call.close(); } catch { /* already gone */ }
      const stale = activeCalls.get(remotePeerId);
      if (stale) {
        if (stale.audioEl) { stale.audioEl.srcObject = null; stale.audioEl.remove(); }
        activeCalls.delete(remotePeerId);
      }
      if (activeCalls.size === 0) releaseMic();
      report();
    }, RING_TIMEOUT_MS + 5000);

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err && err.message };
  }
}

function hangUp(remotePeerId) {
  if (remotePeerId) {
    const entry = activeCalls.get(remotePeerId);
    if (entry) { try { entry.call.close(); } catch { /* already gone */ } }
    return { ok: true };
  }
  for (const [, entry] of activeCalls) { try { entry.call.close(); } catch { /* already gone */ } }
  for (const id of Array.from(pendingIncoming.keys())) decline(id, 'hung-up');
  releaseMic();
  report();
  return { ok: true };
}

window.voiceBridge.onCommand(async (msg) => {
  switch (msg && msg.action) {
    case 'init':    await init(msg.userId); break;
    case 'dial':    window.voiceBridge.result(msg.id, await dial(msg.peerId)); break;
    case 'accept':  window.voiceBridge.result(msg.id, await accept(msg.peerId)); break;
    case 'decline': window.voiceBridge.result(msg.id, decline(msg.peerId, 'user')); break;
    case 'hangup':  window.voiceBridge.result(msg.id, hangUp(msg.peerId)); break;
    default: break;
  }
});

window.voiceBridge.ready();
