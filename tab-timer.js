if (window.top === window) {
  const STORAGE_KEY = 'badgeUI';
  const DEFAULT_UI = { x: null, y: 16, edge: 'right', edgeOffset: 16, scale: 1.0 };
  const BASE_FONT = 14;
  let ui = { ...DEFAULT_UI };

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
      .badge {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        position: relative;
        background: rgba(15, 15, 18, 0.88);
        color: #fff;
        padding: 8px 16px 8px 14px;
        border-radius: 999px;
        box-shadow: 0 4px 16px rgba(0,0,0,0.35), 0 0 0 1px rgba(255,255,255,0.08) inset;
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        font-variant-numeric: tabular-nums;
        letter-spacing: 0.4px;
        font-weight: 500;
        user-select: none;
        cursor: grab;
        display: inline-flex;
        align-items: center;
        gap: 7px;
        white-space: nowrap;
        line-height: 1;
        transition: opacity 0.15s, box-shadow 0.15s;
      }
      .badge:hover { box-shadow: 0 4px 20px rgba(0,0,0,0.45), 0 0 0 1px rgba(255,255,255,0.15) inset; }
      .badge.dragging { cursor: grabbing; opacity: 0.92; }
      .icon { opacity: 0.9; font-size: 0.9em; }
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
    </style>
    <div class="badge" part="badge">
      <span class="icon">⏱</span><span class="time">0:00</span>
      <div class="resize" title="Drag to resize"></div>
    </div>
  `;
  const badge = shadow.querySelector('.badge');
  const timeEl = shadow.querySelector('.time');
  const resizeHandle = shadow.querySelector('.resize');

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
  }

  function mount() {
    if (!host.isConnected && document.body) document.body.appendChild(host);
  }

  async function saveUI() {
    try { await chrome.storage.local.set({ [STORAGE_KEY]: ui }); } catch {}
  }

  async function loadUI() {
    try {
      const r = await chrome.storage.local.get(STORAGE_KEY);
      if (r[STORAGE_KEY]) ui = { ...DEFAULT_UI, ...r[STORAGE_KEY] };
    } catch {}
    applyUI();
  }

  chrome.storage.onChanged.addListener(changes => {
    if (changes[STORAGE_KEY] && changes[STORAGE_KEY].newValue) {
      ui = { ...DEFAULT_UI, ...changes[STORAGE_KEY].newValue };
      applyUI();
    }
  });

  let dragging = false, resizing = false, op = null;

  badge.addEventListener('pointerdown', e => {
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

  async function tick() {
    if (document.visibilityState !== 'visible') return;
    try {
      const res = await chrome.runtime.sendMessage({ type: 'getTabTime' });
      if (!res) return;
      const text = fmt(res.ms);
      if (timeEl.textContent !== text) timeEl.textContent = text;
      mount();
    } catch {}
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') tick();
  });

  setInterval(tick, 1000);
  tick();
}
