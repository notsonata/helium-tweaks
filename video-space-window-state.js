/*
  Stabilize the temporary video's window state while macOS creates its Space.

  chrome.windows.update({ state: "fullscreen" }) can resolve before the native
  transition settles. During that interval Helium may report the same window as
  `normal`. The fullscreen controller treats a real `normal` result as an exit,
  so mask only those early observations. Explicit normal-state updates clear the
  mask immediately.
*/

(() => {
  "use strict";

  const SETTLE_MS = 4000;
  const PREFIX = "[helium-video-debug][window-state]";
  const settleDeadlines = new Map();

  const originalUpdate = chrome.windows.update.bind(chrome.windows);
  const originalGet = chrome.windows.get.bind(chrome.windows);

  chrome.windows.update = function stabilizedUpdate(windowId, updateInfo, ...rest) {
    const hasWindowId = typeof windowId === "number";
    const requestedState = updateInfo?.state;

    if (hasWindowId && requestedState === "fullscreen") {
      const deadline = Date.now() + SETTLE_MS;
      settleDeadlines.set(windowId, deadline);
      console.log(
        `${PREFIX} guard-start window=${windowId} durationMs=${SETTLE_MS}`
      );
    } else if (hasWindowId && requestedState === "normal") {
      if (settleDeadlines.delete(windowId)) {
        console.log(`${PREFIX} guard-cleared-by-normal-update window=${windowId}`);
      }
    }

    try {
      const result = originalUpdate(windowId, updateInfo, ...rest);
      if (!result || typeof result.then !== "function") return result;

      return result.then(
        (window) => {
          if (hasWindowId && requestedState === "fullscreen") {
            console.log(
              `${PREFIX} fullscreen-update-resolved window=${windowId} reportedState=${window?.state || "unknown"}`
            );
          }
          return window;
        },
        (error) => {
          if (hasWindowId && requestedState === "fullscreen") {
            settleDeadlines.delete(windowId);
            console.log(
              `${PREFIX} fullscreen-update-rejected window=${windowId} error=${error?.message || error}`
            );
          }
          throw error;
        }
      );
    } catch (error) {
      if (hasWindowId && requestedState === "fullscreen") {
        settleDeadlines.delete(windowId);
      }
      throw error;
    }
  };

  chrome.windows.get = function stabilizedGet(windowId, ...args) {
    const callbackIndex =
      typeof args[args.length - 1] === "function" ? args.length - 1 : -1;

    if (callbackIndex >= 0) {
      const callback = args[callbackIndex];
      args[callbackIndex] = (window) => callback(stabilizeWindow(windowId, window));
      return originalGet(windowId, ...args);
    }

    const result = originalGet(windowId, ...args);
    if (!result || typeof result.then !== "function") {
      return stabilizeWindow(windowId, result);
    }
    return result.then((window) => stabilizeWindow(windowId, window));
  };

  function stabilizeWindow(windowId, window) {
    const deadline = settleDeadlines.get(windowId);
    if (!deadline) return window;

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      settleDeadlines.delete(windowId);
      console.log(
        `${PREFIX} guard-expired window=${windowId} state=${window?.state || "unknown"}`
      );
      return window;
    }

    if (!window || window.state === "fullscreen") return window;

    console.log(
      `${PREFIX} masked-transient-state window=${windowId} realState=${window.state || "unknown"} normalizedState=fullscreen remainingMs=${remainingMs}`
    );

    return { ...window, state: "fullscreen" };
  }
})();
