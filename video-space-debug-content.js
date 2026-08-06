/*
  Temporary fullscreen diagnostics.

  Logs the page-side Fullscreen API sequence and runtime messages without
  changing fullscreen behavior. Service-worker diagnostics are relayed into the
  same page console so one recording contains both sides of the transition.
*/

(() => {
  "use strict";

  if (window.top !== window.self) return;

  const PREFIX = "[helium-video-debug]";
  const RELAY_MESSAGE = "heliumVideoDebugRelay";
  const RELEVANT_MESSAGES = new Set([
    "heliumYoutubeSpaceEnter",
    "heliumYoutubeSpaceExit",
    "heliumVideoSpacePrepareTransfer",
    "heliumYoutubeSpaceActivate",
    "heliumYoutubeSpaceDeactivate",
  ]);

  const contextId = makeId("page");
  const startedAt = performance.now();
  let sequence = 0;

  log("page", "script-loaded", snapshot());

  document.addEventListener(
    "fullscreenchange",
    () => log("page", "fullscreenchange", snapshot()),
    true
  );
  document.addEventListener(
    "webkitfullscreenchange",
    () => log("page", "webkitfullscreenchange", snapshot()),
    true
  );
  document.addEventListener(
    "visibilitychange",
    () => log("page", "visibilitychange", snapshot()),
    true
  );
  window.addEventListener("focus", () => log("page", "window-focus", snapshot()), true);
  window.addEventListener("blur", () => log("page", "window-blur", snapshot()), true);
  window.addEventListener(
    "pagehide",
    (event) =>
      log("page", "pagehide", {
        ...snapshot(),
        persisted: Boolean(event.persisted),
      }),
    true
  );
  window.addEventListener(
    "pageshow",
    (event) =>
      log("page", "pageshow", {
        ...snapshot(),
        persisted: Boolean(event.persisted),
      }),
    true
  );

  chrome.runtime.onMessage.addListener((message, sender) => {
    if (message?.type === RELAY_MESSAGE && message.entry) {
      console.log(`${PREFIX}[worker-relay] ${message.entry.event}`, message.entry);
      return false;
    }

    if (!RELEVANT_MESSAGES.has(message?.type)) return false;

    log("page", "runtime-message-received", {
      message: cleanMessage(message),
      sender: {
        id: sender?.id || null,
        frameId: sender?.frameId ?? null,
        tabId: sender?.tab?.id ?? null,
        windowId: sender?.tab?.windowId ?? null,
      },
      state: snapshot(),
    });

    return false;
  });

  wrapRuntimeSendMessage();

  function wrapRuntimeSendMessage() {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);

    try {
      chrome.runtime.sendMessage = function (...args) {
        const message = extractMessage(args);
        if (!RELEVANT_MESSAGES.has(message?.type)) {
          return original(...args);
        }

        const callbackIndex =
          typeof args[args.length - 1] === "function" ? args.length - 1 : -1;
        const callId = makeId("send");

        log("page", "runtime-message-send", {
          callId,
          message: cleanMessage(message),
          state: snapshot(),
        });

        if (callbackIndex >= 0) {
          const callback = args[callbackIndex];
          args[callbackIndex] = (...callbackArgs) => {
            const lastError = chrome.runtime.lastError?.message || null;
            log("page", "runtime-message-callback", {
              callId,
              messageType: message.type,
              response: cleanValue(callbackArgs[0]),
              lastError,
              state: snapshot(),
            });
            callback(...callbackArgs);
          };
          return original(...args);
        }

        try {
          const result = original(...args);
          if (!result || typeof result.then !== "function") return result;

          return result.then(
            (response) => {
              log("page", "runtime-message-resolved", {
                callId,
                messageType: message.type,
                response: cleanValue(response),
                state: snapshot(),
              });
              return response;
            },
            (error) => {
              log("page", "runtime-message-rejected", {
                callId,
                messageType: message.type,
                error: errorInfo(error),
                state: snapshot(),
              });
              throw error;
            }
          );
        } catch (error) {
          log("page", "runtime-message-threw", {
            callId,
            messageType: message.type,
            error: errorInfo(error),
            state: snapshot(),
          });
          throw error;
        }
      };
    } catch (error) {
      log("page", "runtime-send-wrapper-unavailable", {
        error: errorInfo(error),
      });
    }
  }

  function extractMessage(args) {
    if (args[0] && typeof args[0] === "object") return args[0];
    if (args[1] && typeof args[1] === "object") return args[1];
    return null;
  }

  function snapshot() {
    const fullscreenElement =
      document.fullscreenElement || document.webkitFullscreenElement || null;
    const videos = [...document.querySelectorAll("video")]
      .map(describeVideo)
      .sort((left, right) => right.area - left.area)
      .slice(0, 4);

    return {
      url: location.href,
      readyState: document.readyState,
      visibilityState: document.visibilityState,
      hasFocus: document.hasFocus(),
      viewport: {
        innerWidth,
        innerHeight,
        outerWidth,
        outerHeight,
        screenX,
        screenY,
      },
      fullscreenElement: describeElement(fullscreenElement),
      videos,
      rootAttributes: {
        activeSession:
          document.documentElement.getAttribute("data-helium-video-space") || null,
      },
    };
  }

  function describeVideo(video) {
    const rect = video.getBoundingClientRect();
    return {
      element: describeElement(video),
      paused: Boolean(video.paused),
      ended: Boolean(video.ended),
      currentTime: finiteNumber(video.currentTime),
      duration: finiteNumber(video.duration),
      readyState: video.readyState,
      networkState: video.networkState,
      muted: Boolean(video.muted),
      volume: finiteNumber(video.volume),
      area: Math.round(Math.max(0, rect.width) * Math.max(0, rect.height)),
    };
  }

  function describeElement(element) {
    if (!(element instanceof Element)) return null;
    const rect = element.getBoundingClientRect();
    return {
      tag: element.tagName.toLowerCase(),
      id: element.id || null,
      className:
        typeof element.className === "string"
          ? element.className.slice(0, 240)
          : null,
      connected: element.isConnected,
      rect: {
        x: round(rect.x),
        y: round(rect.y),
        width: round(rect.width),
        height: round(rect.height),
      },
      markedTarget: element.hasAttribute("data-helium-video-space-target"),
      markedAncestor: element.hasAttribute("data-helium-video-space-ancestor"),
    };
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
    return entry;
  }

  function cleanMessage(message) {
    if (!message || typeof message !== "object") return message;
    return cleanValue(message);
  }

  function cleanValue(value, depth = 0) {
    if (depth > 5) return "[depth-limit]";
    if (value == null) return value;
    if (["string", "number", "boolean"].includes(typeof value)) return value;
    if (value instanceof Error) return errorInfo(value);
    if (value instanceof Element) return describeElement(value);
    if (Array.isArray(value)) {
      return value.slice(0, 30).map((item) => cleanValue(item, depth + 1));
    }
    if (typeof value === "object") {
      const output = {};
      for (const [key, item] of Object.entries(value).slice(0, 60)) {
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

  function finiteNumber(value) {
    return Number.isFinite(value) ? round(value) : null;
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
