# Tab Tracker Desktop

A small always-on-top "pill" that shows which desktop application you are
focused on and how long you have spent in it today.

```
  ● Google Chrome · github.com · 12m 04s
```

It is the desktop counterpart to the Tab Tracker browser extension in the
parent folder, and records time in the same shape so both data sets can be
merged in one dashboard later.

## Requirements

- Windows 10/11
- Node.js 22.12+ (required by Electron 43)
- PowerShell 5.1 (ships with Windows) — used for foreground-window detection

## Install and run

```powershell
cd desktop
npm install
npm start
```

> Electron 43 no longer downloads its binary from its own `postinstall` hook,
> so this package runs `install-electron` in its `postinstall` instead. If you
> ever install with `--ignore-scripts`, fetch the binary manually with
> `npx install-electron`, otherwise `npm start` will not find `electron.exe`.

The pill appears in the bottom-right of the primary display. Drag it anywhere;
its position is remembered across launches.

## Using it

- **Drag** the pill body to move it.
- **Click** the pill to open its settings panel; click it again, click away, or
  press <kbd>Esc</kbd> to close.
- **Drag the right edge** of the pill to resize it. The whole capsule scales
  together — height, padding, type, and the dot — between 200px and 400px wide.
  The grip is also focusable: <kbd>←</kbd>/<kbd>→</kbd> nudge by 10px,
  <kbd>Home</kbd>/<kbd>End</kbd> jump to the minimum and maximum.
- **Right-click** the pill for: Pause/Resume tracking, Reset today's stats,
  Open stats folder, Hide pill, Quit.
- **Tray icon** (shared with the extension's `icons/32.png`) offers Show/Hide
  pill, Pause/Resume, Open stats folder, and Quit — useful when the pill is
  hidden.

The status dot is green while tracking, amber when paused, and dim grey when
idle or when the focused app is unknown.

### Settings panel

Clicking the pill grows the *same* window to make room for a small panel below
it — or above it, when the pill is near the bottom of the display and there is
no room underneath. A second window would have needed click-through regions and
a second always-on-top surface to stay in sync; one window that changes size
avoids both.

The panel is deliberately short:

| Control | Notes |
| --- | --- |
| Pause / Resume tracking | Reflects the live state; also mirrored in both menus |
| Reset today's stats | Two-step — the row expands into Cancel / Reset |
| Quit Tab Tracker | |

The renderer measures the panel and tells the main process how much taller the
window needs to be, so the confirmation step expanding the panel resizes the
window without either side hardcoding a height.

## How focus tracking works

`focus-watcher.ps1` runs as a single long-lived PowerShell process. It samples
the foreground window **every 125ms** but only writes a line when the sample
actually changes, plus an unconditional **heartbeat every ~2 seconds**:

```json
{"pid":14280,"app":"chrome","title":"GitHub — Chrome","cls":"Chrome_WidgetWin_1","ts":1788270756786}
```

Emitting on change rather than on every sample is what makes 8Hz polling free:
a switch shows up in well under a fifth of a second, while stdout stays as quiet
as it was at 1Hz. Measured steady-state cost of the helper is ~0.3% of one core.

When nothing is focused it emits `{"pid":0,"app":null,...}` rather than going
silent, so the app can tell "no focus" apart from "helper died".

`cls` is the foreground window's Win32 class. It exists to separate the Windows
**desktop** from a real Explorer window: both are `explorer.exe`, but the
desktop is `Progman`/`WorkerW` while a file browser is `CabinetWClass`. Sitting
on the desktop is reported as *no focus* — the pill goes idle and accrues
nothing — rather than quietly banking minutes against "File Explorer". A real
Explorer window still tracks normally.

The main process reads that stream line by line. If the helper exits it is
restarted with exponential backoff (1s doubling to a 30s ceiling), and if no
line arrives for 5 seconds the app stops accruing time rather than guessing.

> **If you change the cadence:** `WATCHER_STALE_MS` (5s) is sized against the
> helper's *heartbeat*, not its poll rate, because between switches the
> heartbeat is the only traffic. Raising `$HEARTBEAT_MS` past ~2.4s without
> raising `WATCHER_STALE_MS` would stall accrual every few seconds. main.js
> warns at startup if the two drift out of proportion.

Raw process names are mapped to friendly display names (`chrome` →
`Google Chrome`, `Code` → `VS Code`, `WindowsTerminal` → `Terminal`, …), falling
back to the capitalized raw name for anything unrecognized.

### The pill's own window

Ticks whose PID is this app's own are ignored, so clicking or dragging the HUD
never hijacks the timer to "Electron".

That guard needs a bound, though: the pill is always-on-top, so when the focused
application *exits*, Windows activates the topmost remaining window — which is
the pill. Ignoring our own PID unconditionally would leave a closed application
on screen accruing time forever. So our own window in the foreground only holds
the previous app while the pill plausibly has the user's attention (a gesture in
flight, the settings panel open, or within 2.5s of the last interaction). Past a
1s grace with none of that, the app is treated as gone and the pill drops to its
idle state.

