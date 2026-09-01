/* Offscreen document — dual-purpose:
 *   1. Audio dispatcher (target: 'offscreen-audio') — Adhan + Quran
 *      recitation for prayer-time alerts. Same behavior as before this
 *      file was combined.
 *   2. Voice call driver (target: 'offscreen-voice') — Peer.js client
 *      + mic + N-way remote audio. Incoming calls RING and wait for the
 *      user to accept; the mic is never opened without consent.
 *
 * Both share the same offscreen doc because Chrome MV3 only allows ONE
 * offscreen page per extension at a time. Reasons declared in
 * background.js's createDocument call: ['AUDIO_PLAYBACK', 'USER_MEDIA'].
 *
 * Message routing: every listener gates on `msg.target` and returns
 * false immediately if it doesn't match, so the two handlers don't
 * interfere. */

/* ═══════════════════════════════════════════════════════════════════
 * 1. Audio dispatcher (Adhan + verse recitation)
 * ═══════════════════════════════════════════════════════════════════ */

const audio = document.getElementById('audio');

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen-audio') return false;
  if (msg.action === 'play' && typeof msg.url === 'string' && msg.url) {
    try {
      audio.src = msg.url;
      audio.currentTime = 0;
      const p = audio.play();
      if (p && typeof p.then === 'function') {
        p.then(() => sendResponse({ ok: true }))
         .catch((err) => {
           console.log('[offscreen] play failed:', err && err.message);
           sendResponse({ ok: false, error: err && err.message });
         });
        return true; // keep channel open for async sendResponse
      }
      sendResponse({ ok: true });
    } catch (e) {
      console.log('[offscreen] play threw:', e && e.message);
      sendResponse({ ok: false, error: e && e.message });
    }
    return false;
  }
  if (msg.action === 'stop') {
    try { audio.pause(); audio.currentTime = 0; } catch {}
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

/* ═══════════════════════════════════════════════════════════════════
 * 2. Voice call driver (Peer.js + WebRTC)
 * ═══════════════════════════════════════════════════════════════════
 *
 * Holds:
 *  - The Peer.js client (peerId written to chrome.storage.local.voicePeerId
 *    so background's presence heartbeat can advertise it).
 *  - The user's mic stream (created lazily on first call — avoids
 *    prompting for mic permission just because the extension is running).
 *  - Active mesh peer connections (one entry per remote user).
 *  - One <audio> per remote peer for simultaneous playback of N streams. */

const PEER_HOST = '0.peerjs.com';
const PEER_PORT = 443;
const PEER_KEY = 'peerjs';

let peer = null;
let peerId = null;
let localStream = null;
const activeCalls = new Map(); // remotePeerId -> { call, audioEl }
let audiosContainer = null;

/* Incoming calls are parked here until the user explicitly accepts.
   Answering on arrival would open the microphone with no consent, so a
   ringing call holds its Peer.js call object and nothing else happens
   until acceptCall() or declineCall() runs. Auto-declines after
   RING_TIMEOUT_MS so a missed call doesn't ring forever. */
const RING_TIMEOUT_MS = 30000;
const pendingIncoming = new Map(); // remotePeerId -> { call, timer }

function vlog(...args) { console.log('[tab-tracker-voice]', ...args); }

async function pickPeerId() {
  const { syncConfig } = await chrome.storage.local.get('syncConfig');
  if (syncConfig && syncConfig.userId) {
    /* Random suffix keeps IDs unique if the same user opens the extension
       in a second browser. Prefix "tt-" namespaces us on the public broker
       so we don't collide with unrelated Peer.js apps. */
    const suffix = Math.random().toString(36).slice(2, 10);
    return `tt-${syncConfig.userId}-${suffix}`;
  }
  return undefined;
}

async function initPeer() {
  if (peer) return;
  const id = await pickPeerId();
  peer = new Peer(id, {
    host: PEER_HOST,
    port: PEER_PORT,
    path: '/',
    key: PEER_KEY,
    secure: true,
  });

  peer.on('open', assignedId => {
    peerId = assignedId;
    vlog('peer opened with id', assignedId);
    chrome.storage.local.set({ voicePeerId: assignedId });
  });

  peer.on('call', incoming => {
    vlog('incoming call from', incoming.peer, '— ringing');
    /* Park it. Deliberately NOT answered here — see pendingIncoming. */
    const timer = setTimeout(() => declineCall(incoming.peer, 'timeout'), RING_TIMEOUT_MS);
    pendingIncoming.set(incoming.peer, { call: incoming, timer });

    /* If the caller hangs up mid-ring, stop ringing on our side too. */
    incoming.on('close', () => clearIncoming(incoming.peer));
    incoming.on('error', () => clearIncoming(incoming.peer));

    startRingtone();
    chrome.runtime.sendMessage({ type: 'voice.incomingRing', peerId: incoming.peer }).catch(() => {});
    broadcastVoiceState();
  });

  peer.on('error', err => vlog('peer error', err && err.type, err));
  peer.on('disconnected', () => {
    vlog('disconnected — reconnecting');
    try { peer.reconnect(); } catch {}
  });
  peer.on('close', () => {
    vlog('peer closed');
    peer = null;
    peerId = null;
    chrome.storage.local.remove('voicePeerId');
  });
}

async function ensureLocalStream() {
  if (localStream && localStream.getAudioTracks().some(t => t.readyState === 'live')) {
    return localStream;
  }
  localStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false,
  });
  return localStream;
}

