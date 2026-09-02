# Chrome Web Store listing

Everything to paste into the developer dashboard. The screenshots beside this
file are already 1280×800 — the size the store expects — and are regenerated
with `shoot.js` whenever the UI changes, so they can never drift from what the
extension actually draws.

---

## Name

```
Tab Tracker
```

## Short description (132 char limit)

```
Track active time per site, share to-dos, prayer-time reminders, teammate voice calls, and per-site overuse alerts.
```

## Category

Productivity → Workflow & Planning

---

## Detailed description

```
Tab Tracker shows you where your hours actually went.

It counts the time you were really on a site — focused window, not idle, not just a tab left open in the background — and gives you the day back as a simple, honest breakdown.

WHAT IT DOES

• Time per site, measured properly. A visit counts when you navigate somewhere new; time counts only while that tab is focused, the window has focus, and you have not been idle for 60 seconds.

• A quiet timer badge on every page, showing today's total for the site you are on. Change its colour, or hide it entirely.

• A full dashboard. Pick any day, sort by visits or time, see each site's share of your attention, and export everything as JSON.

• To-dos where you already are. Personal and shared lists split into Today and Later. Add one from the popup, from the floating widget, with Ctrl+Shift+T, or by selecting text on any page and right-clicking it.

• Overuse alerts. Set a per-site limit and get a full-page nudge when you cross it, with your own reminder message.

• Prayer-time reminders. Prayer times for your location, with the call to prayer at the moment itself and a Quran verse a few minutes later, in Arabic and English. No account needed.

• Voice calls with teammates. One click to talk, peer-to-peer, with no meeting links. Incoming calls ring and wait — your microphone only opens after you answer.

YOUR DATA STAYS YOURS

Your browsing statistics never leave your device. There is no account, no analytics, and no telemetry. Everything above works with no server at all.

Voice calling is the single exception, and it is opt-in: it needs somewhere for two browsers to find each other. Even then the server only answers "who is online" — call audio goes directly between participants and never passes through it.

Leave the voice settings blank and the extension never contacts a server.

A companion desktop app is also available, which tracks time per application across your whole computer. It is entirely optional.
```

---

## Permission justifications

The store asks for these individually. Each is worded as the narrowest true
answer, because a vague justification is the most common reason a review stalls.

| Permission | Justification |
|---|---|
| `tabs` | Read the URL of the active tab to group time by site. Only the hostname is kept — full URLs are never stored or transmitted. |
| `storage` | Save your statistics, to-dos and settings on your own device. |
| `idle` | Stop counting time after 60 seconds of inactivity, so time away from the keyboard is not recorded as usage. |
| `alarms` | Periodically save in-flight time so it survives the service worker restarting, and schedule prayer-time reminders. |
| `contextMenus` | Provide the "Add to Tab Tracker to-dos" item when you right-click selected text. |
| `scripting` | Render the timer badge, the to-do widget and alert overlays inside pages. |
| `offscreen` | Play the call to prayer and Quran recitation, and hold the microphone during a voice call. Chrome requires an offscreen document for both. |
| `host_permissions: <all_urls>` | The timer badge and to-do widget appear on any page you visit, so the content script must be able to run anywhere. No page content is read, collected or transmitted — only the hostname of the active tab. |

### Remote code

**No.** All code is included in the package. `peerjs.min.js` is bundled rather
than loaded from a CDN precisely so nothing executable is fetched at runtime.

### Data usage disclosures

- Personally identifiable information — **No**
- Health, financial, authentication information — **No**
- Personal communications — **No** (call audio is peer-to-peer and never
  collected, stored or transmitted to us)
- Location — **No** (prayer times use an approximate city-level lookup that is
  never stored off-device)
- Web history — **Not collected.** Hostnames are stored locally on the user's
  own machine and are not transmitted to the developer or any third party.
- User activity — **Not collected.**

Tick all three certification boxes: no selling to third parties, no use
unrelated to the stated purpose, no use to determine creditworthiness.

### Privacy policy URL

```
https://github.com/uthmanajibade03-droid/tab-tracker/blob/main/PRIVACY.md
```

---

## Screenshots

In order, with the caption baked into each image:

1. `store-1-stats.png` — Today's stats in the popup
2. `store-2-todos.png` — Personal and shared to-dos
3. `store-3-dashboard.png` — The full-day dashboard
4. `store-4-settings.png` — Settings, and what stays local

## Regenerating them

From `desktop/` (which has Electron installed):

```bash
cd store
"../desktop/node_modules/.bin/electron" .
```

`stub.js` fakes the `chrome.*` APIs with realistic seeded data and `shoot.js`
captures the real pages, so these are photographs of the actual UI rather than
mockups. If the popup changes, re-run it and the screenshots follow.

---

## Before submitting

- The **microphone** is the thing most likely to draw a reviewer's attention.
  The justification above states plainly that it opens only after the user
  answers a call, which is what the code does.
- `PRIVACY.md` must be reachable at the URL above — the store rejects a
  privacy policy link that 404s.
- Bump `version` in `manifest.json`; the store refuses a version it has already
  seen.
- Build the upload with `powershell -ExecutionPolicy Bypass -File build_zip.ps1`
  from the repo root.
