'use strict';

/*
 * PeerJS client for the desktop app. Runs in a hidden window because WebRTC
 * and getUserMedia are browser APIs the main process does not have.
 *
 * ── One map, explicit states ───────────────────────────────────────────────
 *
 * Every call this app knows about lives in `calls`, tagged with what it
 * actually is:
 *
 *   'ringing-in'  someone called us; parked, mic untouched, awaiting a person
 *   'ringing-out' we called someone; no media yet, they may never answer
 *   'connected'   media is flowing both ways
 *
 * This replaces an earlier split across two maps where a call was added to the
 * active set the instant it was dialled. That made "I am calling Kemi" and "I
 * am talking to Kemi" indistinguishable — the caller looked busy to the whole
 * roster while merely ringing, could not redial, and nothing could show the
 * difference because the difference was not recorded anywhere.
 *
 * ── Failure is reported, never swallowed ──────────────────────────────────
 *
 * A call can fail for reasons the user must be told about — a denied
 * microphone above all. Every such path calls notify(), which surfaces on the
 * pill. Silence is the one outcome that is never acceptable: a card that
 * simply vanishes is indistinguishable from a bug.
 */

const PEER_HOST = '0.peerjs.com';
const PEER_PORT = 443;
const PEER_KEY = 'peerjs';

/** How long an unanswered call rings before it gives up, both directions. */
const RING_TIMEOUT_MS = 30000;
/* The caller waits slightly longer than the callee rings, so a call that timed
   out on their side is already gone before we conclude anything about it. */
const DIAL_TIMEOUT_MS = RING_TIMEOUT_MS + 5000;

let peer = null;
let peerId = null;
let localStream = null;

/** @type {Map<string, {call: any, audioEl: HTMLAudioElement|null, state: string, timer: any}>} */
const calls = new Map();

/*
 * A data connection per peer, alongside the media call — the control channel.
 *
 * PeerJS signals nothing when a callee closes a call it never answered, so a
 * decline is invisible to the caller: they keep ringing until a timeout, with
 * their microphone held open the whole time, unable to tell refusal from
 * absence. Media alone cannot express "no".
 *
 * The caller opens it when dialling; the callee receives it and can answer
 * back. Small enough to be worth it, and it is the only place a peer can say
 * something that is not audio.
 */
/** @type {Map<string, any>} */
const control = new Map();

function sendControl(remotePeerId, payload) {
  const conn = control.get(remotePeerId);
  if (!conn) return false;
  try {
    if (conn.open) { conn.send(payload); return true; }
  } catch { /* connection died; the timeout still covers us */ }
  return false;
}

function trackControl(conn) {
  control.set(conn.peer, conn);
  conn.on('data', (data) => {
    if (!data || typeof data !== 'object') return;
    if (data.type === 'decline') {
      const entry = calls.get(conn.peer);
      // Only meaningful for a call we are still ringing out on.
      if (entry && entry.state === 'ringing-out') {
        notify('declined', conn.peer);
        drop(conn.peer, 'declined by peer');
      }
    }
  });
  conn.on('close', () => { control.delete(conn.peer); });
  conn.on('error', () => { control.delete(conn.peer); });
}

function closeControl(remotePeerId) {
  const conn = control.get(remotePeerId);
  if (!conn) return;
  try { conn.close(); } catch { /* already gone */ }
  control.delete(remotePeerId);
}

const audioHost = document.getElementById('remote-audio');

function log(...args) { console.log('[voice]', ...args); }

/** Tell the user something happened. `kind` drives how the pill presents it. */
function notify(kind, detail) {
  try { window.voiceBridge.notify({ kind, detail: detail || null }); } catch { /* bridge gone */ }
}

function idsInState(state) {
  const out = [];
  for (const [id, entry] of calls) if (entry.state === state) out.push(id);
  return out;
}

function report() {
  window.voiceBridge.state({
    peerId,
    connected: idsInState('connected'),
    ringingIn: idsInState('ringing-in'),
    ringingOut: idsInState('ringing-out'),
    hasMic: !!(localStream && localStream.getAudioTracks().some(t => t.readyState === 'live')),
  });
}

/* ── microphone ─────────────────────────────────────────────────────────── */

async function ensureMic() {
  if (localStream && localStream.getAudioTracks().some(t => t.readyState === 'live')) {
    return localStream;
  }
  localStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false,
  });
  return localStream;
}

/*
 * Holding an open microphone with nobody to hear it is what makes an app feel
 * like it is spying on you, so it is released the moment the last call ends —
 * and "last call" means connected calls only. A call still ringing out has no
 * audio going anywhere yet.
 */
function releaseMicIfIdle() {
  if (idsInState('connected').length > 0) return;
  if (!localStream) return;
  localStream.getTracks().forEach(t => t.stop());
  localStream = null;
}

/**
 * getUserMedia failures are not interchangeable, and the user can act on the
 * difference: a denied permission needs a trip to system settings, a missing
 * device needs a microphone plugged in.
 */
