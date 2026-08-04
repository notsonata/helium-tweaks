/* Validated bookmark/folder rename mutations for the MV3 service worker. */

(() => {
  "use strict";

  const UPDATE_MESSAGE = "heliumBookmarkUpdate";
  const PROTECTED_ROOT_IDS = new Set(["0", "1", "2", "3"]);

  function cleanTitle(value) {
    if (typeof value !== "string") return "";
    return value.trim().replace(/\s+/g, " ").slice(0, 255);
  }

  function normalizeHttpUrl(value) {
    const raw = String(value || "").trim();
    if (!raw) throw new Error("Enter a URL");
    if (raw.length > 8192) throw new Error("The URL is too long");

    const candidate = /^[a-z][a-z0-9+.-]*:/i.test(raw)
      ? raw
      : `https://${raw}`;
    let parsed;
    try {
      parsed = new URL(candidate);
    } catch {
      throw new Error("Enter a valid URL");
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Only HTTP and HTTPS URLs are supported");
    }

    return parsed.href;
  }

  function publicError(error) {
    const message = typeof error?.message === "string" ? error.message : "";
    return (message || "The bookmark could not be updated")
      .replace(/^Error:\s*/i, "")
      .slice(0, 240);
  }

  async function updateBookmarkNode(message) {
    const id = String(message.id || "");
    const kind = message.kind;
    const title = cleanTitle(message.title);

    if (!id) throw new Error("The selected item is unavailable");
    if (!title) throw new Error("Enter a name");
    if (kind !== "folder" && kind !== "bookmark") {
      throw new Error("Unsupported bookmark item");
    }

    const [node] = await chrome.bookmarks.get(id);
    if (!node) throw new Error("The selected item no longer exists");

    const isBookmark = typeof node.url === "string";
    if (kind === "folder") {
      if (isBookmark) throw new Error("The selected item is not a folder");
      if (PROTECTED_ROOT_IDS.has(id)) {
        throw new Error("Browser root folders cannot be renamed");
      }

      const updated = await chrome.bookmarks.update(id, { title });
      return { item: { id: String(updated.id), title: updated.title || "" } };
    }

    if (!isBookmark) throw new Error("The selected item is not a bookmark");
    const url = normalizeHttpUrl(message.url);
    const updated = await chrome.bookmarks.update(id, { title, url });
    return {
      item: {
        id: String(updated.id),
        title: updated.title || "",
        url: updated.url || "",
      },
    };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== UPDATE_MESSAGE) return false;
    if (sender.id && sender.id !== chrome.runtime.id) return false;
    if (sender.frameId && sender.frameId !== 0) return false;

    updateBookmarkNode(message)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => {
        console.error("[helium-bookmarks] update failed:", error);
        sendResponse({ ok: false, error: publicError(error) });
      });

    return true;
  });
})();
