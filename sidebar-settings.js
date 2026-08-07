/*
  Live bookmark-sidebar preferences.

  This prelude captures the extension's closed shadow root before content.js
  creates it, applies user-controlled dimensions and presentation settings, and
  keeps the bookmarks sidebar permanently visible on options.html without
  changing the user's global pinned state.
*/

(() => {
  "use strict";

  const DEFAULTS = Object.freeze({
    bookmarkSidebarWidth: 210,
    bookmarkRowHeight: 30,
    bookmarkFontSize: 12,
    bookmarkEdgeWidth: 6,
    bookmarkShowFolderCounts: true,
    bookmarkRowHover: true,
    bookmarkScrollbarMode: "auto",
  });

  const listeners = new Set();
  const settingsPage =
    location.protocol === "chrome-extension:" &&
    location.pathname.endsWith("/options.html");

  let current = { ...DEFAULTS };
  let shadowRoot = null;
  let host = null;

  const previousAttachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function heliumSettingsAttachShadow(init) {
    const root = previousAttachShadow.call(this, init);
    if (!shadowRoot) {
      shadowRoot = root;
      host = this;
      queueMicrotask(setup);
    }
    return root;
  };

  const ready = loadSettings();

  globalThis.HeliumSidebarSettings = {
    defaults: { ...DEFAULTS },
    ready,
    get(key) {
      return current[key];
    },
    snapshot() {
      return { ...current };
    },
    onChange(listener) {
      if (typeof listener !== "function") return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    isSettingsPage: settingsPage,
  };

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") return;

    let changed = false;
    const next = { ...current };
    for (const key of Object.keys(DEFAULTS)) {
      if (!changes[key]) continue;
      next[key] = normalize(key, changes[key].newValue);
      changed = true;
    }

    if (!changed) return;
    current = next;
    apply();
    for (const listener of listeners) {
      try {
        listener({ ...current });
      } catch {
        // A consumer may have been removed with its page.
      }
    }
  });

  async function loadSettings() {
    try {
      const stored = await chrome.storage.sync.get(DEFAULTS);
      current = Object.fromEntries(
        Object.keys(DEFAULTS).map((key) => [key, normalize(key, stored[key])])
      );
    } catch {
      current = { ...DEFAULTS };
    }
    apply();
    return { ...current };
  }

  function setup() {
    if (!shadowRoot || !host) return;
    ensureStyles();
    apply();

    if (settingsPage) {
      host.setAttribute("data-helium-settings-page", "");
      const observer = new MutationObserver(() => {
        shadowRoot
          .getElementById("sidebarShell")
          ?.classList.add("open");
      });
      observer.observe(shadowRoot, { childList: true, subtree: true });
    }
  }

  function apply() {
    if (!host) return;

    const width = normalize("bookmarkSidebarWidth", current.bookmarkSidebarWidth);
    const rowHeight = normalize("bookmarkRowHeight", current.bookmarkRowHeight);
    const fontSize = normalize("bookmarkFontSize", current.bookmarkFontSize);
    const edgeWidth = normalize("bookmarkEdgeWidth", current.bookmarkEdgeWidth);

    host.style.setProperty("--panel-width", `${width}px`);
    host.style.setProperty("--row-height", `${rowHeight}px`);
    host.style.setProperty("--folder-height", `${Math.max(24, rowHeight - 2)}px`);
    host.style.setProperty("--font-size", `${fontSize}px`);
    host.style.setProperty("--helium-edge-width", `${edgeWidth}px`);

    host.setAttribute(
      "data-helium-folder-counts",
      current.bookmarkShowFolderCounts ? "show" : "hide"
    );
    host.setAttribute(
      "data-helium-row-hover",
      current.bookmarkRowHover ? "show" : "hide"
    );
    host.setAttribute(
      "data-helium-scrollbar",
      current.bookmarkScrollbarMode === "hidden" ? "hidden" : "auto"
    );

    if (settingsPage) {
      host.setAttribute("data-helium-settings-page", "");
      shadowRoot?.getElementById("sidebarShell")?.classList.add("open");
    }
  }

  function ensureStyles() {
    if (!shadowRoot || shadowRoot.getElementById("heliumSidebarPreferences")) {
      return;
    }

    const style = document.createElement("style");
    style.id = "heliumSidebarPreferences";
    style.textContent = `
      .edge-trigger {
        width: var(--helium-edge-width, 6px) !important;
      }

      .search,
      .folder-name,
      .bookmark-title,
      .empty {
        font-size: var(--font-size, 12px) !important;
      }

      .folder-count {
        font-size: max(9px, calc(var(--font-size, 12px) - 1px)) !important;
      }

      :host([data-helium-folder-counts="hide"]) .folder-count {
        display: none !important;
      }

      :host([data-helium-row-hover="hide"]) .bookmark:hover {
        color: inherit !important;
        background: transparent !important;
      }

      :host([data-helium-scrollbar="hidden"]) .overlay-scrollbar {
        display: none !important;
      }

      :host([data-helium-settings-page]) .edge-trigger {
        display: none !important;
      }

      :host([data-helium-settings-page]) .sidebar-shell,
      :host([data-helium-settings-page]) .sidebar-shell.open {
        top: 16px !important;
        right: 16px !important;
        bottom: 16px !important;
        visibility: visible !important;
        opacity: 1 !important;
        pointer-events: auto !important;
        transform: none !important;
        transition: none !important;
      }

      :host([data-helium-settings-page]) .pin-button,
      :host([data-helium-settings-page]) .footer-shortcuts {
        display: none !important;
      }

      :host([data-helium-settings-page]) .sidebar {
        box-shadow: 0 18px 60px rgba(0, 0, 0, .34) !important;
      }
    `;
    shadowRoot.appendChild(style);
  }

  function normalize(key, value) {
    switch (key) {
      case "bookmarkSidebarWidth":
        return clampNumber(value, 180, 420, DEFAULTS[key]);
      case "bookmarkRowHeight":
        return clampNumber(value, 26, 38, DEFAULTS[key]);
      case "bookmarkFontSize":
        return clampNumber(value, 11, 15, DEFAULTS[key]);
      case "bookmarkEdgeWidth":
        return clampNumber(value, 3, 18, DEFAULTS[key]);
      case "bookmarkShowFolderCounts":
      case "bookmarkRowHover":
        return value !== false;
      case "bookmarkScrollbarMode":
        return value === "hidden" ? "hidden" : "auto";
      default:
        return DEFAULTS[key];
    }
  }

  function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, Math.round(number)));
  }
})();
