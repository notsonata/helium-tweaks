/*
  Compatibility fixes loaded before content.js.

  This prelude keeps the existing sidebar implementation intact while fixing
  four edge cases:
    - block direct /favicon.ico requests to bookmarked sites
    - do not focus search when the panel opens from passive edge hover
    - hide the shortcut badge when Chromium reports no assigned command
    - ignore stale Port disconnect callbacks after a replacement connection
*/

(() => {
  "use strict";

  let shadowRoot = null;
  let actualShortcut;
  let suppressHoverFocus = false;
  let latestPortId = 0;

  /* Capture the extension's closed shadow root inside the content-script
     isolated world. Page scripts still receive null from host.shadowRoot. */
  const nativeAttachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function attachShadow(init) {
    const root = nativeAttachShadow.call(this, init);
    shadowRoot = root;
    queueMicrotask(setupShadowFixes);
    return root;
  };

  /* Stop the site-origin fallback from contacting every bookmarked domain.
     Chromium's extension _favicon endpoint remains allowed; failed loads keep
     the existing letter avatar. */
  const srcDescriptor = Object.getOwnPropertyDescriptor(
    HTMLImageElement.prototype,
    "src"
  );

  if (srcDescriptor?.get && srcDescriptor?.set) {
    Object.defineProperty(HTMLImageElement.prototype, "src", {
      configurable: srcDescriptor.configurable,
      enumerable: srcDescriptor.enumerable,
      get: srcDescriptor.get,
      set(value) {
        try {
          const url = new URL(String(value), location.href);
          if (
            (url.protocol === "http:" || url.protocol === "https:") &&
            url.pathname === "/favicon.ico"
          ) {
            queueMicrotask(() => this.dispatchEvent(new Event("error")));
            return;
          }
        } catch {
          /* Let the native setter handle malformed values. */
        }
        srcDescriptor.set.call(this, value);
      },
    });
  }

  /* Wrap content-script ports so an old port's late disconnect cannot clear
     or reconnect over the current replacement port. Also observe the shortcut
     message before content.js applies its display fallback. */
  const nativeConnect = chrome.runtime.connect.bind(chrome.runtime);
  chrome.runtime.connect = function connect(...args) {
    const realPort = nativeConnect(...args);
    const portId = ++latestPortId;

    realPort.onMessage.addListener((message) => {
      if (message?.type === "shortcut" && typeof message.label === "string") {
        actualShortcut = message.label.trim();
        queueMicrotask(syncShortcutBadge);
      }
    });

    return {
      get name() {
        return realPort.name;
      },
      get sender() {
        return realPort.sender;
      },
      onMessage: realPort.onMessage,
      onDisconnect: {
        addListener(listener) {
          realPort.onDisconnect.addListener((...eventArgs) => {
            if (portId !== latestPortId) return;
            listener(...eventArgs);
          });
        },
        removeListener(listener) {
          realPort.onDisconnect.removeListener(listener);
        },
        hasListener(listener) {
          return realPort.onDisconnect.hasListener(listener);
        },
      },
      postMessage(message) {
        return realPort.postMessage(message);
      },
      disconnect() {
        return realPort.disconnect();
      },
    };
  };

  /* Suppress only the programmatic focus caused by edge-hover opening. Toolbar
     and command opens still focus search, while clicking the field works
     normally. */
  const nativeFocus = HTMLElement.prototype.focus;
  HTMLElement.prototype.focus = function focus(options) {
    const searchInput = shadowRoot?.getElementById("searchInput");
    if (suppressHoverFocus && this === searchInput) return;
    return nativeFocus.call(this, options);
  };

  function setupShadowFixes() {
    if (!shadowRoot) return;

    const edge = shadowRoot.getElementById("edgeTrigger");
    const sidebar = shadowRoot.getElementById("sidebar");

    if (!edge || !sidebar) {
      queueMicrotask(setupShadowFixes);
      return;
    }

    edge.addEventListener("mouseenter", () => {
      suppressHoverFocus = true;
      setTimeout(() => {
        suppressHoverFocus = false;
      }, 260);
    });
    edge.addEventListener("mouseleave", () => {
      suppressHoverFocus = false;
    });
    sidebar.addEventListener("mouseenter", () => {
      suppressHoverFocus = false;
    });

    syncShortcutBadge();
  }

  function syncShortcutBadge() {
    const badge = shadowRoot?.getElementById("searchShortcut");
    if (!badge) return;

    /* Undefined means the service worker has not answered yet. Hide until the
       real assignment is known. Empty means unassigned/conflicted. */
    badge.style.display = actualShortcut ? "" : "none";
  }
})();
