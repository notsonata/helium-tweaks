/*
  Restricted-page fallback.

  Chromium does not permit content-script injection into browser-owned pages
  such as chrome://, helium://, the Chrome Web Store, or pages owned by another
  extension. When the normal sidebar cannot answer an action click, open an
  extension-owned tab that loads the same sidebar scripts directly.
*/

(() => {
  "use strict";

  const PORT_NAME = "helium-bookmarks";
  const FALLBACK_PAGE = "bookmarks.html";
  const OPEN_RETRY_MS = 50;
  const OPEN_RETRY_LIMIT = 40;
  const connectedPorts = new Map();

  /* Keep a separate, read-only routing index instead of reaching into private
     state owned by background.js. Both listeners receive the same Port. */
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== PORT_NAME) return;

    const tabId = port.sender?.tab?.id;
    if (typeof tabId !== "number") return;

    connectedPorts.set(tabId, port);
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (connectedPorts.get(tabId) === port) connectedPorts.delete(tabId);
    });
  });

  chrome.action.onClicked.addListener(async (tab) => {
    if (!tab || typeof tab.id !== "number") return;

    /* background.js owns normal action routing. A live port proves this tab
       already has the sidebar, including our extension-owned fallback page. */
    if (connectedPorts.has(tab.id)) return;

    /* A page may have a content script before its long-lived port is visible.
       Give it one direct chance before falling back. This also covers ordinary
       pages opened during service-worker startup. */
    try {
      const response = await chrome.tabs.sendMessage(tab.id, {
        type: "openAndFocus",
      });
      if (response?.ok) return;
    } catch {
      /* Protected and non-injected pages reject tabs.sendMessage. */
    }

    await openFallbackPage();
  });

  async function openFallbackPage() {
    try {
      const created = await chrome.tabs.create({
        url: chrome.runtime.getURL(FALLBACK_PAGE),
        active: true,
      });

      if (typeof created?.id === "number") {
        openWhenConnected(created.id, 0);
      }
    } catch (error) {
      console.error("[helium-bookmarks] failed to open fallback page:", error);
    }
  }

  function openWhenConnected(tabId, attempt) {
    const port = connectedPorts.get(tabId);
    if (port && postToPort(port, { type: "openAndFocus" })) return;

    if (attempt >= OPEN_RETRY_LIMIT) {
      console.warn(
        "[helium-bookmarks] fallback page opened but its sidebar did not connect"
      );
      return;
    }

    setTimeout(
      () => openWhenConnected(tabId, attempt + 1),
      OPEN_RETRY_MS
    );
  }

  function postToPort(port, message) {
    try {
      port.postMessage(message);
      void chrome.runtime.lastError;
      return true;
    } catch {
      void chrome.runtime.lastError;
      return false;
    }
  }
})();
