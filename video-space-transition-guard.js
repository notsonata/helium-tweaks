/*
  Prevent the fullscreen session watcher from treating transient macOS window
  states during entry as a user-requested fullscreen exit.

  Helium can briefly report the new window as `normal` while the native macOS
  fullscreen/Space animation is still settling, even after windows.update()
  resolves with state=fullscreen. The main controller listens to
  windows.onBoundsChanged and would immediately restore the tab on that transient
  state. This compatibility layer delays only those early `normal` notifications
  and rechecks the real window state after the entry grace period.
*/

(() => {
  "use strict";

  const ENTRY_GUARD_MS = 3000;
  const guardDeadlines = new Map();

  const originalUpdate = chrome.windows.update.bind(chrome.windows);
  const originalAddListener =
    chrome.windows.onBoundsChanged.addListener.bind(
      chrome.windows.onBoundsChanged
    );

  chrome.windows.update = function guardedWindowUpdate(windowId, updateInfo, ...rest) {
    const enteringFullscreen = updateInfo?.state === "fullscreen";

    if (enteringFullscreen && typeof windowId === "number") {
      guardDeadlines.set(windowId, Date.now() + ENTRY_GUARD_MS);
    }

    try {
      const result = originalUpdate(windowId, updateInfo, ...rest);

      if (enteringFullscreen && result?.catch) {
        result.catch(() => guardDeadlines.delete(windowId));
      }

      return result;
    } catch (error) {
      if (enteringFullscreen) guardDeadlines.delete(windowId);
      throw error;
    }
  };

  chrome.windows.onBoundsChanged.addListener = function guardedAddListener(listener) {
    if (typeof listener !== "function") {
      return originalAddListener(listener);
    }

    const deferredChecks = new Map();

    const guardedListener = (window) => {
      const windowId = window?.id;
      const deadline = guardDeadlines.get(windowId);

      if (
        typeof windowId === "number" &&
        deadline &&
        Date.now() < deadline &&
        window?.state !== "fullscreen"
      ) {
        scheduleDeferredCheck(windowId, deadline);
        return;
      }

      if (deadline && Date.now() >= deadline) {
        guardDeadlines.delete(windowId);
      }

      listener(window);
    };

    function scheduleDeferredCheck(windowId, deadline) {
      if (deferredChecks.has(windowId)) return;

      const delayMs = Math.max(0, deadline - Date.now()) + 25;
      const timer = setTimeout(async () => {
        deferredChecks.delete(windowId);
        guardDeadlines.delete(windowId);

        try {
          const current = await chrome.windows.get(windowId);
          listener(current);
        } catch {
          /* The temporary window may have been intentionally closed. */
        }
      }, delayMs);

      deferredChecks.set(windowId, timer);
    }

    return originalAddListener(guardedListener);
  };
})();
