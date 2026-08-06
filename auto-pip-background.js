/*
  Fullscreen-aware Auto PiP tab-switch controller.

  This intentionally coordinates with video-space-background.js. A normal user
  tab switch may request PiP from the tab being left, while tab activations and
  tab moves created by the separate-Space fullscreen workflow are suppressed.
*/

(() => {
  "use strict";

  const SETTINGS = {
    autoPipEnabled: true,
    autoPipExitOnReturn: true,
    autoPipDelayMs: 500,
  };

  const TRY = "heliumAutoPiPTry";
  const RETURN = "heliumAutoPiPReturn";
  const SESSION_KEY = "heliumVideoSpaceSessions:v2";
  const LEGACY_SESSION_KEY = "heliumYoutubeSpaceSessions:v1";
  const PLACEHOLDER_URL = chrome.runtime.getURL("video-placeholder.html");

  const activeTabByWindow = new Map();
  const pendingByTab = new Map();
  const suppressedUntil = new Map();
  const fullscreenVideoTabs = new Set();

  let config = { ...SETTINGS };
  let readyPromise = loadConfig();

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "sync") {
      let changed = false;
      for (const key of Object.keys(SETTINGS)) {
        if (!changes[key]) continue;
        config[key] = normalizeSetting(key, changes[key].newValue);
        changed = true;
      }
      if (changed && !config.autoPipEnabled) cancelAllPending();
      return;
    }

    if (
      areaName === "session" &&
      (changes[SESSION_KEY] || changes[LEGACY_SESSION_KEY])
    ) {
      const current = changes[SESSION_KEY]?.newValue;
      const legacy = changes[LEGACY_SESSION_KEY]?.newValue;
      replaceFullscreenTabs(Array.isArray(current) ? current : legacy);
    }
  });

  chrome.tabs.onActivated.addListener((activeInfo) => {
    const previousTabId = activeTabByWindow.get(activeInfo.windowId);
    activeTabByWindow.set(activeInfo.windowId, activeInfo.tabId);
    handleActivation(previousTabId, activeInfo.tabId).catch(() => {});
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    clearPending(tabId);
    suppressedUntil.delete(tabId);
    fullscreenVideoTabs.delete(tabId);
    for (const [windowId, activeTabId] of activeTabByWindow) {
      if (activeTabId === tabId) activeTabByWindow.delete(windowId);
    }
  });

  chrome.tabs.onDetached.addListener((tabId) => {
    suppressTab(tabId, 2500);
  });

  chrome.tabs.onAttached.addListener((tabId, attachInfo) => {
    suppressTab(tabId, 2500);
    activeTabByWindow.set(attachInfo.newWindowId, tabId);
  });

  globalThis.HeliumAutoPiP = {
    suppressTab,
    setFullscreenTab(tabId, active) {
      if (typeof tabId !== "number") return;
      if (active) {
        fullscreenVideoTabs.add(tabId);
        suppressTab(tabId, 60_000);
      } else {
        fullscreenVideoTabs.delete(tabId);
        suppressTab(tabId, 4000);
      }
    },
    isSuppressed,
  };

  initialize().catch(() => {});

  async function initialize() {
    await readyPromise;
    await refreshFullscreenTabs();
    const activeTabs = await chrome.tabs.query({ active: true });
    for (const tab of activeTabs) {
      if (typeof tab.id === "number" && typeof tab.windowId === "number") {
        activeTabByWindow.set(tab.windowId, tab.id);
      }
    }
  }

  async function loadConfig() {
    try {
      const stored = await chrome.storage.sync.get(SETTINGS);
      config = {
        autoPipEnabled: stored.autoPipEnabled !== false,
        autoPipExitOnReturn: stored.autoPipExitOnReturn !== false,
        autoPipDelayMs: normalizeDelay(stored.autoPipDelayMs),
      };
    } catch {
      config = { ...SETTINGS };
    }
  }

  async function refreshFullscreenTabs() {
    if (!chrome.storage.session) return;
    try {
      const stored = await chrome.storage.session.get([
        SESSION_KEY,
        LEGACY_SESSION_KEY,
      ]);
      const sessions = Array.isArray(stored[SESSION_KEY])
        ? stored[SESSION_KEY]
        : stored[LEGACY_SESSION_KEY];
      replaceFullscreenTabs(sessions);
    } catch {
      // Session storage may be unavailable during worker startup.
    }
  }

  function replaceFullscreenTabs(sessions) {
    fullscreenVideoTabs.clear();
    if (!Array.isArray(sessions)) return;
    for (const session of sessions) {
      if (typeof session?.videoTabId === "number") {
        fullscreenVideoTabs.add(session.videoTabId);
      }
    }
  }

  async function handleActivation(previousTabId, activeTabId) {
    await readyPromise;
    clearPending(activeTabId);

    if (!config.autoPipEnabled) return;

    if (await isRestorePlaceholder(activeTabId)) {
      suppressTab(previousTabId, 7000);
      return;
    }

    if (
      config.autoPipExitOnReturn &&
      typeof activeTabId === "number" &&
      !isSuppressed(activeTabId)
    ) {
      send(activeTabId, { type: RETURN }).catch(() => {});
    }

    if (
      typeof previousTabId !== "number" ||
      previousTabId === activeTabId ||
      isSuppressed(previousTabId)
    ) {
      return;
    }

    schedulePiP(previousTabId);
  }

  function schedulePiP(tabId) {
    clearPending(tabId);
    const delay = normalizeDelay(config.autoPipDelayMs);
    const timer = setTimeout(async () => {
      pendingByTab.delete(tabId);
      if (!config.autoPipEnabled || isSuppressed(tabId)) return;
      try {
        await chrome.tabs.get(tabId);
        if (isSuppressed(tabId)) return;
        await send(tabId, { type: TRY, reason: "tab-switch" });
      } catch {
        // Restricted, closed, or non-scriptable tabs are ignored.
      }
    }, delay);
    pendingByTab.set(tabId, timer);
  }

  async function isRestorePlaceholder(tabId) {
    if (typeof tabId !== "number") return false;
    try {
      const tab = await chrome.tabs.get(tabId);
      return String(tab.url || "").startsWith(PLACEHOLDER_URL);
    } catch {
      return false;
    }
  }

  function suppressTab(tabId, durationMs = 5000) {
    if (typeof tabId !== "number") return;
    clearPending(tabId);
    const current = suppressedUntil.get(tabId) || 0;
    suppressedUntil.set(
      tabId,
      Math.max(current, Date.now() + Math.max(0, Number(durationMs) || 0))
    );
  }

  function isSuppressed(tabId) {
    if (typeof tabId !== "number") return true;
    if (fullscreenVideoTabs.has(tabId)) return true;
    const deadline = suppressedUntil.get(tabId) || 0;
    if (deadline <= Date.now()) {
      suppressedUntil.delete(tabId);
      return false;
    }
    return true;
  }

  function clearPending(tabId) {
    const timer = pendingByTab.get(tabId);
    if (timer) clearTimeout(timer);
    pendingByTab.delete(tabId);
  }

  function cancelAllPending() {
    for (const timer of pendingByTab.values()) clearTimeout(timer);
    pendingByTab.clear();
  }

  function normalizeSetting(key, value) {
    if (key === "autoPipDelayMs") return normalizeDelay(value);
    return value !== false;
  }

  function normalizeDelay(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return SETTINGS.autoPipDelayMs;
    return Math.min(3000, Math.max(100, Math.round(number)));
  }

  function send(tabId, message) {
    return chrome.tabs.sendMessage(tabId, message);
  }
})();