function ensureAudiosContainer() {
  if (!audiosContainer) audiosContainer = document.getElementById('remoteAudios');
  return audiosContainer;
}

function trackCall(call) {
  /* One <audio> per remote peer so N streams play simultaneously. */
  const audioEl = document.createElement('audio');
  audioEl.autoplay = true;
  audioEl.dataset.peer = call.peer;
  ensureAudiosContainer().appendChild(audioEl);
  activeCalls.set(call.peer, { call, audioEl });

  call.on('stream', remoteStream => {
    vlog('remote stream from', call.peer);
    audioEl.srcObject = remoteStream;
    audioEl.play().catch(e => vlog('play failed', e));
  });
  call.on('close', () => {
    vlog('call closed with', call.peer);
    const entry = activeCalls.get(call.peer);
    if (entry && entry.audioEl) { entry.audioEl.srcObject = null; entry.audioEl.remove(); }
    activeCalls.delete(call.peer);
    if (activeCalls.size === 0) stopMic();
    broadcastVoiceState();
  });
  call.on('error', err => vlog('call error', err));
  broadcastVoiceState();
}

function stopMic() {
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
}

/* ─────────── Ringing: accept / decline ─────────── */

/* Drop a ring without sending a decline — used when the CALLER goes away
   (they hung up, or their peer errored), where closing again is pointless. */
function clearIncoming(remotePeerId) {
  const entry = pendingIncoming.get(remotePeerId);
  if (!entry) return;
  clearTimeout(entry.timer);
  pendingIncoming.delete(remotePeerId);
  if (pendingIncoming.size === 0) stopRingtone();
  chrome.runtime.sendMessage({ type: 'voice.ringEnded', peerId: remotePeerId }).catch(() => {});
  broadcastVoiceState();
}

async function acceptCall(remotePeerId) {
  const entry = pendingIncoming.get(remotePeerId);
  if (!entry) return { ok: false, error: 'no-such-ring' };
  clearTimeout(entry.timer);
  pendingIncoming.delete(remotePeerId);
  if (pendingIncoming.size === 0) stopRingtone();
  try {
    /* The mic prompt happens HERE — after the user has agreed to talk. */
    const stream = await ensureLocalStream();
    entry.call.answer(stream);
    trackCall(entry.call);
    chrome.runtime.sendMessage({ type: 'voice.ringEnded', peerId: remotePeerId }).catch(() => {});
    return { ok: true };
  } catch (e) {
    vlog('accept failed (mic denied?)', e);
    try { entry.call.close(); } catch {}
    chrome.runtime.sendMessage({ type: 'voice.ringEnded', peerId: remotePeerId }).catch(() => {});
    broadcastVoiceState();
    return { ok: false, error: 'mic-denied' };
  }
}

function declineCall(remotePeerId, reason) {
  const entry = pendingIncoming.get(remotePeerId);
  if (!entry) return { ok: true, notRinging: true };
  clearTimeout(entry.timer);
  pendingIncoming.delete(remotePeerId);
  try { entry.call.close(); } catch {}
  if (pendingIncoming.size === 0) stopRingtone();
  vlog('declined call from', remotePeerId, reason ? `(${reason})` : '');
  chrome.runtime.sendMessage({ type: 'voice.ringEnded', peerId: remotePeerId, reason }).catch(() => {});
  broadcastVoiceState();
  return { ok: true, reason };
}

