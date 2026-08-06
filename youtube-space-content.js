/*
  YouTube separate-Space fullscreen controller.

  When enabled, YouTube's fullscreen button and the F shortcut are intercepted
  before YouTube enters document fullscreen. The service worker moves the same
  tab into a temporary fullscreen Helium window, while this script makes the
  player occupy the complete page viewport. The tab is not duplicated, so
  playback state, history, captions, and the current position are preserved.
*/

(() => {
  "use strict";

  if (window.top !== window.self) return;

  const SETTING_KEY = "youtubeSeparateSpaceEnabled";
  const ENTER_MESSAGE = "heliumYoutubeSpaceEnter";
  const EXIT_MESSAGE = "heliumYoutubeSpaceExit";
  const ACTIVATE_MESSAGE = "heliumYoutubeSpaceActivate";
  const DEACTIVATE_MESSAGE = "heliumYoutubeSpaceDeactivate";
  const STYLE_ID = "helium-youtube-space-style";
  const ROOT_ATTRIBUTE = "data-helium-youtube-space";

  let enabled = true;
  let requestPending = false;
  let activeSessionId = "";
  let fallbackExitPending = false;

  loadSetting();

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync" || !changes[SETTING_KEY]) return;
    enabled = changes[SETTING_KEY].newValue !== false;
    if (!enabled && activeSessionId) requestExit("setting-disabled");
  });

  window.addEventListener("click", handleFullscreenClick, true);
  window.addEventListener("keydown", handleFullscreenKey, true);
  document.addEventListener("fullscreenchange", handleUnexpectedFullscreen, true);
  window.addEventListener("pagehide", () => {
    if (activeSessionId) {
      sendMessage({
        type: EXIT_MESSAGE,
        sessionId: activeSessionId,
        reason: "pagehide",
      }).catch(() => {});
    }
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id && sender.id !== chrome.runtime.id) return false;

    if (message?.type === ACTIVATE_MESSAGE) {
      activateSpaceMode(String(message.sessionId || ""));
      sendResponse({ ok: true });
      return false;
    }

    if (message?.type === DEACTIVATE_MESSAGE) {
      deactivateSpaceMode();
      sendResponse({ ok: true });
      return false;
    }

    return false;
  });

  function loadSetting() {
    try {
      chrome.storage.sync.get({ [SETTING_KEY]: true }, (result) => {
        if (chrome.runtime.lastError) {
          void chrome.runtime.lastError;
          return;
        }
        enabled = result[SETTING_KEY] !== false;
      });
    } catch {
      enabled = true;
    }
  }

  function handleFullscreenClick(event) {
    if (!enabled || event.button !== 0) return;
    if (!isFullscreenButtonEvent(event)) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    event.stopPropagation();

    if (activeSessionId) {
      requestExit("fullscreen-button");
    } else {
      requestEnter("fullscreen-button");
    }
  }

  function handleFullscreenKey(event) {
    if (!enabled || event.defaultPrevented || event.repeat) return;
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;

    if (event.key === "Escape" && activeSessionId) {
      requestExit("escape");
      return;
    }

    if (String(event.key).toLowerCase() !== "f") return;
    if (isEditableTarget(event)) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    event.stopPropagation();

    if (activeSessionId) {
      requestExit("keyboard-f");
    } else {
      requestEnter("keyboard-f");
    }
  }

  function handleUnexpectedFullscreen() {
    if (!enabled || activeSessionId || requestPending) return;
    const fullscreenElement = document.fullscreenElement;
    if (!fullscreenElement || !looksLikeYouTubeVideoFullscreen(fullscreenElement)) {
      return;
    }

    if (!fallbackExitPending) {
      fallbackExitPending = true;
      Promise.resolve(document.exitFullscreen?.())
        .catch(() => {})
        .finally(() => {
          fallbackExitPending = false;
          requestEnter("fullscreenchange-fallback");
        });
    }
  }

  function isFullscreenButtonEvent(event) {
    return event.composedPath().some((item) => {
      return item instanceof Element && item.matches(".ytp-fullscreen-button");
    });
  }

  function isEditableTarget(event) {
    return event.composedPath().some((item) => {
      if (!(item instanceof Element)) return false;
      return Boolean(
        item.closest(
          "input, textarea, select, [contenteditable=''], [contenteditable='true'], [role='textbox']"
        )
      );
    });
  }

  function looksLikeYouTubeVideoFullscreen(element) {
    if (!(element instanceof Element)) return false;
    return Boolean(
      element.matches("#movie_player, .html5-video-player, video") ||
        element.querySelector?.("video.html5-main-video, #movie_player")
    );
  }

  async function requestEnter(reason) {
    if (!enabled || requestPending || activeSessionId) return;
    requestPending = true;

    try {
      const response = await sendMessage({ type: ENTER_MESSAGE, reason });
      if (!response?.ok) {
        throw new Error(response?.error || "Separate-Space fullscreen failed");
      }
      if (response.sessionId) activateSpaceMode(String(response.sessionId));
    } catch (error) {
      console.error("[helium-tweaks] YouTube fullscreen entry failed:", error);
    } finally {
      requestPending = false;
    }
  }

  async function requestExit(reason) {
    if (requestPending) return;
    const sessionId = activeSessionId;
    if (!sessionId) return;
    requestPending = true;

    try {
      await sendMessage({ type: EXIT_MESSAGE, sessionId, reason });
    } catch (error) {
      console.error("[helium-tweaks] YouTube fullscreen exit failed:", error);
    } finally {
      requestPending = false;
    }
  }

  function activateSpaceMode(sessionId) {
    if (!sessionId) return;
    activeSessionId = sessionId;
    document.documentElement.setAttribute(ROOT_ATTRIBUTE, sessionId);
    ensurePlayerStyle();
    requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
  }

  function deactivateSpaceMode() {
    activeSessionId = "";
    requestPending = false;
    document.documentElement.removeAttribute(ROOT_ATTRIBUTE);
    requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
  }

  function ensurePlayerStyle() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      html[${ROOT_ATTRIBUTE}] {
        overflow: hidden !important;
        background: #000 !important;
      }

      html[${ROOT_ATTRIBUTE}] body {
        overflow: hidden !important;
        background: #000 !important;
      }

      html[${ROOT_ATTRIBUTE}] #movie_player,
      html[${ROOT_ATTRIBUTE}] .html5-video-player {
        position: fixed !important;
        z-index: 2147483646 !important;
        inset: 0 !important;
        width: 100vw !important;
        height: 100vh !important;
        max-width: none !important;
        max-height: none !important;
        margin: 0 !important;
        border: 0 !important;
        border-radius: 0 !important;
        background: #000 !important;
        transform: none !important;
      }

      html[${ROOT_ATTRIBUTE}] #movie_player .html5-video-container,
      html[${ROOT_ATTRIBUTE}] #movie_player video.html5-main-video,
      html[${ROOT_ATTRIBUTE}] .html5-video-player .html5-video-container,
      html[${ROOT_ATTRIBUTE}] .html5-video-player video.html5-main-video {
        width: 100% !important;
        height: 100% !important;
        max-width: none !important;
        max-height: none !important;
      }

      html[${ROOT_ATTRIBUTE}] #movie_player video.html5-main-video,
      html[${ROOT_ATTRIBUTE}] .html5-video-player video.html5-main-video {
        left: 0 !important;
        top: 0 !important;
        object-fit: contain !important;
      }
    `;

    (document.head || document.documentElement).appendChild(style);
  }

  function sendMessage(message) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(response);
        });
      } catch (error) {
        reject(error);
      }
    });
  }
})();