function micFailureKind(err) {
  const name = (err && err.name) || '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'mic-denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'mic-missing';
  return 'mic-failed';
}

/* ── call bookkeeping ───────────────────────────────────────────────────── */

function attachMedia(entry, call) {
  const audioEl = document.createElement('audio');
  audioEl.autoplay = true;
  audioEl.dataset.peer = call.peer;
  audioHost.appendChild(audioEl);
  entry.audioEl = audioEl;

  call.on('stream', (remote) => {
    audioEl.srcObject = remote;
    audioEl.play().catch(err => log('remote playback failed', err && err.message));
    // Media arriving is the only thing that means "connected". Not dialling,
    // not answering — media.
    if (entry.state !== 'connected') {
      entry.state = 'connected';
      if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
      report();
    }
  });
}

function drop(remotePeerId, reason) {
  const entry = calls.get(remotePeerId);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  try { entry.call.close(); } catch { /* already gone */ }
  if (entry.audioEl) { entry.audioEl.srcObject = null; entry.audioEl.remove(); }
  calls.delete(remotePeerId);
  closeControl(remotePeerId);
  releaseMicIfIdle();
  if (entry.state === 'ringing-in') window.voiceBridge.ringEnded(remotePeerId);
  log('dropped', remotePeerId, reason || '');
  report();
}

function watchCall(entry, call) {
  call.on('close', () => {
    // Remote hung up, or the connection died.
    const was = calls.get(call.peer);
    if (was) {
      if (was.timer) clearTimeout(was.timer);
      if (was.audioEl) { was.audioEl.srcObject = null; was.audioEl.remove(); }
      calls.delete(call.peer);
      releaseMicIfIdle();
      if (was.state === 'ringing-in') window.voiceBridge.ringEnded(call.peer);
      if (was.state === 'connected') notify('call-ended', call.peer);
      /*
       * An outgoing call that closes before any media arrived was refused or
       * hung up on. Without this the caller is told nothing at all until the
       * 35-second timeout — so a decline looks exactly like a call still
       * ringing, and the button sits on "Ringing…" long after it is over.
       */
      if (was.state === 'ringing-out') notify('declined', call.peer);
      report();
    }
  });
  call.on('error', (err) => {
    log('call error', err && err.message);
    notify('call-failed', call.peer);
    drop(call.peer, 'error');
  });
}

/* ── peer lifecycle ─────────────────────────────────────────────────────── */

async function init(userId) {
  if (peer) return peerId;
  const suffix = Math.random().toString(36).slice(2, 10);
  const id = userId ? `tt-${userId}-${suffix}` : undefined;

  peer = new Peer(id, { host: PEER_HOST, port: PEER_PORT, path: '/', key: PEER_KEY, secure: true });

  peer.on('open', (assigned) => {
    peerId = assigned;
    log('connected to broker as', assigned);
    report();
  });

  peer.on('call', (incoming) => {
    const existing = calls.get(incoming.peer);

    if (existing && existing.state === 'ringing-out') {
      /*
       * Glare: we dialled each other at the same moment. Both sides are
       * ringing out and both are receiving — and the naive "already known,
       * ignore it" would close BOTH offers, leaving two people who each tried
       * to call the other with no call at all.
       *
       * The intent is unambiguous, so resolve it rather than negotiate: drop
       * our outgoing attempt and answer theirs. The microphone is already open
       * from dialling, so this cannot fail on permissions.
       */
      log('glare with', incoming.peer, '— answering theirs, dropping ours');
      if (existing.timer) clearTimeout(existing.timer);
      try { existing.call.close(); } catch { /* fine */ }
      if (existing.audioEl) { existing.audioEl.srcObject = null; existing.audioEl.remove(); }
      calls.delete(incoming.peer);

      const entry = { call: incoming, audioEl: null, state: 'ringing-in', timer: null };
      calls.set(incoming.peer, entry);
      watchCall(entry, incoming);
      if (localStream) {
        incoming.answer(localStream);
        attachMedia(entry, incoming);
      }
      report();
      return;
    }

    if (existing) {
      // Already ringing or talking to them; a duplicate offer is noise.
      try { incoming.close(); } catch { /* fine */ }
      return;
    }
    log('incoming call from', incoming.peer);
    const entry = {
      call: incoming,
      audioEl: null,
      state: 'ringing-in',
      timer: setTimeout(() => {
        notify('missed-call', incoming.peer);
        drop(incoming.peer, 'no answer');
      }, RING_TIMEOUT_MS),
    };
    calls.set(incoming.peer, entry);
    watchCall(entry, incoming);
    window.voiceBridge.ring(incoming.peer);
    report();
  });

  /* The caller opens a control channel when dialling; this is the callee end. */
  peer.on('connection', (conn) => trackControl(conn));

  peer.on('disconnected', () => {
    log('broker dropped us; reconnecting');
    try { peer.reconnect(); } catch { /* gone */ }
  });
  peer.on('close', () => { peer = null; peerId = null; report(); });
  peer.on('error', (err) => {
    const type = (err && err.type) || '';
    log('peer error', type);
    // peer-unavailable means the person we dialled is not reachable — the one
    // peer error a user can actually do something about.
    if (type === 'peer-unavailable') notify('peer-unavailable', null);
  });

  return peerId;
}

