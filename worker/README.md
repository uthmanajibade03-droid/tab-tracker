# `tabtracker-api` — voice-call rendezvous Worker

Replaces the voice half of the third-party `admin.tayst.live` backend with a
Cloudflare Worker on the owner's own domain.

**Audio never touches this server.** Calls are peer-to-peer over WebRTC
(PeerJS). This Worker is a rendezvous board and nothing else:

- who is online, and what their current PeerJS ID is;
- who is currently in a call with whom (the `callWith` graph the extension
  folds into "meetings" by connected components);
- a short-lived inbox of *knocks* — "I want to join your call".

Nothing here is durable user data. Presence rows expire 60 seconds after the
last heartbeat; knocks expire after 2 minutes. Left alone, the store empties
itself.

---

## Storage: why a Durable Object

Presence has to be fresh within a few seconds — the extension heartbeats every
~24s and polls the roster every ~6s. Workers KV is eventually consistent with
a **60-second minimum TTL**, which would spend the entire staleness budget
before a heartbeat even arrived; teammates would flicker in and out of the
roster. A single Durable Object is one strongly-consistent instance that every
client reads and writes — the right shape for one small shared board at this
scale (a handful of teammates).

The DO uses the **SQLite storage backend** (`new_sqlite_classes` in the
migration), which is available on the Workers **Free** plan. Two tables:
`presence` (keyed by `user_id`) and `knocks` (keyed by knock id). Expired rows
are swept at the top of every request — cheaper than an alarm at this size, and
it guarantees a reader never sees a stale row even after the DO has been idle.

---

## The contract

Every path below is exactly what `background.js` already calls. Shapes were
derived from the client code, not invented — see "Where each shape comes from"
at the bottom.

### Auth

All `/api/admin/*` endpoints require a shared secret in the **`x-tt-token`**
header, compared against the `TT_TOKEN` Worker secret in constant time.

| Condition | Status | Body |
|---|---|---|
| header missing or wrong | `401` | `{ "ok": false, "error": "unauthorized" }` |
| `TT_TOKEN` secret not set on the Worker | `503` | `{ "ok": false, "error": "server-not-configured" }` |

A missing secret is deliberately *not* a 401 — a deploy mistake should not
masquerade as a caller mistake.

### CORS

