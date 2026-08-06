/*
  Separate macOS Space fullscreen for fullscreen web video.

  A page first enters its own real Fullscreen API state. The same tab is then
  moved into a temporary Helium window and that window enters browser fullscreen,
  which macOS normally places in a separate Space. A placeholder tab remains at
  the original position and restores the video tab.
*/

(() => {
  "use strict";

  const SETTING_KEY = "videoSeparateSpaceEnabled";
  const LEGACY_SETTING_KEY = "youtubeSeparateSpaceEnabled";
  const SESSION_STORAGE_KEY = "heliumYoutubeSpaceSessions:v1";
  const ENTER_MESSAGE = "heliumYoutubeSpaceEnter";
  const EXIT_MESSAGE = "heliumYoutubeSpaceExit";
  const STATUS_MESSAGE = "heliumYoutubeSpaceStatus";
  const ACTIVATE_MESSAGE = "heliumYoutubeSpaceActivate";
  const DEACTIVATE_MESSAGE = "heliumYoutubeSpaceDeactivate";
  const PLACEHOLDER_PAGE = "video-placeholder.html";
  const FULLSCREEN_GRACE_MS = 1200;

  const sessions = new Map();
  const boundsTimers = new Map();
  let loadPromise = null;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message !== "object") return false;
    if (sender.id && sender.id !== chrome.runtime.id) return false;
    if (sender.frameId && sender.frameId !== 0) return false;

    if (message.type === ENTER_MESSAGE) {
      beginSession(sender.tab, message.reason)
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) => sendResponse({ ok: false, error: publicError(error) }));
      return true;
    }

    if (message.type === EXIT_MESSAGE) {
      restoreMatchingSession(message, sender)
        .then((restored) => sendResponse({ ok: true, restored }))
        .catch((error) => sendResponse({ ok: false, error: publicError(error) }));
      return true;
    }

    if (message.type === STATUS_MESSAGE) {
      getPublicStatus(message.sessionId)
        .then((status) => sendResponse({ ok: true, ...status }))
        .catch((error) => sendResponse({ ok: false, error: publicError(error) }));
      return true;
    }

    return false;
  });

  chrome.windows.onBoundsChanged.addListener((window) => {
    if (typeof window?.id !== "number") return;
    scheduleWindowStateCheck(window.id);
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
    const newSetting = changes[SETTING_KEY];
    const legacySetting = changes[LEGACY_SETTING_KEY];
    if (!newSetting && !legacySetting) return;

    const disabled = newSetting
      ? newSetting.newValue === false
      : legacySetting.newValue === false;

    if (disabled) {
      restoreAllSessions("setting-disabled").catch((error) => {
        console.error("[helium-tweaks] could not exit active video session:", error);
      });
    }
  });

  ensureLoaded().then(reconcileSessions).catch((error) => {
    console.error("[helium-tweaks] fullscreen session recovery failed:", error);
  });

  async function beginSession(senderTab, reason) {
    await ensureLoaded();

    if (!(await settingEnabled())) {
      throw new Error("Separate-Space video fullscreen is disabled");
    }
    if (!senderTab || typeof senderTab.id !== "number") {
      throw new Error("The fullscreen video tab is unavailable");
    }

    const existing = findSessionByVideoTab(senderTab.id);
    if (existing) return { sessionId: existing.id, reused: true };

    const tab = await chrome.tabs.get(senderTab.id);
    if (tab.incognito) {
      throw new Error("Separate-Space fullscreen is not available in Incognito");
    }
    if (typeof tab.windowId !== "number" || typeof tab.index !== "number") {
      throw new Error("The video tab position is unavailable");
    }

    const originalWindow = await chrome.windows.get(tab.windowId);
    if (originalWindow.type !== "normal") {
      throw new Error("The video tab must be in a normal browser window");
    }
    if (originalWindow.state === "fullscreen") {
      throw new Error("Exit the current browser fullscreen window first");
    }

    const sessionId = makeSessionId();
    let placeholderTab = null;
    let fullscreenWindow = null;

    try {
      placeholderTab = await chrome.tabs.create({
        windowId: tab.windowId,
        index: tab.index,
        active: true,
        url: chrome.runtime.getURL(
          `${PLACEHOLDER_PAGE}?session=${encodeURIComponent(sessionId)}`
        ),
      });

      fullscreenWindow = await chrome.windows.create({
        tabId: tab.id,
        type: "normal",
        focused: true,
      });

      if (typeof fullscreenWindow?.id !== "number") {
        throw new Error("Helium did not create the fullscreen video window");
      }

      const session = {
        id: sessionId,
        videoTabId: tab.id,
        originalWindowId: tab.windowId,
        originalIndex: tab.index,
        originalPinned: Boolean(tab.pinned),
        placeholderTabId:
          typeof placeholderTab?.id === "number" ? placeholderTab.id : null,
        fullscreenWindowId: fullscreenWindow.id,
        phase: "entering",
        seenFullscreen: false,
        createdAt: Date.now(),
        enteredAt: 0,
        reason: String(reason || "document-fullscreen").slice(0, 80),
      };

      sessions.set(sessionId, session);
      await persistSessions();

      await sendToVideoTab(session.videoTabId, {
        type: ACTIVATE_MESSAGE,
        sessionId,
      });

      const updatedWindow = await chrome.windows.update(fullscreenWindow.id, {
        state: "fullscreen",
        focused: true,
      });

      session.phase = "active";
      session.seenFullscreen = updatedWindow?.state === "fullscreen";
      session.enteredAt = Date.now();
      await persistSessions();

      return { sessionId };
    } catch (error) {
      const createdSession = sessions.get(sessionId);
      if (createdSession) {
        await restoreSession(sessionId, "entry-failed").catch(() => {});
      } else {
        if (typeof placeholderTab?.id === "number") {
          await safeRemoveTab(placeholderTab.id);
        }
        if (typeof fullscreenWindow?.id === "number") {
          await safeNormalizeWindow(fullscreenWindow.id);
          try {
            await chrome.tabs.move(tab.id, {
              windowId: tab.windowId,
              index: tab.index,
            });
            await chrome.tabs.update(tab.id, {
              active: true,
              pinned: tab.pinned,
            });
            await chrome.windows.update(tab.windowId, { focused: true });
          } catch {
            /* Preserve the original error; best-effort rollback only. */
          }
        }
      }
      throw error;
    }
  }

  async function restoreMatchingSession(message, sender) {
    await ensureLoaded();

    const requestedId = String(message.sessionId || "");
    let session = requestedId ? sessions.get(requestedId) : null;

    if (!session && typeof sender?.tab?.id === "number") {
      session =
        findSessionByVideoTab(sender.tab.id) ||
        findSessionByPlaceholderTab(sender.tab.id);
    }

    if (!session) return false;
    await restoreSession(session.id, String(message.reason || "requested"));
    return true;
  }

  async function restoreSession(sessionId, reason) {
    await ensureLoaded();
    const session = sessions.get(String(sessionId));
    if (!session) return false;
    if (session.phase === "restoring") return true;

    session.phase = "restoring";
    session.restoreReason = String(reason || "requested").slice(0, 80);
    await persistSessions();

    await sendToVideoTab(session.videoTabId, {
      type: DEACTIVATE_MESSAGE,
      sessionId: session.id,
    }).catch(() => {});

    const videoTab = await safeGetTab(session.videoTabId);
    if (!videoTab) {
      await safeRemoveTab(session.placeholderTabId);
      sessions.delete(session.id);
      await persistSessions();
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
        await persistSessions();
        throw error;
      }
    } else {
      await safeRemoveTab(session.placeholderTabId);
      if (typeof videoTab.windowId === "number") {
        await safeNormalizeWindow(videoTab.windowId);
        try {
          await chrome.tabs.update(session.videoTabId, { active: true });
          await chrome.windows.update(videoTab.windowId, { focused: true });
        } catch {
          /* The user may have closed the video window during restoration. */
        }
      }
    }

    await sendToVideoTab(session.videoTabId, {
      type: DEACTIVATE_MESSAGE,
      sessionId: session.id,
    }).catch(() => {});

    sessions.delete(session.id);
    await persistSessions();
    return true;
  }

  async function restoreAllSessions(reason) {
    await ensureLoaded();
    const ids = [...sessions.keys()];
    for (const id of ids) {
      await restoreSession(id, reason).catch((error) => {
        console.error(`[helium-tweaks] could not restore video session ${id}:`, error);
      });
    }
  }

  function scheduleWindowStateCheck(windowId) {
    clearTimeout(boundsTimers.get(windowId));
    boundsTimers.set(
      windowId,
      setTimeout(() => {
        boundsTimers.delete(windowId);
        checkWindowState(windowId).catch(() => {});
      }, 180)
    );
  }

  async function checkWindowState(windowId) {
    await ensureLoaded();
    const session = findSessionByFullscreenWindow(windowId);
    if (!session || session.phase !== "active") return;

    const window = await safeGetWindow(windowId);
    if (!window) return;

    if (window.state === "fullscreen") {
      if (!session.seenFullscreen) {
        session.seenFullscreen = true;
        await persistSessions();
      }
      return;
    }

    const oldEnough = Date.now() - session.enteredAt >= FULLSCREEN_GRACE_MS;
    if (session.seenFullscreen || oldEnough) {
      await restoreSession(session.id, "window-left-fullscreen");
    }
  }

  async function handleWindowRemoved(windowId) {
    await ensureLoaded();
    clearTimeout(boundsTimers.get(windowId));
    boundsTimers.delete(windowId);

    const fullscreenSession = findSessionByFullscreenWindow(windowId);
    if (fullscreenSession && fullscreenSession.phase !== "restoring") {
      await safeRemoveTab(fullscreenSession.placeholderTabId);
      sessions.delete(fullscreenSession.id);
      await persistSessions();
      return;
    }

    let changed = false;
    for (const session of sessions.values()) {
      if (session.originalWindowId === windowId) {
        session.originalWindowId = null;
        changed = true;
      }
    }
    if (changed) await persistSessions();
  }

  async function handleTabRemoved(tabId) {
    await ensureLoaded();

    const videoSession = findSessionByVideoTab(tabId);
    if (videoSession && videoSession.phase !== "restoring") {
      await safeRemoveTab(videoSession.placeholderTabId);
      sessions.delete(videoSession.id);
      await persistSessions();
      return;
    }

    const placeholderSession = findSessionByPlaceholderTab(tabId);
    if (placeholderSession) {
      placeholderSession.placeholderTabId = null;
      await persistSessions();
    }
  }

  async function getPublicStatus(requestedId) {
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

  async function reconcileSessions() {
    await ensureLoaded();
    for (const session of [...sessions.values()]) {
      const tab = await safeGetTab(session.videoTabId);
      const window = await safeGetWindow(session.fullscreenWindowId);

      if (!tab || !window) {
        await safeRemoveTab(session.placeholderTabId);
        sessions.delete(session.id);
        continue;
      }

      if (session.phase === "restoring") {
        session.phase = "active";
      }

      if (session.phase === "active" && window.state !== "fullscreen") {
        await restoreSession(session.id, "service-worker-recovery").catch(() => {});
      }
    }
    await persistSessions();
  }

  async function ensureLoaded() {
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      if (!chrome.storage.session) return;
      const result = await chrome.storage.session.get(SESSION_STORAGE_KEY);
      const stored = result[SESSION_STORAGE_KEY];
      if (!Array.isArray(stored)) return;

      for (const item of stored) {
        if (!item || !item.id || typeof item.videoTabId !== "number") continue;
        sessions.set(String(item.id), item);
      }
    })();
    return loadPromise;
  }

  async function persistSessions() {
    if (!chrome.storage.session) return;
    await chrome.storage.session.set({
      [SESSION_STORAGE_KEY]: [...sessions.values()],
    });
  }

  async function settingEnabled() {
    const result = await chrome.storage.sync.get({
      [SETTING_KEY]: null,
      [LEGACY_SETTING_KEY]: true,
    });
    return result[SETTING_KEY] == null
      ? result[LEGACY_SETTING_KEY] !== false
      : result[SETTING_KEY] !== false;
  }

  function findSessionByVideoTab(tabId) {
    return [...sessions.values()].find((session) => session.videoTabId === tabId);
  }

  function findSessionByPlaceholderTab(tabId) {
    return [...sessions.values()].find(
      (session) => session.placeholderTabId === tabId
    );
  }

  function findSessionByFullscreenWindow(windowId) {
    return [...sessions.values()].find(
      (session) => session.fullscreenWindowId === windowId
    );
  }

  async function sendToVideoTab(tabId, message) {
    let lastError = null;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        const response = await chrome.tabs.sendMessage(tabId, message);
        if (response?.ok !== false) return response;
      } catch (error) {
        lastError = error;
      }
      await delay(50);
    }
    throw lastError || new Error("The fullscreen video page did not answer");
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
        await delay(80);
      }
    } catch {
      /* Window was already closed. */
    }
  }

  async function safeRemoveTab(tabId) {
    if (typeof tabId !== "number") return;
    try {
      await chrome.tabs.remove(tabId);
    } catch {
      /* Tab was already closed. */
    }
  }

  function makeSessionId() {
    if (crypto?.randomUUID) return crypto.randomUUID();
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function publicError(error) {
    const message = typeof error?.message === "string" ? error.message : "";
    return (message || "Separate-Space fullscreen failed")
      .replace(/^Error:\s*/i, "")
      .slice(0, 240);
  }
})();
