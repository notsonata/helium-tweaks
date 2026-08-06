/*
  Fullscreen-aware Auto PiP page controller.

  Normal tab switches may enter PiP for the largest playing video. The separate-
  Space fullscreen workflow is detected through its existing target/root markers
  and runtime messages, so moving the tab never opens a competing PiP window.
*/

(() => {
  "use strict";

  if (window.top !== window.self) return;

  const DEFAULTS = {
    autoPipEnabled: true,
    autoPipExitOnReturn: true,
    autoPipExcludedSites: [],
  };

  const TRY = "heliumAutoPiPTry";
  const RETURN = "heliumAutoPiPReturn";
  const SPACE_ACTIVATE = "heliumYoutubeSpaceActivate";
  const SPACE_DEACTIVATE = "heliumYoutubeSpaceDeactivate";
  const SPACE_ROOT = "data-helium-video-space";
  const SPACE_TARGET = "data-helium-video-space-target";

  let config = { ...DEFAULTS };
  let suppressedUntil = 0;
  let spaceSessionActive = false;
  let mediaSessionRegistered = false;
  let lastAttemptAt = 0;

  initialize().catch(() => {});

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id && sender.id !== chrome.runtime.id) return false;

    if (message?.type === TRY) {
      tryEnterPiP(String(message.reason || "tab-switch"))
        .then((result) => sendResponse(result))
        .catch((error) =>
          sendResponse({ ok: false, error: String(error?.message || error) })
        );
      return true;
    }

    if (message?.type === RETURN) {
      handleReturn()
        .then((result) => sendResponse(result))
        .catch((error) =>
          sendResponse({ ok: false, error: String(error?.message || error) })
        );
      return true;
    }

    if (message?.type === SPACE_ACTIVATE) {
      spaceSessionActive = true;
      suppressedUntil = Number.MAX_SAFE_INTEGER;
      exitPiP().catch(() => {});
      return false;
    }

    if (message?.type === SPACE_DEACTIVATE) {
      spaceSessionActive = false;
      suppressedUntil = Date.now() + 5000;
      return false;
    }

    return false;
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") return;
    if (
      !changes.autoPipEnabled &&
      !changes.autoPipExitOnReturn &&
      !changes.autoPipExcludedSites
    ) {
      return;
    }

    loadConfig()
      .then(syncMediaSessionHandler)
      .then(() => {
        if (!config.autoPipEnabled) return exitPiP();
      })
      .catch(() => {});
  });

  const markerObserver = new MutationObserver(() => {
    if (isSpaceTransition()) {
      exitPiP().catch(() => {});
    } else if (!spaceSessionActive && suppressedUntil === Number.MAX_SAFE_INTEGER) {
      suppressedUntil = Date.now() + 3500;
    }
  });

  markerObserver.observe(document.documentElement, {
    attributes: true,
    subtree: true,
    attributeFilter: [SPACE_ROOT, SPACE_TARGET],
  });

  async function initialize() {
    await loadConfig();
    await syncMediaSessionHandler();
  }

  async function loadConfig() {
    try {
      const stored = await chrome.storage.sync.get(DEFAULTS);
      config = {
        autoPipEnabled: stored.autoPipEnabled !== false,
        autoPipExitOnReturn: stored.autoPipExitOnReturn !== false,
        autoPipExcludedSites: normalizeExcludedSites(
          stored.autoPipExcludedSites
        ),
      };
    } catch {
      config = { ...DEFAULTS };
    }
  }

  async function syncMediaSessionHandler() {
    const shouldRegister =
      config.autoPipEnabled &&
      !isExcludedSite() &&
      navigator.mediaSession &&
      typeof navigator.mediaSession.setActionHandler === "function";

    if (!shouldRegister) {
      unregisterMediaSessionHandler();
      return;
    }

    try {
      navigator.mediaSession.setActionHandler(
        "enterpictureinpicture",
        async () => {
          await tryEnterPiP("browser-auto-pip");
        }
      );
      mediaSessionRegistered = true;
    } catch {
      mediaSessionRegistered = false;
    }
  }

  function unregisterMediaSessionHandler() {
    if (!mediaSessionRegistered || !navigator.mediaSession) return;
    try {
      navigator.mediaSession.setActionHandler("enterpictureinpicture", null);
    } catch {
      // The action may not be supported by this Chromium build.
    }
    mediaSessionRegistered = false;
  }

  async function tryEnterPiP(reason) {
    if (!config.autoPipEnabled) return { ok: true, entered: false, reason: "disabled" };
    if (isExcludedSite()) return { ok: true, entered: false, reason: "excluded-site" };
    if (isSuppressed()) return { ok: true, entered: false, reason: "fullscreen-suppressed" };
    if (!document.pictureInPictureEnabled) {
      return { ok: true, entered: false, reason: "unsupported" };
    }
    if (document.pictureInPictureElement) {
      return { ok: true, entered: false, reason: "already-active" };
    }

    const now = Date.now();
    if (now - lastAttemptAt < 1200) {
      return { ok: true, entered: false, reason: "throttled" };
    }
    lastAttemptAt = now;

    const video = findBestPlayingVideo();
    if (!video) return { ok: true, entered: false, reason: "no-playing-video" };

    try {
      await video.requestPictureInPicture();
      return { ok: true, entered: true, reason };
    } catch (error) {
      console.debug(
        "[helium-auto-pip] PiP request was blocked:",
        error?.name || "Error",
        error?.message || error
      );
      return {
        ok: false,
        entered: false,
        error: String(error?.message || error),
      };
    }
  }

  async function handleReturn() {
    if (!config.autoPipEnabled || !config.autoPipExitOnReturn) {
      return { ok: true, exited: false };
    }
    if (isSpaceTransition()) return { ok: true, exited: false };
    const exited = await exitPiP();
    return { ok: true, exited };
  }

  async function exitPiP() {
    if (!document.pictureInPictureElement) return false;
    try {
      await document.exitPictureInPicture();
      return true;
    } catch {
      return false;
    }
  }

  function isSuppressed() {
    return (
      spaceSessionActive ||
      Date.now() < suppressedUntil ||
      isSpaceTransition() ||
      Boolean(document.fullscreenElement || document.webkitFullscreenElement)
    );
  }

  function isSpaceTransition() {
    return (
      document.documentElement.hasAttribute(SPACE_ROOT) ||
      Boolean(document.querySelector(`[${SPACE_TARGET}]`))
    );
  }

  function findBestPlayingVideo() {
    const videos = collectVideos();
    let best = null;
    let bestScore = -1;

    for (const video of videos) {
      try {
        if (
          video.paused ||
          video.ended ||
          video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
          video.disablePictureInPicture
        ) {
          continue;
        }

        const rect = video.getBoundingClientRect();
        const area = Math.max(0, rect.width) * Math.max(0, rect.height);
        const visible =
          rect.bottom > 0 &&
          rect.right > 0 &&
          rect.top < innerHeight &&
          rect.left < innerWidth;
        const audible = video.muted || video.volume === 0 ? 0 : 1_000_000_000;
        const score = audible + area * (visible ? 1 : 0.2);

        if (score > bestScore) {
          bestScore = score;
          best = video;
        }
      } catch {
        // Ignore detached or protected media elements.
      }
    }

    return best;
  }

  function collectVideos() {
    const videos = [...document.querySelectorAll("video")];
    for (const frame of document.querySelectorAll("iframe")) {
      try {
        const frameDocument = frame.contentDocument;
        if (!frameDocument) continue;
        videos.push(...frameDocument.querySelectorAll("video"));
      } catch {
        // Cross-origin frames are intentionally inaccessible.
      }
    }
    return videos;
  }

  function isExcludedSite() {
    const host = location.hostname.toLowerCase();
    return config.autoPipExcludedSites.some(
      (entry) => host === entry || host.endsWith(`.${entry}`)
    );
  }

  function normalizeExcludedSites(value) {
    const entries = Array.isArray(value)
      ? value
      : String(value || "").split(/[\n,]+/);
    return [
      ...new Set(
        entries
          .map((entry) => String(entry).trim().toLowerCase())
          .map((entry) => entry.replace(/^https?:\/\//, "").split("/")[0])
          .filter(Boolean)
      ),
    ];
  }
})();