The caller is a Chrome extension service worker (`chrome-extension://<id>`
origin). `OPTIONS` preflight is answered **before** the auth check (a browser
sends the probe without custom headers, so 401-ing it would deadlock the real
request). Responses carry:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, PATCH, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type, x-tt-token   (echoes the requested list)
Access-Control-Max-Age: 86400
```

Origin is deliberately permissive. The extension id changes between an unpacked
dev load, a self-hosted build and a Web Store listing, so an origin allow-list
would need a redeploy on every repack — for no security gain, since an `Origin`
header is not a credential (anything outside a browser omits or forges it). The
token is the real gate, and `*` without credentials mode means no cookie or
other ambient authority can ride along.

All responses also send `Cache-Control: no-store`; a cached roster is a wrong
roster.

---

### `POST /api/admin/presence` — heartbeat (~every 24s)

```jsonc
// request
{
  "userId":   "tomiwa",           // required, <=64 chars
  "name":     "Tomiwa",           // optional, truncated to 80; defaults to userId
  "peerId":   "abc-123-peer",     // required, <=128 chars ("pending-<userId>" before PeerJS connects)
  "callWith": ["segun"]           // optional, user ids, <=32 entries; self is filtered out
}
```

```jsonc
// 200
{ "ok": true, "userId": "tomiwa", "online": 2 }
```

Upserts exactly one row, keyed by the `userId` in the body. Unknown fields are
ignored (every field is read by name). The client only checks `res.ok`.

### `GET /api/admin/presence` — the roster

```jsonc
// 200
{
  "online": [
    { "userId": "segun",  "name": "Segun",  "peerId": "peer-s", "callWith": ["tomiwa"], "lastSeen": 1756713600000 },
    { "userId": "tomiwa", "name": "Tomiwa", "peerId": "peer-t", "callWith": ["segun"],  "lastSeen": 1756713601000 }
  ]
}
```

Sorted by name, case-insensitive. Only entries seen within the last 60s.
`lastSeen` is an extra field the client ignores — it is there for debugging.

### `POST /api/admin/knock` — "let me join your call"

```jsonc
// request
{
  "fromUserId": "kemi",
  "fromName":   "Kemi",
  "fromPeerId": "peer-k",
  "targets":    ["segun", "tomiwa"]   // required, non-empty after cleaning
}
```

```jsonc
// 200
{
  "ok": true,
  "knock": {
    "id": "k-mfa1x2-1a2b3c4d",
    "fromUserId": "kemi", "fromName": "Kemi", "fromPeerId": "peer-k",
    "targets": ["segun", "tomiwa"],
    "acceptedBy": null,
    "createdAt": 1756713602000
  }
}
```

The extension stores `knock.id` to track its own outstanding request, so
`ok` and `knock.id` are both load-bearing. A user may hold at most 5 knocks;
older ones are dropped on the next create.

### `GET /api/admin/knock?user=<userId>` — my inbox and outbox

```jsonc
// 200
{
  "incoming": [ /* knocks where targets includes <userId> and I am not the sender */ ],
  "outgoing": [ /* knocks I sent */ ]
}
```

Accepted knocks stay listed until the sender `DELETE`s them — that is how the
hand-off completes: the sender polls `outgoing`, sees `acceptedBy` set, dials
every `targets` entry over PeerJS, then deletes the knock. The recipient's UI
filters accepted knocks out of `incoming` itself.

`user` is required; a missing/invalid one is `400 { "error": "bad-user" }`.

### `PATCH /api/admin/knock` — accept

```jsonc
// request
{ "knockId": "k-mfa1x2-1a2b3c4d", "accepterUserId": "segun" }
```

```jsonc
// 200
{ "ok": true, "knock": { /* ...same shape, acceptedBy now set */ } }
```

- `404 { "error": "knock-not-found" }` if it expired or was already deleted.
- `403 { "error": "not-a-target" }` if `accepterUserId` is not in `targets`.
  Without that check, any token holder could accept a knock addressed to
  someone else and make the sender dial into a call never opened to them.
- Idempotent: a second accept returns the same knock; first acceptance wins.

### `DELETE /api/admin/knock?id=<knockId>` — cancel / ignore / clean up

```jsonc
// 200
{ "ok": true, "deleted": 1 }
```

Used by three flows: the sender cancelling, the recipient pressing "Ignore",
and the sender cleaning up after an accepted knock has been dialled. The client
sends no identity on this call, so any token holder may delete any knock id —
see "Trust model" below.

### `GET /api/health` — unauthenticated liveness probe

```jsonc
{ "ok": true, "service": "tabtracker-api", "tokenConfigured": true, "time": "2026-09-01T..." }
```

Reveals nothing about the roster. It exists so the route and DNS can be
verified before the secret is even set.

### Anything else under `/api/`

`404 { "ok": false, "error": "not-found", "path": "..." }` by default. See
`API_PASSTHROUGH` under "Routing" if the site Worker ever grows its own `/api/`
endpoints on this hostname.

---

## Input handling

Every request body is treated as hostile:

- **Objects only.** Arrays and scalars are rejected before any handler runs.
- **Size cap.** Bodies over 16KB are rejected (`413`) before being read.
- **Control characters stripped** from every string (NUL, newlines, C0/C1), so
  a value cannot smuggle structure into a log line or a rendered UI string.
- **Identity fields** (`userId`, `peerId`, `knockId`) are *rejected* when
  over-long — they must round-trip byte-exact or PeerJS dialling breaks.
  **Display fields** (`name`) are *truncated* to 80 chars, so an over-long name
  degrades instead of taking presence down with it.
- **Lists** (`callWith`, `targets`) drop non-string and over-long entries,
  dedupe, filter out the caller's own id, and cap at 32 entries.
- **Unknown fields are ignored** — every field is read by name.
- **One record per call.** A presence POST upserts exactly the single row named
  by its own `userId`; there is no bulk or multi-user write path anywhere.
- **The DO instance name is fixed in code** (`"global"`), never caller-supplied,
  so no caller can address a different instance and shard the roster.
- **The DO never parses a caller-controlled path** — the Worker re-addresses
  each request to a short internal `/presence` or `/knock` path.

### Trust model — read this before adding untrusted users

Authentication is a single shared team secret. Within that boundary there is no
per-user identity, so **any token holder can claim any `userId`** on a
heartbeat, or delete any knock id. That is inherent to the shared-token design
the extension already ships, not a gap introduced here. The enforceable
integrity rules — that a knock can only be accepted by one of its own targets,
that a heartbeat writes only its own row, that nothing can be written in bulk —
are all in place. If the team ever grows past people who trust each other with
one shared secret, this needs real per-user credentials.

---

## Deploying

### 1. Set the shared secret (once per Worker)

```bash
cd worker
npx wrangler@latest secret put TT_TOKEN
# paste the same value the extension has in its options page ("API token")
```

It must match `syncConfig.token` in the extension exactly. The secret is never
stored in this repo; `wrangler.toml` has no token in it, by design.

### 2. Deploy

```bash
cd worker
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... npx wrangler@latest deploy
```

Validate the config without credentials first:

```bash
npx wrangler@latest deploy --dry-run
```

### 3. Smoke-test

```bash
curl -s https://tabtracker.uthman.xyz/api/health
# {"ok":true,"service":"tabtracker-api","tokenConfigured":true,...}

