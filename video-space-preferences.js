/*
  Preference gate for the existing fullscreen-video controller.

  The working video-space-content.js implementation is left unchanged. This
  prelude wraps only its four event listeners while they are registered, then
  restores EventTarget.prototype.addEventListener. Disabled triggers fall
  through to the website's own native fullscreen handling.
*/

(() => {
  "use strict";

  if (window.top !== window.self) return;

  const DEFAULTS = Object.freeze({
    videoSpaceControlClickEnabled: true,
    videoSpaceKeyboardEnabled: true,
    videoSpaceEscapeEnabled: true,
    videoSpaceFallbackEnabled: true,
    videoSpaceExcludedSites: [],
  });

  let config = { ...DEFAULTS };
  let captured = 0;

  const nativeAddEventListener = EventTarget.prototype.addEventListener;
  const restoreTimer = setTimeout(restorePrototype, 15000);

  EventTarget.prototype.addEventListener = function preferenceAwareAdd(
    type,
    listener,
    options
  ) {
    const wrapped = wrapKnownVideoSpaceListener(this, type, listener);
    return nativeAddEventListener.call(this, type, wrapped, options);
  };

  loadConfig();

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") return;

    let changed = false;
    const next = { ...config };
    for (const key of Object.keys(DEFAULTS)) {
      if (!changes[key]) continue;
      next[key] = normalize(key, changes[key].newValue);
      changed = true;
    }
    if (changed) config = next;
  });

  function wrapKnownVideoSpaceListener(target, type, listener) {
    if (typeof listener !== "function") return listener;

    let source = "";
    try {
      source = Function.prototype.toString.call(listener);
    } catch {
      return listener;
    }

    if (target === window && type === "click" && source.includes("handleClick")) {
      return capture(function gatedFullscreenClick(event) {
        if (isExcludedSite() || !config.videoSpaceControlClickEnabled) return;
        return listener.call(this, event);
      });
    }

    if (
      target === window &&
      type === "keydown" &&
      source.includes("handleKey")
    ) {
      return capture(function gatedFullscreenKey(event) {
        if (isExcludedSite()) return;
        const key = String(event?.key || "").toLowerCase();
        if (key === "f" && !config.videoSpaceKeyboardEnabled) return;
        if (key === "escape" && !config.videoSpaceEscapeEnabled) return;
        return listener.call(this, event);
      });
    }

    if (
      target === document &&
      (type === "fullscreenchange" || type === "webkitfullscreenchange") &&
      source.includes("handleFullscreenChange")
    ) {
      return capture(function gatedFullscreenFallback(event) {
        if (isExcludedSite() || !config.videoSpaceFallbackEnabled) return;
        return listener.call(this, event);
      });
    }

    return listener;
  }

  function capture(listener) {
    captured += 1;
    if (captured >= 4) queueMicrotask(restorePrototype);
    return listener;
  }

  function restorePrototype() {
    clearTimeout(restoreTimer);
    if (EventTarget.prototype.addEventListener === preferenceAwareAdd) {
      EventTarget.prototype.addEventListener = nativeAddEventListener;
    }
  }

  function preferenceAwareAdd(type, listener, options) {
    const wrapped = wrapKnownVideoSpaceListener(this, type, listener);
    return nativeAddEventListener.call(this, type, wrapped, options);
  }

  async function loadConfig() {
    try {
      const stored = await chrome.storage.sync.get(DEFAULTS);
      config = Object.fromEntries(
        Object.keys(DEFAULTS).map((key) => [key, normalize(key, stored[key])])
      );
    } catch {
      config = { ...DEFAULTS };
    }
  }

  function isExcludedSite() {
    const host = location.hostname.toLowerCase();
    return normalizeSites(config.videoSpaceExcludedSites).some(
      (entry) => host === entry || host.endsWith(`.${entry}`)
    );
  }

  function normalize(key, value) {
    if (key === "videoSpaceExcludedSites") return normalizeSites(value);
    return value !== false;
  }

  function normalizeSites(value) {
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
