'use strict';

/*
 * Automatic updates, against the project's GitHub Releases.
 *
 * Deliberately quiet. The app checks on launch and every few hours, downloads
 * in the background, and then does nothing except surface a "ready" flag — the
 * restart is the user's call. Silently replacing someone's running application
 * is the one behaviour this must never have.
 *
 * If it should be installed without a restart being asked for, it happens on
 * quit, which is the moment it costs nothing.
 *
 * Everything here degrades: a machine with no network, a rate-limited GitHub,
 * or a dev build with no published release must all leave the app working
 * exactly as it would have anyway.
 */

const { app } = require('electron');

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

let autoUpdater = null;
let onChange = () => {};
let timer = null;

/** @type {{state: 'idle'|'checking'|'downloading'|'ready'|'error', version: string|null, percent: number, message: string|null}} */
let status = { state: 'idle', version: null, percent: 0, message: null };

function log(...args) { console.log('[updater]', ...args); }

function setStatus(next) {
  status = { ...status, ...next };
  onChange(getStatus());
}

function getStatus() {
  return { ...status, current: app.getVersion() };
}

function init({ onStatus } = {}) {
  onChange = typeof onStatus === 'function' ? onStatus : () => {};

  /*
   * A dev run has no published release to compare against and no packaged
   * metadata to compare with, so electron-updater throws rather than reporting
   * "up to date". Skip entirely — this is not an error worth surfacing.
   */
  if (!app.isPackaged) {
    log('not packaged; auto-update disabled for this run');
    return;
  }

  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (err) {
    log('electron-updater unavailable:', err.message);
    return;
  }

  // We surface our own affordance, so nothing should install underfoot.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => setStatus({ state: 'checking', message: null }));

  autoUpdater.on('update-not-available', () => setStatus({ state: 'idle', version: null, percent: 0 }));

  autoUpdater.on('update-available', (info) => {
    log('update available:', info && info.version);
    setStatus({ state: 'downloading', version: info ? info.version : null, percent: 0 });
  });

  autoUpdater.on('download-progress', (p) => {
    setStatus({ state: 'downloading', percent: Math.round((p && p.percent) || 0) });
  });

  autoUpdater.on('update-downloaded', (info) => {
    log('update ready:', info && info.version);
    setStatus({ state: 'ready', version: info ? info.version : null, percent: 100 });
  });

  autoUpdater.on('error', (err) => {
    /*
     * Being offline is the common case and is not a failure the user needs to
     * hear about — it just means "not today". Record it for the log and go back
     * to idle rather than showing an error the user can do nothing with.
     */
    log('check failed:', (err && err.message) || err);
    setStatus({ state: 'idle', message: null });
  });

  check();
  timer = setInterval(check, CHECK_INTERVAL_MS);
}

function check() {
  if (!autoUpdater) return;
  autoUpdater.checkForUpdates().catch((err) => {
    log('check threw:', (err && err.message) || err);
  });
}

/** Restart into the new version now. No-op unless one is downloaded. */
function installNow() {
  if (!autoUpdater || status.state !== 'ready') return false;
  // isSilent=false so the NSIS installer still shows progress; isForceRunAfter
  // so the user lands back in the app rather than at their desktop.
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
  return true;
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { init, check, installNow, getStatus, stop };
