/* Tab Tracker rendezvous API — Cloudflare Worker + Durable Object.
 *
 * Replaces the voice-call half of the old third-party admin server
 * (admin.tayst.live) with a Worker on the owner's own domain.
 *
 * WHAT THIS SERVER IS
 *   Audio is peer-to-peer (PeerJS / WebRTC). No media ever touches this
 *   Worker. It is purely a rendezvous board:
 *     - who is online, and what their current PeerJS ID is
 *     - who is currently in a call with whom (the `callWith` graph the
 *       extension folds into "meetings" via connected components)
 *     - a short-lived inbox of "knocks" — requests to join a call
 *
 * ENDPOINTS (shapes derived verbatim from background.js / tab-timer.js —
 * see README.md for the full contract):
 *   POST   /api/admin/presence            { userId, name, peerId, callWith[] }
 *   GET    /api/admin/presence          → { online: [ ...entries ] }
 *   POST   /api/admin/knock               { fromUserId, fromName, fromPeerId, targets[] }
 *                                       → { ok: true, knock: {...} }
 *   GET    /api/admin/knock?user=<id>   → { incoming: [...], outgoing: [...] }
 *   PATCH  /api/admin/knock               { knockId, accepterUserId }
 *                                       → { ok: true, knock: {...} }
 *   DELETE /api/admin/knock?id=<id>     → { ok: true, deleted: n }
 *   GET    /api/health                  → { ok: true, ... }   (no auth — smoke test)
 *
 * STORAGE
 *   A single Durable Object instance ("global") on the SQLite backend.
 *   Presence has to be fresh within a few seconds; Workers KV is
 *   eventually consistent with a 60s minimum TTL, which is exactly the
 *   staleness budget we need to spend on the heartbeat itself. A DO is a
 *   single strongly-consistent rendezvous point — the right shape for
 *   "one small shared board a handful of people read every 6 seconds".
 *
 * AUTH
 *   Shared secret in the `x-tt-token` header, compared against the
 *   TT_TOKEN Worker secret. Never hardcoded. See README.md.
 */

/* ── Tunables ─────────────────────────────────────────────────────── */

const PRESENCE_TTL_MS = 60_000;   // heartbeat is ~24s; miss two → gone
const KNOCK_TTL_MS = 120_000;     // a join request nobody answers dies quietly
const MAX_KNOCKS_PER_USER = 5;    // bound one caller's footprint

/* Input bounds. Identity fields are rejected when over-long (they must
   round-trip byte-exact for PeerJS dialing to work); display fields are
   truncated so an over-long name degrades instead of breaking presence. */
const MAX_USER_ID = 64;
const MAX_NAME = 80;
const MAX_PEER_ID = 128;
const MAX_KNOCK_ID = 64;
const MAX_LIST = 32;              // callWith[] / targets[] entries

const DO_INSTANCE_NAME = 'global';

/* ── CORS ─────────────────────────────────────────────────────────── */

/* The caller is a Chrome extension service worker, whose Origin is
 * `chrome-extension://<id>`. That id changes between an unpacked dev
 * load, a self-hosted build and a Web Store listing, so pinning an
 * allow-list of origins here would mean re-deploying the Worker every
 * time the extension is re-packed — a maintenance trap with no security
 * payoff, because a browser Origin header is not a credential in the
 * first place (anything outside a browser simply omits or forges it).
 *
 * The `x-tt-token` shared secret is the real gate. CORS is therefore
 * deliberately permissive on origin: `*` with NO credentials mode, which
 * the Fetch spec forbids from carrying cookies, so nothing is riding on
 * ambient authority. A hostile web page that somehow learned the token
 * could already call this API from a non-browser context anyway. */
function corsHeaders(request) {
  const requested = request.headers.get('Access-Control-Request-Headers');
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': requested || 'Content-Type, x-tt-token',
    'Access-Control-Max-Age': '86400',
  };
}

