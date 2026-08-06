/*
  Temporary service-worker diagnostics for fullscreen video transitions.

  Records runtime messages, tab/window events, and the Chrome API calls made by
  the fullscreen controller. Entries are also relayed to the active video tab so
  the page DevTools console contains one combined timeline.
*/

(() => {
  "use strict";

  const PREFIX = "[helium-video-debug]";
  const RELAY_MESSAGE = "heliumVideoDebugRelay";
  const RELEVANT_MESSAGES = new Set([
    "heliumYoutubeSpaceEnter",
    "heliumYoutubeSpaceExit",
    "heliumVideoSpacePrepareTransfer",
    "heliumYoutubeSpaceActivate",
    "heliumYoutubeSpaceDeactivate",
    "heliumYoutubeSpaceStatus",
  ]);
  const CAPTURE_WINDOW_MS = 45_000;

  const contextId = makeId("worker");
  const startedAt = performance.now();
  const trackedTabIds = new Set();
  const trackedWindowIds = new Set();
  let sequence = 0;
  let captureUntil = 0;

  const originalTabSendMessage = chrome.tabs.sendMessage.bind(chrome.tabs);

  log("worker", "script-loaded", {
    extensionVersion: chrome.runtime.getManifest().version,
  });

  chrome.runtime.onMessage.addListener((message, sender) => {
    if (!RELEVANT_MESSAGES.has(message?.type)) return false;

    beginCapture(sender?.tab);
    log("worker", "runtime-message-received", {
      message: cleanValue(message),
      sender: describeSender(sender),
    });
    return false;
  });

  chrome.windows.onCreated.addListener((window) => {
    if (!captureActive()) return;
    trackWindow(window?.id);
    log("worker", "windows.onCreated", { window: describeWindow(window) });
  });

  chrome.windows.onBoundsChanged.addListener((window) => {
    if (!captureActive() && !trackedWindowIds.has(window?.id)) return;
    trackWindow(window?.id);
    log("worker", "windows.onBoundsChanged", {
      window: describeWindow(window),
    });
  });

  chrome.windows.onFocusChanged.addListener((windowId) => {
    if (!captureActive() && !trackedWindowIds.has(windowId)) return;
    log("worker", "windows.onFocusChanged", { windowId });
  });

  chrome.windows.onRemoved.addListener((windowId) => {
    if (!captureActive() && !trackedWindowIds.has(windowId)) return;
    log("worker", "windows.onRemoved", { windowId });
    trackedWindowIds.delete(windowId);
  });

  chrome.tabs.onCreated.addListener((tab) => {
    if (!captureActive()) return;
    trackTab(tab?.id, tab?.windowId);
    log("worker", "tabs.onCreated", { tab: describeTab(tab) });
  });

  chrome.tabs.onActivated.addListener((activeInfo) => {
    if (
      !captureActive() &&
      !trackedTabIds.has(activeInfo?.tabId) &&
      !trackedWindowIds.has(activeInfo?.windowId)
    ) {
      return;
    }
    trackTab(activeInfo?.tabId, activeInfo?.windowId);
    log("worker", "tabs.onActivated", { activeInfo: cleanValue(activeInfo) });
  });

  chrome.tabs.onDetached.addListener((tabId, detachInfo) => {
    if (!captureActive() && !trackedTabIds.has(tabId)) return;
    trackTab(tabId, detachInfo?.oldWindowId);
    log("worker", "tabs.onDetached", {
      tabId,
      detachInfo: cleanValue(detachInfo),
    });
  });

  chrome.tabs.onAttached.addListener((tabId, attachInfo) => {
    if (!captureActive() && !trackedTabIds.has(tabId)) return;
    trackTab(tabId, attachInfo?.newWindowId);
    log("worker", "tabs.onAttached", {
      tabId,
      attachInfo: cleanValue(attachInfo),
    });
  });

  chrome.tabs.onMoved.addListener((tabId, moveInfo) => {
    if (!captureActive() && !trackedTabIds.has(tabId)) return;
    trackTab(tabId, moveInfo?.windowId);
    log("worker", "tabs.onMoved", {
      tabId,
      moveInfo: cleanValue(moveInfo),
    });
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!trackedTabIds.has(tabId)) return;
    const relevant = {};
    for (const key of ["status", "url", "pinned", "active", "discarded"]) {
      if (key in changeInfo) relevant[key] = changeInfo[key];
    }
    if (Object.keys(relevant).length === 0) return;
    log("worker", "tabs.onUpdated", {
      tabId,
      changeInfo: relevant,
      tab: describeTab(tab),
    });
  });

  chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
    if (!captureActive() && !trackedTabIds.has(tabId)) return;
    log("worker", "tabs.onRemoved", {
      tabId,
      removeInfo: cleanValue(removeInfo),
    });
    trackedTabIds.delete(tabId);
  });

  wrapChromeMethod(chrome.windows, "create", "chrome.windows.create");
  wrapChromeMethod(chrome.windows, "update", "chrome.windows.update");
  wrapChromeMethod(chrome.tabs, "create", "chrome.tabs.create");
  wrapChromeMethod(chrome.tabs, "move", "chrome.tabs.move");
  wrapChromeMethod(chrome.tabs, "update", "chrome.tabs.update");
  wrapChromeMethod(chrome.tabs, "remove", "chrome.tabs.remove");
  wrapChromeMethod(chrome.tabs, "sendMessage", "chrome.tabs.sendMessage", {
    shouldLog(args) {
      const message = args[1];
      return message?.type !== RELAY_MESSAGE && RELEVANT_MESSAGES.has(message?.type);
    },
  });

  if (chrome.storage.session?.set) {
    wrapChromeMethod(chrome.storage.session, "set", "chrome.storage.session.set", {
      shouldLog(args) {
        return Object.keys(args[0] || {}).some((key) =>
          key.includes("heliumYoutubeSpaceSessions")
        );
      },
    });
  }

  function wrapChromeMethod(target, methodName, label, options = {}) {
    const original = target?.[methodName];
    if (typeof original !== "function") return;
    const bound = original.bind(target);

    try {
      target[methodName] = function (...args) {
        const shouldLog = options.shouldLog
          ? options.shouldLog(args)
          : captureActive();
        const callbackIndex =
          typeof args[args.length - 1] === "function" ? args.length - 1 : -1;
        const callId = makeId("api");

        if (shouldLog) {
          log("worker", "api-call", {
            callId,
            api: label,
            args: cleanValue(args.slice(0, callbackIndex >= 0 ? -1 : undefined)),
            stack: shortStack(),
          });
        }

        if (callbackIndex >= 0) {
          const callback = args[callbackIndex];
          args[callbackIndex] = (...callbackArgs) => {
            if (shouldLog) {
              log("worker", "api-callback", {
                callId,
                api: label,
                result: cleanValue(callbackArgs),
                lastError: chrome.runtime.lastError?.message || null,
              });
            }
            callback(...callbackArgs);
          };
          return bound(...args);
        }

        try {
          const result = bound(...args);
          if (!result || typeof result.then !== "function") {
            if (shouldLog) {
              log("worker", "api-return", {
                callId,
                api: label,
                result: cleanValue(result),
              });
            }
            return result;
          }

          return result.then(
            (value) => {
              trackResult(value);
              if (shouldLog) {
                log("worker", "api-resolved", {
                  callId,
                  api: label,
                  result: cleanValue(value),
                });
              }
              return value;
            },
            (error) => {
              if (shouldLog) {
                log("worker", "api-rejected", {
                  callId,
                  api: label,
                  error: errorInfo(error),
                });
              }
              throw error;
            }
          );
        } catch (error) {
          if (shouldLog) {
            log("worker", "api-threw", {
              callId,
              api: label,
              error: errorInfo(error),
            });
          }
          throw error;
        }
      };
    } catch (error) {
      log("worker", "api-wrapper-unavailable", {
        api: label,
        error: errorInfo(error),
      });
    }
  }

  function beginCapture(tab) {
    captureUntil = Math.max(captureUntil, Date.now() + CAPTURE_WINDOW_MS);
    trackTab(tab?.id, tab?.windowId);
  }

  function captureActive() {
    return Date.now() <= captureUntil;
  }

  function trackResult(value) {
    if (!value || typeof value !== "object") return;
    if (typeof value.id === "number" && "state" in value) trackWindow(value.id);
    if (typeof value.id === "number" && "windowId" in value) {
      trackTab(value.id, value.windowId);
    }
    if (Array.isArray(value)) value.forEach(trackResult);
  }

  function trackTab(tabId, windowId) {
    if (typeof tabId === "number") trackedTabIds.add(tabId);
    if (typeof windowId === "number") trackedWindowIds.add(windowId);
  }

  function trackWindow(windowId) {
    if (typeof windowId === "number") trackedWindowIds.add(windowId);
  }

  function log(scope, event, details = {}) {
    const entry = {
      source: scope,
      event,
      sequence: ++sequence,
      contextId,
      timestamp: new Date().toISOString(),
      elapsedMs: round(performance.now() - startedAt),
      ...cleanValue(details),
    };

    console.log(`${PREFIX}[${scope}] ${event}`, entry);
    relay(entry);
    return entry;
  }

  function relay(entry) {
    for (const tabId of trackedTabIds) {
      try {
        const result = originalTabSendMessage(tabId, {
          type: RELAY_MESSAGE,
          entry,
        });
        if (result?.catch) result.catch(() => {});
      } catch {
        /* The tab may be moving between windows or already closed. */
      }
    }
  }

  function describeSender(sender) {
    return {
      id: sender?.id || null,
      frameId: sender?.frameId ?? null,
      url: sender?.url || null,
      tab: describeTab(sender?.tab),
    };
  }

  function describeTab(tab) {
    if (!tab || typeof tab !== "object") return null;
    return {
      id: tab.id ?? null,
      windowId: tab.windowId ?? null,
      index: tab.index ?? null,
      active: Boolean(tab.active),
      pinned: Boolean(tab.pinned),
      discarded: Boolean(tab.discarded),
      status: tab.status || null,
      url: tab.url || null,
      title: tab.title || null,
    };
  }

  function describeWindow(window) {
    if (!window || typeof window !== "object") return null;
    return {
      id: window.id ?? null,
      focused: Boolean(window.focused),
      state: window.state || null,
      type: window.type || null,
      left: window.left ?? null,
      top: window.top ?? null,
      width: window.width ?? null,
      height: window.height ?? null,
      tabs: Array.isArray(window.tabs)
        ? window.tabs.map((tab) => describeTab(tab))
        : undefined,
    };
  }

  function cleanValue(value, depth = 0) {
    if (depth > 6) return "[depth-limit]";
    if (value == null) return value;
    if (["string", "number", "boolean"].includes(typeof value)) return value;
    if (value instanceof Error) return errorInfo(value);
    if (Array.isArray(value)) {
      return value.slice(0, 40).map((item) => cleanValue(item, depth + 1));
    }
    if (typeof value === "object") {
      const output = {};
      for (const [key, item] of Object.entries(value).slice(0, 80)) {
        output[key] = cleanValue(item, depth + 1);
      }
      return output;
    }
    return String(value);
  }

  function errorInfo(error) {
    return {
      name: error?.name || "Error",
      message: error?.message || String(error),
      stack: typeof error?.stack === "string" ? error.stack : null,
    };
  }

  function shortStack() {
    const stack = new Error().stack;
    if (typeof stack !== "string") return null;
    return stack.split("\n").slice(3, 9).join("\n");
  }

  function round(value) {
    return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
  }

  function makeId(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
  }
})();
