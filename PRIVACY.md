# Tab Tracker — Privacy Policy

_Last updated: September 1, 2026_

Tab Tracker records how many times you visit each site and how much time you
actively spend there. It also offers to-dos, prayer-time reminders, and optional
voice calls with teammates.

**Your browsing statistics never leave your device.** There is no account, no
analytics, and no telemetry. The sections below list every network request the
extension makes and exactly why.

---

## What is collected, and where it lives

- The **URL** of tabs you open — used only to extract the hostname
  (e.g. `github.com`). Full URLs are never stored.
- The **active/focused state** of your tabs and windows, to time how long each
  site is in the foreground.
- The **idle state** of your computer, to pause tracking after 60 seconds away.
- Any **to-dos** you create.

All of it is stored in `chrome.storage.local`, on your machine. None of it is
uploaded anywhere.

---

## Every outbound request

| Destination | Why | When |
|---|---|---|
| `fonts.googleapis.com` | Webfont for the on-page timer badge | On pages where the badge renders |
| `ipwho.is` (falling back to `geojs.io`, `ipapi.co`) | Approximate location, to calculate prayer times | Once, then cached indefinitely |
| `api.aladhan.com` | Prayer times for your coordinates | Hourly |
| `api.alquran.cloud` | Text of the verse shown after a prayer | Once per verse, then cached |
| `everyayah.com` | Quran recitation audio | When a verse alert fires |
| `islamcan.com` | Call to prayer (Adhan) audio | When a prayer alert fires |
| Your voice server | Who is online for calls | Only if you configure voice |
| `0.peerjs.com` | Connecting you to the person you're calling | Only during a call |

These services receive your IP address, as any web request would. None of them
receive your browsing history, your statistics, or your to-dos.

**If you leave the voice settings blank, the last two rows never happen** — and
the rest are the ordinary cost of prayer times and audio working at all.

---

## Voice calls

Calling is entirely optional and off until you fill in the settings.

- Audio is **WebRTC, peer-to-peer** — it travels directly between participants
  and never passes through any server.
- A small server (yours, if you deployed the included Worker) answers only one
  question: who is online, and what is their connection ID. It never sees audio.
- Connection setup goes through the public **PeerJS broker** at `0.peerjs.com`,
  which sees connection metadata — IDs and IP addresses — but never audio.
- **Incoming calls ring and wait.** You see who is calling with **Answer** and
  **Decline**, and a ringtone plays. Unanswered calls decline after 30 seconds.
- Your **microphone opens only after you press Answer** — never on an incoming
  call by itself, and never merely because the extension is running. It is
  released when your last call ends.
- Everyone with the shared team token can see who else is online. Only share it
  with people you want on your roster.

---

## The desktop companion

Tab Tracker's desktop app tracks time per *application* and stores it on your
machine, in your user data folder. When both are running, the extension sends
the current site to the app over **`127.0.0.1` (loopback)** so the pill can show
which site you're on. That connection never leaves your computer and is not
reachable from the network.

---

## Your control

- View everything on the dashboard; export it all as JSON.
- **Clear all** on the dashboard permanently deletes local statistics.
- Clear the voice settings to go back to a completely server-free extension.
- Hide the floating widget with Ctrl+Shift+H.
- Uninstalling removes all stored data.

---

## Permissions explained

| Permission | Why it's needed |
|---|---|
| `tabs` | Read tab URLs to group activity by site |
| `host_permissions: <all_urls>` | Inject the floating badge and widget on every page |
| `storage` | Save statistics and settings on your device |
| `idle` | Pause tracking when you're away from your computer |
| `alarms` | Periodically save tracking time and schedule prayer reminders |
| `contextMenus` | Add the "Add to Tab Tracker to-dos" right-click item |
| `scripting` | Render alerts and the to-do widget inside pages |
| `offscreen` | Play prayer audio and hold the microphone during calls |

---

## Contact

Questions: open an issue on the project's repository, or contact the developer
through the Chrome Web Store listing.