function json(request, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      /* Presence is only useful if it is current — never let the edge,
         a proxy or the extension's HTTP cache serve a stale roster. */
      'Cache-Control': 'no-store',
      ...corsHeaders(request),
    },
  });
}

/* ── Validation helpers — every request body is treated as hostile ── */

function cleanString(v) {
  if (typeof v !== 'string') return null;
  /* Strip C0/C1 control characters (including NUL and newlines) so a
     value can never smuggle structure into a log line or a UI string. */
  const s = v.replace(/[\u0000-\u001F\u007F-\u009F]/g, '').trim();
  return s.length ? s : null;
}

/** Identity-ish field: must survive byte-exact, so over-long is rejected. */
function idField(v, max) {
  const s = cleanString(v);
  if (s === null || s.length > max) return null;
  return s;
}

/** Display field: truncated rather than rejected. */
function displayField(v, max, fallback) {
  const s = cleanString(v);
  if (s === null) return fallback;
  return s.length > max ? s.slice(0, max) : s;
}

/** Array of user ids: unknown/!string/over-long entries are dropped, deduped, capped. */
function idList(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  const seen = new Set();
  for (const item of v) {
    const id = idField(item, MAX_USER_ID);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_LIST) break;
  }
  return out;
}

/** Parse a JSON body with a hard size cap; returns null on anything unusable. */
async function readJson(request) {
  const len = Number(request.headers.get('Content-Length') || '0');
  if (len > 16_384) return null;           // ~16KB is orders of magnitude over
  let text;
  try {
    text = await request.text();
  } catch {
    return null;
  }
  if (text.length > 16_384) return null;   // chunked bodies report no length
  try {
    const parsed = JSON.parse(text);
    /* Objects only. Arrays and scalars are never a valid body here, and
       rejecting them up front means no handler has to re-check. */
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/* Constant-time-ish string compare — avoids leaking the token prefix
   through response timing. Lengths are compared first (unavoidable). */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function newKnockId() {
  return `k-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
}

/* ── Durable Object: the single rendezvous board ──────────────────── */

export class Rendezvous {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    /* Schema creation must finish before any request is served. */
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS presence (
          user_id   TEXT PRIMARY KEY,
          name      TEXT NOT NULL,
          peer_id   TEXT NOT NULL,
          call_with TEXT NOT NULL,
          last_seen INTEGER NOT NULL
        );
      `);
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS knocks (
          id           TEXT PRIMARY KEY,
          from_user_id TEXT NOT NULL,
          from_name    TEXT NOT NULL,
          from_peer_id TEXT NOT NULL,
          targets      TEXT NOT NULL,
          accepted_by  TEXT,
          created_at   INTEGER NOT NULL
        );
      `);
      this.sql.exec(`CREATE INDEX IF NOT EXISTS knocks_from ON knocks(from_user_id);`);
    });
  }

  /* Drop anything that has aged out. Called at the top of every request:
     at this scale (a handful of rows) it is cheaper than an alarm, and it
     guarantees a reader never sees an expired row even if the DO has been
     idle for an hour. */
  sweep(now) {
    this.sql.exec('DELETE FROM presence WHERE last_seen < ?', now - PRESENCE_TTL_MS);
    this.sql.exec('DELETE FROM knocks WHERE created_at < ?', now - KNOCK_TTL_MS);
  }

  rowToKnock(r) {
    let targets = [];
    try { targets = JSON.parse(r.targets); } catch { targets = []; }
    return {
      id: r.id,
      fromUserId: r.from_user_id,
      fromName: r.from_name,
      fromPeerId: r.from_peer_id,
      targets: Array.isArray(targets) ? targets : [],
      /* The extension tests `if (k.acceptedBy)`, and `!k.acceptedBy`
         must be true while pending — null, never undefined/"" ambiguity. */
      acceptedBy: r.accepted_by || null,
      createdAt: r.created_at,
    };
  }

  async fetch(request) {
    const url = new URL(request.url);
    const now = Date.now();
    this.sweep(now);

    const op = url.pathname;      // set by the Worker, not by the caller
    const method = request.method;

    if (op === '/presence' && method === 'POST') return this.postPresence(request, now);
    if (op === '/presence' && method === 'GET') return this.getPresence();
    if (op === '/knock' && method === 'POST') return this.postKnock(request, now);
    if (op === '/knock' && method === 'GET') return this.getKnocks(url);
    if (op === '/knock' && method === 'PATCH') return this.patchKnock(request);
    if (op === '/knock' && method === 'DELETE') return this.deleteKnock(url);

    return Response.json({ ok: false, error: 'not-found' }, { status: 404 });
  }

  async postPresence(request, now) {
    const body = await readJson(request);
    if (!body) return Response.json({ ok: false, error: 'bad-json' }, { status: 400 });

    const userId = idField(body.userId, MAX_USER_ID);
    if (!userId) return Response.json({ ok: false, error: 'bad-userId' }, { status: 400 });

    const peerId = idField(body.peerId, MAX_PEER_ID);
    if (!peerId) return Response.json({ ok: false, error: 'bad-peerId' }, { status: 400 });

    const name = displayField(body.name, MAX_NAME, userId);
    /* A caller may only list people other than themselves as call peers,
       and only ever writes THIS one row — one heartbeat can never touch
       another user's record, and unknown body fields are ignored
       outright because every field is read by name. */
    const callWith = idList(body.callWith).filter((u) => u !== userId);

    this.sql.exec(
      `INSERT INTO presence (user_id, name, peer_id, call_with, last_seen)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         name = excluded.name,
         peer_id = excluded.peer_id,
         call_with = excluded.call_with,
         last_seen = excluded.last_seen`,
      userId, name, peerId, JSON.stringify(callWith), now,
    );

    const [{ n }] = this.sql.exec('SELECT COUNT(*) AS n FROM presence').toArray();
    return Response.json({ ok: true, userId, online: n });
  }

  getPresence() {
    const rows = this.sql.exec(
      'SELECT user_id, name, peer_id, call_with, last_seen FROM presence ORDER BY name COLLATE NOCASE',
    ).toArray();
    const online = rows.map((r) => {
      let callWith = [];
      try { callWith = JSON.parse(r.call_with); } catch { callWith = []; }
      return {
        userId: r.user_id,
        name: r.name,
        peerId: r.peer_id,
        callWith: Array.isArray(callWith) ? callWith : [],
        lastSeen: r.last_seen,
      };
    });
    return Response.json({ online });
  }

  async postKnock(request, now) {
    const body = await readJson(request);
    if (!body) return Response.json({ ok: false, error: 'bad-json' }, { status: 400 });

    const fromUserId = idField(body.fromUserId, MAX_USER_ID);
    if (!fromUserId) return Response.json({ ok: false, error: 'bad-fromUserId' }, { status: 400 });

    const fromPeerId = idField(body.fromPeerId, MAX_PEER_ID);
    if (!fromPeerId) return Response.json({ ok: false, error: 'bad-fromPeerId' }, { status: 400 });

    const fromName = displayField(body.fromName, MAX_NAME, fromUserId);
    const targets = idList(body.targets).filter((u) => u !== fromUserId);
    if (!targets.length) return Response.json({ ok: false, error: 'no-targets' }, { status: 400 });

    /* Bound one caller's footprint: keep only their most recent knocks. */
    const mine = this.sql.exec(
      'SELECT id FROM knocks WHERE from_user_id = ? ORDER BY created_at DESC',
      fromUserId,
    ).toArray();
    for (const row of mine.slice(MAX_KNOCKS_PER_USER - 1)) {
      this.sql.exec('DELETE FROM knocks WHERE id = ?', row.id);
    }

    const id = newKnockId();
    this.sql.exec(
      `INSERT INTO knocks (id, from_user_id, from_name, from_peer_id, targets, accepted_by, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
      id, fromUserId, fromName, fromPeerId, JSON.stringify(targets), now,
    );

    const knock = {
      id, fromUserId, fromName, fromPeerId, targets, acceptedBy: null, createdAt: now,
    };
    return Response.json({ ok: true, knock });
  }

  getKnocks(url) {
    const user = idField(url.searchParams.get('user'), MAX_USER_ID);
    if (!user) return Response.json({ ok: false, error: 'bad-user' }, { status: 400 });

    const rows = this.sql.exec(
      'SELECT * FROM knocks ORDER BY created_at ASC',
    ).toArray().map((r) => this.rowToKnock(r));

    return Response.json({
      /* incoming = someone asking to join a call I am in.
         outgoing = my own request, which I poll for `acceptedBy` so the
         extension knows to start dialling. Accepted knocks stay listed
         until the requester DELETEs them — that is how the hand-off ends. */
      incoming: rows.filter((k) => k.fromUserId !== user && k.targets.includes(user)),
      outgoing: rows.filter((k) => k.fromUserId === user),
    });
  }

  async patchKnock(request) {
    const body = await readJson(request);
    if (!body) return Response.json({ ok: false, error: 'bad-json' }, { status: 400 });

    const knockId = idField(body.knockId, MAX_KNOCK_ID);
    const accepterUserId = idField(body.accepterUserId, MAX_USER_ID);
    if (!knockId) return Response.json({ ok: false, error: 'bad-knockId' }, { status: 400 });
    if (!accepterUserId) return Response.json({ ok: false, error: 'bad-accepterUserId' }, { status: 400 });

    const rows = this.sql.exec('SELECT * FROM knocks WHERE id = ?', knockId).toArray();
    if (!rows.length) return Response.json({ ok: false, error: 'knock-not-found' }, { status: 404 });

    const knock = this.rowToKnock(rows[0]);
    /* Only someone the knock was actually addressed to may accept it.
       Without this, any token holder could accept a knock aimed at
       somebody else and make the requester dial into a call that was
       never opened to them. */
    if (!knock.targets.includes(accepterUserId)) {
      return Response.json({ ok: false, error: 'not-a-target' }, { status: 403 });
    }
    /* Idempotent: a double-tap on Accept returns the same knock. First
       acceptance wins so the requester's dial list stays stable. */
    if (!knock.acceptedBy) {
      this.sql.exec('UPDATE knocks SET accepted_by = ? WHERE id = ?', accepterUserId, knockId);
      knock.acceptedBy = accepterUserId;
    }
    return Response.json({ ok: true, knock });
  }

  deleteKnock(url) {
    const id = idField(url.searchParams.get('id'), MAX_KNOCK_ID);
    if (!id) return Response.json({ ok: false, error: 'bad-id' }, { status: 400 });
    const before = this.sql.exec('SELECT COUNT(*) AS n FROM knocks WHERE id = ?', id).toArray()[0].n;
    this.sql.exec('DELETE FROM knocks WHERE id = ?', id);
    return Response.json({ ok: true, deleted: before });
  }
}

