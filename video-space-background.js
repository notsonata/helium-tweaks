/*
  PR #17-style separate-Space video fullscreen.

  The same tab is moved into a temporary popup Helium window, the page isolates
  its detected player, and that window is switched to browser fullscreen. A
  placeholder remains at the tab's original position and restores the same tab.
*/

(() => {
  "use strict";

  const SETTING_KEY = "videoSeparateSpaceEnabled";
  const LEGACY_SETTING_KEY = "youtubeSeparateSpaceEnabled";
  const STORAGE_KEY = "heliumVideoSpaceSessions:v2";
  const LEGACY_STORAGE_KEY = "heliumYoutubeSpaceSessions:v1";

  const ENTER = "heliumYoutubeSpaceEnter";
  const EXIT = "heliumYoutubeSpaceExit";
  const STATUS = "heliumYoutubeSpaceStatus";
  const ACTIVATE = "heliumYoutubeSpaceActivate";
  const DEACTIVATE = "heliumYoutubeSpaceDeactivate";
  const PLACEHOLDER = "video-placeholder.html";
  const EXIT_ARM_MS = 1800;

  const sessions = new Map();
  const boundsTimers = new Map();
  let loadPromise = null;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message !== "object") return false;
    if (sender.id && sender.id !== chrome.runtime.id) return false;
    if (sender.frameId && sender.frameId !== 0) return false;

    if (message.type === ENTER) {
      enter(sender.tab, message.reason)
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) => sendResponse({ ok: false, error: publicError(error) }));
      return true;
    }

    if (message.type === EXIT) {
      restoreMatching(message, sender)
        .then((restored) => sendResponse({ ok: true, restored }))
        .catch((error) => sendResponse({ ok: false, error: publicError(error) }));
      return true;
    }

    if (message.type === STATUS) {
      status(message.sessionId)
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) => sendResponse({ ok: false, error: publicError(error) }));
      return true;
    }

    return false;
  });

  chrome.windows.onBoundsChanged.addListener((window) => {
    const session = findByFullscreenWindow(window?.id);
    if (!session || session.phase !== "active") return;
    if (Date.now() < session.exitArmedAt) return;

    clearTimeout(boundsTimers.get(window.id));
    boundsTimers.set(
      window.id,
      setTimeout(() => {
        boundsTimers.delete(window.id);
        checkWindowExit(window.id).catch(() => {});
      }, 240)
    );
  });

  chrome.windows.onRemoved.addListener((windowId) => {
    handleWindowRemoved(windowId).catch((error) => {
      console.error("[helium-tweaks] fullscreen window cleanup failed:", error);
    });
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    handleTabRemoved(tabId).catch((error) => {
      console.error("[helium-tweaks] fullscreen tab cleanup failed:", error);
    });
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") return;
    const current = changes[SETTING_KEY];
    const legacy = changes[LEGACY_SETTING_KEY];
    if (!current && !legacy) return;

    const disabled = current
      ? current.newValue === false
      : legacy.newValue === false;
    if (disabled) restoreAll("setting-disabled").catch(() => {});
  });

  ensureLoaded().then(reconcile).catch((error) => {
    console.error("[helium-tweaks] fullscreen session recovery failed:", error);
  });

  async function enter(senderTab, reason) {
    await ensureLoaded();
    if (!(await enabled())) throw new Error("Fullscreen video Spaces are disabled");
    if (!senderTab || typeof senderTab.id !== "number") {
      throw new Error("The video tab is unavailable");
    }

    const existing = findByVideoTab(senderTab.id);
    if (existing) return { sessionId: existing.id, reused: true };

    const tab = await chrome.tabs.get(senderTab.id);
    if (tab.incognito) throw new Error("Unavailable in Incognito");
    if (typeof tab.windowId !== "number" || typeof tab.index !== "number") {
      throw new Error("The video tab position is unavailable");
    }

    const originalWindow = await chrome.windows.get(tab.windowId);
    if (originalWindow.type !== "normal") {
      throw new Error("The video tab must be in a normal Helium window");
    }
    if (originalWindow.state === "fullscreen") {
      throw new Error("The page is still in native fullscreen");
    }

    const id = makeId();
    let placeholder = null;
    let videoWindow = null;

    try {
      placeholder = await chrome.tabs.create({
        windowId: tab.windowId,
        index: tab.index,
        active: true,
        url: chrome.runtime.getURL(
          `${PLACEHOLDER}?session=${encodeURIComponent(id)}`
        ),
      });

      videoWindow = await chrome.windows.create({
        tabId: tab.id,
        type: "popup",
        focused: true,
      });
      if (typeof videoWindow?.id !== "number") {
        throw new Error("Helium did not create the video window");
      }

      const session = {
        id,
        videoTabId: tab.id,
        originalWindowId: tab.windowId,
        originalIndex: tab.index,
        originalPinned: Boolean(tab.pinned),
        placeholderTabId:
          typeof placeholder?.id === "number" ? placeholder.id : null,
        fullscreenWindowId: videoWindow.id,
        phase: "entering",
        createdAt: Date.now(),
        enteredAt: 0,
        exitArmedAt: 0,
        reason: String(reason || "video-fullscreen").slice(0, 80),
      };

      sessions.set(id, session);
      await persist();

      await sendToVideoTab(tab.id, { type: ACTIVATE, sessionId: id });
      await chrome.windows.update(videoWindow.id, {
        state: "fullscreen",
        focused: true,
      });

      session.phase = "active";
      session.enteredAt = Date.now();
      session.exitArmedAt = session.enteredAt + EXIT_ARM_MS;
      await persist();
      return { sessionId: id };
    } catch (error) {
      if (sessions.has(id)) {
        await restore(id, "entry-failed").catch(() => {});
      } else {
        await safeRemoveTab(placeholder?.id);
        if (typeof videoWindow?.id === "number") {
          await safeNormalizeWindow(videoWindow.id);
          await moveBack(tab).catch(() => {});
        }
      }
      throw error;
    }
  }

  async function restoreMatching(message, sender) {
    await ensureLoaded();
    const requestedId = String(message.sessionId || "");
    let session = requestedId ? sessions.get(requestedId) : null;
    if (!session && typeof sender?.tab?.id === "number") {
      session =
        findByVideoTab(sender.tab.id) || findByPlaceholderTab(sender.tab.id);
    }
    if (!session) return false;
    await restore(session.id, String(message.reason || "requested"));
    return true;
  }

  async function restore(id, reason) {
    await ensureLoaded();
    const session = sessions.get(String(id));
    if (!session || session.phase === "restoring") return Boolean(session);

    session.phase = "restoring";
    session.restoreReason = String(reason || "requested").slice(0, 80);
    await persist();

    await sendToVideoTab(session.videoTabId, {
      type: DEACTIVATE,
      sessionId: session.id,
    }).catch(() => {});

    const videoTab = await safeGetTab(session.videoTabId);
    if (!videoTab) {
      await safeRemoveTab(session.placeholderTabId);
      sessions.delete(session.id);
      await persist();
      return true;
    }

    await safeNormalizeWindow(session.fullscreenWindowId);
    const originalWindow = await safeGetWindow(session.originalWindowId);

    if (originalWindow) {
      try {
        await chrome.tabs.move(session.videoTabId, {
          windowId: session.originalWindowId,
          index: Math.max(0, session.originalIndex),
        });
        await chrome.tabs.update(session.videoTabId, {
          active: true,
          pinned: session.originalPinned,
        });
        await safeRemoveTab(session.placeholderTabId);
        await chrome.windows.update(session.originalWindowId, { focused: true });
      } catch (error) {
        session.phase = "active";
        await persist();
        throw error;
      }
    } else {
      await safeRemoveTab(session.placeholderTabId);
      await chrome.tabs.update(session.videoTabId, { active: true }).catch(() => {});
      await chrome.windows.update(videoTab.windowId, { focused: true }).catch(() => {});
    }

    sessions.delete(session.id);
    await persist();
    return true;
  }

  async function checkWindowExit(windowId) {
    const session = findByFullscreenWindow(windowId);
    if (!session || session.phase !== "active") return;
    if (Date.now() < session.exitArmedAt) return;

    const window = await safeGetWindow(windowId);
    if (!window || window.state === "fullscreen") return;

    await delay(280);
    const confirmed = await safeGetWindow(windowId);
    if (confirmed && confirmed.state !== "fullscreen") {
      await restore(session.id, "window-left-fullscreen");
    }
  }

  async function handleWindowRemoved(windowId) {
    clearTimeout(boundsTimers.get(windowId));
    boundsTimers.delete(windowId);
    await ensureLoaded();

    const session = findByFullscreenWindow(windowId);
    if (session && session.phase !== "restoring") {
      await safeRemoveTab(session.placeholderTabId);
      sessions.delete(session.id);
      await persist();
      return;
    }

    let changed = false;
    for (const item of sessions.values()) {
      if (item.originalWindowId === windowId) {
        item.originalWindowId = null;
        changed = true;
      }
    }
    if (changed) await persist();
  }

  async function handleTabRemoved(tabId) {
    await ensureLoaded();
    const video = findByVideoTab(tabId);
    if (video && video.phase !== "restoring") {
      await safeRemoveTab(video.placeholderTabId);
      sessions.delete(video.id);
      await persist();
      return;
    }

    const placeholder = findByPlaceholderTab(tabId);
    if (placeholder) {
      placeholder.placeholderTabId = null;
      await persist();
    }
  }

  async function status(requestedId) {
    await ensureLoaded();
    const session = requestedId
      ? sessions.get(String(requestedId))
      : [...sessions.values()][0];
    if (!session) return { active: false, count: 0 };
    return {
      active: true,
      count: sessions.size,
      sessionId: session.id,
      phase: session.phase,
    };
  }

  async function restoreAll(reason) {
    await ensureLoaded();
    for (const id of [...sessions.keys()]) {
      await restore(id, reason).catch(() => {});
    }
  }

  async function reconcile() {
    await ensureLoaded();
    for (const session of [...sessions.values()]) {
      const tab = await safeGetTab(session.videoTabId);
      const window = await safeGetWindow(session.fullscreenWindowId);
      if (!tab || !window) {
        await safeRemoveTab(session.placeholderTabId);
        sessions.delete(session.id);
        continue;
      }
      if (session.phase === "restoring") session.phase = "active";
      if (!session.exitArmedAt) session.exitArmedAt = Date.now() + EXIT_ARM_MS;
    }
    await persist();
  }

  async function ensureLoaded() {
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      if (!chrome.storage.session) return;
      const result = await chrome.storage.session.get([
        STORAGE_KEY,
        LEGACY_STORAGE_KEY,
      ]);
      const stored = Array.isArray(result[STORAGE_KEY])
        ? result[STORAGE_KEY]
        : result[LEGACY_STORAGE_KEY];
      if (!Array.isArray(stored)) return;
      for (const item of stored) {
        if (!item?.id || typeof item.videoTabId !== "number") continue;
        sessions.set(String(item.id), item);
      }
    })();
    return loadPromise;
  }

  async function persist() {
    if (!chrome.storage.session) return;
    await chrome.storage.session.set({
      [STORAGE_KEY]: [...sessions.values()],
    });
  }

  async function enabled() {
    const result = await chrome.storage.sync.get({
      [SETTING_KEY]: null,
      [LEGACY_SETTING_KEY]: true,
    });
    return result[SETTING_KEY] == null
      ? result[LEGACY_SETTING_KEY] !== false
      : result[SETTING_KEY] !== false;
  }

  function findByVideoTab(tabId) {
    return [...sessions.values()].find((item) => item.videoTabId === tabId);
  }

  function findByPlaceholderTab(tabId) {
    return [...sessions.values()].find(
      (item) => item.placeholderTabId === tabId
    );
  }

  function findByFullscreenWindow(windowId) {
    return [...sessions.values()].find(
      (item) => item.fullscreenWindowId === windowId
    );
  }

  async function sendToVideoTab(tabId, message) {
    let lastError = null;
    for (let attempt = 0; attempt < 16; attempt += 1) {
      try {
        const response = await chrome.tabs.sendMessage(tabId, message);
        if (response?.ok !== false) return response;
      } catch (error) {
        lastError = error;
      }
      await delay(50);
    }
    throw lastError || new Error("The video page did not answer");
  }

  async function moveBack(tab) {
    await chrome.tabs.move(tab.id, {
      windowId: tab.windowId,
      index: tab.index,
    });
    await chrome.tabs.update(tab.id, {
      active: true,
      pinned: tab.pinned,
    });
    await chrome.windows.update(tab.windowId, { focused: true });
  }

  async function safeGetTab(tabId) {
    if (typeof tabId !== "number") return null;
    try {
      return await chrome.tabs.get(tabId);
    } catch {
      return null;
    }
  }

  async function safeGetWindow(windowId) {
    if (typeof windowId !== "number") return null;
    try {
      return await chrome.windows.get(windowId);
    } catch {
      return null;
    }
  }

  async function safeNormalizeWindow(windowId) {
    if (typeof windowId !== "number") return;
    try {
      const window = await chrome.windows.get(windowId);
      if (window.state === "fullscreen") {
        await chrome.windows.update(windowId, { state: "normal" });
        await delay(120);
      }
    } catch {
      // Window already closed.
    }
  }

  async function safeRemoveTab(tabId) {
    if (typeof tabId !== "number") return;
    try {
      await chrome.tabs.remove(tabId);
    } catch {
      // Tab already closed.
    }
  }

  function makeId() {
    return (
      crypto?.randomUUID?.() ||
      `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
    );
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function publicError(error) {
    return String(error?.message || "Separate-Space fullscreen failed")
      .replace(/^Error:\s*/i, "")
      .slice(0, 240);
  }
})();