/* ── actions ────────────────────────────────────────────────────────────── */

async function dial(remotePeerId) {
  if (!peer || !peerId) return { ok: false, error: 'not-connected' };

  const existing = calls.get(remotePeerId);
  if (existing) {
    // Redialling someone we are already talking to is a no-op, not an error.
    return { ok: true, already: existing.state };
  }

  let stream;
  try {
    stream = await ensureMic();
  } catch (err) {
    const kind = micFailureKind(err);
    log('cannot dial:', kind, err && err.message);
    notify(kind, null);
    return { ok: false, error: kind };
  }

  const call = peer.call(remotePeerId, stream);
  if (!call) {
    releaseMicIfIdle();
    return { ok: false, error: 'call-failed' };
  }

  const entry = {
    call,
    audioEl: null,
    state: 'ringing-out',
    /*
     * PeerJS gives the caller no "they declined" signal, so an unanswered call
     * would otherwise sit here forever — advertising us as busy and blocking a
     * retry. Give the callee's ring time to expire, then give up.
     */
    timer: setTimeout(() => {
      const still = calls.get(remotePeerId);
      if (!still || still.state === 'connected') return;
      notify('no-answer', remotePeerId);
      drop(remotePeerId, 'no answer');
    }, DIAL_TIMEOUT_MS),
  };
  calls.set(remotePeerId, entry);
  attachMedia(entry, call);
  watchCall(entry, call);
  /* Opened alongside the media call so the callee has a way to say 'no'. */
  try { trackControl(peer.connect(remotePeerId)); } catch { /* timeout still covers us */ }
  report();
  return { ok: true };
}

async function accept(remotePeerId) {
  const entry = calls.get(remotePeerId);
  if (!entry || entry.state !== 'ringing-in') return { ok: false, error: 'no-such-ring' };

  let stream;
  try {
    // The microphone opens HERE — after a person chose to answer.
    stream = await ensureMic();
  } catch (err) {
    const kind = micFailureKind(err);
    log('cannot answer:', kind, err && err.message);
    // Tell them WHY before the card disappears, or answering looks broken.
    notify(kind, null);
    drop(remotePeerId, kind);
    return { ok: false, error: kind };
  }

  if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
  entry.call.answer(stream);
  attachMedia(entry, entry.call);
  // Stays 'ringing-in' until media actually arrives, so the UI never claims a
  // connection that has not happened.
  window.voiceBridge.ringEnded(remotePeerId);
  report();
  return { ok: true };
}

function decline(remotePeerId) {
  const entry = calls.get(remotePeerId);
  if (!entry) return { ok: true, notRinging: true };
  /* Say so before tearing down, or the caller cannot tell refusal from
     absence and rings on with an open microphone until the timeout. */
  sendControl(remotePeerId, { type: 'decline' });
  drop(remotePeerId, 'declined');
  return { ok: true };
}

function hangUp(remotePeerId) {
  if (remotePeerId) {
    drop(remotePeerId, 'hung up');
    return { ok: true };
  }
  for (const id of Array.from(calls.keys())) drop(id, 'hung up all');
  return { ok: true };
}

/**
 * Join a call already in progress by dialling every participant.
 *
 * A mesh has no "the call" to join — it is just everyone connected to everyone
 * — so joining means ringing each participant, and each of them sees a normal
 * incoming call they can accept or decline. That is the notification-and-
 * consent behaviour wanted here, with no extra server state to keep in sync.
 */
async function joinCall(peerIds) {
  if (!Array.isArray(peerIds) || !peerIds.length) return { ok: false, error: 'nobody-to-call' };
  const results = [];
  for (const id of peerIds) {
    if (id === peerId) continue; // never dial ourselves
    results.push(await dial(id));
  }
  const anyOk = results.some(r => r && r.ok);
  return anyOk ? { ok: true, dialled: results.length } : { ok: false, error: 'all-failed' };
}

window.voiceBridge.onCommand(async (msg) => {
  switch (msg && msg.action) {
    case 'init':    await init(msg.userId); break;
    case 'dial':    window.voiceBridge.result(msg.id, await dial(msg.peerId)); break;
    case 'join':    window.voiceBridge.result(msg.id, await joinCall(msg.peerIds)); break;
    case 'accept':  window.voiceBridge.result(msg.id, await accept(msg.peerId)); break;
    case 'decline': window.voiceBridge.result(msg.id, decline(msg.peerId)); break;
    case 'hangup':  window.voiceBridge.result(msg.id, hangUp(msg.peerId)); break;
    default: break;
  }
});

window.voiceBridge.ready();