/* ── Worker: auth, CORS, and routing into the DO ──────────────────── */

export default {
  async fetch(request, env, _ctx) {
    const url = new URL(request.url);

    /* Preflight. Answered before auth on purpose: a browser sends the
       OPTIONS probe without the x-tt-token header (that is the whole
       point of the probe), so 401-ing it would deadlock the real call. */
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    /* Unauthenticated liveness probe. Reveals nothing about the roster —
       it exists so the route + DNS can be verified before the secret is
       even set. */
    if (url.pathname === '/api/health' && request.method === 'GET') {
      return json(request, {
        ok: true,
        service: 'tabtracker-api',
        tokenConfigured: typeof env.TT_TOKEN === 'string' && env.TT_TOKEN.length > 0,
        time: new Date().toISOString(),
      });
    }

    const isVoiceApi = url.pathname === '/api/admin/presence' || url.pathname === '/api/admin/knock';

    if (!isVoiceApi) {
      /* This Worker is mounted on `tabtracker.uthman.xyz/api/*`, which is
         a wider net than the two paths it implements. Anything else under
         /api/ is either a typo or an endpoint that belongs to the site
         Worker sitting on the same hostname's Custom Domain. Routes take
         precedence over Custom Domains, so we would otherwise black-hole
         it. Flip API_PASSTHROUGH to "true" in wrangler.toml to hand those
         requests on to the Custom Domain Worker instead of 404-ing. */
      const isLocalDev = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
      if (env.API_PASSTHROUGH === 'true' && !isLocalDev) {
        /* Guarded off in local dev: there is no Custom Domain Worker
           behind `wrangler dev`, so fetch(request) would just re-enter
           this Worker until it hit the subrequest limit. */
        try {
          return await fetch(request);
        } catch (e) {
          return json(request, { ok: false, error: 'passthrough-failed', detail: String(e && e.message) }, 502);
        }
      }
      return json(request, { ok: false, error: 'not-found', path: url.pathname }, 404);
    }

    /* A missing secret is a deploy mistake, not a caller mistake — say so
       distinctly instead of pretending the caller's token was wrong. */
    if (typeof env.TT_TOKEN !== 'string' || env.TT_TOKEN.length === 0) {
      return json(request, { ok: false, error: 'server-not-configured' }, 503);
    }

    const token = request.headers.get('x-tt-token');
    if (!safeEqual(token || '', env.TT_TOKEN)) {
      return json(request, { ok: false, error: 'unauthorized' }, 401);
    }

    const allowed = {
      '/api/admin/presence': ['GET', 'POST'],
      '/api/admin/knock': ['GET', 'POST', 'PATCH', 'DELETE'],
    }[url.pathname];
    if (!allowed.includes(request.method)) {
      return json(request, { ok: false, error: 'method-not-allowed' }, 405);
    }

    /* One DO instance is the whole rendezvous board. The name is fixed,
       never caller-supplied — a caller must not be able to address a
       different instance and shard the roster. */
    const id = env.ROSTER.idFromName(DO_INSTANCE_NAME);
    const stub = env.ROSTER.get(id);

    /* Re-address to a short internal path so the DO never parses a
       caller-controlled pathname, and forward only the parts it needs. */
    const op = url.pathname === '/api/admin/presence' ? '/presence' : '/knock';
    const inner = new URL(`https://do${op}${url.search}`);

    /* Buffer the body here rather than streaming it through: it is a few
       hundred bytes, and a materialised string sidesteps the half-duplex
       stream rules on a re-constructed Request. Hard cap first — an
       oversized body is rejected before it is ever read into memory. */
    let bodyText;
    if (request.method === 'POST' || request.method === 'PATCH') {
      const declared = Number(request.headers.get('Content-Length') || '0');
      if (declared > 16_384) {
        return json(request, { ok: false, error: 'payload-too-large' }, 413);
      }
      try {
        bodyText = await request.text();
      } catch {
        return json(request, { ok: false, error: 'bad-body' }, 400);
      }
      if (bodyText.length > 16_384) {
        return json(request, { ok: false, error: 'payload-too-large' }, 413);
      }
    }

    const forwarded = new Request(inner, {
      method: request.method,
      headers: { 'Content-Type': 'application/json' },
      body: bodyText,
    });

    let res;
    try {
      res = await stub.fetch(forwarded);
    } catch (e) {
      return json(request, { ok: false, error: 'rendezvous-unavailable', detail: String(e && e.message) }, 503);
    }

    /* Re-wrap so CORS + no-store land on DO responses too. */
    const text = await res.text();
    return new Response(text, {
      status: res.status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        ...corsHeaders(request),
      },
    });
  },
};
