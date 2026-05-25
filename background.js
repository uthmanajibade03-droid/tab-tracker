const IDLE_SECONDS = 600;
const MAX_FLUSH_MS = 5 * 60 * 1000; // sanity cap: never credit more than 5 min in a single flush (guards against system sleep)

let state = {
  activeTabId: null,
  activeDomain: null,
  activeStart: null,
  windowFocused: true,
  userActive: true
};
let tabDomains = {};

chrome.idle.setDetectionInterval(IDLE_SECONDS);

async function loadState() {
  const r = await chrome.storage.local.get(['state', 'tabDomains']);
  if (r.state) state = { ...state, ...r.state, activeStart: null };
  if (r.tabDomains) tabDomains = r.tabDomains;
  await pruneClosedTabs();
  await syncCurrentState();
}

async function pruneClosedTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    const live = new Set(tabs.map(t => t.id));
    for (const id of Object.keys(tabDomains)) if (!live.has(Number(id))) delete tabDomains[id];
  } catch {}
}

async function syncCurrentState() {
  try {
    const idleState = await chrome.idle.queryState(IDLE_SECONDS);
    state.userActive = idleState === 'active';
    const win = await chrome.windows.getLastFocused({ populate: false }).catch(() => null);
    state.windowFocused = !!(win && win.focused);
    let domain = null, tabId = null;
    if (state.windowFocused && win) {
      const [active] = await chrome.tabs.query({ active: true, windowId: win.id });
      if (active) {
        domain = domainOf(active.url);
        tabId = active.id;
      }
    }
    await startTracking(tabId, domain);
  } catch (e) {
    console.warn('syncCurrentState failed', e);
  }
}

loadState();

chrome.runtime.onStartup.addListener(loadState);
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('flush', { periodInMinutes: 1 });
  loadState();
});
chrome.alarms.create('flush', { periodInMinutes: 1 });

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function domainOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

async function persist() {
  await chrome.storage.local.set({ state, tabDomains });
}

async function flushActive() {
  if (!state.activeStart) return;
  let elapsed = Date.now() - state.activeStart;
  state.activeStart = null;
  if (elapsed <= 0) return;
  if (elapsed > MAX_FLUSH_MS) elapsed = MAX_FLUSH_MS;
  if (state.activeDomain) {
    const key = todayKey();
    const { stats = {} } = await chrome.storage.local.get('stats');
    stats[key] = stats[key] || {};
    const dom = stats[key][state.activeDomain] || { opens: 0, activeMs: 0 };
    dom.activeMs += elapsed;
    stats[key][state.activeDomain] = dom;
    await chrome.storage.local.set({ stats });
  }
}

async function recordOpen(domain) {
  if (!domain) return;
  const key = todayKey();
  const { stats = {} } = await chrome.storage.local.get('stats');
  stats[key] = stats[key] || {};
  const dom = stats[key][domain] || { opens: 0, activeMs: 0 };
  dom.opens += 1;
  stats[key][domain] = dom;
  await chrome.storage.local.set({ stats });
}

async function startTracking(tabId, domain) {
  state.activeTabId = tabId || null;
  state.activeDomain = domain || null;
  state.activeStart = (tabId && domain && state.windowFocused && state.userActive) ? Date.now() : null;
  await persist();
}

async function transitionTo(tabId, domain) {
  await flushActive();
  await startTracking(tabId, domain);
}

// Self-heal: a heartbeat from a content script means the page is alive and the user may be on it.
// If it's the focused window's active tab and we're not tracking it, start tracking — handles
// post-sleep wake-up where chrome.idle/onActivated events may not have fired.
async function heartbeat(tab) {
  if (!tab || !tab.id) return;
  const domain = domainOf(tab.url);
  if (!domain) return;
  try {
    const win = await chrome.windows.get(tab.windowId);
    if (!win.focused || !tab.active) return;
    state.userActive = true;
    state.windowFocused = true;
    if (state.activeTabId !== tab.id || state.activeDomain !== domain || !state.activeStart) {
      await transitionTo(tab.id, domain);
    }
  } catch {}
}

async function domainElapsedToday(domain) {
  if (!domain) return 0;
  const key = todayKey();
  const { stats = {} } = await chrome.storage.local.get('stats');
  let ms = (stats[key] && stats[key][domain] && stats[key][domain].activeMs) || 0;
  if (state.activeDomain === domain && state.activeStart) {
    ms += Date.now() - state.activeStart;
  }
  return ms;
}

chrome.tabs.onCreated.addListener(tab => {
  const d = domainOf(tab.url || tab.pendingUrl || '');
  if (d) {
    tabDomains[tab.id] = d;
    recordOpen(d);
  }
  persist();
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (!info.url && info.status !== 'complete') return;
  const d = domainOf(tab.url);
  if (!d) return;
  const domainChanged = tabDomains[tabId] !== d;
  if (domainChanged) {
    if (state.activeTabId === tabId) await flushActive();
    tabDomains[tabId] = d;
    await recordOpen(d);
  }
  if (tab.active) {
    const win = await chrome.windows.get(tab.windowId).catch(() => null);
    if (win && win.focused) await transitionTo(tabId, d);
  }
  await persist();
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    await transitionTo(tabId, domainOf(tab.url));
  } catch {}
});

chrome.tabs.onRemoved.addListener(async tabId => {
  if (state.activeTabId === tabId) {
    await flushActive();
    state.activeTabId = null;
    state.activeDomain = null;
  }
  delete tabDomains[tabId];
  await persist();
});

chrome.windows.onFocusChanged.addListener(async windowId => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    state.windowFocused = false;
    await flushActive();
    await persist();
  } else {
    state.windowFocused = true;
    const [active] = await chrome.tabs.query({ active: true, windowId });
    if (active) await transitionTo(active.id, domainOf(active.url));
  }
});

chrome.idle.onStateChanged.addListener(async newState => {
  if (newState === 'active') {
    state.userActive = true;
    await syncCurrentState();
  } else {
    state.userActive = false;
    await flushActive();
    await persist();
  }
});

chrome.alarms.onAlarm.addListener(async a => {
  if (a.name !== 'flush') return;
  await flushActive();
  await syncCurrentState();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'getTabTime') return;
  (async () => {
    const tab = sender.tab;
    if (tab) await heartbeat(tab);
    const domain = tab ? domainOf(tab.url) : null;
    const ms = await domainElapsedToday(domain);
    sendResponse({ ms });
  })();
  return true; // keep message channel open for async sendResponse
});
