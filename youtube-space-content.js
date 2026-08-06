/*
  Generic separate-Space video fullscreen controller.

  The site is allowed to enter its own real Fullscreen API state first. Once a
  video/player/embedded media frame is actually fullscreen, the service worker
  moves the same tab into a temporary fullscreen Helium window. The exact
  fullscreen element is retained as a CSS fallback in case moving the tab makes
  Chromium leave document fullscreen.
*/

(() => {
  "use strict";

  if (window.top !== window.self) return;

  const SETTING_KEY = "videoSeparateSpaceEnabled";
  const LEGACY_SETTING_KEY = "youtubeSeparateSpaceEnabled";
  const ENTER_MESSAGE = "heliumYoutubeSpaceEnter";
  const EXIT_MESSAGE = "heliumYoutubeSpaceExit";
  const ACTIVATE_MESSAGE = "heliumYoutubeSpaceActivate";
  const DEACTIVATE_MESSAGE = "heliumYoutubeSpaceDeactivate";
  const STYLE_ID = "helium-video-space-style";
  const ROOT_ATTRIBUTE = "data-helium-video-space";
  const TARGET_ATTRIBUTE = "data-helium-video-space-target";
  const ANCESTOR_ATTRIBUTE = "data-helium-video-space-ancestor";
  const EXIT_GRACE_MS = 1800;

  let enabled = true;
  let requestPending = false;
  let activeSessionId = "";
  let activationAt = 0;
  let fullscreenTarget = null;
  let markedAncestors = [];

  loadSetting();

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") return;
    if (!changes[SETTING_KEY] && !changes[LEGACY_SETTING_KEY]) return;

    if (changes[SETTING_KEY]) {
      enabled = changes[SETTING_KEY].newValue !== false;
    } else if (changes[LEGACY_SETTING_KEY]) {
      enabled = changes[LEGACY_SETTING_KEY].newValue !== false;
    }

    if (!enabled && activeSessionId) requestExit("setting-disabled");
  });

  document.addEventListener("fullscreenchange", handleFullscreenChange, true);
  document.addEventListener("webkitfullscreenchange", handleFullscreenChange, true);
  window.addEventListener("keydown", handleKeydown, true);

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
      chrome.storage.sync.get(
        { [SETTING_KEY]: null, [LEGACY_SETTING_KEY]: true },
        (result) => {
          if (chrome.runtime.lastError) {
            void chrome.runtime.lastError;
            return;
          }
          enabled =
            result[SETTING_KEY] == null
              ? result[LEGACY_SETTING_KEY] !== false
              : result[SETTING_KEY] !== false;
        }
      );
    } catch {
      enabled = true;
    }
  }

  function handleFullscreenChange() {
    const current = getFullscreenElement();

    if (current) {
      if (!enabled || activeSessionId || requestPending) return;
      if (!looksLikeFullscreenMedia(current)) return;

      fullscreenTarget = current;
      markFullscreenTarget(current);
      requestEnter("document-fullscreen");
      return;
    }

    if (
      activeSessionId &&
      !requestPending &&
      Date.now() - activationAt > EXIT_GRACE_MS
    ) {
      requestExit("document-fullscreen-exit");
    }
  }

  function handleKeydown(event) {
    if (!activeSessionId || event.key !== "Escape") return;

    event.preventDefault();
    event.stopImmediatePropagation();
    event.stopPropagation();
    requestExit("escape");
  }

  function getFullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }

  function looksLikeFullscreenMedia(element) {
    if (!(element instanceof Element)) return false;

    if (element.matches("video")) return true;
    if (element.querySelector("video")) return true;

    if (element.matches("iframe")) {
      const allow = String(element.getAttribute("allow") || "").toLowerCase();
      return (
        element.hasAttribute("allowfullscreen") ||
        element.hasAttribute("webkitallowfullscreen") ||
        allow.includes("fullscreen")
      );
    }

    const visibleVideos = [...document.querySelectorAll("video")].filter(
      isVisibleVideo
    );
    return visibleVideos.some((video) => element.contains(video));
  }

  function isVisibleVideo(video) {
    const rect = video.getBoundingClientRect();
    return rect.width >= 120 && rect.height >= 68;
  }

  async function requestEnter(reason) {
    if (!enabled || requestPending || activeSessionId || !fullscreenTarget) return;
    requestPending = true;

    try {
      const response = await sendMessage({ type: ENTER_MESSAGE, reason });
      if (!response?.ok) {
        throw new Error(response?.error || "Separate-Space fullscreen failed");
      }
      if (response.sessionId) activateSpaceMode(String(response.sessionId));
    } catch (error) {
      clearTargetMarks();
      fullscreenTarget = null;
      console.error("[helium-tweaks] video fullscreen entry failed:", error);
    } finally {
      requestPending = false;
    }
  }

  async function requestExit(reason) {
    if (requestPending || !activeSessionId) return;
    const sessionId = activeSessionId;
    requestPending = true;

    try {
      await sendMessage({ type: EXIT_MESSAGE, sessionId, reason });
    } catch (error) {
      console.error("[helium-tweaks] video fullscreen exit failed:", error);
    } finally {
      requestPending = false;
    }
  }

  function activateSpaceMode(sessionId) {
    if (!sessionId) return;

    const target =
      (fullscreenTarget && fullscreenTarget.isConnected && fullscreenTarget) ||
      getFullscreenElement() ||
      findBestVideoTarget();

    if (!target) return;

    fullscreenTarget = target;
    activeSessionId = sessionId;
    activationAt = Date.now();
    markFullscreenTarget(target);
    ensurePlayerStyle();
    document.documentElement.setAttribute(ROOT_ATTRIBUTE, sessionId);

    requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
  }

  function deactivateSpaceMode() {
    activeSessionId = "";
    requestPending = false;
    activationAt = 0;

    const fullscreenElement = getFullscreenElement();
    if (fullscreenElement) {
      const exitFullscreen =
        document.exitFullscreen || document.webkitExitFullscreen;
      if (typeof exitFullscreen === "function") {
        Promise.resolve(exitFullscreen.call(document)).catch(() => {});
      }
    }

    document.documentElement.removeAttribute(ROOT_ATTRIBUTE);
    clearTargetMarks();
    fullscreenTarget = null;
    requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
  }

  function findBestVideoTarget() {
    const videos = [...document.querySelectorAll("video")].filter(isVisibleVideo);
    if (videos.length === 0) return null;

    videos.sort((left, right) => videoScore(right) - videoScore(left));
    const video = videos[0];
    return findPlayerContainer(video);
  }

  function videoScore(video) {
    const rect = video.getBoundingClientRect();
    const playbackBonus = !video.paused && !video.ended ? 1_000_000_000 : 0;
    return playbackBonus + rect.width * rect.height;
  }

  function findPlayerContainer(video) {
    let candidate = video;
    let current = video.parentElement;
    let depth = 0;
    const videoRect = video.getBoundingClientRect();
    const videoArea = Math.max(1, videoRect.width * videoRect.height);
    const viewportArea = Math.max(1, innerWidth * innerHeight);

    while (
      current &&
      current !== document.body &&
      current !== document.documentElement &&
      depth < 8
    ) {
      const rect = current.getBoundingClientRect();
      const area = Math.max(0, rect.width * rect.height);
      const identity = `${current.id || ""} ${current.className || ""}`;
      const playerHint =
        /(?:^|[\s_-])(player|video|media|fullscreen|html5|vjs|jw|plyr|shaka)(?:$|[\s_-])/i.test(
          identity
        ) || current.getAttribute("role") === "application";
      const closelyWrapsVideo =
        area >= videoArea * 0.9 &&
        area <= videoArea * 3.5 &&
        rect.width <= innerWidth * 1.1 &&
        rect.height <= innerHeight * 1.1;

      if (closelyWrapsVideo || (playerHint && area <= viewportArea * 1.1)) {
        candidate = current;
      }

      if (area > viewportArea * 1.2 && !playerHint) break;
      current = current.parentElement;
      depth += 1;
    }

    return candidate;
  }

  function markFullscreenTarget(target) {
    clearTargetMarks();
    if (!(target instanceof Element)) return;

    target.setAttribute(TARGET_ATTRIBUTE, "");
    let current = target.parentElement;
    while (current && current !== document.documentElement) {
      current.setAttribute(ANCESTOR_ATTRIBUTE, "");
      markedAncestors.push(current);
      current = current.parentElement;
    }
  }

  function clearTargetMarks() {
    if (fullscreenTarget instanceof Element) {
      fullscreenTarget.removeAttribute(TARGET_ATTRIBUTE);
    }
    for (const element of markedAncestors) {
      element.removeAttribute(ANCESTOR_ATTRIBUTE);
    }
    markedAncestors = [];
  }

  function ensurePlayerStyle() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      html[${ROOT_ATTRIBUTE}],
      html[${ROOT_ATTRIBUTE}] body {
        width: 100% !important;
        height: 100% !important;
        margin: 0 !important;
        padding: 0 !important;
        overflow: hidden !important;
        background: #000 !important;
      }

      html[${ROOT_ATTRIBUTE}] body * {
        visibility: hidden !important;
      }

      html[${ROOT_ATTRIBUTE}] [${ANCESTOR_ATTRIBUTE}],
      html[${ROOT_ATTRIBUTE}] [${TARGET_ATTRIBUTE}],
      html[${ROOT_ATTRIBUTE}] [${TARGET_ATTRIBUTE}] * {
        visibility: visible !important;
      }

      html[${ROOT_ATTRIBUTE}] [${TARGET_ATTRIBUTE}] {
        position: fixed !important;
        z-index: 2147483647 !important;
        inset: 0 !important;
        display: block !important;
        width: 100vw !important;
        height: 100vh !important;
        min-width: 100vw !important;
        min-height: 100vh !important;
        max-width: none !important;
        max-height: none !important;
        margin: 0 !important;
        padding: 0 !important;
        border: 0 !important;
        border-radius: 0 !important;
        overflow: hidden !important;
        background: #000 !important;
        transform: none !important;
        object-fit: contain !important;
      }

      html[${ROOT_ATTRIBUTE}] [${TARGET_ATTRIBUTE}] video {
        position: absolute !important;
        inset: 0 !important;
        width: 100% !important;
        height: 100% !important;
        max-width: none !important;
        max-height: none !important;
        margin: 0 !important;
        object-fit: contain !important;
        background: #000 !important;
      }

      html[${ROOT_ATTRIBUTE}] iframe[${TARGET_ATTRIBUTE}] {
        border: 0 !important;
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
