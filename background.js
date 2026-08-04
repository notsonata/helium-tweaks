/*
  Helium Bookmarks Sidebar — MV3 service worker.

  Responsibilities:
    - Own bookmark data and push it to connected sidebar content scripts.
    - Listen to bookmark changes and refresh every open sidebar.
    - Execute validated bookmark mutations requested by the editor UI.
    - Report the configured keyboard shortcut.
    - Route toolbar and keyboard activation to the active tab.
*/

const PORT_NAME = "helium-bookmarks";
const MUTATION_MESSAGE = "heliumBookmarkMutation";
const OTHER_BOOKMARKS_ID = "2";
const PROTECTED_ROOT_IDS = new Set(["0", "1", "2", "3"]);

/** tabId -> Port */
const ports = new Map();
let broadcastTimer = null;

/* ---------- bookmark tree ------------------------------------------------ */

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

async function buildRawBookmarkIndex() {
  const roots = await chrome.bookmarks.getTree();
  const index = new Map();

  const walk = (node, parentId = null, depth = 0) => {
    const id = String(node.id);
    index.set(id, {
      node,
      parentId:
        typeof node.parentId === "string" ? String(node.parentId) : parentId,
      depth,
    });
    for (const child of node.children || []) {
      walk(child, id, depth + 1);
    }
  };

  for (const root of roots) walk(root);
  return index;
}

/* ---------- shortcut label ----------------------------------------------- */

async function getShortcutLabel() {
  try {
    const all = await chrome.commands.getAll();
    const cmd = all.find((command) => command.name === "_execute_action");
    return (cmd && cmd.shortcut) || "";
  } catch {
    return "";
  }
}

/* ---------- broadcasting ------------------------------------------------- */

function sendToPort(port, message) {
  try {
    port.postMessage(message);
    void chrome.runtime.lastError;
    return true;
  } catch {
    void chrome.runtime.lastError;
    return false;
  }
}

function broadcast(message) {
  for (const [tabId, port] of ports) {
    if (!sendToPort(port, message) && ports.get(tabId) === port) {
      ports.delete(tabId);
    }
  }
}

function scheduleBookmarkRefresh() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(async () => {
    broadcastTimer = null;
    if (ports.size === 0) return;
    try {
      const tree = await readBookmarkTree();
      broadcast({ type: "bookmarks", tree });
    } catch (error) {
      console.error("[helium-bookmarks] failed to refresh tree:", error);
    }
  }, 90);
}

/* ---------- connection lifecycle ---------------------------------------- */

async function initPort(port) {
  const sender = port.sender;
  const tabId = sender?.tab?.id;

  if (sender?.frameId && sender.frameId !== 0) {
    port.disconnect();
    return;
  }
  if (typeof tabId !== "number") {
    port.disconnect();
    return;
  }

  ports.set(tabId, port);
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    if (ports.get(tabId) === port) ports.delete(tabId);
  });

  try {
    const tree = await readBookmarkTree();
    sendToPort(port, { type: "bookmarks", tree });
  } catch (error) {
    console.error("[helium-bookmarks] initial bookmark read failed:", error);
  }

  try {
    const label = await getShortcutLabel();
    sendToPort(port, { type: "shortcut", label });
  } catch {
    /* non-fatal */
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;
  initPort(port);
});

/* ---------- bookmark mutations ------------------------------------------ */

function uniqueIds(ids) {
  if (!Array.isArray(ids)) return [];
  return [...new Set(ids.map(String).filter(Boolean))];
}

function cleanFolderTitle(value) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/g, " ").slice(0, 255);
}

function publicError(error, fallback) {
  const message = typeof error?.message === "string" ? error.message : "";
  if (!message) return fallback;
  return message.replace(/^Error:\s*/i, "").slice(0, 240);
}

async function createFolderMutation(message) {
  const title = cleanFolderTitle(message.title);
  if (!title) throw new Error("Enter a folder name");

  const parentId = String(message.parentId || OTHER_BOOKMARKS_ID);
  const [parent] = await chrome.bookmarks.get(parentId);
  if (!parent || typeof parent.url === "string") {
    throw new Error("The destination folder is unavailable");
  }

  const created = await chrome.bookmarks.create({ parentId, title });
  scheduleBookmarkRefresh();
  return { folder: normalizeNode(created) };
}

async function deleteBookmarksMutation(message) {
  const ids = uniqueIds(message.ids);
  if (ids.length === 0) throw new Error("No bookmarks were selected");

  const index = await buildRawBookmarkIndex();
  const valid = ids.filter((id) => typeof index.get(id)?.node?.url === "string");
  if (valid.length === 0) throw new Error("The selected bookmarks no longer exist");

  let removed = 0;
  for (const id of valid) {
    try {
      await chrome.bookmarks.remove(id);
      removed += 1;
    } catch (error) {
      console.warn(`[helium-bookmarks] could not remove bookmark ${id}:`, error);
    }
  }

  if (removed === 0) throw new Error("The selected bookmarks could not be deleted");
  scheduleBookmarkRefresh();
  return { removed };
}

