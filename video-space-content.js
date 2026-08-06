/*
  Generic PR #17-style video fullscreen interception.

  Actual fullscreen controls are intercepted before the site enters document
  fullscreen. A fullscreenchange fallback handles players whose controls cannot
  be identified. The exact player is marked before the tab is moved so the same
  element and its controls can fill the temporary Helium window.
*/

(() => {
  "use strict";

  if (window.top !== window.self) return;

  const SETTING_KEY = "videoSeparateSpaceEnabled";
  const LEGACY_SETTING_KEY = "youtubeSeparateSpaceEnabled";
  const ENTER = "heliumYoutubeSpaceEnter";
  const EXIT = "heliumYoutubeSpaceExit";
  const ACTIVATE = "heliumYoutubeSpaceActivate";
  const DEACTIVATE = "heliumYoutubeSpaceDeactivate";

  const ROOT = "data-helium-video-space";
  const TARGET = "data-helium-video-space-target";
  const PATH = "data-helium-video-space-path";
  const STYLE_ID = "helium-video-space-style";

  const KNOWN_FULLSCREEN_CONTROL_SELECTOR = [
    ".ytp-fullscreen-button",
    "[data-plyr='fullscreen']",
    ".vjs-fullscreen-control",
    ".jw-icon-fullscreen",
    ".shaka-fullscreen-button",
    "[data-testid*='fullscreen' i]",
    "[data-testid*='full-screen' i]",
  ].join(", ");

  const INTERACTIVE_SELECTOR = [
    "button",
    "[role='button']",
    "input[type='button']",
    "input[type='image']",
    "a[href]",
  ].join(", ");

  let enabled = true;
  let pending = false;
  let activeSessionId = "";
  let playerTarget = null;
  let markedPath = [];
  let fallbackInProgress = false;

  loadSetting();

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") return;
    if (!changes[SETTING_KEY] && !changes[LEGACY_SETTING_KEY]) return;
    enabled = changes[SETTING_KEY]
      ? changes[SETTING_KEY].newValue !== false
      : changes[LEGACY_SETTING_KEY].newValue !== false;
    if (!enabled && activeSessionId) requestExit("setting-disabled");
  });

  window.addEventListener("click", handleClick, true);
  window.addEventListener("keydown", handleKey, true);
  document.addEventListener("fullscreenchange", handleFullscreenChange, true);
  document.addEventListener("webkitfullscreenchange", handleFullscreenChange, true);

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id && sender.id !== chrome.runtime.id) return false;

    if (message?.type === ACTIVATE) {
      activate(String(message.sessionId || ""));
      sendResponse({ ok: true });
      return false;
    }

    if (message?.type === DEACTIVATE) {
      deactivate();
      sendResponse({ ok: true });
      return false;
    }

    return false;
  });

  function loadSetting() {
    chrome.storage.sync.get(
      { [SETTING_KEY]: null, [LEGACY_SETTING_KEY]: true },
      (result) => {
        if (chrome.runtime.lastError) return;
        enabled =
          result[SETTING_KEY] == null
            ? result[LEGACY_SETTING_KEY] !== false
            : result[SETTING_KEY] !== false;
      }
    );
  }

  function handleClick(event) {
    if (!enabled || event.button !== 0 || pending) return;

    const control = findFullscreenControl(event.composedPath());
    if (!control) return;

    const target = findPlayerForControl(control) || findBestPlayer();
    if (!target) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    event.stopPropagation();

    if (activeSessionId) {
      requestExit("fullscreen-control");
    } else {
      setPlayerTarget(target);
      requestEnter("fullscreen-control");
    }
  }

  function handleKey(event) {
    if (!enabled || pending || event.repeat) return;
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    if (isEditable(event.composedPath())) return;

    if (event.key === "Escape" && activeSessionId) {
      event.preventDefault();
      event.stopImmediatePropagation();
      requestExit("escape");
      return;
    }

    if (String(event.key).toLowerCase() !== "f") return;

    const target = findBestPlayer();
    if (!target) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    event.stopPropagation();

    if (activeSessionId) {
      requestExit("keyboard-f");
    } else {
      setPlayerTarget(target);
      requestEnter("keyboard-f");
    }
  }

  function handleFullscreenChange() {
    if (!enabled || activeSessionId || pending || fallbackInProgress) return;

    const fullscreenElement =
      document.fullscreenElement || document.webkitFullscreenElement;
    if (!(fullscreenElement instanceof Element)) return;

    const target = chooseTargetFromFullscreenElement(fullscreenElement);
    if (!target) return;

    fallbackInProgress = true;
    setPlayerTarget(target);

    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    Promise.resolve(
      typeof exit === "function" ? exit.call(document) : undefined
    )
      .catch(() => {})
      .then(() => waitForNativeFullscreenExit())
      .then(() => requestEnter("fullscreenchange-fallback"))
      .finally(() => {
        fallbackInProgress = false;
      });
  }

  function findFullscreenControl(path) {
    for (const item of path) {
      if (!(item instanceof Element)) continue;

      if (item.matches(KNOWN_FULLSCREEN_CONTROL_SELECTOR)) {
        return item;
      }

      if (!item.matches(INTERACTIVE_SELECTOR)) continue;

      const labels = [
        item.getAttribute("aria-label"),
        item.getAttribute("title"),
        item.getAttribute("data-title-no-tooltip"),
        item.getAttribute("data-tooltip-text"),
        item.getAttribute("data-tooltip"),
      ]
        .filter((value) => typeof value === "string")
        .map(normalizeLabel)
        .filter(Boolean);

      if (labels.some(isFullscreenLabel)) return item;
    }

    return null;
  }

  function normalizeLabel(value) {
    return String(value)
      .toLowerCase()
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isFullscreenLabel(value) {
    return /^(?:enter |exit |toggle )?full ?screen(?: mode)?$/.test(value);
  }

  function findPlayerForControl(control) {
    const youtube = control.closest("#movie_player.html5-video-player");
    if (youtube && hasVisibleVideo(youtube)) return youtube;

    const known = control.closest(
      ".html5-video-player, .video-js, .jwplayer, .plyr, " +
        "[data-shaka-player-container], [data-video-player], " +
        "[class*='video-player'], [class*='media-player']"
    );
    if (known && hasVisibleVideo(known)) return known;

    let current = control.parentElement;
    for (let depth = 0; current && depth < 9; depth += 1) {
      if (current.querySelector?.("video")) {
        const rect = current.getBoundingClientRect();
        const area = rect.width * rect.height;
        const viewport = Math.max(1, innerWidth * innerHeight);

        if (
          rect.width >= 160 &&
          rect.height >= 90 &&
          area <= viewport * 1.4
        ) {
          return current;
        }
      }
      current = current.parentElement;
    }

    return null;
  }

  function chooseTargetFromFullscreenElement(element) {
    if (element.matches("iframe")) return element;
    if (element.matches("video")) return findPlayerContainer(element);

    const video = bestVideoInside(element);
    if (!video) return null;

    const known = element.matches(
      "#movie_player, .html5-video-player, .video-js, .jwplayer, .plyr, " +
        "[data-shaka-player-container]"
    );

    return known ? element : findPlayerContainer(video, element);
  }

  function findBestPlayer() {
    const youtube = document.querySelector("#movie_player.html5-video-player");
    if (youtube && hasVisibleVideo(youtube)) return youtube;

    const videos = [...document.querySelectorAll("video")].filter(isVisibleVideo);
    if (!videos.length) return null;

    videos.sort((a, b) => videoScore(b) - videoScore(a));
    return findPlayerContainer(videos[0]);
  }

  function findPlayerContainer(video, boundary = null) {
    const viewportArea = Math.max(1, innerWidth * innerHeight);
    const videoRect = video.getBoundingClientRect();
    const videoArea = Math.max(1, videoRect.width * videoRect.height);

    let best = video;
    let current = video.parentElement;

    for (let depth = 0; current && depth < 9; depth += 1) {
      if (boundary && !boundary.contains(current) && current !== boundary) break;
      if (current === document.body || current === document.documentElement) break;

      const rect = current.getBoundingClientRect();
      const area = Math.max(0, rect.width * rect.height);
      const identity = `${current.id || ""} ${String(current.className || "")}`;
      const hinted =
        /player|video|media|fullscreen|html5|vjs|jw|plyr|shaka/i.test(identity);
      const wraps =
        area >= videoArea * 0.9 &&
        area <= videoArea * 4 &&
        area <= viewportArea * 1.25;

      if (wraps || (hinted && area <= viewportArea * 1.25)) best = current;
      if (boundary && current === boundary) break;

      current = current.parentElement;
    }

    return best;
  }

  function bestVideoInside(element) {
    const videos = [...element.querySelectorAll("video")].filter(isVisibleVideo);
    if (!videos.length) return null;

    videos.sort((a, b) => videoScore(b) - videoScore(a));
    return videos[0];
  }

  function hasVisibleVideo(element) {
    return [...element.querySelectorAll("video")].some(isVisibleVideo);
  }

  function isVisibleVideo(video) {
    const rect = video.getBoundingClientRect();
    return rect.width >= 120 && rect.height >= 68;
  }

  function videoScore(video) {
    const rect = video.getBoundingClientRect();
    const playing = !video.paused && !video.ended ? 1_000_000_000 : 0;
    return playing + rect.width * rect.height;
  }

  function isEditable(path) {
    return path.some(
      (item) =>
        item instanceof Element &&
        Boolean(
          item.closest(
            "input, textarea, select, [contenteditable='true'], [role='textbox']"
          )
        )
    );
  }

  function setPlayerTarget(target) {
    clearMarks();
    if (!(target instanceof Element)) return;

    playerTarget = target;
    target.setAttribute(TARGET, "");

    let current = target.parentElement;
    while (current && current !== document.documentElement) {
      current.setAttribute(PATH, "");
      markedPath.push(current);
      current = current.parentElement;
    }
  }

  function clearMarks() {
    if (playerTarget instanceof Element) {
      playerTarget.removeAttribute(TARGET);
    }

    for (const element of markedPath) {
      element.removeAttribute(PATH);
    }

    markedPath = [];
  }

  async function requestEnter(reason) {
    if (!enabled || pending || activeSessionId || !playerTarget) return;

    pending = true;
    try {
      const response = await sendMessage({ type: ENTER, reason });
      if (!response?.ok) {
        throw new Error(response?.error || "Fullscreen transfer failed");
      }
      if (response.sessionId) activate(String(response.sessionId));
    } catch (error) {
      console.error("[helium-tweaks] video fullscreen entry failed:", error);
      clearMarks();
      playerTarget = null;
    } finally {
      pending = false;
    }
  }

  async function requestExit(reason) {
    if (pending || !activeSessionId) return;

    pending = true;
    try {
      await sendMessage({
        type: EXIT,
        sessionId: activeSessionId,
        reason,
      });
    } catch (error) {
      console.error("[helium-tweaks] video fullscreen exit failed:", error);
    } finally {
      pending = false;
    }
  }

  function activate(sessionId) {
    if (!sessionId) return;

    if (!(playerTarget instanceof Element) || !playerTarget.isConnected) {
      playerTarget = findBestPlayer();
      if (playerTarget) setPlayerTarget(playerTarget);
    }

    if (!playerTarget) return;

    activeSessionId = sessionId;
    ensureStyle();
    document.documentElement.setAttribute(ROOT, sessionId);
    requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
  }

  function deactivate() {
    activeSessionId = "";
    pending = false;
    document.documentElement.removeAttribute(ROOT);
    clearMarks();
    playerTarget = null;
    requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      html[${ROOT}],
      html[${ROOT}] body {
        width: 100% !important;
        height: 100% !important;
        margin: 0 !important;
        padding: 0 !important;
        overflow: hidden !important;
        background: #000 !important;
      }

      html[${ROOT}] body > :not([${PATH}]):not([${TARGET}]) {
        display: none !important;
      }

      html[${ROOT}] [${PATH}] > :not([${PATH}]):not([${TARGET}]) {
        display: none !important;
      }

      html[${ROOT}] [${TARGET}] {
        position: fixed !important;
        z-index: 2147483647 !important;
        inset: 0 !important;
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
      }

      html[${ROOT}] [${TARGET}] > video,
      html[${ROOT}] [${TARGET}] video:not([${TARGET}]) {
        position: absolute !important;
        inset: 0 !important;
        width: 100% !important;
        height: 100% !important;
        max-width: none !important;
        max-height: none !important;
        margin: 0 !important;
        object-fit: contain !important;
        background: #000 !important;
        transform: none !important;
      }

      html[${ROOT}] video[${TARGET}] {
        width: 100vw !important;
        height: 100vh !important;
        max-width: none !important;
        max-height: none !important;
        object-fit: contain !important;
        background: #000 !important;
      }

      html[${ROOT}] #movie_player[${TARGET}] .html5-video-container {
        position: absolute !important;
        inset: 0 !important;
        width: 100% !important;
        height: 100% !important;
      }

      html[${ROOT}] #movie_player[${TARGET}] video.html5-main-video {
        position: absolute !important;
        left: 0 !important;
        top: 0 !important;
        width: 100% !important;
        height: 100% !important;
        max-width: none !important;
        max-height: none !important;
        margin: 0 !important;
        object-fit: contain !important;
        transform: none !important;
      }

      html[${ROOT}] iframe[${TARGET}] {
        border: 0 !important;
      }
    `;

    (document.head || document.documentElement).appendChild(style);
  }

  async function waitForNativeFullscreenExit() {
    const deadline = Date.now() + 1800;

    while (Date.now() < deadline) {
      const current =
        document.fullscreenElement || document.webkitFullscreenElement;

      if (!current) {
        await new Promise((resolve) => setTimeout(resolve, 220));
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }

  function sendMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response);
      });
    });
  }
})();
