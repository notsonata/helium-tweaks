/*
  Keyboard routing for the bookmark sidebar.

  The toolbar action now opens Helium Tweaks settings. Cmd/Ctrl+K remains the
  direct bookmark-sidebar command, including the restricted-page fallback.
*/

(() => {
  "use strict";

  const PORT_NAME = "helium-bookmarks";
  const COMMAND_NAME = "toggle-bookmarks-sidebar";
  const FALLBACK_PAGE = "bookmarks.html";
  const OPEN_RETRY_MS = 50;
  const OPEN_RETRY_LIMIT = 40;
  const connectedPorts = new Map();

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== PORT_NAME) return;
    const tabId = port.sender?.tab?.id;
    if (typeof tabId !== "number") return;

    connectedPorts.set(tabId, port);
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (connectedPorts.get(tabId) === port) connectedPorts.delete(tabId);
    });

    sendShortcutLabel(port, 0);
    setTimeout(() => sendShortcutLabel(port, 1), 350);
  });

  chrome.commands.onCommand.addListener((command, tab) => {
    if (command !== COMMAND_NAME) return;
    routeSidebar(tab).catch((error) => {
      console.error("[helium-tweaks] bookmark shortcut failed:", error);
    });
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "heliumOpenBookmarksSidebar") return false;
    if (sender.id && sender.id !== chrome.runtime.id) return false;

    routeSidebar(sender.tab)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  });

  async function routeSidebar(tab) {
    const target = await resolveTargetTab(tab);
    if (target && typeof target.id === "number") {
      const port = connectedPorts.get(target.id);
      if (port && postToPort(port, { type: "openAndFocus" })) return;

      try {
        const response = await chrome.tabs.sendMessage(target.id, {
          type: "openAndFocus",
        });
        if (response?.ok !== false) return;
      } catch {
        /* Restricted or non-injected tab: use the extension-owned page. */
      }
    }

    await openFallbackPage();
  }

  async function resolveTargetTab(tab) {
    if (tab && typeof tab.id === "number") return tab;
    const [active] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    return active || null;
  }

  async function openFallbackPage() {
    const created = await chrome.tabs.create({
      url: chrome.runtime.getURL(FALLBACK_PAGE),
      active: true,
    });

    if (typeof created?.id === "number") openWhenConnected(created.id, 0);
  }

  function openWhenConnected(tabId, attempt) {
    const port = connectedPorts.get(tabId);
    if (port && postToPort(port, { type: "openAndFocus" })) return;

    if (attempt >= OPEN_RETRY_LIMIT) {
      console.warn(
        "[helium-tweaks] bookmarks page opened but its sidebar did not connect"
      );
      return;
    }

    setTimeout(
      () => openWhenConnected(tabId, attempt + 1),
      OPEN_RETRY_MS
    );
  }

  async function sendShortcutLabel(port, attempt) {
    try {
      const commands = await chrome.commands.getAll();
      const command = commands.find((item) => item.name === COMMAND_NAME);
      if (!command?.shortcut) return;
      postToPort(port, { type: "shortcut", label: command.shortcut });
    } catch (error) {
      if (attempt > 0) {
        console.warn("[helium-tweaks] could not read bookmark shortcut:", error);
      }
    }
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
