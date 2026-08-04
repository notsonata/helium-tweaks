/*
  Validated bookmark move operations for drag-and-drop editing.

  This file is imported by service-worker.js alongside the existing background
  worker. It uses a distinct message type so it does not conflict with the
  create/delete mutation listener in background.js.
*/

(() => {
  "use strict";

  const MOVE_MESSAGE = "heliumBookmarkMove";
  const PROTECTED_ROOT_IDS = new Set(["0", "1", "2", "3"]);

  function cleanId(value) {
    if (value == null) return "";
    return String(value).trim();
  }

  function publicError(error, fallback) {
    const message = typeof error?.message === "string" ? error.message : "";
    return (message || fallback).replace(/^Error:\s*/i, "").slice(0, 240);
  }

  async function buildIndex() {
    const roots = await chrome.bookmarks.getTree();
    const index = new Map();

    const walk = (node, parentId = null) => {
      const id = String(node.id);
      index.set(id, {
        node,
        parentId:
          typeof node.parentId === "string" ? String(node.parentId) : parentId,
      });
      for (const child of node.children || []) walk(child, id);
    };

    for (const root of roots) walk(root);
    return index;
  }

  function destinationIsInsideFolder(destinationId, folderId, index) {
    let currentId = destinationId;
    while (currentId) {
      if (currentId === folderId) return true;
      currentId = index.get(currentId)?.parentId || null;
    }
    return false;
  }

  async function moveNode(message) {
    const id = cleanId(message.id);
    const parentId = cleanId(message.parentId);
    const beforeId = cleanId(message.beforeId);
    const afterId = cleanId(message.afterId);

    if (!id || !parentId) throw new Error("The move destination is unavailable");
    if (PROTECTED_ROOT_IDS.has(id)) {
      throw new Error("Browser root folders cannot be moved");
    }
    if (beforeId && afterId) throw new Error("The move position is invalid");
    if (beforeId === id || afterId === id) return { moved: false, unchanged: true };

    const index = await buildIndex();
    const entry = index.get(id);
    const destination = index.get(parentId);

    if (!entry) throw new Error("The selected bookmark no longer exists");
    if (!destination || typeof destination.node.url === "string") {
      throw new Error("The destination folder no longer exists");
    }

    const movingFolder = typeof entry.node.url !== "string";
    if (movingFolder && destinationIsInsideFolder(parentId, id, index)) {
      throw new Error("A folder cannot be moved inside itself");
    }

    const children = await chrome.bookmarks.getChildren(parentId);
    const filtered = children.filter((child) => String(child.id) !== id);

    let destinationIndex = filtered.length;
    if (beforeId) {
      destinationIndex = filtered.findIndex(
        (child) => String(child.id) === beforeId
      );
      if (destinationIndex < 0) {
        throw new Error("The target position is no longer available");
      }
    } else if (afterId) {
      const anchorIndex = filtered.findIndex(
        (child) => String(child.id) === afterId
      );
      if (anchorIndex < 0) {
        throw new Error("The target position is no longer available");
      }
      destinationIndex = anchorIndex + 1;
    }

    const currentParentId = entry.parentId || "";
    const currentChildren = currentParentId
      ? await chrome.bookmarks.getChildren(currentParentId)
      : [];

    if (currentParentId === parentId) {
      const desired = filtered.map((child) => String(child.id));
      desired.splice(destinationIndex, 0, id);
      const current = currentChildren.map((child) => String(child.id));
      if (
        current.length === desired.length &&
        current.every((value, position) => value === desired[position])
      ) {
        return { moved: false, unchanged: true };
      }
    }

    const moved = await chrome.bookmarks.move(id, {
      parentId,
      index: destinationIndex,
    });

    return {
      moved: true,
      id: String(moved.id),
      parentId,
      index: destinationIndex,
    };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== MOVE_MESSAGE) return false;
    if (sender.id && sender.id !== chrome.runtime.id) return false;
    if (sender.frameId && sender.frameId !== 0) return false;

    moveNode(message)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => {
        console.error("[helium-bookmarks] move failed:", error);
        sendResponse({
          ok: false,
          error: publicError(error, "Bookmark move failed"),
        });
      });

    return true;
  });
})();