curl -s -o /dev/null -w '%{http_code}\n' https://tabtracker.uthman.xyz/api/admin/presence
# 401

curl -s -H 'x-tt-token: <TOKEN>' https://tabtracker.uthman.xyz/api/admin/presence
# {"online":[]}
```

---

## Routing: coexisting with the site Worker

The `tabtracker` Worker (`../wrangler.toml`) already owns
`tabtracker.uthman.xyz` through a **Custom Domain** route. This Worker adds a
**path-pattern route** on the *same hostname*:

```toml
[[routes]]
pattern = "tabtracker.uthman.xyz/api/*"
zone_name = "uthman.xyz"
```

**These coexist.** Cloudflare's Workers routing docs state it directly: *"Routes
can `fetch()` Custom Domains and take precedence if configured on the same
hostname"*, with a worked example of a Custom Domain on `api.example.com` plus a
route on `api.example.com/auth` pointing at a different Worker. The route wins
for matching paths; everything else still reaches the Custom Domain Worker.

So no separate `api.` subdomain is needed, and no DNS record has to be created
here — the Custom Domain already provisioned the proxied record for this
hostname. Deploy order does not matter.

Two consequences worth knowing:

- `/api/*` is wider than the two paths this Worker implements. If the static
  site Worker ever grows its own `/api/` endpoints on this hostname, this
  Worker would shadow them. Set `API_PASSTHROUGH = "true"` in `wrangler.toml`
  and unmatched `/api/` requests are handed on with `fetch(request)`, which
  resolves to the Custom Domain Worker (a route cannot be the target of a
  same-zone `fetch()`, so this cannot loop back here).
- If you would rather keep the surfaces fully separate, the alternative is a
  dedicated `api.tabtracker.uthman.xyz` Custom Domain on this Worker. It is not
  necessary — just a different taste in blast radius.

---

## Pointing the extension at it

### Required client change: send the token

The four voice fetches in `background.js` currently send **no `x-tt-token`
header** (unlike the to-dos/salah/notify calls, which do). Against this Worker
they will all get `401` until the header is added. The call sites, at the time
this Worker was written:

| Line | Call | Fix |
|---|---|---|
| ~1221 | `POST .../api/admin/knock` | add `'x-tt-token': syncConfig.token` to `headers` |
| ~1247 | `PATCH .../api/admin/knock` | add `'x-tt-token': syncConfig.token` to `headers` |
| ~1268 | `DELETE .../api/admin/knock?id=` | add a `headers: { 'x-tt-token': syncConfig.token }` option |
| ~1324 | `POST .../api/admin/presence` (`sendVoicePresence`) | add `'x-tt-token': syncConfig.token` to `headers` |
| ~1355 | `GET .../api/admin/presence` (`pollVoiceRoster`) | add `headers: { 'x-tt-token': syncConfig.token }` |
| ~1356 | `GET .../api/admin/knock?user=` (`pollVoiceRoster`) | add `headers: { 'x-tt-token': syncConfig.token }` |

The token is already in `syncConfig.token` at every one of those sites (or one
`chrome.storage.local.get` away), so this is a header addition, not a redesign.
Passing the token in a query string would be worse — it would land in logs.

### Choosing the base URL

The extension builds every URL from a single `syncConfig.adminUrl`. That base
is also used by `/api/todos`, `/api/salah`, `/api/notify`, `/api/tab-stats` and
`/api/admin/tab-tracker-token`, **none of which this Worker implements**. So:

- **If those other endpoints have also been moved** to this domain, just change
  the Admin URL in the extension's options page to
  `https://tabtracker.uthman.xyz` and everything follows.
- **If they have not**, pointing `adminUrl` here would break to-dos, salah and
  notifications. Give the voice code its own base instead — e.g. read
  `syncConfig.voiceUrl` (falling back to `adminUrl`) in `sendVoicePresence`,
  `pollVoiceRoster` and the three knock handlers, and set it to
  `https://tabtracker.uthman.xyz`. That is a `background.js` change, owned by
  whoever owns that file.

`host_permissions` in `manifest.json` must cover the new host for the extension
to reach it.

---

## Local development

```bash
cd worker
cp .dev.vars.example .dev.vars      # local-only token; .dev.vars is gitignored
npx wrangler@latest dev --port 8787 --local
```

`--local` runs the Durable Object in miniflare with a real SQLite file under
`.wrangler/`, so expiry and persistence behave as they do in production.
`API_PASSTHROUGH` is ignored on `localhost`/`127.0.0.1` — there is no Custom
Domain Worker behind `wrangler dev`, so passing through would just re-enter
this Worker in a loop.

```bash
T='local-dev-token-not-a-secret'
curl -s -X POST localhost:8787/api/admin/presence -H "x-tt-token: $T" \
  -H 'Content-Type: application/json' \
  -d '{"userId":"tomiwa","name":"Tomiwa","peerId":"peer-t","callWith":[]}'
curl -s localhost:8787/api/admin/presence -H "x-tt-token: $T"
```

---

## Where each shape comes from

| Shape | Source |
|---|---|
| `POST /api/admin/presence` body | `background.js` → `sendVoicePresence()` |
| `GET /api/admin/presence` → `{ online: [...] }` | `background.js` → `pollVoiceRoster()`, `Array.isArray(j.online)` |
| Presence entry fields (`userId`, `name`, `peerId`, `callWith`) | `pollVoiceRoster()` maps + `tab-timer.js` `computeMeetings()` |
| `POST /api/admin/knock` body | `background.js` → `voice.knockRequest` handler |
| `POST` reply needs `ok` + `knock.id` | `tab-timer.js` → `voiceRequestJoin()` reads `r.knock?.id` |
| `PATCH` body `{ knockId, accepterUserId }` | `background.js` → `voice.knockAccept` handler |
| `DELETE ?id=` | `background.js` → `voice.knockCancel` + `handleAcceptedOutgoingKnock()` |
| `GET ?user=` → `{ incoming, outgoing }` | `pollVoiceRoster()` |
| `acceptedBy` drives auto-dial | `pollVoiceRoster()` → `handleAcceptedOutgoingKnock()` |
| `x-tt-token` auth header | `background.js` → `todoSyncOnce()` / `postTodo()` / `salahSyncOnce()` |
