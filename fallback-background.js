/*
  Restricted-page fallback.

  Chromium does not permit content-script injection into browser-owned pages
  such as chrome://, helium://, the Chrome Web Store, or pages owned by another
  extension. When the normal sidebar cannot answer an action click, open an
  extension-owned tab that loads the same sidebar scripts directly.
*/

(() => {
  "use strict";

  const FALLBACK_PAGE = "bookmarks.html";
  const OPEN_RETRY_MS = 50;
  const OPEN_RETRY_LIMIT = 40;

  chrome.action.onClicked.addListener(async (tab) => {
    if (!tab || typeof tab.id !== "number") return;

    /* background.js owns normal action routing. A live port proves this tab
       already has the sidebar, including our extension-owned fallback page. */
    if (ports.has(tab.id)) return;

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
    const port = ports.get(tabId);
    if (port && sendToPort(port, { type: "openAndFocus" })) return;

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
})();