## Idle detection

Time stops accruing after 60 seconds without keyboard or mouse input
(`powerMonitor.getSystemIdleTime()`), and the dot goes grey. It resumes on the
next input. This matches the browser extension's 60-second idle threshold.

## Data

Stats are written to `stats.json` in Electron's `userData` directory — on
Windows that is:

```
%APPDATA%\tab-tracker-desktop\stats.json
```

Use **Open stats folder** from either menu to jump straight to it.

```jsonc
{
  "2026-09-01": {
    "Google Chrome": { "opens": 14, "activeMs": 4820000 },
    "VS Code":       { "opens": 9,  "activeMs": 9130000 }
  }
}
```

- `activeMs` — foreground time, excluding idle and paused periods.
- `opens` — number of times the app *became* focused, matching how the
  extension counts a domain "visit".

Writes are debounced to at most one every 10 seconds (plus a guaranteed flush
on quit and on system suspend) and are atomic: the file is written to a temp
sibling, fsync'd, then renamed over the target, so a crash mid-write can never
leave a corrupt `stats.json`. The day key rolls over at local midnight.

Because of that debounce, `stats.json` on disk lags the pill's live counter by
up to 10 seconds. The pill is the accurate figure.

### `ui-state.json`

Pill position, size, and paused state live in `ui-state.json` in the same
folder:

```jsonc
{
  "x": 3213,      // the PILL's top-left, never the window's — they differ
  "y": 120,       //   while the panel is open upward
  "width": 260,   // 200–400; height is always round(width * 52/260)
  "paused": false
}
```

Every field is validated independently on load, so a file written by an older
version (which only had `x`/`y`) upgrades cleanly instead of being discarded.
Position writes are debounced 500ms, since `move` fires all through a drag.

A saved position that no longer intersects any display falls back to the
bottom-right of the primary display, and any change to the pill's size
re-clamps it to its display's work area so growing near an edge cannot push it
off screen.

## WebSocket bridge

The app listens on `ws://127.0.0.1:51314` (loopback only — it never binds
`0.0.0.0`) so the browser extension can report which site is in view. **The
bridge is entirely optional**: if nothing ever connects, or the port is already
taken, the app logs it and carries on with app-level tracking only.

### Extension → app

```json
{ "type": "domain", "domain": "github.com", "activeMs": 12345 }
```

Send while the browser is the focused window.

### App → extension

```json
{ "type": "focus", "app": "Google Chrome", "activeMs": 12345 }
```

Sent on every focus change, and once immediately on connect so a newly
connected extension does not have to wait for the next switch.

### Display rule

When the focused app is a known browser (Chrome, Edge, Firefox, Brave, Opera,
Vivaldi, Arc, Chromium) **and** a domain has been reported within the last
10 seconds, the pill shows `Google Chrome · github.com` with the domain in a
dimmer weight. Otherwise it shows the app name alone. The staleness window
means a browser left open on a stale connection degrades to just the app name
instead of showing a domain the user is no longer on.

## Security notes

- The renderer runs with `nodeIntegration: false`, `contextIsolation: true`,
  and `sandbox: true`. Its entire capability surface is the fixed list of
  functions exposed in `preload.js` — there is no raw `ipcRenderer` and no way
  to name a channel the main process did not opt into. Every argument is
  re-validated on the main side; `preload.js` keeps the surface small rather
  than policing it.
- A CSP blocks all network and remote content; the pill only ever renders local
  files.
- The bridge binds loopback only and ignores any message that is not a
  well-formed `domain` report.

## Files

| File | Role |
| --- | --- |
| `main.js` | Window geometry, tray, focus watcher, idle handling, stats, bridge, menus |
| `preload.js` | The only main↔renderer channel (`contextBridge`) |
| `renderer/pill.html` · `pill.css` · `pill.js` | The pill UI, the settings panel, and the move/resize gestures |
| `focus-watcher.ps1` | Foreground-window poller (P/Invoke into `user32.dll`) |

## Packaging note

`focus-watcher.ps1` cannot be executed from inside `app.asar`. If you package
this, ship the script via `extraResources`; `main.js` already looks in
`process.resourcesPath` when it detects it is running from an asar archive.
