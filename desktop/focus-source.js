'use strict';

/*
 * Where the foreground-window stream comes from, per platform.
 *
 * The seam is deliberately narrow. Both helpers emit the same thing — one JSON
 * object per line, `{pid, app, title, cls, ts}`, on change plus a heartbeat —
 * so everything downstream (parsing, staleness, accrual, restart-with-backoff)
 * is written once and knows nothing about the operating system. The only thing
 * that differs is which process to start.
 *
 * Splitting here rather than branching inside startWatcher() keeps a future
 * third platform from turning that function into a tangle of ifs.
 */

const path = require('path');
const fs = require('fs');

/*
 * In a packaged build the app source may live inside app.asar, and neither
 * powershell.exe nor osascript can read a script from inside that archive —
 * they are external processes with no idea what an asar is. Fall back to the
 * unpacked resources directory, which is where the scripts are shipped.
 */
function resolveScript(filename) {
  const inSource = path.join(__dirname, filename);
  if (!__dirname.includes('app.asar')) return inSource;
  return path.join(process.resourcesPath, filename);
}

/**
 * @returns {{command: string, args: string[], script: string, platform: string}|null}
 *   null when this platform has no watcher, or its script is missing.
 */
function watcherCommand() {
  if (process.platform === 'win32') {
    const script = resolveScript('focus-watcher.ps1');
    if (!fs.existsSync(script)) {
      console.error('[watcher] focus-watcher.ps1 not found at', script);
      return null;
    }
    return {
      platform: 'win32',
      command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
      script,
    };
  }

  if (process.platform === 'darwin') {
    const script = resolveScript('focus-watcher.jxa.js');
    if (!fs.existsSync(script)) {
      console.error('[watcher] focus-watcher.jxa.js not found at', script);
      return null;
    }
    return {
      platform: 'darwin',
      // JavaScript for Automation, so the helper can call AppKit directly
      // instead of paying to spawn a process on every sample.
      command: 'osascript',
      args: ['-l', 'JavaScript', script],
      script,
    };
  }

  console.warn(`[watcher] no foreground-window helper for platform "${process.platform}";` +
    ' the pill will run but will not track applications');
  return null;
}

/*
 * Process names (lowercased) whose foreground time may be attributed to a web
 * domain reported by the browser extension.
 *
 * Both spellings are needed: Windows reports the executable ("chrome"), while
 * macOS reports the display name ("Google Chrome"). Listing only one silently
 * disables the domain half of the bridge on the other platform — the pill
 * would keep saying "Google Chrome" and never "Google Chrome · github.com".
 */
const BROWSER_PROCESSES = new Set([
  // Windows executables
  'chrome', 'msedge', 'firefox', 'brave', 'opera', 'vivaldi', 'arc', 'chromium',
  // macOS display names
  'google chrome', 'google chrome canary', 'microsoft edge', 'brave browser',
  'firefox developer edition', 'safari', 'chromium', 'orion',
]);

module.exports = { watcherCommand, BROWSER_PROCESSES };
