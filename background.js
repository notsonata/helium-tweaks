/*
  Helium Bookmarks Sidebar — MV3 service worker.

  Responsibilities:
    - Own bookmark data: read chrome.bookmarks.getTree(), normalize, and push
      to every connected content-script port.
    - Listen to bookmark change events and re-broadcast (debounced) so the
      sidebar refreshes live without reloading the page.
    - Provide the configured keyboard-shortcut label for the search badge.
    - Bridge the toolbar action + _execute_action command to a single
      "open and focus" message sent to the active tab.

  It deliberately does NOT own UI state (pinned / collapsed). Those live in
  chrome.storage.local and are read/written by the content script.
*/

const PORT_NAME = "helium-bookmarks";

/** tabId -> Port */
const ports = new Map();

let broadcastTimer = null;

/* ---------- bookmark tree ------------------------------------------------ */

/**
 * Normalize a raw chrome.bookmarks node into a smaller, stable shape.
 *   { id, title, url?, children?: [...] }
 * The invisible root node (id "0") is collapsed out: its children become the
 * top-level folders. Empty titles on the root's direct children (e.g. the
 * untitled root) are left intact; the content script renames a couple of the
 * well-known Chrome roots for display.
 */
function normalizeNode(node) {
  const out = { id: String(node.id), title: node.title || "" };
  if (typeof node.url === "string") {
    out.url = node.url;
    return out;
  }
  if (Array.isArray(node.children)) {
    out.children = node.children.map(normalizeNode).filter(Boolean);
  }
  return out;
}

function normalizeTree(rootNodes) {
  // rootNodes is typically a single node with id "0" and children being the
  // real roots (Bookmarks bar, Other bookmarks, Mobile bookmarks).
  const topLevel = [];
  for (const root of rootNodes) {
    if (Array.isArray(root.children) && root.children.length) {
      topLevel.push(...root.children.map(normalizeNode));
    } else if (root.id !== "0") {
      topLevel.push(normalizeNode(root));
    }
  }
  return topLevel;
}

async function readBookmarkTree() {
  const tree = await chrome.bookmarks.getTree();
  return normalizeTree(tree);
}

/* ---------- shortcut label ----------------------------------------------- */

async function getShortcutLabel() {
  try {
    const all = await chrome.commands.getAll();
    const cmd = all.find((c) => c.name === "_execute_action");
    return (cmd && cmd.shortcut) || "";
  } catch {
    return "";
  }
}

/* ---------- broadcasting ------------------------------------------------- */

function sendToPort(port, message) {
  try {
    port.postMessage(message);
    // Reading lastError clears the "Unchecked runtime.lastError" warning that
    // Chrome otherwise logs when the port died (e.g. the page entered bfcache).
    void chrome.runtime.lastError;
    return true;
  } catch (err) {
    // Port already closed (tab navigated, bfcache, extension reloaded) — expected.
    void chrome.runtime.lastError;
    return false;
  }
}

function broadcast(message) {
  for (const [tabId, port] of ports) {
    if (!sendToPort(port, message)) {
      // Stale port: only delete if it hasn't already been replaced.
      if (ports.get(tabId) === port) ports.delete(tabId);
    }
  }
}

/** Debounced re-fetch + broadcast, so a burst of bookmark events (e.g. import)
 * collapses into a single refresh. */
function scheduleBookmarkRefresh() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(async () => {
    broadcastTimer = null;
    if (ports.size === 0) return;
    try {
      const tree = await readBookmarkTree();
      broadcast({ type: "bookmarks", tree });
    } catch (err) {
      console.error("[helium-bookmarks] failed to refresh tree:", err);
    }
  }, 90);
}

/* ---------- connection lifecycle ---------------------------------------- */

async function initPort(port) {
  const sender = port.sender;
  const tabId = sender && sender.tab && sender.tab.id;

  // The sidebar lives in the top-level frame only; ignore any stray iframe.
  if (sender && sender.frameId && sender.frameId !== 0) {
    port.disconnect();
    return;
  }
  if (typeof tabId !== "number") {
    port.disconnect();
    return;
  }

  ports.set(tabId, port);
  // Identity check: if a replacement port connected before this disconnect
  // fired, leave the newer port in place. Reading lastError prevents Chrome
  // from logging "Unchecked runtime.lastError" when the port closed because the
  // page entered back/forward cache, navigated, or the SW went idle.
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    if (ports.get(tabId) === port) ports.delete(tabId);
  });

  // Push the current data immediately so the sidebar doesn't start empty.
  try {
    const tree = await readBookmarkTree();
    sendToPort(port, { type: "bookmarks", tree });
  } catch (err) {
    console.error("[helium-bookmarks] initial bookmark read failed:", err);
  }

  try {
    const label = await getShortcutLabel();
    if (label) sendToPort(port, { type: "shortcut", label });
  } catch {
    /* non-fatal */
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;
  initPort(port);
});

/* ---------- bookmark change events -------------------------------------- */

const REFRESH_EVENTS = [
  chrome.bookmarks.onCreated,
  chrome.bookmarks.onRemoved,
  chrome.bookmarks.onChanged,
  chrome.bookmarks.onMoved,
  chrome.bookmarks.onChildrenReordered,
];

for (const ev of REFRESH_EVENTS) {
  if (ev && ev.addListener) {
    ev.addListener(scheduleBookmarkRefresh);
  }
}

// onImportEnded fires once after a large import; refresh regardless of timer.
if (chrome.bookmarks.onImportEnded && chrome.bookmarks.onImportEnded.addListener) {
  chrome.bookmarks.onImportEnded.addListener(scheduleBookmarkRefresh);
}

/* ---------- action / command bridge ------------------------------------- */

// Uses the tab supplied by chrome.action.onClicked, which is unambiguous across
// windows (re-querying {active, currentWindow} can race in multi-window setups).
async function openSidebarInTab(tab) {
  try {
    if (!tab || typeof tab.id !== "number") return;
    const port = ports.get(tab.id);
    if (port) {
      const ok = sendToPort(port, { type: "openAndFocus" });
      if (!ok) {
        // Stale port still in the map: drop it and fall through to one-shot.
        if (ports.get(tab.id) === port) ports.delete(tab.id);
      } else {
        return;
      }
    }
    // No live port. The content script is not loaded on this page (e.g. a
    // restricted page) OR the tab predates installation. Try a one-shot
    // message; the content script may inject and respond on the next load.
    if (!tab.url || /^https?:/i.test(tab.url) || /^file:/i.test(tab.url)) {
      try {
        await chrome.tabs.sendMessage(tab.id, { type: "openAndFocus" });
        void chrome.runtime.lastError;
      } catch {
        // Expected on restricted pages or before the content script injects.
        void chrome.runtime.lastError;
      }
    }
  } catch (err) {
    console.error("[helium-bookmarks] openSidebarInTab failed:", err);
  }
}

chrome.action.onClicked.addListener(openSidebarInTab);

// _execute_action routes BOTH the toolbar click and the keyboard shortcut here.