/* ─────────── Ringtone ───────────
 * Synthesized with Web Audio rather than shipping an mp3: nothing to
 * bundle, no network fetch, and it can't contend with the <audio>
 * element the Adhan uses. Two short bursts every 3s — the familiar
 * "ring ring" cadence. */
let ringCtx = null;
let ringTimer = null;

function ringBurst(ctx, at) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(480, at);
  /* Ramped attack/release so it reads as a chirp rather than a click. */
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(0.18, at + 0.02);
  gain.gain.setValueAtTime(0.18, at + 0.32);
  gain.gain.linearRampToValueAtTime(0, at + 0.4);
  osc.connect(gain).connect(ctx.destination);
  osc.start(at);
  osc.stop(at + 0.42);
}

function startRingtone() {
  if (ringTimer) return; // already ringing for another caller
  try {
    if (!ringCtx) ringCtx = new AudioContext();
    if (ringCtx.state === 'suspended') ringCtx.resume().catch(() => {});
    const cycle = () => {
      const now = ringCtx.currentTime;
      ringBurst(ringCtx, now);
      ringBurst(ringCtx, now + 0.6);
    };
    cycle();
    ringTimer = setInterval(cycle, 3000);
  } catch (e) {
    vlog('ringtone failed', e && e.message);
  }
}

function stopRingtone() {
  if (ringTimer) { clearInterval(ringTimer); ringTimer = null; }
}

async function startCall(remotePeerId) {
  if (!peer) await initPeer();
  if (!peer || !peerId) return { ok: false, error: 'peer-not-ready' };
  if (activeCalls.has(remotePeerId)) return { ok: true, already: true };
  const stream = await ensureLocalStream();
  const call = peer.call(remotePeerId, stream);
  if (!call) return { ok: false, error: 'call-failed' };
  trackCall(call);
  return { ok: true, peerId };
}

function endCall(remotePeerId) {
  const entry = activeCalls.get(remotePeerId);
  if (!entry) return { ok: true, notActive: true };
  try { entry.call.close(); } catch {}
  if (entry.audioEl) { entry.audioEl.srcObject = null; entry.audioEl.remove(); }
  activeCalls.delete(remotePeerId);
  if (activeCalls.size === 0) stopMic();
  broadcastVoiceState();
  return { ok: true };
}

function endAllCalls() {
  for (const [, entry] of activeCalls) {
    try { entry.call.close(); } catch {}
    if (entry.audioEl) { entry.audioEl.srcObject = null; entry.audioEl.remove(); }
  }
  activeCalls.clear();
  /* "Hang up everything" should silence pending rings too, not just
     live calls — otherwise the ringtone outlives the gesture. */
  for (const remotePeerId of Array.from(pendingIncoming.keys())) {
    declineCall(remotePeerId, 'ended-all');
  }
  stopMic();
  broadcastVoiceState();
  return { ok: true };
}

function getVoiceState() {
  return {
    peerId,
    inCallWith: Array.from(activeCalls.keys()),
    ringingFrom: Array.from(pendingIncoming.keys()),
    hasMic: !!(localStream && localStream.getAudioTracks().some(t => t.readyState === 'live')),
  };
}

function broadcastVoiceState() {
  chrome.runtime.sendMessage({ type: 'voiceState', state: getVoiceState() }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen-voice') return false;
  (async () => {
    try {
      switch (msg.action) {
        case 'init':
          await initPeer();
          sendResponse({ ok: true, peerId });
          break;
        case 'startCall':
          sendResponse(await startCall(msg.peerId));
          break;
        case 'acceptCall':
          sendResponse(await acceptCall(msg.peerId));
          break;
        case 'declineCall':
          sendResponse(declineCall(msg.peerId, 'user'));
          break;
        case 'endCall':
          sendResponse(endCall(msg.peerId));
          break;
        case 'endAllCalls':
          sendResponse(endAllCalls());
          break;
        case 'getState':
          sendResponse(getVoiceState());
          break;
        default:
          sendResponse({ ok: false, error: 'unknown-action' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e && e.message });
    }
  })();
  return true;
});

initPeer();