function selectedFolders(ids, index) {
  return uniqueIds(ids).filter((id) => {
    const entry = index.get(id);
    return (
      entry &&
      typeof entry.node.url !== "string" &&
      !PROTECTED_ROOT_IDS.has(id)
    );
  });
}

function topmostSelectedFolders(ids, index) {
  const selected = new Set(ids);
  return ids.filter((id) => {
    let parentId = index.get(id)?.parentId || null;
    while (parentId) {
      if (selected.has(parentId)) return false;
      parentId = index.get(parentId)?.parentId || null;
    }
    return true;
  });
}

async function deleteFolderTrees(ids, index) {
  const topmost = topmostSelectedFolders(ids, index);
  let removed = 0;

  for (const id of topmost) {
    try {
      await chrome.bookmarks.removeTree(id);
      removed += 1;
    } catch (error) {
      console.warn(`[helium-bookmarks] could not remove folder tree ${id}:`, error);
    }
  }

  return removed;
}

async function deleteFoldersOnly(ids, index) {
  const deepestFirst = [...ids].sort(
    (left, right) =>
      (index.get(right)?.depth || 0) - (index.get(left)?.depth || 0)
  );

  let removed = 0;
  let moved = 0;

  for (const id of deepestFirst) {
    try {
      const children = await chrome.bookmarks.getChildren(id);
      for (const child of children) {
        await chrome.bookmarks.move(String(child.id), {
          parentId: OTHER_BOOKMARKS_ID,
        });
        moved += 1;
      }
      await chrome.bookmarks.remove(id);
      removed += 1;
    } catch (error) {
      console.warn(`[helium-bookmarks] could not remove folder ${id}:`, error);
    }
  }

  return { removed, moved };
}

async function deleteFoldersMutation(message) {
  const index = await buildRawBookmarkIndex();
  const ids = selectedFolders(message.ids, index);
  if (ids.length === 0) {
    throw new Error("No removable folders were selected");
  }

  if (message.mode === "everything") {
    const removed = await deleteFolderTrees(ids, index);
    if (removed === 0) throw new Error("The selected folders could not be deleted");
    scheduleBookmarkRefresh();
    return { removed, mode: "everything" };
  }

  const result = await deleteFoldersOnly(ids, index);
  if (result.removed === 0) {
    throw new Error("The selected folders could not be deleted");
  }
  scheduleBookmarkRefresh();
  return { ...result, mode: "folderOnly" };
}

async function handleBookmarkMutation(message) {
  switch (message.action) {
    case "createFolder":
      return createFolderMutation(message);
    case "deleteBookmarks":
      return deleteBookmarksMutation(message);
    case "deleteFolders":
      return deleteFoldersMutation(message);
    default:
      throw new Error("Unsupported bookmark operation");
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== MUTATION_MESSAGE) return false;
  if (sender.id && sender.id !== chrome.runtime.id) return false;
  if (sender.frameId && sender.frameId !== 0) return false;

  handleBookmarkMutation(message)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => {
      console.error("[helium-bookmarks] mutation failed:", error);
      sendResponse({
        ok: false,
        error: publicError(error, "Bookmark operation failed"),
      });
    });

  return true;
});

/* ---------- bookmark change events -------------------------------------- */

const REFRESH_EVENTS = [
  chrome.bookmarks.onCreated,
  chrome.bookmarks.onRemoved,
  chrome.bookmarks.onChanged,
  chrome.bookmarks.onMoved,
  chrome.bookmarks.onChildrenReordered,
];

for (const event of REFRESH_EVENTS) {
  if (event?.addListener) event.addListener(scheduleBookmarkRefresh);
}

if (chrome.bookmarks.onImportEnded?.addListener) {
  chrome.bookmarks.onImportEnded.addListener(scheduleBookmarkRefresh);
}

/* ---------- action / command bridge ------------------------------------- */

async function openSidebarInTab(tab) {
  try {
    if (!tab || typeof tab.id !== "number") return;
    const port = ports.get(tab.id);
    if (port) {
      const ok = sendToPort(port, { type: "openAndFocus" });
      if (!ok) {
        if (ports.get(tab.id) === port) ports.delete(tab.id);
      } else {
        return;
      }
    }

    if (!tab.url || /^https?:/i.test(tab.url) || /^file:/i.test(tab.url)) {
      try {
        await chrome.tabs.sendMessage(tab.id, { type: "openAndFocus" });
        void chrome.runtime.lastError;
      } catch {
        void chrome.runtime.lastError;
      }
    }
  } catch (error) {
    console.error("[helium-bookmarks] openSidebarInTab failed:", error);
  }
}

chrome.action.onClicked.addListener(openSidebarInTab);
