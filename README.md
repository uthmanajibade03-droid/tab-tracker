# Tab Tracker

Chrome/Edge extension (Manifest V3) that tracks the sites you visit and how long
you actively spend on each one — plus to-dos, prayer-time reminders, and one-tap
voice calls with teammates.

Everything runs locally out of the box and needs no account. Voice calling is the
only feature that requires a server, and it's opt-in.

## Install

1. Open `chrome://extensions` (or `edge://extensions`).
2. Toggle **Developer mode** on.
3. Click **Load unpacked** and pick this folder.
4. Pin the Tab Tracker icon to your toolbar.

To build a Chrome Web Store zip instead:

```bash
powershell -ExecutionPolicy Bypass -File build_zip.ps1
```

## What it does

### Tracking (always on, always local)

- Counts a **visit** whenever a tab navigates to a new domain.
- Counts **active time** while a tab is focused, the window has focus, and
  you're not idle (60s threshold).
- Shows a **floating timer badge** on every page with today's time on that site.
  Its gradient is configurable in Settings.
- Stored in `chrome.storage.local`. The dashboard has a day picker, sortable
  table, JSON export, and Clear all.

### To-dos

- Personal and shared lists, each split into **Today** and **Later**, stored
  locally.
- Add from the popup, from the floating widget, or by selecting text on any page
  and right-clicking → **Add to Tab Tracker to-dos**.
- `Ctrl+Shift+T` quick-add · `Ctrl+Shift+H` show/hide the floating widget.

### Overuse alerts

When you cross a per-site time threshold (default 30 min), a full-page alert
fires with a configurable reminder message.

### Prayer times

No server or account required. Your approximate location is looked up once from
your IP (across several providers, since free ones rate-limit aggressively), then
cached; prayer times come from the public **Aladhan** API. Each prayer fires in
two stages:

1. **At prayer time** — the prayer name appears and the Adhan plays.
2. **A few minutes later** (configurable) — a Quran verse card appears in Arabic
   and English, with Husary recitation.

Only the verse *references* are bundled; the text is fetched from
**alquran.cloud** and cached, so the scripture is authoritative rather than
transcribed into source. References rotate daily.

Audio plays through an offscreen document, which is what lets it fire from an
alarm without a user gesture.

### Voice calls

Teammates online appear in the **Voice** tab of the popup and in the floating
widget.

- Click **Call** and it rings on their end. They see who's calling with
  **Answer** / **Decline**; their mic stays off until they answer. Unanswered
  calls auto-decline after 30 seconds.
- To join a call already in progress, send a **knock**; once a participant
  accepts, both sides dial everyone automatically.
- Audio is peer-to-peer WebRTC (mesh, so multi-party works). Signalling goes
  through the public PeerJS broker; audio never touches any server.

## Voice setup

Everything except calling works with no configuration at all. Calling needs a
rendezvous server, because two browsers cannot discover each other unaided —
deploy the one in [`worker/`](worker/) to your own Cloudflare account, then fill
in **Settings**:

1. **Your name** — how teammates see you. A `userId` slug is derived from it
   (`Rasheed Ajiba` → `rasheed-ajiba`); changing it later makes you a new person
   to the roster.
2. **Voice server** — where the Worker is deployed.
3. **Team token** — must match the Worker's `TT_TOKEN` secret. One shared token
   for the whole team.

Click **Test connection**. It checks the server is reachable *and* that your
token is accepted — a wrong token is the failure this button exists to catch.

Call audio is peer-to-peer and never touches the server.

## Files

| File | Role |
|---|---|
| `background.js` | Service worker — tracking, prayer times, alarms, voice signalling, desktop bridge |
| `tab-timer.js` | Content script — floating badge, to-do widget, alert overlays |
| `offscreen.js` | Prayer audio playback and WebRTC mic + peer connections |
| `popup.*` | Toolbar popup — to-dos, today's stats, voice roster, settings |
| `options.*` | Settings page — identity, voice server, badge colors |
| `dashboard.*` | Full local dashboard — day picker, sorting, export |
| `peerjs.min.js` | Bundled PeerJS (vendored so no CDN is needed at runtime) |

## Privacy

Your browsing statistics never leave your device — there is no account and no
telemetry. Prayer times and audio come from public APIs, and voice calls contact
your own server only to answer "who is online". [PRIVACY.md](PRIVACY.md) lists
every outbound request and why it happens.

## Desktop app

A companion floating pill that tracks time per *application* — across your whole
computer, not just the browser — lives in [`desktop/`](desktop/). When both are
running, the extension sends the current site to it over loopback so the pill can
show `Google Chrome · github.com`.

## Repository layout

| Folder | What it is |
|---|---|
| _(root)_ | The Chrome/Edge extension |
| [`desktop/`](desktop/) | Electron app — the floating pill |
| [`worker/`](worker/) | Cloudflare Worker — voice rendezvous |
| [`site/`](site/) | The landing page |
