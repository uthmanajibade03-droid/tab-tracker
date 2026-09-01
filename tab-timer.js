/* Floating timer badge — injected on every http(s) page.
 * Shadow-DOM isolated so page CSS can't touch us. Draggable + resizable.
 * Polls `getTabTime` once per second; same domain across multiple tabs
 * shares the same total because the background script keys time by domain,
 * not tab id. */

if (window.top === window) {
  /* Version log — easy way to tell at a glance whether the page is
     running the latest extension code. Look in DevTools console for
     this line; if you don't see it, you're on an older build. */
  console.log('[Tab Tracker v1.0.0] tab-timer loaded');

  const STORAGE_KEY = 'badgeUI';
  const COLOR_KEY = 'badgeColors';
  const ALERT_KEY = 'categoryAlerts';
  /* Same shape as ALERT_KEY but tracks the SEPARATE teammate-notify
     boundary per (domain, day). Independent so admins can set a tighter
     or looser threshold for distraction-site notifications than the
     general per-site overuse alert. */
  const NOTIFY_ALERT_KEY = 'notifyAlerts';
  const TODO_WIDGET_KEY = 'todoWidgetUI';
  const DEFAULT_UI = { x: null, y: 16, edge: 'right', edgeOffset: 16, scale: 1.0 };
  const DEFAULT_COLORS = { from: '#4DDB9B', to: '#12603D' };
  const BASE_FONT = 14;
  let ui = { ...DEFAULT_UI };
  let colors = { ...DEFAULT_COLORS };

  /* ────────────── Category-time alert ──────────────────────────────
   * Once the visitor's CUMULATIVE active time across all tabs in a
   * category crosses the threshold (default 30 min) today, the badge
   * grows + reddens + slides to the viewport center + calmly pulses
   * for ~4 seconds, then settles back to its normal spot.
   *
   * Domain lists are intentionally short and US-centric — easy to
   * extend later. Subdomain match is "endsWith('.' + domain)" so e.g.
   * music.youtube.com counts as entertainment. The alert fires once
   * per category per day; the consumed flag is persisted to
   * chrome.storage.local so a page reload or another tab in the same
   * category doesn't re-fire it. */
  const CATEGORIES = {
    social: [
      'facebook.com', 'fb.com', 'fb.watch',
      'instagram.com',
      'twitter.com', 'x.com',
      'tiktok.com',
      'snapchat.com',
      'threads.net',
      'reddit.com',
      'pinterest.com',
      'linkedin.com',
      'bsky.app',
      'discord.com',
      'whatsapp.com', 'web.whatsapp.com',
      'telegram.org', 'web.telegram.org'
    ],
    entertainment: [
      'youtube.com', 'youtu.be',
      'netflix.com',
      'hulu.com',
      'twitch.tv',
      'disneyplus.com',
      'primevideo.com',
      'hbomax.com', 'max.com',
      'spotify.com',
      'soundcloud.com',
      'vimeo.com',
      'dailymotion.com',
      'crunchyroll.com',
      'peacocktv.com',
      'paramountplus.com',
      'tubi.tv', 'pluto.tv',
      '9gag.com'
    ],
    games: [
      'roblox.com',
      'steamcommunity.com', 'steampowered.com',
      'epicgames.com',
      'miniclip.com',
      'chess.com', 'lichess.org',
      'poki.com',
      'coolmathgames.com',
      'kongregate.com',
      'addictinggames.com',
      'agame.com', 'y8.com',
      'crazygames.com',
      'newgrounds.com',
      'armorgames.com',
      'itch.io'
    ]
  };
  const DEFAULT_THRESHOLD_MINUTES = 30;
  const DEFAULT_NOTIFY_THRESHOLD_MINUTES = 30;
  const DEFAULT_ALERT_DURATION_SECONDS = 4;
  let currentThresholdMinutes = DEFAULT_THRESHOLD_MINUTES;
  let currentNotifyThresholdMinutes = DEFAULT_NOTIFY_THRESHOLD_MINUTES;
  let currentAlertDurationSeconds = DEFAULT_ALERT_DURATION_SECONDS;
  const ALERT_TRANSITION_MS = 650;

  function categoryOf(domain) {
    if (!domain) return null;
    for (const cat of Object.keys(CATEGORIES)) {
      const list = CATEGORIES[cat];
      for (const d of list) {
        if (domain === d || domain.endsWith('.' + d)) return cat;
      }
    }
    return null;
  }

  let alertActive = false;
  /* Per-day, per-domain checkpoint — last threshold boundary that fired
     for each site today. The alert fires whenever a site's cumulative
     active-ms today crosses a fresh multiple of the threshold past its
     own checkpoint. So a 30-min threshold rings independently for
     youtube.com (at 30, 60, 90 min on YouTube), instagram.com, and so
     on — visitor gets a nudge per site, not a single combined nudge.
     Two parallel checkpoint holders feed checkDomainBoundary: one for
     the red overuse alert, one for the purple teammate-notify. */
  const overuseCheckpoint = { perDomain: {}, dayKey: null };
  const notifyCheckpoint = { perDomain: {}, dayKey: null };

  /* Per-domain overuse reminder text — admin-configurable in the
     TodosPanel and shown on the alert overlay when it fires. */
  let currentReminderText = '';

  /* Admin-configured list of "distraction" domains. When the per-site
     overuse alert fires on any of these, the offender's background also
     POSTs /api/notify to fan a popup out to teammates. Sync into this
     var on every /api/todos poll via background.js. Empty list = off. */
  let currentDistractionDomains = [];

  function fmt(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    const ss = String(s % 60).padStart(2, '0');
    const mm = String(m % 60).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
  }

  const host = document.createElement('div');
  host.id = '__tab_tracker_badge_host__';
  host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; pointer-events: auto;';
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `
    <style>
      /* Load Inter (UI / English) and Amiri Quran (Arabic Mushaf) via
         @import inside the shadow DOM. The @import is scoped to the
         shadow root's stylesheet so it doesn't touch the host page's
         CSS. Falls back to system fonts when the host page's CSP
         blocks fonts.googleapis.com. */
      @import url('https://fonts.googleapis.com/css2?family=Inter:wght@500;600;700&family=Amiri+Quran&display=swap');
    </style>
    <style>
      .badge {
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        position: relative;
        /* Background applied inline from chrome.storage.local.badgeColors.
           Solid fallback here in case JS doesn't run (very rare). */
        background: #209C64;
        color: #fff;
        padding: 8px 16px 8px 14px;
        border-radius: 999px;
        box-shadow: 0 4px 16px rgba(0,0,0,0.25), 0 0 0 1px rgba(255,255,255,0.12) inset;
        font-variant-numeric: tabular-nums;
        letter-spacing: -0.012em;
        font-weight: 600;
        user-select: none;
        cursor: grab;
        display: inline-flex;
        align-items: center;
        gap: 7px;
        white-space: nowrap;
        line-height: 1;
        transition: opacity 0.15s, box-shadow 0.15s;
        text-shadow: 0 1px 2px rgba(0,0,0,0.25);
      }
      .badge:hover { box-shadow: 0 4px 20px rgba(0,0,0,0.35), 0 0 0 1px rgba(255,255,255,0.2) inset; }
      .badge.dragging { cursor: grabbing; opacity: 0.92; }
      /* Voice-chat signals — someone is trying to reach you OR you're
         in a call. If you're in a call, the yellow knock border is
         suppressed but the numeric count still shows so you can see
         join requests pile up. */
      .badge.voice-knock {
        box-shadow: 0 0 0 3px #ffb84d, 0 4px 20px rgba(255,168,0,0.5);
        animation: voice-knock-pulse 1.2s ease-in-out infinite;
      }
      @keyframes voice-knock-pulse {
        0%,100% { box-shadow: 0 0 0 3px #ffb84d, 0 4px 20px rgba(255,168,0,0.5); }
        50%     { box-shadow: 0 0 0 5px #ffce70, 0 4px 24px rgba(255,168,0,0.7); }
      }
      .badge.voice-in-call {
        box-shadow: 0 0 0 3px #4DDB9B, 0 4px 20px rgba(77,219,155,0.5);
        animation: voice-call-pulse 1.4s ease-in-out infinite;
      }
      @keyframes voice-call-pulse {
        0%,100% { box-shadow: 0 0 0 3px #4DDB9B, 0 4px 20px rgba(77,219,155,0.5); }
        50%     { box-shadow: 0 0 0 5px #7fecb8, 0 4px 24px rgba(77,219,155,0.75); }
      }
      .knock-count {
        position: absolute; top: -6px; right: -6px;
        background: #d95400; color: #fff; font-size: 10px;
        min-width: 16px; height: 16px; padding: 0 4px;
        border-radius: 999px;
        display: inline-flex; align-items: center; justify-content: center;
        font-weight: 700; box-shadow: 0 1px 4px rgba(0,0,0,0.3);
      }
      .icon { opacity: 0.95; font-size: 0.9em; }
      .resize {
        position: absolute;
        right: 1px;
        bottom: 1px;
        width: 14px;
        height: 14px;
        cursor: nwse-resize;
        opacity: 0.5;
        border-radius: 0 0 999px 0;
      }
      .resize::after {
        content: '';
        position: absolute;
        right: 3px;
        bottom: 3px;
        width: 6px;
        height: 6px;
        border-right: 2px solid #fff;
        border-bottom: 2px solid #fff;
      }
      .resize:hover { opacity: 1; }

      /* ─── Category-time alert ─────────────────────────────────────
         When the visitor crosses 30 min on a category (social /
         entertainment / games), JS adds .alert-active to .badge AND
         applies a translate-to-viewport-center transform on the host.
         The badge gets a gradient red repaint + soft glow + slow
         scale pulse. !important on background + box-shadow beats the
         inline gradient applied by applyColors(). */
      @keyframes ttAlertPulse {
        0%, 100% { transform: scale(1); }
        50%      { transform: scale(1.08); }
      }
      .badge.alert-active {
        background: linear-gradient(135deg, #ff5e5e 0%, #a01919 100%) !important;
        box-shadow:
          0 0 0 1px rgba(255, 255, 255, 0.18) inset,
          0 12px 50px rgba(184, 30, 30, 0.55),
          0 0 80px rgba(255, 80, 80, 0.4) !important;
        animation: ttAlertPulse 1.4s ease-in-out infinite;
      }

      /* Prayer alert — a calmer cousin of the red overuse alert. Same
         scale-to-center motion driven by the host's transform; the
         badge gets a teal/emerald gradient instead of red. */
      .badge.prayer-active {
        background: linear-gradient(135deg, #34d399 0%, #047857 100%) !important;
        box-shadow:
          0 0 0 1px rgba(255, 255, 255, 0.22) inset,
          0 12px 50px rgba(4, 120, 87, 0.5),
          0 0 80px rgba(52, 211, 153, 0.35) !important;
        animation: ttAlertPulse 2s ease-in-out infinite;
      }

      /* Overuse reminder overlay — small notification card under the
         red badge during the alert, showing the admin-configured
         reminder text. */
      .overuse-reminder {
        position: fixed;
        left: 50%;
        top: 50%;
        transform: translate(-50%, calc(-50% + 70px)) scale(0.96);
        width: min(320px, 80vw);
        background: linear-gradient(135deg, #ff7676 0%, #b81e1e 100%);
        color: #fff;
        border-radius: 12px;
        box-shadow:
          0 0 0 1px rgba(255, 255, 255, 0.2) inset,
          0 16px 50px rgba(184, 30, 30, 0.45);
        padding: 12px 18px;
        text-align: center;
        opacity: 0;
        z-index: 2147483647;
        transition: opacity 400ms ease-out, transform 400ms cubic-bezier(0.34, 1.56, 0.64, 1);
        pointer-events: none;
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 13px;
        font-weight: 600;
        letter-spacing: -0.012em;
        line-height: 1.4;
      }
      .overuse-reminder.show {
        opacity: 1;
        transform: translate(-50%, calc(-50% + 70px)) scale(1);
      }

      /* Teammate-notify overlay — purple cousin of the overuse card.
         Fires when an offender's per-site overuse alert lands on a
         distraction-listed site: each teammate's tab sees a popup with
         "{name} is not moving y'all forward — {minutes} min on {site}",
         and the offender sees a self heads-up. Distinct purple so it's
         visually separable from the red overuse + emerald prayer. */
      .teammate-overlay {
        position: fixed;
        left: 50%;
        top: 50%;
        transform: translate(-50%, -50%) scale(0.96);
        width: min(320px, 80vw);
        background: linear-gradient(135deg, #a78bfa 0%, #5b21b6 100%);
        color: #fff;
        border-radius: 12px;
        box-shadow:
          0 0 0 1px rgba(255, 255, 255, 0.2) inset,
          0 16px 50px rgba(76, 29, 149, 0.5);
        padding: 14px 20px;
        text-align: center;
        opacity: 0;
        z-index: 2147483647;
        transition: opacity 400ms ease-out, transform 400ms cubic-bezier(0.34, 1.56, 0.64, 1);
        pointer-events: none;
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 13px;
        font-weight: 600;
        letter-spacing: -0.012em;
        line-height: 1.4;
      }
      .teammate-overlay.show {
        opacity: 1;
        transform: translate(-50%, -50%) scale(1);
      }

      /* Verse card — fixed overlay that appears in the verse follow-up
         notification. Wide brand-green gradient card, English on top
         (most users read English first), Arabic in larger serif below,
         reference at the bottom. */
      .verse-overlay {
        position: fixed;
        left: 50%;
        top: 50%;
        transform: translate(-50%, -50%) scale(0.96);
        width: min(360px, 82vw);
        background: linear-gradient(135deg, #4DDB9B 0%, #12603D 100%);
        color: #fff;
        border-radius: 14px;
        box-shadow:
          0 0 0 1px rgba(255, 255, 255, 0.18) inset,
          0 20px 60px rgba(0, 0, 0, 0.3);
        padding: 16px 20px 12px;
        text-align: center;
        opacity: 0;
        z-index: 2147483647;
        transition: opacity 500ms ease-out, transform 500ms cubic-bezier(0.34, 1.56, 0.64, 1);
        pointer-events: none;
      }
      .verse-overlay.show {
        opacity: 1;
        transform: translate(-50%, -50%) scale(1);
      }
      /* Arabic stays on top as the primary visual anchor. Mushaf-style
         font stack — QPC fonts when installed locally, then Amiri Quran
         (loaded via @import), then Naskh Arabic system fallbacks. */
      .verse-arabic {
        font-family: "QCF_P604", "QCF_V2", "KFGQPC HAFS Uthmanic Script",
          "KFGQPC Uthman Taha Naskh", "Amiri Quran", "Scheherazade New",
          "Noto Naskh Arabic", "Traditional Arabic", "Geeza Pro", serif;
        font-size: 16px;
        line-height: 1.95;
        direction: rtl;
        margin: 0 0 10px;
        color: #ffffff;
        font-weight: 500;
      }
      /* Focal English — Inter SemiBold, tight tracking, larger than the
         continuation. This is what the visitor reads first. */
      .verse-english-main {
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-weight: 600;
        font-size: 13px;
        line-height: 1.4;
        letter-spacing: -0.012em;
        margin: 0 0 6px;
        color: #ffffff;
      }
      /* Continuation — lighter, smaller, signals "more context". */
      .verse-english-extra {
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-weight: 500;
        font-size: 11px;
        line-height: 1.45;
        letter-spacing: -0.005em;
        margin: 0 0 8px;
        color: rgba(255, 255, 255, 0.78);
      }
      .verse-reference {
        margin: 4px 0 0;
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 9px;
        font-weight: 700;
        letter-spacing: 0.18em;
        text-transform: uppercase;
        color: rgba(255, 255, 255, 0.7);
      }

      /* ─── Mini-dashboard panel ─────────────────────────────────────
         Double-clicking the badge toggles it. Click outside to close.
         Mirrors popup.html exactly: same header, totals, table, sync
         status row, and footer with "Open dashboard" + "Settings".
         Lives as a SIBLING of .badge (not inside it) so the badge's
         drag handler doesn't intercept clicks on the panel's links. */
      .panel {
        position: absolute;
        top: calc(100% + 8px);
        right: 0;
        width: 320px;
        max-height: 420px;
        overflow-y: auto;
        background: #fff;
        color: #222;
        border: 1px solid rgba(0,0,0,0.1);
        border-radius: 12px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.18);
        padding: 12px;
        font-family: system-ui, -apple-system, sans-serif;
        font-size: 13px;
        display: none;
        cursor: default;
        user-select: text;
        text-align: left;
      }
      .panel.open { display: block; }
      .panel .tabs {
        display: flex;
        gap: 4px;
        border-bottom: 1px solid #eee;
        margin: -4px -4px 8px;
        padding: 0 4px 0;
      }
      .panel .tab {
        background: none;
        border: none;
        padding: 6px 10px;
        font: inherit;
        font-size: 12px;
        font-weight: 600;
        color: #888;
        cursor: pointer;
        border-bottom: 2px solid transparent;
        margin-bottom: -1px;
      }
      .panel .tab.active { color: #209C64; border-bottom-color: #209C64; }
      .panel .tabview { display: none; }
      .panel .tabview.active { display: block; }
      .panel h1 { font-size: 13px; margin: 0 0 8px; font-weight: 600; display: flex; justify-content: space-between; align-items: baseline; }
      .panel h1 small { font-weight: normal; color: #888; }
      .panel .totals { color: #555; font-size: 12px; }
      /* To-dos section */
      .todo-add { display: flex; gap: 4px; margin-bottom: 8px; }
      .todo-add input { flex: 1; padding: 5px 7px; border: 1px solid rgba(0,0,0,0.12); border-radius: 6px; font: inherit; font-size: 12px; }
      .todo-add button { padding: 5px 9px; border: 1px solid #209C64; background: #209C64; color: #fff; border-radius: 6px; font: inherit; font-size: 12px; cursor: pointer; }
      .todo-add button:disabled { opacity: 0.4; cursor: default; }
      .todo-section { margin-bottom: 8px; }
      .todo-section .head { display: flex; justify-content: space-between; align-items: center; font-size: 10px; font-weight: 700; color: #888; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 3px; }
      .todo-section ul { list-style: none; padding: 0; margin: 0; }
      .todo-item { display: flex; align-items: flex-start; gap: 6px; padding: 4px 6px; border-radius: 6px; }
      .todo-item:hover { background: #f5f5f5; }
      .todo-item input[type="checkbox"] { margin-top: 2px; }
      .todo-item .txt { flex: 1; word-break: break-word; line-height: 1.3; }
      .todo-item.done .txt { color: #aaa; text-decoration: line-through; }
      .todo-item .meta { font-size: 10px; color: #aaa; }
      .todo-item .actions { display: flex; gap: 2px; opacity: 0; transition: opacity 0.15s; }
      .todo-item:hover .actions { opacity: 1; }
      .todo-item .actions button { background: none; border: none; padding: 0 4px; cursor: pointer; color: #888; font: inherit; font-size: 11px; }
      .todo-item .actions button:hover { color: #222; }
      .todo-item .actions .del:hover { color: #c00; }
      .todo-bucket-toggle { display: flex; gap: 2px; margin-bottom: 8px; font-size: 11px; }
      .todo-bucket-toggle button { background: #f0f0f0; border: none; padding: 4px 8px; border-radius: 4px; cursor: pointer; font: inherit; font-size: 11px; color: #666; }
      .todo-bucket-toggle button.active { background: #209C64; color: #fff; }
      .todo-empty { font-style: italic; color: #aaa; padding: 6px; font-size: 11px; }
      .todo-kind-header { font-size: 11px; font-weight: 700; color: #222; margin: 8px 0 4px; padding-bottom: 2px; border-bottom: 1px solid #eee; }
      .todo-kind-header .count { font-weight: normal; color: #888; margin-left: 4px; }
      .panel table { width: 100%; border-collapse: collapse; margin-top: 6px; }
      .panel th, .panel td { text-align: left; padding: 4px 6px; font-weight: normal; }
      .panel th { color: #888; font-size: 11px; border-bottom: 1px solid #eee; }
      .panel tr:nth-child(even) td { background: #fafafa; }
      .panel td.num { text-align: right; font-variant-numeric: tabular-nums; }
      .panel .domain { max-width: 170px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .panel .empty { color: #888; text-align: center; padding: 16px; font-style: italic; }
      .panel .sync { font-size: 11px; color: #888; margin-top: 6px; display: flex; justify-content: space-between; align-items: center; }
      .panel .sync .status-ok { color: #209C64; }
      .panel .sync .status-err { color: #b00; }
      .panel .footer { margin-top: 10px; padding-top: 8px; border-top: 1px solid #eee; display: flex; justify-content: space-between; align-items: center; }
      .panel .footer a { color: #209C64; text-decoration: none; font-size: 12px; cursor: pointer; }
      .panel .footer a:hover { text-decoration: underline; }
      .panel .footer button { background: none; border: none; color: #209C64; cursor: pointer; padding: 0; font: inherit; }
      .panel .footer button:hover { text-decoration: underline; }

      /* ─── Voice tab styles ─────────────────────────────────────── */
      .voice-status-line { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
      .voice-status-line h3 { font-size: 12px; margin: 0; font-weight: 600; }
      .voice-status { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: #888; }
      .voice-status .dot { width: 7px; height: 7px; border-radius: 50%; background: #d0d0d0; }
      .voice-status.ready .dot { background: #209C64; }
      .voice-status.pending .dot { background: #ffa500; }
      .voice-status.err .dot { background: #b00; }

      .voice-err {
        background: #fde7e7; color: #a00; border: 1px solid #f3c4c4;
        border-radius: 4px; padding: 6px 8px; font-size: 11px; margin-bottom: 8px;
        word-break: break-word;
      }
      .voice-not-configured {
        text-align: center; padding: 20px 12px; color: #888; font-size: 12px;
      }
      .voice-not-configured button {
        display: inline-block; margin-top: 8px; padding: 6px 12px;
        background: #209C64; color: #fff; border: none; border-radius: 4px;
        cursor: pointer; font: inherit; font-size: 12px;
      }

      .in-call-banner {
        background: #e6f7ee; border: 1px solid #4DDB9B; border-radius: 6px;
        padding: 8px 10px; margin-bottom: 8px;
        display: flex; justify-content: space-between; align-items: center; gap: 8px;
      }
      .in-call-banner .who { font-weight: 600; color: #12603D; font-size: 12px; }
      .in-call-banner .live {
        display: inline-block; width: 7px; height: 7px; border-radius: 50%;
        background: #209C64; margin-right: 5px;
        animation: pv-pulse 1.4s ease-in-out infinite;
      }
      @keyframes pv-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
      .in-call-banner button {
        background: #b00; color: #fff; border: none; padding: 4px 10px;
        border-radius: 4px; font: inherit; font-size: 11px; cursor: pointer;
      }
      .in-call-banner button:hover { background: #900; }

      /* Incoming call. Deliberately louder than the amber knock card —
         a knock is a request to join, this is a phone ringing right now. */
      .ring-card {
        background: #e6f7ee; border: 1px solid #7fd3ab; border-radius: 6px;
        padding: 9px 10px; margin-bottom: 6px;
        display: flex; justify-content: space-between; align-items: center; gap: 8px;
        animation: ring-card-pulse 1.4s ease-in-out infinite;
      }
      @keyframes ring-card-pulse {
        0%, 100% { box-shadow: 0 0 0 0 rgba(32, 156, 100, 0.32); }
        50%      { box-shadow: 0 0 0 5px rgba(32, 156, 100, 0); }
      }
      .ring-card .msg { font-size: 12px; color: #12603D; flex: 1; }
      .ring-card .msg .sub { display: block; font-size: 10px; color: #4a8c6d; margin-top: 1px; }
      .ring-card .btns { display: flex; gap: 4px; flex-shrink: 0; }
      .ring-card button {
        background: #209C64; color: #fff; border: none; padding: 5px 11px;
        border-radius: 4px; font: inherit; font-size: 11px; font-weight: 600; cursor: pointer;
      }
      .ring-card button:hover { background: #12603D; }
      .ring-card button.decline { background: #fff; color: #b00; border: 1px solid #f3c4c4; font-weight: 500; }
      .ring-card button.decline:hover { background: #fde7e7; }

      .knock-card {
        background: #fff8e1; border: 1px solid #f7d774; border-radius: 6px;
        padding: 8px 10px; margin-bottom: 6px;
        display: flex; justify-content: space-between; align-items: center; gap: 8px;
      }
      .knock-card .msg { font-size: 12px; color: #6b5300; flex: 1; }
      .knock-card .btns { display: flex; gap: 4px; flex-shrink: 0; }
      .knock-card button {
        background: #209C64; color: #fff; border: none; padding: 4px 10px;
        border-radius: 4px; font: inherit; font-size: 11px; cursor: pointer;
      }
      .knock-card button:hover { background: #12603D; }
      .knock-card button.reject { background: #eee; color: #333; }
      .knock-card button.reject:hover { background: #ddd; }

      .waiting-card {
        background: #f7faf8; border: 1px dashed #d5d5d5; border-radius: 6px;
        padding: 8px 10px; margin-bottom: 8px;
        display: flex; justify-content: space-between; align-items: center; gap: 8px;
        font-size: 12px; color: #666;
      }
      .waiting-card button {
        background: none; border: none; color: #888; cursor: pointer;
        font: inherit; font-size: 11px; text-decoration: underline;
      }

      .voice-section-header {
        font-size: 10px; color: #888; text-transform: uppercase; letter-spacing: 0.5px;
        font-weight: 600; margin: 8px 0 4px;
      }
      .voice-list { list-style: none; padding: 0; margin: 0; }
      .voice-list li {
        display: flex; justify-content: space-between; align-items: center;
        padding: 5px 4px; border-radius: 4px;
      }
      .voice-list li:hover { background: #f7faf8; }
      .voice-list .name { font-size: 12px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .voice-list .name .dot {
        display: inline-block; width: 7px; height: 7px; border-radius: 50%;
        background: #209C64; margin-right: 6px; vertical-align: middle;
      }
      .voice-list .name .dot.in-meeting { background: #ffa500; }
      .voice-list .name .meta { color: #888; font-size: 10px; margin-left: 5px; }
      .voice-list button {
        background: #209C64; color: #fff; border: none; padding: 3px 10px;
        border-radius: 4px; font: inherit; font-size: 11px; cursor: pointer;
        flex-shrink: 0;
      }
      .voice-list button:hover { background: #12603D; }
      .voice-list button.join { background: #fff; color: #12603D; border: 1px solid #209C64; }
      .voice-list button.join:hover { background: #e6f7ee; }
      .voice-list button:disabled { background: #ccc; cursor: not-allowed; border-color: #ccc; color: #fff; }
      .voice-empty { color: #888; font-style: italic; font-size: 11px; padding: 6px 0; }
    </style>
    <div class="badge" part="badge" title="Double-click for team + today's summary · drag to move">
      <span class="icon">⏱</span><span class="time">0:00</span>
      <span class="knock-count" id="knock-count" hidden>0</span>
      <div class="resize" title="Drag to resize"></div>
    </div>
    <div class="panel" id="panel" role="dialog" aria-label="Tab tracker today">
      <div class="tabs" role="tablist">
        <button type="button" class="tab active" data-tab="todos" role="tab">To-dos</button>
        <button type="button" class="tab" data-tab="stats" role="tab">Today's stats</button>
        <button type="button" class="tab" data-tab="voice" role="tab">Voice</button>
      </div>
      <div class="tabview active" data-view="todos">
        <div class="todo-add">
          <input id="todo-input" type="text" placeholder="Add to personal…" maxlength="500" />
          <button type="button" id="todo-add-btn">Add</button>
        </div>
        <div class="todo-bucket-toggle">
          <button type="button" data-kind="personal" class="active" id="todo-kind-personal">Personal</button>
          <button type="button" data-kind="shared" id="todo-kind-shared">Shared</button>
        </div>
        <div id="todo-list-container"></div>
      </div>
      <div class="tabview" data-view="stats">
        <h1>Today <small id="panel-date"></small></h1>
        <div class="totals" id="panel-totals"></div>
        <table id="panel-tbl">
          <thead><tr><th>Site</th><th class="num">Visits</th><th class="num">Active</th></tr></thead>
          <tbody></tbody>
        </table>
        <div class="empty" id="panel-empty" hidden>No activity tracked yet.</div>
        <div class="sync" id="panel-sync"></div>
      </div>
      <div class="tabview" data-view="voice">
        <div id="voice-not-configured" class="voice-not-configured" hidden>
          Sign in with your name to see who's online + call teammates.
          <br><button type="button" id="voice-setup">Open Settings</button>
        </div>
        <div id="voice-on-desktop" class="voice-not-configured" hidden>
          <b>Calls are handled by the Tab Tracker app.</b>
          <br>You're reachable there even with the browser closed — incoming
          calls ring on the pill. Open the app to see who's online.
        </div>
        <div id="voice-content" hidden>
          <div class="voice-status-line">
            <h3>Voice chat</h3>
            <span class="voice-status pending" id="voice-status"><span class="dot"></span><span id="voice-status-label">connecting…</span></span>
          </div>
          <div class="voice-err" id="voice-err" hidden></div>
          <div class="in-call-banner" id="in-call" hidden>
            <div class="who"><span class="live"></span>In call with <span id="in-call-names"></span></div>
            <button type="button" id="hangup">Hang up</button>
          </div>
          <div id="incoming-calls"></div>
          <div id="incoming-knocks"></div>
          <div class="waiting-card" id="outgoing-knock" hidden>
            <span id="outgoing-knock-msg"></span>
            <button type="button" id="cancel-knock">Cancel</button>
          </div>
          <div id="ongoing-meetings"></div>
          <div class="voice-section-header">Teammates online</div>
          <ul class="voice-list" id="idle-roster"></ul>
          <div class="voice-empty" id="no-teammates" hidden>Nobody else is online right now.</div>
        </div>
      </div>
      <div class="footer">
        <a id="panel-dash">Open dashboard →</a>
        <button type="button" id="panel-opts">Settings</button>
      </div>
    </div>
    <div class="verse-overlay" id="verse-overlay" aria-hidden="true">
      <p class="verse-arabic" id="verse-arabic"></p>
      <p class="verse-english-main" id="verse-english-main"></p>
      <p class="verse-english-extra" id="verse-english-extra"></p>
      <p class="verse-reference" id="verse-reference"></p>
      <!-- Husary recitation, loaded on-demand from everyayah.com CDN
           (same source quran.com streams from — free, no key, ~50KB
           per ayah). Hidden visually; we only need the audio. The src
           is set per-alert from the verse reference. preload=none so
           we don't fetch until the alert actually fires. -->
    </div>
    <div class="overuse-reminder" id="overuse-reminder" aria-hidden="true"></div>
    <div class="teammate-overlay" id="teammate-overlay" aria-hidden="true"></div>
  `;
  const badge = shadow.querySelector('.badge');
  const timeEl = shadow.querySelector('.time');
  const resizeHandle = shadow.querySelector('.resize');
  const panel = shadow.querySelector('#panel');
  const panelDate = shadow.querySelector('#panel-date');
  const panelTotals = shadow.querySelector('#panel-totals');
  const panelTbody = shadow.querySelector('#panel-tbl tbody');
  const panelEmpty = shadow.querySelector('#panel-empty');
  const panelTbl = shadow.querySelector('#panel-tbl');
  const panelSync = shadow.querySelector('#panel-sync');
  const verseOverlay = shadow.querySelector('#verse-overlay');
  const verseArabic = shadow.querySelector('#verse-arabic');
  const verseEnglishMain = shadow.querySelector('#verse-english-main');
  const verseEnglishExtra = shadow.querySelector('#verse-english-extra');
  const verseReference = shadow.querySelector('#verse-reference');

  /* Audio playback (Adhan + Husary verse) is handled by an offscreen
     document — see background.js → playAudio(). Content scripts can't
     reliably play sound on chrome.alarms-driven alerts because Chrome's
     autoplay policy requires a recent user gesture in the visitor's
     tab, which isn't present when alarms fire silently. */
  const overuseReminder = shadow.querySelector('#overuse-reminder');
  const teammateOverlay = shadow.querySelector('#teammate-overlay');

  function applyUI() {
    const w = window.innerWidth, h = window.innerHeight;
    const minY = 0, maxY = Math.max(0, h - 40);
    const clampedY = Math.max(minY, Math.min(maxY, ui.y));
    host.style.top = `${clampedY}px`;
    if (ui.x !== null) {
      const maxX = Math.max(0, w - 80);
      host.style.left = `${Math.max(0, Math.min(maxX, ui.x))}px`;
      host.style.right = 'auto';
    } else if (ui.edge === 'left') {
      host.style.left = `${ui.edgeOffset}px`;
      host.style.right = 'auto';
    } else {
      host.style.right = `${ui.edgeOffset}px`;
      host.style.left = 'auto';
    }
    badge.style.fontSize = `${BASE_FONT * ui.scale}px`;
    /* Anchor the to-do widget to the badge so dragging either one moves
       both. The widget sits just below the badge's bottom edge, aligned
       to the same horizontal position. Recompute on every applyUI so
       badge scale changes / window resizes / drags all keep them locked. */
    applyTodoLayoutToBadge();
  }

  /* Position the to-do widget right under the badge. Reads the badge's
     freshly-applied rect (force-layout via getBoundingClientRect) so the
     widget's top always reflects the live badge height + scale. Width
     and height come from todoUI (independently resizable); position
     comes from the shared `ui`.
     If the badge isn't laid out yet (rect collapsed to 0×0 — typical
     during the very first applyUI call), the widget now FALLS BACK to
     a sensible default position (top-right, 70px down) instead of
     hiding. A RAF retry sharpens the alignment once the badge has a
     real rect. This kills the "widget doesn't show on reload unless
     I manually toggle" bug. */
  function applyTodoLayoutToBadge() {
    if (!todoHost) return;
    if (todoUI.hidden) { todoHost.style.display = 'none'; return; }
    /* Always render — never hide due to layout-timing issues. */
    todoHost.style.display = 'block';
    todoHost.style.width = `${Math.max(220, todoUI.width)}px`;
    todoHost.style.height = `${Math.max(220, todoUI.height)}px`;
    todoHost.style.left = 'auto';

    const rect = host.getBoundingClientRect();
    if (rect.width < 10 || !host.isConnected) {
      /* Default placement until the badge has a real rect. */
      todoHost.style.top = '70px';
      todoHost.style.right = '16px';
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(applyTodoLayoutToBadge);
      } else {
        setTimeout(applyTodoLayoutToBadge, 50);
      }
      return;
    }
    const gap = 10;
    todoHost.style.top = `${Math.max(0, rect.bottom + gap)}px`;
    /* Align the widget's RIGHT edge to the badge's RIGHT edge so a
       skinny badge in the top-right corner has its bigger to-do widget
       hanging neatly underneath without overflowing the viewport. */
    todoHost.style.right = `${Math.max(0, window.innerWidth - rect.right)}px`;
  }

  /* Apply the gradient inline so it overrides the solid fallback in the
     <style> above. Diagonal direction matches the brand mark's typical
     light-to-dark sweep. */
  function applyColors() {
    badge.style.background = `linear-gradient(135deg, ${colors.from} 0%, ${colors.to} 100%)`;
  }

  function mount() {
    if (!host.isConnected && document.body) document.body.appendChild(host);
    /* Re-mount the to-do widget alongside the badge — same auto-recover
       logic so a page that nukes our DOM (or a load-order race) can't
       leave the widget orphaned. `todoHost` is declared further down in
       this IIFE; before that point the typeof guard returns "undefined"
       and we skip silently. By the time `tick()` runs (every 1 s), the
       widget host exists and gets re-mounted every tick. */
    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      todoHost;
    } catch {
      return; // TDZ on first synchronous mount() call — widget not declared yet
    }
    if (todoHost && !todoHost.isConnected && document.body) {
      document.body.appendChild(todoHost);
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(applyTodoLayoutToBadge);
      }
    }
  }

  async function saveUI() {
    try { await chrome.storage.local.set({ [STORAGE_KEY]: ui }); } catch {}
  }

  async function loadUI() {
    try {
      const r = await chrome.storage.local.get([STORAGE_KEY, COLOR_KEY, 'thresholdMinutes', 'notifyThresholdMinutes', 'alertDurationSeconds', 'overuseReminder', 'notifyDistractionDomains']);
      if (r[STORAGE_KEY]) ui = { ...DEFAULT_UI, ...r[STORAGE_KEY] };
      if (r[COLOR_KEY]) colors = { ...DEFAULT_COLORS, ...r[COLOR_KEY] };
      if (typeof r.thresholdMinutes === 'number' && r.thresholdMinutes > 0) {
        currentThresholdMinutes = r.thresholdMinutes;
      }
      if (typeof r.notifyThresholdMinutes === 'number' && r.notifyThresholdMinutes > 0) {
        currentNotifyThresholdMinutes = r.notifyThresholdMinutes;
      }
      if (typeof r.alertDurationSeconds === 'number' && r.alertDurationSeconds > 0) {
        currentAlertDurationSeconds = r.alertDurationSeconds;
      }
      if (typeof r.overuseReminder === 'string') {
        currentReminderText = r.overuseReminder;
      }
      if (Array.isArray(r.notifyDistractionDomains)) {
        currentDistractionDomains = r.notifyDistractionDomains;
      }
      console.log(
        `[Tab Tracker] thresholds loaded — overuse=${currentThresholdMinutes}min/site notify=${currentNotifyThresholdMinutes}min/site alertDuration=${currentAlertDurationSeconds}s reminder="${currentReminderText.slice(0, 40)}" distractionDomains=${currentDistractionDomains.length}`
      );
    } catch {}
    applyUI();
    applyColors();
  }

  /* Live-update on changes to UI, colors, OR threshold. The background
     script writes thresholdMinutes after each /api/todos sync; this
     listener keeps the open tabs' badges in sync with the admin's
     configured value without needing a tab reload. */
  chrome.storage.onChanged.addListener(changes => {
    if (changes[STORAGE_KEY] && changes[STORAGE_KEY].newValue) {
      ui = { ...DEFAULT_UI, ...changes[STORAGE_KEY].newValue };
      applyUI();
    }
    if (changes[COLOR_KEY] && changes[COLOR_KEY].newValue) {
      colors = { ...DEFAULT_COLORS, ...changes[COLOR_KEY].newValue };
      applyColors();
    }
    if (changes.thresholdMinutes && typeof changes.thresholdMinutes.newValue === 'number') {
      currentThresholdMinutes = changes.thresholdMinutes.newValue;
      console.log('[Tab Tracker] threshold updated locally:', currentThresholdMinutes, 'min');
    }
    if (changes.notifyThresholdMinutes && typeof changes.notifyThresholdMinutes.newValue === 'number') {
      currentNotifyThresholdMinutes = changes.notifyThresholdMinutes.newValue;
      console.log('[Tab Tracker] notify threshold updated locally:', currentNotifyThresholdMinutes, 'min');
    }
    if (changes.alertDurationSeconds && typeof changes.alertDurationSeconds.newValue === 'number') {
      currentAlertDurationSeconds = changes.alertDurationSeconds.newValue;
      console.log('[Tab Tracker] alert duration updated locally:', currentAlertDurationSeconds, 's');
    }
    /* Cross-tab checkpoint sync. When one tab fires (either red overuse
       OR purple teammate-notify) it writes the new boundary into its
       storage key; every other tab refreshes its in-memory checkpoint
       via this listener so it can't re-fire stale. */
    if (changes[ALERT_KEY] && changes[ALERT_KEY].newValue) {
      syncCheckpointFromStorage(changes[ALERT_KEY].newValue, overuseCheckpoint);
    }
    if (changes[NOTIFY_ALERT_KEY] && changes[NOTIFY_ALERT_KEY].newValue) {
      syncCheckpointFromStorage(changes[NOTIFY_ALERT_KEY].newValue, notifyCheckpoint);
    }
    /* Reminder text live-updates from sync — no tab reload needed. */
    if (typeof changes.overuseReminder !== 'undefined') {
      currentReminderText = typeof changes.overuseReminder.newValue === 'string'
        ? changes.overuseReminder.newValue
        : '';
    }
    /* Distraction-domain list live-updates from sync. */
    if (typeof changes.notifyDistractionDomains !== 'undefined') {
      currentDistractionDomains = Array.isArray(changes.notifyDistractionDomains.newValue)
        ? changes.notifyDistractionDomains.newValue
        : [];
    }
  });

  /* Force-fire trigger from the popup ("Fire test alert" button).
     Reuses the same animation path as the threshold breach. */
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'forceAlert') {
      if (typeof msg.durationOverrideSec === 'number' && msg.durationOverrideSec > 0) {
        triggerAlert.__overrideSec = msg.durationOverrideSec;
      }
      triggerAlert();
      sendResponse({ ok: true });
      return true;
    }
    if (msg && msg.type === 'prayerName') {
      triggerPrayerNameAlert(msg);
      sendResponse({ ok: true });
      return true;
    }
    if (msg && msg.type === 'prayerVerse') {
      triggerVerseAlert(msg);
      sendResponse({ ok: true });
      return true;
    }
    if (msg && msg.type === 'teammateAlert') {
      triggerTeammateAlert(msg);
      sendResponse({ ok: true });
      return true;
    }
    /* Back-compat: the old combined message keeps working in case any
       older background.js or test script still uses it. */
    if (msg && msg.type === 'prayerTime') {
      triggerPrayerNameAlert(msg);
      setTimeout(() => triggerVerseAlert(msg), Math.max(1500, (msg.nameSeconds || 5) * 1000 + 800));
      sendResponse({ ok: true });
      return true;
    }
  });

  let dragging = false, resizing = false, op = null;

  badge.addEventListener('pointerdown', e => {
    if (alertActive) return;
    if (e.target === resizeHandle || resizeHandle.contains(e.target)) return;
    dragging = true;
    badge.classList.add('dragging');
    badge.setPointerCapture(e.pointerId);
    const rect = host.getBoundingClientRect();
    op = { x: e.clientX, y: e.clientY, left: rect.left, top: rect.top, pointerId: e.pointerId };
    e.preventDefault();
  });

  badge.addEventListener('pointermove', e => {
    if (!dragging || !op || e.pointerId !== op.pointerId) return;
    ui.x = op.left + (e.clientX - op.x);
    ui.y = op.top + (e.clientY - op.y);
    applyUI();
  });

  badge.addEventListener('pointerup', e => {
    if (!dragging) return;
    dragging = false;
    badge.classList.remove('dragging');
    try { badge.releasePointerCapture(e.pointerId); } catch {}
    saveUI();
  });

  resizeHandle.addEventListener('pointerdown', e => {
    if (alertActive) return;
    resizing = true;
    resizeHandle.setPointerCapture(e.pointerId);
    op = { x: e.clientX, y: e.clientY, scale: ui.scale, pointerId: e.pointerId };
    e.preventDefault();
    e.stopPropagation();
  });

  resizeHandle.addEventListener('pointermove', e => {
    if (!resizing || !op || e.pointerId !== op.pointerId) return;
    const delta = ((e.clientX - op.x) + (e.clientY - op.y)) / 2;
    ui.scale = Math.max(0.7, Math.min(3.5, op.scale + delta / 80));
    applyUI();
  });

  resizeHandle.addEventListener('pointerup', e => {
    if (!resizing) return;
    resizing = false;
    try { resizeHandle.releasePointerCapture(e.pointerId); } catch {}
    saveUI();
  });

  window.addEventListener('resize', applyUI);

  loadUI();
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount, { once: true });

  /* Debug trigger — admin "Fire test alert" button sends
     `#ttAlertTest=d=10&r=Your reminder text` so the test reflects
     the just-typed duration + reminder even before the next sync. Also
     accepts the legacy `#ttAlertTest=10` shape (duration only).
     The capture group reads to end-of-fragment so '&r=...' survives —
     a `[^&]+` capture would truncate the reminder param. */
  const alertHash = location.hash.match(/ttAlertTest(?:=(.*))?$/);
  if (alertHash) {
    let overrideSec = null;
    let reminderText = '';
    if (alertHash[1]) {
      const raw = alertHash[1];
      /* New shape: d=10&r=Step away — has '=' inside. Old shape:
         just a number. */
      if (raw.includes('=')) {
        try {
          const params = new URLSearchParams(decodeURIComponent(raw));
          const d = parseInt(params.get('d') || '', 10);
          if (Number.isFinite(d) && d > 0) overrideSec = d;
          reminderText = params.get('r') || '';
        } catch {}
      } else {
        const n = parseInt(raw, 10);
        if (Number.isFinite(n) && n > 0) overrideSec = n;
      }
    }
    setTimeout(() => {
      console.log(`[Tab Tracker] debug trigger fired via #ttAlertTest (override=${overrideSec ?? 'none'}s, reminder="${reminderText.slice(0, 40)}")`);
      if (overrideSec && overrideSec > 0) {
        triggerAlert.__overrideSec = overrideSec;
      }
      triggerAlert({ domain: 'test.example.com', reminderText });
    }, 800);
  }

  /* `#ttPrayerTest` or `#ttPrayerTest=nameSec,gapSec,verseSec`
     fires the full prayer-alert sequence with the supplied durations
     (default 5,3,10 if missing). The admin Salah panel encodes the
     latest saved settings into the URL so the test reflects current
     admin state even before sync runs. */
  const prayerHash = location.hash.match(/ttPrayerTest(?:=(\d+),(\d+),(\d+))?/);
  if (prayerHash) {
    const nameSec = prayerHash[1] ? parseInt(prayerHash[1], 10) : 5;
    const gapSec = prayerHash[2] ? parseInt(prayerHash[2], 10) : 3;
    const verseSec = prayerHash[3] ? parseInt(prayerHash[3], 10) : 10;
    setTimeout(async () => {
      console.log(`[Tab Tracker] debug trigger fired via #ttPrayerTest (name=${nameSec}s gap=${gapSec}s verse=${verseSec}s)`);
      /* The test path doesn't go through background.dispatchPrayerNameAlert
         (which is where the offscreen audio normally fires), so we must
         explicitly ask background to play the Adhan + verse audio here.
         Reads salahAlert.adhanUrl from chrome.storage for the Adhan and
         derives the Husary URL from the verse reference. */
      let adhanUrl = '';
      try {
        const r = await chrome.storage.local.get('salahAlert');
        if (r.salahAlert && typeof r.salahAlert.adhanUrl === 'string') {
          adhanUrl = r.salahAlert.adhanUrl.trim();
        }
      } catch {}
      let verse = null;
      try {
        const r = await chrome.storage.local.get('salahVerse');
        verse = r.salahVerse || null;
      } catch {}
      if (!verse) {
        verse = {
          arabic: 'رِجَالٌ لَّا تُلْهِيهِمْ تِجَارَةٌ وَلَا بَيْعٌ عَن ذِكْرِ ٱللَّهِ وَإِقَامِ ٱلصَّلَوٰةِ',
          englishMain: "men who are not distracted either by buying or selling from Allah's remembrance, or performing prayer",
          englishExtra: '',
          reference: 'Quran 24:37',
        };
      }
      /* Fire the Adhan via background's offscreen-audio dispatcher. */
      if (adhanUrl) {
        try { chrome.runtime.sendMessage({ type: 'playAudio', url: adhanUrl }).catch(() => {}); } catch {}
      }
      triggerPrayerNameAlert({ prayer: 'Dhuhr', nameSeconds: nameSec });
      setTimeout(() => {
        /* Schedule the Husary recitation when the verse alert fires. */
        if (verse && verse.reference) {
          const m = String(verse.reference).match(/(\d{1,3})\s*:\s*(\d{1,3})/);
          if (m) {
            const s = String(parseInt(m[1], 10)).padStart(3, '0');
            const a = String(parseInt(m[2], 10)).padStart(3, '0');
            const husaryUrl = `https://everyayah.com/data/Husary_128kbps/${s}${a}.mp3`;
            try { chrome.runtime.sendMessage({ type: 'playAudio', url: husaryUrl }).catch(() => {}); } catch {}
          }
        }
        triggerVerseAlert({ verseSeconds: verseSec, verse });
      }, nameSec * 1000 + gapSec * 1000);
    }, 800);
  }


  async function tick() {
    if (document.visibilityState !== 'visible') return;
    /* While an alert (overuse OR prayer) is showing, don't push the
       live time back into the badge — that would clobber the "Dhuhr"
       text mid-animation. Tick resumes when the cleanup function flips
       alertActive back to false. */
    if (alertActive) return;
    try {
      const res = await chrome.runtime.sendMessage({ type: 'getTabTime' });
      if (!res) return;
      const text = fmt(res.ms);
      if (timeEl.textContent !== text) timeEl.textContent = text;
      mount();
    } catch {}
  }

  /* Cross-tab checkpoint loader — used both for the in-place 'day
     rolled over' refresh inside checkDomainBoundary and the
     storage.onChanged listener that mirrors writes across tabs. */
  function syncCheckpointFromStorage(stored, checkpoint) {
    const dayKey = panelTodayKey();
    const today = stored && stored[dayKey];
    if (today && typeof today === 'object' && !Array.isArray(today)) {
      checkpoint.perDomain = {};
      for (const [k, v] of Object.entries(today)) {
        if (typeof v === 'number' && k.includes('.')) checkpoint.perDomain[k] = v;
      }
      checkpoint.dayKey = dayKey;
    }
  }

  /* Per-day, per-domain boundary tracker. Each domain has its own
     checkpoint — a 30-min threshold rings independently for
     youtube.com (at 30/60/90 min on YouTube), instagram.com, and so on.
     The visible-tab gate keeps every tab in every window from firing
     simultaneously when the boundary crosses. Only the first domain to
     cross fires per tick; if two cross at once the next tick catches
     the other. Shared by the red overuse alert and the purple
     teammate-notify — same boundary math, different threshold, key,
     filter, and on-fire callback. */
  async function checkDomainBoundary({ thresholdMinutes, checkpointKey, checkpoint, domainFilter, onFire, label }) {
    if (document.visibilityState !== 'visible') return;
    try {
      const r = await chrome.storage.local.get('overuseEnabled');
      if (r.overuseEnabled === false) return;
    } catch {}

    const dayKey = panelTodayKey();
    if (checkpoint.dayKey !== dayKey) {
      checkpoint.dayKey = dayKey;
      checkpoint.perDomain = {};
      try {
        const r = await chrome.storage.local.get(checkpointKey);
        syncCheckpointFromStorage(r[checkpointKey], checkpoint);
      } catch {}
    }

    try {
      const r = await chrome.storage.local.get('stats');
      const today = (r.stats && r.stats[dayKey]) || {};
      const thresholdMs = Math.max(1, thresholdMinutes) * 60 * 1000;

      let firedDomain = null;
      let firedBoundary = 0;
      for (const domain in today) {
        if (!domainFilter(domain)) continue;
        const ms = (today[domain] && today[domain].activeMs) || 0;
        const boundary = Math.floor(ms / thresholdMs) * thresholdMs;
        if (boundary === 0) continue;
        const last = checkpoint.perDomain[domain] || 0;
        if (boundary > last) {
          firedDomain = domain;
          firedBoundary = boundary;
          break;
        }
      }
      if (!firedDomain) return;

      console.log(
        `[Tab Tracker] ${label}: ${firedDomain} crossed ${Math.round(firedBoundary / 60000)} min`,
        `(threshold ${thresholdMinutes} min)`
      );
      checkpoint.perDomain[firedDomain] = firedBoundary;
      try {
        const r2 = await chrome.storage.local.get(checkpointKey);
        const all = r2[checkpointKey] || {};
        all[dayKey] = { ...checkpoint.perDomain };
        await chrome.storage.local.set({ [checkpointKey]: all });
      } catch {}
      onFire({
        domain: firedDomain,
        boundary: firedBoundary,
        minutes: Math.round(firedBoundary / 60000),
      });
    } catch {}
  }

  async function checkOveruseAlert() {
    if (alertActive) return;
    await checkDomainBoundary({
      thresholdMinutes: currentThresholdMinutes,
      checkpointKey: ALERT_KEY,
      checkpoint: overuseCheckpoint,
      domainFilter: () => true,
      label: 'alert',
      onFire: ({ domain }) => triggerAlert({ domain, reminderText: currentReminderText }),
    });
  }

  /* Teammate-notify fan-out. Runs independently of the per-site overuse
     alert at its own threshold. Server enqueues teammate payloads + a
     self heads-up; the recipients' tabs pull on their /api/todos poll. */
  async function checkNotifyAlert() {
    if (!Array.isArray(currentDistractionDomains) || currentDistractionDomains.length === 0) return;
    await checkDomainBoundary({
      thresholdMinutes: currentNotifyThresholdMinutes,
      checkpointKey: NOTIFY_ALERT_KEY,
      checkpoint: notifyCheckpoint,
      domainFilter: (domain) => currentDistractionDomains.some(
        (d) => domain === d || domain.endsWith('.' + d)
      ),
      label: 'notify',
      onFire: ({ domain, minutes }) => {
        try {
          chrome.runtime.sendMessage({ type: 'notifyTeammates', domain, minutes }).catch(() => {});
        } catch {}
      },
    });
  }

  /* `currentDismissAlert` holds whichever alert is currently active so
     a global keydown/click can run its cleanup immediately. Set by
     each triggerXxx function and cleared on cleanup. */
  let currentDismissAlert = null;
  /* Earliest moment the active alert can be dismissed by user input.
     For prayer alerts we hold this at Date.now() + 5 s so a stray
     keystroke can't accidentally close the prayer name / verse before
     the visitor has had a chance to read it. Other alerts (overuse,
     teammate-notify) set this to 0 → dismissable immediately. */
  let currentDismissibleAt = 0;
  const PRAYER_DISMISS_GRACE_MS = 5000;

  /* Slide the host to viewport center via a transform delta (clean
     reversal — original CSS position is untouched), enlarge, repaint
     red via the .alert-active class, hold for the configured seconds,
     then return home in one synchronous transition. Drag/resize are
     blocked while the alert is active so the visitor can't yank it
     around mid-pulse. Visitor can dismiss early by pressing any key or
     clicking anywhere. */
  function triggerAlert(opts) {
    if (alertActive) return;
    alertActive = true;
    currentDismissibleAt = 0; // overuse → dismissable immediately
    opts = opts || {};

    const hostRect = host.getBoundingClientRect();
    const dx = window.innerWidth / 2 - (hostRect.left + hostRect.width / 2);
    const dy = window.innerHeight / 2 - (hostRect.top + hostRect.height / 2);

    /* `all: initial` on the host wiped transition defaults, so set
       both transition + transform explicitly here. */
    host.style.transition = `transform ${ALERT_TRANSITION_MS}ms cubic-bezier(0.34, 1.56, 0.64, 1)`;
    host.style.transform = `translate(${dx}px, ${dy}px) scale(2.5)`;
    badge.classList.add('alert-active');

    /* Badge shows just the domain — the cumulative minutes used to be
       appended ("youtube.com 15m") but testers misread that as the
       threshold. */
    const originalTime = timeEl.textContent;
    if (opts.domain) {
      const shortDom = opts.domain.length > 22 ? opts.domain.slice(0, 20) + '…' : opts.domain;
      timeEl.textContent = shortDom;
    }

    /* Reminder card slides in below the badge if either the caller
       supplied text (test trigger) or the admin set one (live sync). */
    const reminderText = (opts.reminderText || currentReminderText || '').trim();
    if (overuseReminder && reminderText) {
      overuseReminder.textContent = reminderText;
      setTimeout(() => overuseReminder.classList.add('show'), 250);
    }

    /* Override duration when the caller passes one (used by the admin
       test URL so saved-but-not-yet-synced values are honoured right
       away instead of waiting for the next 1-min sync). */
    const durSec = (typeof triggerAlert.__overrideSec === 'number' && triggerAlert.__overrideSec > 0)
      ? triggerAlert.__overrideSec
      : currentAlertDurationSeconds;
    triggerAlert.__overrideSec = undefined;
    const animationMs = Math.max(500, durSec * 1000);
    console.log(`[Tab Tracker] alert firing for ${durSec}s`);

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(t1);
      host.style.transform = '';
      badge.classList.remove('alert-active');
      timeEl.textContent = originalTime;
      if (overuseReminder) overuseReminder.classList.remove('show');
      setTimeout(() => {
        host.style.transition = '';
        alertActive = false;
        currentDismissAlert = null;
      }, ALERT_TRANSITION_MS + 50);
    };
    const t1 = setTimeout(cleanup, animationMs);
    currentDismissAlert = cleanup;
  }

  /* Teammate-notify overlay. Two payload kinds: 'teammate' (you're a
     recipient — render the admin's template with {name}/{site}/{minutes}
     substituted) and 'self' (you're the offender — render the fixed
     heads-up). Same scale-to-center motion as the other alerts, but the
     badge isn't repainted; only the purple overlay slides in. Held a
     bit longer than the overuse alert so the message is readable. */
  const DEFAULT_TEAM_TEMPLATE = "{name} is not moving y'all forward — {minutes} min on {site} today.";
  const SELF_HEADS_UP_TEMPLATE = "Heads up — your teammates just saw you on {site} ({minutes} min today).";

  function renderTemplate(tpl, { name, site, minutes }) {
    return String(tpl)
      .replace(/\{name\}/g, name || '')
      .replace(/\{site\}/g, site || '')
      .replace(/\{minutes\}/g, String(minutes ?? ''));
  }

  function triggerTeammateAlert(msg) {
    if (alertActive) return;
    if (document.visibilityState !== 'visible') return;
    if (!teammateOverlay) return;
    alertActive = true;
    currentDismissibleAt = 0; // teammate-notify → dismissable immediately

    const kind = msg && msg.kind === 'self' ? 'self' : 'teammate';
    const senderName = (msg && msg.senderName) || '';
    const domain = (msg && msg.domain) || '';
    const minutes = (msg && typeof msg.minutes === 'number') ? msg.minutes : 0;
    const template = kind === 'self'
      ? SELF_HEADS_UP_TEMPLATE
      : ((msg && msg.template) || DEFAULT_TEAM_TEMPLATE);
    teammateOverlay.textContent = renderTemplate(template, { name: senderName, site: domain, minutes });

    const hostRect = host.getBoundingClientRect();
    const dx = window.innerWidth / 2 - (hostRect.left + hostRect.width / 2);
    const dy = window.innerHeight / 2 - (hostRect.top + hostRect.height / 2);
    host.style.transition = `transform ${ALERT_TRANSITION_MS}ms cubic-bezier(0.34, 1.56, 0.64, 1)`;
    host.style.transform = `translate(${dx}px, ${dy}px) scale(1.6)`;

    const showT = setTimeout(() => teammateOverlay.classList.add('show'), 200);
    const durSec = Math.max(3, currentAlertDurationSeconds + 2);
    const animationMs = durSec * 1000;
    console.log(`[Tab Tracker] teammate alert (${kind}) firing for ${durSec}s: ${teammateOverlay.textContent.slice(0, 80)}`);

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(showT);
      clearTimeout(t1);
      teammateOverlay.classList.remove('show');
      host.style.transform = '';
      setTimeout(() => {
        host.style.transition = '';
        alertActive = false;
        currentDismissAlert = null;
      }, ALERT_TRANSITION_MS + 50);
    };
    const t1 = setTimeout(cleanup, animationMs);
    currentDismissAlert = cleanup;
  }

  /* First prayer notification: badge slides to center, scales up,
   * repaints emerald, swaps the time text for the prayer name, holds
   * for `nameSeconds`, then returns to normal. Audio (Adhan) plays
   * via the offscreen document — see background.js. */
  function triggerPrayerNameAlert(msg) {
    console.log('[Tab Tracker] triggerPrayerNameAlert called:', { prayer: msg && msg.prayer, nameSeconds: msg && msg.nameSeconds, alertActive });
    if (alertActive) {
      console.log('[Tab Tracker] prayer-name SKIPPED — alertActive is already true');
      return;
    }
    alertActive = true;
    currentDismissibleAt = Date.now() + PRAYER_DISMISS_GRACE_MS;
    const prayerName = (msg && msg.prayer) || 'Prayer';
    const nameSec = Math.max(1, msg && typeof msg.nameSeconds === 'number' ? msg.nameSeconds : 5);

    const originalTime = timeEl.textContent;
    timeEl.textContent = prayerName;

    const hostRect = host.getBoundingClientRect();
    const dx = window.innerWidth / 2 - (hostRect.left + hostRect.width / 2);
    const dy = window.innerHeight / 2 - (hostRect.top + hostRect.height / 2);
    host.style.transition = `transform ${ALERT_TRANSITION_MS}ms cubic-bezier(0.34, 1.56, 0.64, 1)`;
    host.style.transform = `translate(${dx}px, ${dy}px) scale(2.5)`;
    badge.classList.add('prayer-active');

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(t1);
      host.style.transform = '';
      badge.classList.remove('prayer-active');
      timeEl.textContent = originalTime;
      /* Tell background.js to stop the Adhan when the visual alert
         ends, so the audio doesn't outlive the popup. */
      try { chrome.runtime.sendMessage({ type: 'stopAudio' }).catch(() => {}); } catch {}
      setTimeout(() => {
        host.style.transition = '';
        alertActive = false;
        currentDismissAlert = null;
      }, ALERT_TRANSITION_MS + 50);
    };
    const t1 = setTimeout(cleanup, nameSec * 1000);
    currentDismissAlert = cleanup;
  }

  /* Follow-up verse notification: badge slides to center again (without
   * the prayer name text), the verse overlay fades in below with Arabic
   * + English translation + Surah:Ayah reference, holds for
   * `verseSeconds`, then everything returns to normal. Fires as a
   * SEPARATE alert from the prayer-name one — driven by a `verse:<name>`
   * chrome.alarm scheduled `verseDelayMinutes` after the prayer time. */
  function triggerVerseAlert(msg) {
    console.log('[Tab Tracker] triggerVerseAlert called:', { verseSeconds: msg && msg.verseSeconds, ref: msg && msg.verse && msg.verse.reference, alertActive });
    if (alertActive) {
      console.log('[Tab Tracker] prayer-verse SKIPPED — alertActive is already true');
      return;
    }
    alertActive = true;
    currentDismissibleAt = Date.now() + PRAYER_DISMISS_GRACE_MS;
    const verseSec = Math.max(1, msg && typeof msg.verseSeconds === 'number' ? msg.verseSeconds : 10);
    const verse = (msg && msg.verse) || null;

    if (verse && verseArabic && verseEnglishMain && verseEnglishExtra && verseReference) {
      verseArabic.textContent = verse.arabic || '';
      /* Back-compat: older salah responses ship a single `english` field
         without the focal split. Fall back to putting all of it in the
         main slot so old data still renders something sensible. */
      const main = verse.englishMain || verse.english || '';
      const extra = verse.englishExtra || '';
      verseEnglishMain.textContent = main;
      verseEnglishExtra.textContent = extra;
      verseEnglishExtra.style.display = extra ? '' : 'none';
      verseReference.textContent = verse.reference || '';
    }

    const hostRect = host.getBoundingClientRect();
    const dx = window.innerWidth / 2 - (hostRect.left + hostRect.width / 2);
    const dy = window.innerHeight / 2 - (hostRect.top + hostRect.height / 2);
    host.style.transition = `transform ${ALERT_TRANSITION_MS}ms cubic-bezier(0.34, 1.56, 0.64, 1)`;
    host.style.transform = `translate(${dx}px, ${dy}px) scale(2.5)`;
    badge.classList.add('prayer-active');

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(t1);
      clearTimeout(t2);
      if (verseOverlay) verseOverlay.classList.remove('show');
      /* Tell background.js to stop the Husary recitation so the audio
         doesn't outlive the visual. */
      try { chrome.runtime.sendMessage({ type: 'stopAudio' }).catch(() => {}); } catch {}
      host.style.transform = '';
      badge.classList.remove('prayer-active');
      setTimeout(() => {
        host.style.transition = '';
        alertActive = false;
        currentDismissAlert = null;
      }, ALERT_TRANSITION_MS + 50);
    };
    /* Stagger the verse overlay slightly after the badge starts moving
       so it feels like the verse "arrives with" the badge instead of
       popping in early. */
    const t1 = setTimeout(() => {
      if (verseOverlay) verseOverlay.classList.add('show');
    }, 250);
    /* Hold for verseSeconds — the offscreen audio plays in parallel
       and will outlive the visual if needed (caller decides whether
       to keep audio running by NOT firing stopAudio, but our cleanup
       does stop it). Admin can bump verseSeconds via /tab-tracker if
       they want the visual to linger as long as the recitation. */
    const t2 = setTimeout(cleanup, verseSec * 1000);
    currentDismissAlert = cleanup;
  }

  /* Global tap-to-dismiss — pressing any key or clicking anywhere on
     the page immediately cancels whatever alert is currently showing
     and returns the badge home. Each trigger function sets
     `currentDismissAlert` to its cleanup function; this listener just
     runs it if it exists. */
  function dismissActiveAlert() {
    if (!alertActive || !currentDismissAlert) return;
    if (Date.now() < currentDismissibleAt) return; // grace window — prayer alerts
    console.log('[Tab Tracker] alert dismissed by user input');
    const fn = currentDismissAlert;
    currentDismissAlert = null;
    fn();
  }
  document.addEventListener('keydown', dismissActiveAlert, true);
  document.addEventListener('click', dismissActiveAlert, true);

  /* Pull-based alert delivery. Background queues prayer name, prayer
     verse, teammate-notify, and self heads-ups into chrome.storage; each
     visible http(s) tab pulls one at a time on its 5-tick cadence when
     it's free to render. Fixes both the chrome:// / newtab drop and the
     batch alertActive loss in one place. The dispatcher routes by
     `kind` to the right trigger function. */
  async function pullAndRenderAlert() {
    if (alertActive) return;
    if (document.visibilityState !== 'visible') return;
    try {
      const res = await chrome.runtime.sendMessage({ type: 'pullTeammateAlert' });
      const a = res && res.alert;
      if (!a) return;
      console.log('[Tab Tracker] pulled alert from queue:', a.kind, a.prayer || '');
      if (a.kind === 'prayer-name') triggerPrayerNameAlert(a);
      else if (a.kind === 'prayer-verse') triggerVerseAlert(a);
      else triggerTeammateAlert(a);
    } catch (e) {
      console.log('[Tab Tracker] pullAndRenderAlert failed:', e && e.message);
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      tick();
      checkOveruseAlert();
      checkNotifyAlert();
      pullAndRenderAlert();
    }
  });

  /* Tick the timer every second; check the per-site thresholds and pull
     any pending teammate alert every 5 ticks so we don't hammer
     chrome.storage. */
  let tickCount = 0;
  setInterval(() => {
    tickCount++;
    tick();
    if (tickCount % 5 === 0) {
      checkOveruseAlert();
      checkNotifyAlert();
      pullAndRenderAlert();
    }
  }, 1000);
  tick();
  checkOveruseAlert();
  checkNotifyAlert();
  pullAndRenderAlert();

  /* ─── Mini-dashboard panel ─────────────────────────────────────────
     Double-click the badge to open. Click outside (or dblclick again) to
     close. Mirrors popup.html exactly: header + totals + table + sync
     row + footer with "Open dashboard" + "Settings".

     Implementation notes:
       - Panel is a SIBLING of .badge in the shadow DOM, not a child.
         Keeps the badge's pointerdown drag handler from intercepting
         clicks on the panel's link/button.
       - Panel's own pointer events also stopPropagation as a belt-and-
         suspenders measure (so even if positioning changes later, drag
         won't suddenly start hijacking clicks).
       - Click-outside detection uses composedPath() to peek through the
         shadow root — a click anywhere on the host page closes the panel. */

  function panelTodayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function panelFmtTime(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }
  function panelFmtRel(ts) {
    if (!ts) return 'never';
    const secs = Math.round((Date.now() - ts) / 1000);
    if (secs < 60) return `${secs}s ago`;
    const mins = Math.round(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 48) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  }

  async function renderPanel() {
    const key = panelTodayKey();
    panelDate.textContent = key;

    /* Today's stats table + totals — same shape as popup.js. */
    const r = await chrome.storage.local.get(['stats', 'syncConfig', 'lastSyncAt', 'lastSyncStatus']);
    const today = (r.stats && r.stats[key]) || {};
    const rows = Object.entries(today)
      .map(([domain, v]) => ({ domain, opens: v.opens, activeMs: v.activeMs }))
      .sort((a, b) => b.activeMs - a.activeMs);

    panelTbody.innerHTML = '';
    if (rows.length === 0) {
      panelTbl.hidden = true;
      panelEmpty.hidden = false;
      panelTotals.textContent = '';
    } else {
      panelTbl.hidden = false;
      panelEmpty.hidden = true;
      for (const r of rows.slice(0, 12)) {
        const tr = document.createElement('tr');
        const dom = document.createElement('td');
        dom.className = 'domain';
        dom.title = r.domain;
        dom.textContent = r.domain;
        const visits = document.createElement('td');
        visits.className = 'num';
        visits.textContent = r.opens;
        const active = document.createElement('td');
        active.className = 'num';
        active.textContent = panelFmtTime(r.activeMs);
        tr.append(dom, visits, active);
        panelTbody.appendChild(tr);
      }
      const totalMs = rows.reduce((a, r) => a + r.activeMs, 0);
      const totalOpens = rows.reduce((a, r) => a + r.opens, 0);
      panelTotals.textContent = `${rows.length} sites · ${totalOpens} visits · ${panelFmtTime(totalMs)} active`;
    }

    /* Sync status row — same logic as popup.js. */
    const cfg = r.syncConfig;
    if (!cfg || !cfg.adminUrl || !cfg.token || !cfg.userId) {
      panelSync.innerHTML = '<span>Sync: not configured</span>';
    } else {
      const cls = r.lastSyncStatus && r.lastSyncStatus !== 'ok' ? 'status-err' : 'status-ok';
      const detail = r.lastSyncStatus && r.lastSyncStatus !== 'ok' ? ` (${r.lastSyncStatus})` : '';
      panelSync.innerHTML = `<span class="${cls}">Last sync: ${panelFmtRel(r.lastSyncAt)}${detail}</span>`;
    }
  }

  /* ─── To-dos panel section ────────────────────────────────────────
   * Both buckets (personal + shared) come from chrome.storage.local,
   * which the background script populates from /api/todos. Mutations
   * round-trip through the background so we don't duplicate the
   * sync logic here. Bucket toggle (Personal/Shared) is purely local. */
  let currentTodoKind = 'personal';
  const todoInput = shadow.querySelector('#todo-input');
  const todoAddBtn = shadow.querySelector('#todo-add-btn');
  const todoListContainer = shadow.querySelector('#todo-list-container');
  const todoKindPersonalBtn = shadow.querySelector('#todo-kind-personal');
  const todoKindSharedBtn = shadow.querySelector('#todo-kind-shared');

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  async function renderTodos() {
    const key = currentTodoKind === 'shared' ? 'todos.shared' : 'todos.personal';
    const r = await chrome.storage.local.get(key);
    const items = Array.isArray(r[key]) ? r[key] : [];
    const today = items.filter(t => t.bucket === 'today' && !t.completed)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const later = items.filter(t => t.bucket === 'later' && !t.completed)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const done = items.filter(t => t.completed)
      .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''));

    function row(t) {
      const klass = t.completed ? 'todo-item done' : 'todo-item';
      const meta = t.createdByName
        ? `<div class="meta">by ${escapeHtml(t.createdByName)}</div>`
        : '';
      return `
        <li class="${klass}" data-id="${escapeHtml(t.id)}">
          <input type="checkbox" data-action="toggle" ${t.completed ? 'checked' : ''} />
          <div class="txt">
            ${escapeHtml(t.text)}
            ${meta}
          </div>
          <div class="actions">
            ${!t.completed ? `<button data-action="up" title="Up">↑</button>` : ''}
            ${!t.completed ? `<button data-action="down" title="Down">↓</button>` : ''}
            ${!t.completed ? `<button data-action="bucket" title="Move to ${t.bucket === 'today' ? 'later' : 'today'}">${t.bucket === 'today' ? '→' : '←'}</button>` : ''}
            <button data-action="delete" class="del" title="Delete">✕</button>
          </div>
        </li>
      `;
    }

    let html = '';
    if (today.length === 0 && later.length === 0 && done.length === 0) {
      html = '<div class="todo-empty">No to-dos yet. Add one above, or use the right-click menu / keyboard shortcut.</div>';
    } else {
      if (today.length > 0) {
        html += `<div class="todo-section"><div class="head">Today<span>${today.length}</span></div><ul>${today.map(row).join('')}</ul></div>`;
      }
      if (later.length > 0) {
        html += `<div class="todo-section"><div class="head">Later<span>${later.length}</span></div><ul>${later.map(row).join('')}</ul></div>`;
      }
      if (done.length > 0) {
        html += `<div class="todo-section" style="opacity:0.65"><div class="head">Done<span>${done.length}</span></div><ul>${done.slice(0, 4).map(row).join('')}</ul></div>`;
      }
    }
    todoListContainer.innerHTML = html;
  }

  todoKindPersonalBtn.addEventListener('click', () => {
    currentTodoKind = 'personal';
    todoKindPersonalBtn.classList.add('active');
    todoKindSharedBtn.classList.remove('active');
    todoInput.placeholder = 'Add to personal…';
    renderTodos();
  });
  todoKindSharedBtn.addEventListener('click', () => {
    currentTodoKind = 'shared';
    todoKindSharedBtn.classList.add('active');
    todoKindPersonalBtn.classList.remove('active');
    todoInput.placeholder = 'Add to shared…';
    renderTodos();
  });

  async function submitTodoAdd() {
    const text = todoInput.value.trim();
    if (!text) return;
    todoInput.value = '';
    try {
      await chrome.runtime.sendMessage({ type: 'addTodo', kind: currentTodoKind, text });
      renderTodos();
    } catch {}
  }
  todoAddBtn.addEventListener('click', submitTodoAdd);
  todoInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); submitTodoAdd(); }
  });

  todoListContainer.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const li = btn.closest('[data-id]');
    if (!li) return;
    const id = li.dataset.id;
    const action = btn.dataset.action;
    const key = currentTodoKind === 'shared' ? 'todos.shared' : 'todos.personal';
    const r = await chrome.storage.local.get(key);
    const items = Array.isArray(r[key]) ? r[key] : [];
    const todo = items.find(t => t.id === id);
    if (!todo) return;

    if (action === 'toggle') {
      const next = { ...todo, completed: !todo.completed, completedAt: todo.completed ? undefined : new Date().toISOString() };
      await chrome.runtime.sendMessage({ type: 'patchTodo', kind: currentTodoKind, todo: next });
      renderTodos();
      return;
    }
    if (action === 'delete') {
      await chrome.runtime.sendMessage({ type: 'deleteTodo', kind: currentTodoKind, id });
      renderTodos();
      return;
    }
    if (action === 'bucket') {
      const next = { ...todo, bucket: todo.bucket === 'today' ? 'later' : 'today' };
      await chrome.runtime.sendMessage({ type: 'patchTodo', kind: currentTodoKind, todo: next });
      renderTodos();
      return;
    }
    if (action === 'up' || action === 'down') {
      const same = items.filter(t => t.bucket === todo.bucket && !t.completed)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      const idx = same.findIndex(t => t.id === id);
      const swapIdx = idx + (action === 'up' ? -1 : 1);
      if (idx < 0 || swapIdx < 0 || swapIdx >= same.length) return;
      const other = same[swapIdx];
      const a = { ...todo, order: other.order };
      const b = { ...other, order: todo.order };
      await chrome.runtime.sendMessage({ type: 'patchTodo', kind: currentTodoKind, todo: a });
      await chrome.runtime.sendMessage({ type: 'patchTodo', kind: currentTodoKind, todo: b });
      renderTodos();
      return;
    }
  });

  /* Re-render whenever the background's sync writes a fresh list. */
  chrome.storage.onChanged.addListener(changes => {
    if (changes['todos.personal'] || changes['todos.shared']) {
      if (panel.classList.contains('open')) renderTodos();
    }
  });

  /* Tab switching between To-dos, Today's stats, and Voice. */
  shadow.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const which = tab.dataset.tab;
      shadow.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
      shadow.querySelectorAll('.tabview').forEach(v => v.classList.toggle('active', v.dataset.view === which));
      if (which === 'todos') renderTodos();
      if (which === 'voice') {
        /* Poke background so roster refreshes NOW instead of waiting up
           to 6s for the next alarm tick — makes tab-switch feel live. */
        chrome.runtime.sendMessage({ type: 'voice.pokeRoster' }).catch(() => {});
        loadVoiceState().then(renderVoice);
      }
    });
  });

  function openPanel() {
    renderPanel();
    renderTodos();
    panel.classList.add('open');
  }
  function closePanel() {
    panel.classList.remove('open');
  }

  badge.addEventListener('dblclick', (e) => {
    if (e.target === resizeHandle || resizeHandle.contains(e.target)) return;
    if (panel.classList.contains('open')) closePanel();
    else openPanel();
  });

  /* Click outside (anywhere in the host page that isn't the badge or
     the panel itself) closes the panel. composedPath lets us see what
     the click hit including elements inside our shadow root. */
  document.addEventListener('pointerdown', (e) => {
    if (!panel.classList.contains('open')) return;
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    if (path.includes(host)) return; // click on our own host (badge or panel)
    closePanel();
  }, true);

  /* Stop panel pointer events from bubbling to the badge — guarantees
     the link + button stay clickable even if layout changes later. */
  panel.addEventListener('pointerdown', (e) => e.stopPropagation());

  /* Refresh while open so data doesn't go stale. */
  setInterval(() => {
    if (panel.classList.contains('open')) renderPanel();
  }, 5000);

  /* Footer actions — both route through the background script because
     content scripts can't open tabs / options pages directly. */
  shadow.querySelector('#panel-dash').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    chrome.runtime.sendMessage({ type: 'openDashboard' }).catch(() => {});
    closePanel();
  });
  shadow.querySelector('#panel-opts').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    chrome.runtime.sendMessage({ type: 'openOptions' }).catch(() => {});
    closePanel();
  });

  /* ═══════════ Floating to-do widget ═══════════════════════════════
   * Second floating element (separate from the timer badge). Always
   * visible (unless the user hides it via the X button), draggable,
   * resizable, shadow-DOM isolated. Mirrors the badge's affordances so
   * the visitor can manage both spatially the same way.
   *
   * Simpler add/view than the tabbed admin: one combined stream of
   * Today + Later items, each tagged with a "P"/"S" pill indicating
   * Personal vs Shared. One input + one kind toggle handles add for
   * both buckets — no tab-switching required.
   *
   * Hide is sticky (persists in chrome.storage.local). To bring the
   * widget back, the user toggles "Show to-do widget" in the popup. */

  const DEFAULT_TODO_UI = {
    x: null, y: 70, edge: 'right', edgeOffset: 16,
    width: 300, height: 380, hidden: false,
  };
  let todoUI = { ...DEFAULT_TODO_UI };
  let widgetAddKind = 'personal';

  const todoHost = document.createElement('div');
  todoHost.id = '__tab_tracker_todo_widget_host__';
  todoHost.style.cssText = 'all: initial; position: fixed; z-index: 2147483646; pointer-events: auto;';
  const todoShadow = todoHost.attachShadow({ mode: 'closed' });
  todoShadow.innerHTML = `
    <style>
      .widget {
        font-family: system-ui, -apple-system, sans-serif;
        background: #ffffff;
        color: #1a1a1a;
        border: 1px solid rgba(0,0,0,0.08);
        border-radius: 14px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.18), 0 2px 6px rgba(0,0,0,0.06);
        display: flex;
        flex-direction: column;
        width: 100%;
        height: 100%;
        overflow: hidden;
      }
      .head {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 10px;
        background: linear-gradient(135deg, #4DDB9B 0%, #12603D 100%);
        color: #fff;
        cursor: grab;
        user-select: none;
        font-size: 12px;
        font-weight: 600;
        letter-spacing: 0.2px;
      }
      .head.dragging { cursor: grabbing; opacity: 0.95; }
      .head .title { flex: 1; }
      .head .count {
        font-size: 10px;
        opacity: 0.85;
        background: rgba(255,255,255,0.18);
        padding: 1px 6px;
        border-radius: 999px;
        font-weight: 600;
      }
      .head button {
        background: rgba(255,255,255,0.15);
        border: none;
        color: #fff;
        width: 22px;
        height: 22px;
        border-radius: 6px;
        cursor: pointer;
        font: inherit;
        font-size: 12px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0;
      }
      .head button:hover { background: rgba(255,255,255,0.28); }

      .add-row {
        display: flex;
        gap: 4px;
        padding: 8px 10px;
        border-bottom: 1px solid #eee;
        background: #fafafa;
      }
      .add-row input {
        flex: 1;
        padding: 6px 8px;
        border: 1px solid #ddd;
        border-radius: 6px;
        font: inherit;
        font-size: 12px;
        background: #fff;
      }
      .add-row input:focus { outline: none; border-color: #209C64; }
      .kind-toggle {
        border: 1px solid #ddd;
        background: #fff;
        padding: 3px 4px;
        border-radius: 6px;
        cursor: pointer;
        font: inherit;
        font-size: 10px;
        font-weight: 700;
        color: #555;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        min-width: 30px;
      }
      .kind-toggle.personal { background: #f0f7f3; color: #12603D; border-color: #b8e6cf; }
      .kind-toggle.shared { background: #fff3e0; color: #b35900; border-color: #ffd699; }
      .add-btn {
        background: #209C64;
        color: #fff;
        border: none;
        padding: 5px 9px;
        border-radius: 6px;
        cursor: pointer;
        font: inherit;
        font-size: 12px;
        font-weight: 600;
      }
      .add-btn:hover { background: #12603D; }
      .add-btn:disabled { opacity: 0.4; cursor: default; }

      .items {
        flex: 1;
        overflow-y: auto;
        padding: 4px 6px 8px;
      }
      .section-head {
        font-size: 9px;
        font-weight: 700;
        color: #999;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        padding: 6px 6px 2px;
      }
      .item {
        display: flex;
        align-items: flex-start;
        gap: 6px;
        padding: 5px 6px;
        border-radius: 6px;
        cursor: default;
        font-size: 12px;
        line-height: 1.35;
      }
      .item:hover { background: #f5f5f5; }
      .item input[type="checkbox"] { margin-top: 2px; cursor: pointer; }
      .item .txt { flex: 1; word-break: break-word; }
      .item.done .txt { color: #aaa; text-decoration: line-through; }
      .item .pill {
        display: inline-block;
        font-size: 8px;
        font-weight: 800;
        padding: 1px 4px;
        border-radius: 3px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        margin-right: 4px;
        vertical-align: 1px;
      }
      .item .pill.p { background: #e3f2eb; color: #12603D; }
      .item .pill.s { background: #fff3e0; color: #b35900; }
      .item .del {
        background: none;
        border: none;
        color: #aaa;
        cursor: pointer;
        font-size: 12px;
        padding: 0 4px;
        opacity: 0;
        transition: opacity 0.15s;
      }
      .item:hover .del { opacity: 1; }
      .item .del:hover { color: #c00; }
      .empty {
        font-style: italic;
        color: #aaa;
        text-align: center;
        font-size: 11px;
        padding: 24px 12px;
      }

      .resize {
        position: absolute;
        right: 2px;
        bottom: 2px;
        width: 16px;
        height: 16px;
        cursor: nwse-resize;
        opacity: 0.45;
      }
      .resize::after {
        content: '';
        position: absolute;
        right: 4px;
        bottom: 4px;
        width: 7px;
        height: 7px;
        border-right: 2px solid #888;
        border-bottom: 2px solid #888;
      }
      .resize:hover { opacity: 0.9; }
    </style>
    <div class="widget">
      <div class="head" part="head">
        <span class="title">✓ To-dos</span>
        <span class="count" id="todo-count">0</span>
        <button id="todo-close" title="Hide widget (re-enable from the toolbar popup)" aria-label="Hide">✕</button>
      </div>
      <div class="add-row">
        <input id="todo-add-input" type="text" placeholder="Add a to-do…" maxlength="500" />
        <button class="kind-toggle personal" id="todo-kind" title="Click to switch between Personal / Shared">Personal</button>
        <button class="add-btn" id="todo-add-btn" title="Add">+</button>
      </div>
      <div class="items" id="todo-items"></div>
      <div class="resize" title="Drag to resize"></div>
    </div>
  `;

  const widgetEl = todoShadow.querySelector('.widget');
  const headEl = todoShadow.querySelector('.head');
  const closeBtn = todoShadow.querySelector('#todo-close');
  const todoAddInputEl = todoShadow.querySelector('#todo-add-input');
  const kindToggleBtn = todoShadow.querySelector('#todo-kind');
  const addBtn = todoShadow.querySelector('#todo-add-btn');
  const itemsEl = todoShadow.querySelector('#todo-items');
  const countEl = todoShadow.querySelector('#todo-count');
  const todoResize = todoShadow.querySelector('.resize');

  /* Thin wrapper kept around for the storage-change listener and
     manual show/hide toggles — defers to applyTodoLayoutToBadge so
     position always comes from the badge, never from todoUI.x/y. */
  function applyTodoUI() {
    applyTodoLayoutToBadge();
  }

  async function saveTodoUI() {
    try { await chrome.storage.local.set({ [TODO_WIDGET_KEY]: todoUI }); } catch {}
  }

  async function loadTodoUI() {
    try {
      const r = await chrome.storage.local.get(TODO_WIDGET_KEY);
      if (r[TODO_WIDGET_KEY]) todoUI = { ...DEFAULT_TODO_UI, ...r[TODO_WIDGET_KEY] };
    } catch {}
    applyTodoUI();
  }

  function mountTodoWidget() {
    if (!todoHost.isConnected && document.body) {
      document.body.appendChild(todoHost);
      /* Defer to next frame so the badge has had a layout pass before we
         measure it. Without this the widget can still position itself
         on the previous (incorrect) badge geometry. */
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(applyTodoLayoutToBadge);
      }
    }
  }

  /* React to storage changes from anywhere — popup hides it, options
     repaints colors, sync updates the lists. */
  chrome.storage.onChanged.addListener(changes => {
    if (changes[TODO_WIDGET_KEY] && changes[TODO_WIDGET_KEY].newValue) {
      todoUI = { ...DEFAULT_TODO_UI, ...changes[TODO_WIDGET_KEY].newValue };
      applyTodoUI();
    }
    if (changes['todos.personal'] || changes['todos.shared']) {
      renderTodoWidget();
    }
  });

  /* Drag handle = the gradient head bar. Dragging the widget moves the
     BADGE's anchor point (shared `ui` state), and the widget follows
     because applyUI repositions both. This is what makes the badge +
     widget feel like a single attached unit per the user spec. */
  let todoDrag = null;
  headEl.addEventListener('pointerdown', e => {
    if (e.target === closeBtn || closeBtn.contains(e.target)) return;
    const badgeRect = host.getBoundingClientRect();
    todoDrag = {
      x: e.clientX,
      y: e.clientY,
      badgeLeft: badgeRect.left,
      badgeTop: badgeRect.top,
      pointerId: e.pointerId,
    };
    headEl.classList.add('dragging');
    headEl.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  headEl.addEventListener('pointermove', e => {
    if (!todoDrag || e.pointerId !== todoDrag.pointerId) return;
    /* Move the shared anchor — applyUI repositions BOTH badge + widget. */
    ui.x = todoDrag.badgeLeft + (e.clientX - todoDrag.x);
    ui.y = todoDrag.badgeTop + (e.clientY - todoDrag.y);
    applyUI();
  });
  headEl.addEventListener('pointerup', e => {
    if (!todoDrag) return;
    todoDrag = null;
    headEl.classList.remove('dragging');
    try { headEl.releasePointerCapture(e.pointerId); } catch {}
    /* Save BOTH so the new anchor + widget dimensions survive reload. */
    saveUI();
    saveTodoUI();
  });

  let todoResizeOp = null;
  todoResize.addEventListener('pointerdown', e => {
    todoResizeOp = { x: e.clientX, y: e.clientY, w: todoUI.width, h: todoUI.height, pointerId: e.pointerId };
    todoResize.setPointerCapture(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
  });
  todoResize.addEventListener('pointermove', e => {
    if (!todoResizeOp || e.pointerId !== todoResizeOp.pointerId) return;
    todoUI.width = Math.max(220, todoResizeOp.w + (e.clientX - todoResizeOp.x));
    todoUI.height = Math.max(220, todoResizeOp.h + (e.clientY - todoResizeOp.y));
    applyTodoUI();
  });
  todoResize.addEventListener('pointerup', e => {
    if (!todoResizeOp) return;
    todoResizeOp = null;
    try { todoResize.releasePointerCapture(e.pointerId); } catch {}
    saveTodoUI();
  });

  closeBtn.addEventListener('click', () => {
    todoUI.hidden = true;
    saveTodoUI();
    applyTodoUI();
  });

  /* Kind toggle — click swaps between Personal and Shared and recolors
     the chip so the visitor always sees what kind the next add lands in. */
  function setKind(k) {
    widgetAddKind = k;
    kindToggleBtn.textContent = k === 'shared' ? 'Shared' : 'Personal';
    kindToggleBtn.classList.toggle('personal', k === 'personal');
    kindToggleBtn.classList.toggle('shared', k === 'shared');
    todoAddInputEl.placeholder = k === 'shared' ? 'Add a shared to-do…' : 'Add a personal to-do…';
  }
  kindToggleBtn.addEventListener('click', () => {
    setKind(widgetAddKind === 'personal' ? 'shared' : 'personal');
  });

  async function submitWidgetAdd() {
    const text = todoAddInputEl.value.trim();
    if (!text) return;
    todoAddInputEl.value = '';
    try {
      await chrome.runtime.sendMessage({ type: 'addTodo', kind: widgetAddKind, text });
    } catch {}
    /* Listener will re-render on storage write; no explicit call needed. */
  }
  addBtn.addEventListener('click', submitWidgetAdd);
  todoAddInputEl.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); submitWidgetAdd(); }
    /* Quick toggle to shared via Shift+Tab from the input — keeps mouse use
       optional. Most-used shortcut after Enter. */
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      setKind(widgetAddKind === 'personal' ? 'shared' : 'personal');
    }
  });

  function escapeForWidget(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  async function renderTodoWidget() {
    if (todoUI.hidden) return;
    const r = await chrome.storage.local.get(['todos.personal', 'todos.shared']);
    const personal = (r['todos.personal'] || []).map(t => ({ ...t, kind: 'personal' }));
    const shared = (r['todos.shared'] || []).map(t => ({ ...t, kind: 'shared' }));
    const all = [...personal, ...shared];
    const open = all.filter(t => !t.completed);
    countEl.textContent = String(open.length);

    const today = open.filter(t => t.bucket !== 'later').sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const later = open.filter(t => t.bucket === 'later').sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    function row(t) {
      const pill = t.kind === 'shared'
        ? `<span class="pill s" title="Shared">S</span>`
        : `<span class="pill p" title="Personal">P</span>`;
      return `
        <div class="item" data-id="${escapeForWidget(t.id)}" data-kind="${t.kind}">
          <input type="checkbox" data-action="toggle" />
          <div class="txt">${pill}${escapeForWidget(t.text)}</div>
          <button class="del" data-action="delete" title="Delete">✕</button>
        </div>
      `;
    }

    let html = '';
    if (today.length === 0 && later.length === 0) {
      html = `<div class="empty">All clear. Add one above to get started.</div>`;
    } else {
      if (today.length > 0) {
        html += `<div class="section-head">Today · ${today.length}</div>` + today.map(row).join('');
      }
      if (later.length > 0) {
        html += `<div class="section-head" style="margin-top:8px">Later · ${later.length}</div>` + later.map(row).join('');
      }
    }
    itemsEl.innerHTML = html;
  }

  itemsEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const item = btn.closest('.item');
    if (!item) return;
    const id = item.dataset.id;
    const kind = item.dataset.kind;
    const action = btn.dataset.action;
    const key = kind === 'shared' ? 'todos.shared' : 'todos.personal';
    const r = await chrome.storage.local.get(key);
    const list = Array.isArray(r[key]) ? r[key] : [];
    const todo = list.find(t => t.id === id);
    if (!todo) return;

    if (action === 'toggle') {
      const next = { ...todo, completed: true, completedAt: new Date().toISOString() };
      await chrome.runtime.sendMessage({ type: 'patchTodo', kind, todo: next });
    } else if (action === 'delete') {
      await chrome.runtime.sendMessage({ type: 'deleteTodo', kind, id });
    }
  });

  loadTodoUI();
  if (document.body) mountTodoWidget();
  else document.addEventListener('DOMContentLoaded', mountTodoWidget, { once: true });
  /* Initial paint — chrome.storage may still be empty if first install
     happens before this runs, but the change listener catches the
     subsequent sync write. */
  renderTodoWidget();

  /* ═════════════════════════════════════════════════════════════════
   * Voice tab logic
   * ═════════════════════════════════════════════════════════════════
   *
   * All state (presence, knocks, our own voiceState) comes from
   * chrome.storage.local, populated by background's voiceRoster alarm
   * (~6s). We do NOT fetch admin from this content script — one poller
   * in the background is enough, and every open tab reading storage
   * beats every open tab hitting the network.
   *
   * Storage keys watched:
   *   syncConfig      → signed-in check
   *   voiceState      → my own call state (peerId, inCallWith[], hasMic)
   *   voicePresence   → full roster [{userId,name,peerId,callWith[],...}]
   *   voiceKnocks     → { incoming:[...], outgoing:[...] }
   *   voiceLastError  → last background HTTP failure (banner)
   *
   * The Voice tab and the badge visual state both re-render on any of
   * these changing — so a knock reaching the browser lights up the
   * badge even if nobody is looking at the tab. */

  const knockCountEl = shadow.querySelector('#knock-count');
  const voiceNotConfigured = shadow.querySelector('#voice-not-configured');
  const voiceOnDesktop = shadow.querySelector('#voice-on-desktop');
  const voiceContent = shadow.querySelector('#voice-content');
  const voiceStatus = shadow.querySelector('#voice-status');
  const voiceStatusLabel = shadow.querySelector('#voice-status-label');
  const voiceErr = shadow.querySelector('#voice-err');
  const inCallEl = shadow.querySelector('#in-call');
  const inCallNames = shadow.querySelector('#in-call-names');
  const incomingCallsEl = shadow.querySelector('#incoming-calls');
  const incomingKnocksEl = shadow.querySelector('#incoming-knocks');
  const outgoingKnockEl = shadow.querySelector('#outgoing-knock');
  const outgoingKnockMsg = shadow.querySelector('#outgoing-knock-msg');
  const ongoingMeetingsEl = shadow.querySelector('#ongoing-meetings');
  const idleRosterEl = shadow.querySelector('#idle-roster');
  const noTeammatesEl = shadow.querySelector('#no-teammates');

  let vCfg = null;
  let vState = { peerId: null, inCallWith: [], hasMic: false };
  let vPresence = [];
  let vKnocks = { incoming: [], outgoing: [] };
  let vIncoming = [];
  let vLastError = null;
  let vOutgoingKnockId = null;
  let vDesktopActive = false;

  async function loadVoiceState() {
    const r = await chrome.storage.local.get([
      'syncConfig', 'voiceState', 'voicePresence', 'voiceKnocks', 'voiceLastError',
      'voiceIncoming', 'desktopAppConnected'
    ]);
    vDesktopActive = r.desktopAppConnected === true;
    vCfg = r.syncConfig || null;
    vState = r.voiceState || vState;
    vPresence = Array.isArray(r.voicePresence) ? r.voicePresence : [];
    vKnocks = r.voiceKnocks || vKnocks;
    vIncoming = Array.isArray(r.voiceIncoming) ? r.voiceIncoming : [];
    vLastError = r.voiceLastError || null;
    if (vOutgoingKnockId && !vKnocks.outgoing?.some(k => k.id === vOutgoingKnockId)) {
      vOutgoingKnockId = null;
    }
  }

  function voiceNameOf(userId) {
    const p = vPresence.find(x => x.userId === userId);
    return p ? p.name : userId;
  }

  function voiceEscapeHTML(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  /* Connected-components on the callWith graph — one meeting = one
     group of transitively-connected users. */
  function computeMeetings() {
    const byUser = new Map(vPresence.map(p => [p.userId, p]));
    const visited = new Set();
    const meetings = [];
    for (const p of vPresence) {
      if (visited.has(p.userId)) continue;
      if (!Array.isArray(p.callWith) || p.callWith.length === 0) continue;
      const group = new Set();
      const stack = [p.userId];
      while (stack.length) {
        const uid = stack.pop();
        if (visited.has(uid)) continue;
        visited.add(uid);
        group.add(uid);
        const q = byUser.get(uid);
        if (q && Array.isArray(q.callWith)) {
          for (const other of q.callWith) if (!visited.has(other)) stack.push(other);
        }
      }
      if (group.size >= 2) meetings.push(group);
    }
    return meetings;
  }

  function myMeeting(meetings) {
    if (!vCfg) return null;
    return meetings.find(m => m.has(vCfg.userId)) || null;
  }

  function renderVoice() {
    /* While the desktop app is connected it — not this browser — is the one
       registered for calls. Showing a roster here would list the user's own
       app as a teammate and offer to call it, and any "in call" state derived
       from that roster is about the app, not about this tab. */
    if (vDesktopActive) {
      voiceContent.hidden = true;
      voiceNotConfigured.hidden = true;
      voiceOnDesktop.hidden = false;
      updateVoiceBadgeState({ inCall: false, incoming: 0 });
      return;
    }
    voiceOnDesktop.hidden = true;

    if (!vCfg || !vCfg.userId) {
      voiceContent.hidden = true;
      voiceNotConfigured.hidden = false;
      updateVoiceBadgeState({ inCall: false, incoming: 0 });
      return;
    }
    voiceContent.hidden = false;
    voiceNotConfigured.hidden = true;

    if (vLastError) {
      voiceStatus.className = 'voice-status err';
      voiceStatusLabel.textContent = 'error';
      voiceErr.textContent = 'Voice server: ' + vLastError;
      voiceErr.hidden = false;
    } else if (!vState.peerId) {
      voiceStatus.className = 'voice-status pending';
      voiceStatusLabel.textContent = 'connecting…';
      voiceErr.hidden = true;
    } else {
      voiceStatus.className = 'voice-status ready';
      voiceStatusLabel.textContent = 'ready';
      voiceErr.hidden = true;
    }

    const meetings = computeMeetings();
    const mine = myMeeting(meetings);
    const inCall = !!(mine && mine.size >= 2);

    /* Only count participants still on the roster. A `callWith` entry can
       outlive the person it names — they close their browser mid-call and
       their presence expires — which otherwise renders as "In call with"
       followed by nothing, next to a Hang up button for a call that ended. */
    const others = inCall
      ? Array.from(mine)
          .filter(u => u !== vCfg.userId)
          .filter(u => vPresence.some(p => p.userId === u))
          .map(voiceNameOf)
          .filter(Boolean)
      : [];

    /* One source of truth from here down: a "call" with nobody still present
       is not a call, and the badge and button labels must agree with what the
       banner says rather than each deciding for themselves. */
    const reallyInCall = others.length > 0;

    if (reallyInCall) {
      inCallNames.textContent = others.join(', ');
      inCallEl.hidden = false;
    } else {
      inCallEl.hidden = true;
    }

    /* Incoming calls ring at the top — they're time-sensitive in a way
       knocks aren't, and the caller is waiting on the line. */
    incomingCallsEl.innerHTML = '';
    for (const c of vIncoming) {
      const card = document.createElement('div');
      card.className = 'ring-card';
      const msg = document.createElement('div');
      msg.className = 'msg';
      msg.innerHTML = `<b>${voiceEscapeHTML(c.name)}</b> is calling<span class="sub">Your mic stays off until you answer</span>`;
      const btns = document.createElement('div');
      btns.className = 'btns';
      const answer = document.createElement('button');
      answer.type = 'button';
      answer.textContent = 'Answer';
      answer.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'voice.acceptCall', peerId: c.peerId }).catch(() => {});
      });
      const decline = document.createElement('button');
      decline.type = 'button';
      decline.className = 'decline';
      decline.textContent = 'Decline';
      decline.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'voice.declineCall', peerId: c.peerId }).catch(() => {});
      });
      btns.appendChild(answer);
      btns.appendChild(decline);
      card.appendChild(msg);
      card.appendChild(btns);
      incomingCallsEl.appendChild(card);
    }

    const pending = (vKnocks.incoming || []).filter(k => !k.acceptedBy);
    incomingKnocksEl.innerHTML = '';
    for (const k of pending) {
      const card = document.createElement('div');
      card.className = 'knock-card';
      const otherTargets = (k.targets || []).filter(u => u !== vCfg.userId).map(voiceNameOf).join(', ');
      const msg = document.createElement('div');
      msg.className = 'msg';
      msg.innerHTML = `<b>${voiceEscapeHTML(k.fromName)}</b> wants to join${otherTargets ? ` your call with ${voiceEscapeHTML(otherTargets)}` : ''}`;
      const btns = document.createElement('div');
      btns.className = 'btns';
      const accept = document.createElement('button');
      accept.type = 'button';
      accept.textContent = 'Accept';
      accept.addEventListener('click', () => voiceAcceptKnock(k.id));
      const reject = document.createElement('button');
      reject.type = 'button';
      reject.className = 'reject';
      reject.textContent = 'Ignore';
      reject.addEventListener('click', () => voiceCancelKnock(k.id));
      btns.appendChild(accept);
      btns.appendChild(reject);
      card.appendChild(msg);
      card.appendChild(btns);
      incomingKnocksEl.appendChild(card);
    }

    const myOutgoing = (vKnocks.outgoing || []).find(k => k.id === vOutgoingKnockId && !k.acceptedBy);
    if (myOutgoing) {
      outgoingKnockEl.hidden = false;
      outgoingKnockMsg.textContent = `Waiting for ${(myOutgoing.targets || []).map(voiceNameOf).join(' or ')} to accept…`;
    } else {
      outgoingKnockEl.hidden = true;
    }

    ongoingMeetingsEl.innerHTML = '';
    const othersMeetings = meetings.filter(m => !m.has(vCfg.userId));
    if (othersMeetings.length) {
      const h = document.createElement('div');
      h.className = 'voice-section-header';
      h.style.marginTop = '10px';
      h.textContent = 'Ongoing meetings';
      ongoingMeetingsEl.appendChild(h);
      const ul = document.createElement('ul');
      ul.className = 'voice-list';
      for (const m of othersMeetings) {
        const li = document.createElement('li');
        const names = Array.from(m).map(voiceNameOf).join(' + ');
        const nameSpan = document.createElement('span');
        nameSpan.className = 'name';
        nameSpan.innerHTML = `<span class="dot in-meeting"></span>${voiceEscapeHTML(names)}`;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'join';
        const alreadyKnocking = myOutgoing && Array.from(m).every(u => (myOutgoing.targets || []).includes(u));
        btn.textContent = alreadyKnocking ? 'Waiting…' : 'Request to join';
        btn.disabled = !!myOutgoing || inCall;
        btn.addEventListener('click', () => voiceRequestJoin(Array.from(m)));
        li.appendChild(nameSpan);
        li.appendChild(btn);
        ul.appendChild(li);
      }
      ongoingMeetingsEl.appendChild(ul);
    }

    const inAny = new Set();
    for (const m of meetings) for (const u of m) inAny.add(u);
    const idle = vPresence
      .filter(p => p.userId !== vCfg.userId && !inAny.has(p.userId))
      .sort((a, b) => a.name.localeCompare(b.name));
    idleRosterEl.innerHTML = '';
    for (const p of idle) {
      const li = document.createElement('li');
      const isPending = String(p.peerId).startsWith('pending-');
      const nameSpan = document.createElement('span');
      nameSpan.className = 'name';
      nameSpan.innerHTML = `<span class="dot"></span>${voiceEscapeHTML(p.name)}${isPending ? '<span class="meta">(connecting)</span>' : ''}`;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = reallyInCall ? 'Add' : 'Call';
      btn.disabled = isPending || !vState.peerId;
      btn.addEventListener('click', () => voiceCallUser(p));
      li.appendChild(nameSpan);
      li.appendChild(btn);
      idleRosterEl.appendChild(li);
    }
    noTeammatesEl.hidden = idle.length > 0 || othersMeetings.length > 0 || pending.length > 0;

    /* A ringing call counts toward the badge the same way a knock does,
       so the pulse shows up even when the panel is closed. */
    updateVoiceBadgeState({ inCall: reallyInCall, incoming: pending.length + vIncoming.length });
  }

  function updateVoiceBadgeState({ inCall, incoming }) {
    /* Note: don't fight the OTHER badge classes (alert-active,
       prayer-active). Those set the entire background color for their
       own alerts. Voice classes are box-shadow-only so the two systems
       can coexist visually — a prayer alert wins on background, voice
       adds a colored halo/border around whatever background is set. */
    badge.classList.toggle('voice-in-call', !!inCall);
    badge.classList.toggle('voice-knock', !inCall && incoming > 0);
    if (incoming > 0) {
      knockCountEl.textContent = String(incoming);
      knockCountEl.hidden = false;
    } else {
      knockCountEl.hidden = true;
    }
  }

  async function voiceCallUser(p) {
    const r = await chrome.runtime.sendMessage({ type: 'voice.startCall', peerId: p.peerId });
    if (!r || !r.ok) {
      alert('Call failed: ' + ((r && r.error) || 'unknown — see extension service worker console'));
    }
  }
  async function voiceRequestJoin(targets) {
    const r = await chrome.runtime.sendMessage({ type: 'voice.knockRequest', targets });
    if (!r || !r.ok) {
      alert('Request to join failed: ' + ((r && r.error) || 'unknown'));
      return;
    }
    vOutgoingKnockId = r.knock?.id || null;
    renderVoice();
  }
  async function voiceAcceptKnock(knockId) {
    const r = await chrome.runtime.sendMessage({ type: 'voice.knockAccept', knockId });
    if (!r || !r.ok) alert('Accept failed: ' + ((r && r.error) || 'unknown'));
  }
  async function voiceCancelKnock(knockId) {
    await chrome.runtime.sendMessage({ type: 'voice.knockCancel', knockId });
  }

  shadow.querySelector('#hangup').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'voice.endAllCalls' });
    vState = { ...vState, inCallWith: [], hasMic: false };
    renderVoice();
  });
  shadow.querySelector('#cancel-knock').addEventListener('click', async () => {
    if (!vOutgoingKnockId) return;
    await voiceCancelKnock(vOutgoingKnockId);
    vOutgoingKnockId = null;
    renderVoice();
  });
  shadow.querySelector('#voice-setup').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'openOptions' }).catch(() => {});
  });

  /* Storage listener — re-render on ANY change to voice-related keys,
     even while the Voice tab isn't visible. Keeps badge state live for
     "someone is trying to reach you" nudges. */
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.syncConfig || changes.voiceState || changes.voicePresence ||
        changes.voiceKnocks || changes.voiceLastError || changes.voiceIncoming ||
        changes.desktopAppConnected) {
      loadVoiceState().then(renderVoice);
    }
  });

  /* Initial paint so badge state reflects current storage right after
     page load — an incoming knock lights up the badge without needing
     the user to open the panel first. */
  loadVoiceState().then(renderVoice);
}
