/*
  Helium Bookmarks Sidebar — content script.

  Renders a Shadow-DOM-isolated sidebar overlay on ordinary web pages and wires
  up the template's edge-hover / pin / search / collapse behavior. Bookmark data
  is supplied by the background service worker over a long-lived port.

  Design notes:
    - A single host element (#helium-bookmarks-sidebar-root) with one shadow root.
    - A duplicate-injection guard prevents ever building two sidebars per page.
    - The sidebar overlays the page; page width/layout is never changed.
    - Styles are loaded as text into the shadow root (deterministic, isolated).
*/

(() => {
  "use strict";

  // ----- duplicate-injection guard ----------------------------------------
  if (window.__heliumBookmarksSidebar) return;
  window.__heliumBookmarksSidebar = true;

  // Only run in the top-level frame. The manifest already sets all_frames:false,
  // but this is a cheap, defensive extra check.
  if (window.top !== window.self) return;

  const PORT_NAME = "helium-bookmarks";
  const STORAGE_COLLAPSED = "heliumBmSidebar:collapsed:v1";
  const STORAGE_PINNED = "heliumBmSidebar:pinned:v1";
  const CLOSE_DELAY_MS = 140; // leave-delay, template value
  const OPEN_DELAY_MS = 140; // enter-delay, mirrors CLOSE_DELAY_MS for symmetric feel

  // Bookmarks bar / Other bookmarks / Mobile bookmarks appear untitled or
  // with generic titles depending on locale. Map a few well-known ids/titles
  // to friendlier labels for the top level.
  const ROOT_TITLE_OVERRIDES = {
    "1": "Bookmarks bar",
    "2": "Other bookmarks",
    "3": "Mobile bookmarks",
  };

  // ----- state ------------------------------------------------------------
  /** Normalized bookmark tree from the background. */
  let bookmarkTree = [];
  /** Folder id -> collapsed boolean (persisted). */
  let collapsed = {};
  /** Persisted pinned flag. Defaults to false (unpinned overlay). */
  let pinned = false;
  /** Current search query (not persisted). */
  let searchQuery = "";

  let closeTimer = null;
  let openTimer = null;
  let toastTimer = null;
  let port = null;
  let portDead = false;
  /** Avoids reconnect storms on edge-hover while a connect is in flight. */
  let reconnecting = false;

  // ----- DOM scaffold -----------------------------------------------------
  const host = document.createElement("div");
  host.id = "helium-bookmarks-sidebar-root";
  // The host must not affect page layout or intercept page pointer events.
  host.style.cssText =
    "all: initial; margin: 0 !important; padding: 0 !important; border: 0 !important; background: transparent !important; width: 0 !important; height: 0 !important; top: 0 !important; left: 0 !important; position: static !important;";
  const shadow = host.attachShadow({ mode: "open" });

  // Build the sidebar markup inside the shadow root. This mirrors the template
  // HTML exactly, minus the demo page content and the removed row-menu button.
  shadow.innerHTML = `
    <div class="edge-trigger" id="edgeTrigger" aria-hidden="true"></div>

    <aside class="sidebar-shell" id="sidebarShell" aria-label="Bookmark sidebar">
      <div class="sidebar" id="sidebar">
        <div class="search-wrap">
          <svg class="search-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="11" cy="11" r="6.5" stroke="currentColor" stroke-width="2"/>
            <path d="m16 16 4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>

          <input
            class="search"
            id="searchInput"
            type="search"
            placeholder="Search"
            autocomplete="off"
            spellcheck="false"
            aria-label="Search bookmarks"
          >

          <span class="search-shortcut hidden" id="searchShortcut" aria-hidden="true"></span>

          <button class="clear-search" id="clearSearch" type="button" aria-label="Clear search">
            <svg width="13" height="13" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path d="m5 5 10 10M15 5 5 15"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"/>
            </svg>
          </button>
        </div>

        <div class="scroll" id="scroll">
          <div id="folders"></div>
          <div class="empty" id="emptyState">No bookmarks match this search.</div>
        </div>

        <footer class="sidebar-footer">
          <div class="footer-left">
            <button
              class="pin-button"
              id="pinButton"
              type="button"
              aria-label="Pin sidebar"
              aria-pressed="false"
              title="Keep sidebar open"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M8 3h8l-1 6 3 3v2H6v-2l3-3-1-6Z"
                  stroke="currentColor"
                  stroke-width="1.7"
                  stroke-linejoin="round"/>
                <path d="M12 14v7"
                  stroke="currentColor"
                  stroke-width="1.7"
                  stroke-linecap="round"/>
              </svg>
            </button>
          </div>

          <span class="footer-shortcuts">
            <span class="kbd">Esc</span> close
          </span>
        </footer>
      </div>
    </aside>

    <div class="toast" id="toast" role="status" aria-live="polite"></div>
  `;

  // Load the stylesheet as text into the shadow root. This is more deterministic
  // than a <link> (no flash of unstyled content, no race with render()).
  function loadStyles() {
    return fetch(chrome.runtime.getURL("sidebar.css"))
      .then((r) => r.text())
      .then((css) => {
        const style = document.createElement("style");
        style.textContent = css;
        shadow.insertBefore(style, shadow.firstChild);
      })
      .catch((err) => {
        console.error("[helium-bookmarks] failed to load sidebar.css:", err);
      });
  }

  // Cached shadow DOM references.
  const els = {};
  function ref(id) {
    return (els[id] = els[id] || shadow.getElementById(id));
  }

  // ----- storage ----------------------------------------------------------
  function loadState() {
    return new Promise((resolve) => {
      chrome.storage.local.get(
        [STORAGE_COLLAPSED, STORAGE_PINNED],
        (result) => {
          if (chrome.runtime.lastError) {
            // Non-fatal: fall back to defaults.
            console.error(
              "[helium-bookmarks] storage read failed:",
              chrome.runtime.lastError
            );
          } else {
            const c = result[STORAGE_COLLAPSED];
            if (c && typeof c === "object") collapsed = c;
            pinned = result[STORAGE_PINNED] === true;
          }
          resolve();
        }
      );
    });
  }

  function persistCollapsed() {
    chrome.storage.local.set(
      { [STORAGE_COLLAPSED]: collapsed },
      () => {
        if (chrome.runtime.lastError) {
          console.error(
            "[helium-bookmarks] failed to persist collapsed state:",
            chrome.runtime.lastError
          );
        }
      }
    );
  }

  function persistPinned() {
    chrome.storage.local.set({ [STORAGE_PINNED]: pinned }, () => {
      if (chrome.runtime.lastError) {
        console.error(
          "[helium-bookmarks] failed to persist pinned state:",
          chrome.runtime.lastError
        );
      }
    });
  }

  // ----- open / close / pin (template behavior) --------------------------
  function setOpen(open) {
    const shell = ref("sidebarShell");
    if (open) {
      clearTimeout(closeTimer);
    } else {
      clearTimeout(openTimer);
    }
    shell.classList.toggle("open", open);
  }

  function scheduleClose() {
    clearTimeout(closeTimer);
    if (pinned) return;
    closeTimer = setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  }

  /**
   * Schedule the sidebar to open after OPEN_DELAY_MS. Mirrors the leave/close
   * delay so the sidebar is as responsive to opening as it is to closing.
   * Cancelled if the pointer leaves the edge strip first, or if it enters the
   * panel directly.
   */
  function scheduleOpen() {
    clearTimeout(openTimer);
    openTimer = setTimeout(() => setOpen(true), OPEN_DELAY_MS);
  }

  function cancelOpen() {
    clearTimeout(openTimer);
  }

  function setPinned(next, notify = true) {
    pinned = next;
    persistPinned();
    const btn = ref("pinButton");
    btn.classList.toggle("active", next);
    btn.setAttribute("aria-pressed", String(next));
    btn.setAttribute("aria-label", next ? "Unpin sidebar" : "Pin sidebar");
    if (next) setOpen(true);
    if (notify) showToast(next ? "Sidebar pinned" : "Sidebar unpinned");
  }

  function showToast(message) {
    const toast = ref("toast");
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.add("visible");
    toastTimer = setTimeout(() => toast.classList.remove("visible"), 1300);
  }

  // ----- overflow fade (exact template logic) -----------------------------
  function updateOverflowFades() {
    requestAnimationFrame(() => {
      const labels = shadow.querySelectorAll(".bookmark-title");
      labels.forEach((label) => {
        label.classList.toggle(
          "overflowing",
          label.scrollWidth > label.clientWidth + 1
        );
      });
    });
  }

  // ----- favicon ----------------------------------------------------------
  function faviconUrl(pageUrl) {
    const u = chrome.runtime.getURL("/_favicon/");
    return `${u}?pageUrl=${encodeURIComponent(pageUrl)}&size=32`;
  }

  /**
   * Derive the site's own favicon.ico URL from a page URL.
   * e.g. "https://github.com/foo/bar" -> "https://github.com/favicon.ico"
   */
  function siteFaviconUrl(pageUrl) {
    try {
      const parsed = new URL(pageUrl);
      return `${parsed.origin}/favicon.ico`;
    } catch {
      return null;
    }
  }

  /**
   * Try loading a favicon for a bookmark into the given icon element, using a
   * fallback chain so we don't show an empty box:
   *   1. Chromium's _favicon/ endpoint (cached, privacy-preserving, offline)
   *   2. The site's own /favicon.ico (native cross-origin <img> load)
   * If every source fails, the letter fallback already in the element stays.
   */
  function loadFavicon(icon, pageUrl, fallbackLetter) {
    const sources = [faviconUrl(pageUrl)];
    const siteIco = siteFaviconUrl(pageUrl);
    if (siteIco && siteIco !== sources[0]) sources.push(siteIco);

    let attempt = 0;
    const tryNext = () => {
      if (attempt >= sources.length) return; // keep letter fallback
      const src = sources[attempt++];
      const img = new Image();
      img.alt = "";
      img.referrerPolicy = "no-referrer";
      img.addEventListener("load", () => {
        // Only swap in if we actually got a real image (non-zero dimensions).
        if (img.naturalWidth > 0 && img.naturalHeight > 0) {
          icon.textContent = "";
          icon.appendChild(img);
        } else {
          tryNext();
        }
      });
      img.addEventListener("error", tryNext);
      img.src = src;
    };
    tryNext();
  }

  function safeUrl(url) {
    if (typeof url !== "string") return null;
    const trimmed = url.trim();
    if (!trimmed) return null;
    // Allow only http(s) and a few benign schemes; drop javascript:/data: etc.
    if (/^(https?|ftp|file):/i.test(trimmed)) return trimmed;
    return null;
  }

  // ----- rendering --------------------------------------------------------
  /** Map folder id -> joined-ancestor-titles path, for folder-path matching. */
  function buildFolderPathMap(nodes, pathParts, map) {
    for (const node of nodes) {
      if (node.url) continue; // leaf
      const title = displayTitle(node) || "";
      const path = [...pathParts, title].join("/").replace(/^\/+/, "");
      map[node.id] = path;
      if (node.children) {
        buildFolderPathMap(node.children, [...pathParts, title], map);
      }
    }
    return map;
  }

  function displayTitle(node) {
    if (ROOT_TITLE_OVERRIDES[node.id]) return ROOT_TITLE_OVERRIDES[node.id];
    return node.title || "Untitled";
  }

  function matchesQuery(haystack, q) {
    return !q || haystack.toLowerCase().includes(q);
  }

  /**
   * Build a display tree from a bookmark node:
   *   folder -> { type:"folder", node, children: [bookmark|folder...] }
   *   bookmark -> { type:"bookmark", node }
   *
   * In search mode a folder is kept only if it (or any descendant) matches;
   * its children list contains only matching entries. In non-search mode the
   * full structure is preserved.
   */
  function buildDisplayNode(node, depth, q, folderPathMap) {
    if (node.url) {
      if (!q) return { type: "bookmark", node };
      const title = node.title || "";
      const url = node.url || "";
      if (
        matchesQuery(title, q) ||
        matchesQuery(url, q)
      ) {
        return { type: "bookmark", node };
      }
      return null;
    }

    // Folder.
    const childDisplay = [];
    let childMatchCount = 0;
    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        const dn = buildDisplayNode(child, depth + 1, q, folderPathMap);
        if (!dn) continue;
        if (dn.type === "bookmark") childMatchCount++;
        childDisplay.push(dn);
      }
    }

    if (q) {
      // A folder is shown only if it has matching descendant bookmarks OR its
      // own title/path matches the query. Otherwise drop it entirely.
      const folderMatchesItself =
        matchesQuery(displayTitle(node), q) ||
        matchesQuery(folderPathMap[node.id] || "", q);
      if (childMatchCount === 0 && !folderMatchesItself) {
        return null;
      }
    }

    return {
      type: "folder",
      node,
      depth,
      childMatchCount,
      children: childDisplay,
    };
  }

  function render() {
    const q = searchQuery.trim().toLowerCase();
    const foldersRoot = ref("folders");
    foldersRoot.replaceChildren();

    const folderPathMap = buildFolderPathMap(bookmarkTree, [], {});

    let totalVisible = 0;
    const rootContainer = document.createDocumentFragment();

    for (const top of bookmarkTree) {
      const dn = buildDisplayNode(top, 0, q, folderPathMap);
      if (!dn) continue;
      const appended = renderNode(dn, q);
      if (appended) {
        rootContainer.appendChild(appended.element);
        totalVisible += appended.bookmarkCount;
      }
    }

    foldersRoot.appendChild(rootContainer);

    ref("emptyState").classList.toggle("visible", totalVisible === 0);
    ref("clearSearch").classList.toggle("visible", q.length > 0);
    // Badge visibility depends on both "typing" and "shortcut configured";
    // setShortcutBadge is the single source of truth for both.
    setShortcutBadge(currentShortcut);
    updateOverflowFades();

    // When not searching, prune collapsed-state entries for folders that no
    // longer exist (deleted folders).
    if (!q) pruneDeletedFolders();
  }

  /**
   * Render a display node. Returns { element, bookmarkCount } or null.
   * Folders nest their children inside their folder-inner, so collapsing a
   * parent collapses its descendant folders too.
   */
  function renderNode(dn, q) {
    if (dn.type === "bookmark") {
      return { element: renderBookmark(dn.node), bookmarkCount: 1 };
    }

    const node = dn.node;
    const depth = dn.depth;

    const folderEl = document.createElement("section");
    folderEl.className = "folder";
    if (depth > 0) folderEl.classList.add("nested");
    folderEl.dataset.folderId = node.id;

    // In search mode we ignore stored collapsed state and show expanded.
    const isCollapsed = !q && Boolean(collapsed[node.id]);
    folderEl.classList.toggle("collapsed", isCollapsed);

    const header = document.createElement("button");
    header.className = "folder-header";
    header.type = "button";
    header.setAttribute("aria-expanded", String(!isCollapsed));

    header.appendChild(makeChevron());

    const name = document.createElement("span");
    name.className = "folder-name";
    name.textContent = displayTitle(node);
    header.appendChild(name);

    const count = document.createElement("span");
    count.className = "folder-count";
    count.textContent = String(dn.childMatchCount);
    header.appendChild(count);

    header.addEventListener("click", () => {
      // Collapse toggling is disabled during an active search.
      if (searchQuery.trim()) return;
      const nextCollapsed = !folderEl.classList.contains("collapsed");
      folderEl.classList.toggle("collapsed", nextCollapsed);
      header.setAttribute("aria-expanded", String(!nextCollapsed));
      collapsed[node.id] = nextCollapsed;
      persistCollapsed();
      updateOverflowFades();
    });

    const content = document.createElement("div");
    content.className = "folder-content";

    const inner = document.createElement("div");
    inner.className = "folder-inner";

    let bookmarkCount = 0;
    for (const child of dn.children) {
      const appended = renderNode(child, q);
      if (!appended) continue;
      inner.appendChild(appended.element);
      bookmarkCount += appended.bookmarkCount;
    }

    content.appendChild(inner);
    folderEl.append(header, content);
    return { element: folderEl, bookmarkCount };
  }

  function makeChevron() {
    const chevron = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "svg"
    );
    chevron.setAttribute("class", "chevron");
    chevron.setAttribute("viewBox", "0 0 20 20");
    chevron.setAttribute("fill", "none");
    chevron.setAttribute("aria-hidden", "true");
    const chevPath = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "path"
    );
    chevPath.setAttribute("d", "m7.25 4.5 5.5 5.5-5.5 5.5");
    chevPath.setAttribute("stroke", "currentColor");
    chevPath.setAttribute("stroke-width", "1.7");
    chevPath.setAttribute("stroke-linecap", "round");
    chevPath.setAttribute("stroke-linejoin", "round");
    chevron.appendChild(chevPath);
    return chevron;
  }

  function renderBookmark(bm) {
    const url = safeUrl(bm.url);
    const row = document.createElement("a");
    row.className = "bookmark";
    // Real anchor with the actual URL. No target, no preventDefault: native
    // current-tab navigation; Cmd/middle/Shift-click all handled by the browser.
    if (url) {
      row.href = url;
    } else {
      // Malformed/unsupported URL: render non-navigable, dimmed.
      row.removeAttribute("href");
      row.style.opacity = "0.55";
      row.title = "Unsupported bookmark URL";
    }
    row.title = bm.title || url || "";

    const icon = document.createElement("span");
    icon.className = "favicon";
    // Letter fallback (template behavior) shown until a favicon loads, and kept
    // permanently if every favicon source fails.
    const fallbackLetter = ((bm.title || "?").trim()[0] || "?").toUpperCase();
    icon.textContent = fallbackLetter;

    if (url) {
      loadFavicon(icon, url, fallbackLetter);
    }

    const label = document.createElement("span");
    label.className = "bookmark-title";
    label.textContent = bm.title || url || "Untitled";

    row.append(icon, label);
    return row;
  }

  function pruneDeletedFolders() {
    // Collect all folder ids currently present in the tree.
    const live = new Set();
    (function collect(nodes) {
      for (const n of nodes) {
        if (!n.url) {
          live.add(n.id);
          if (n.children) collect(n.children);
        }
      }
    })(bookmarkTree);

    let changed = false;
    for (const key of Object.keys(collapsed)) {
      if (!live.has(key)) {
        delete collapsed[key];
        changed = true;
      }
    }
    if (changed) persistCollapsed();
  }

  // ----- search -----------------------------------------------------------
  function applySearch(value) {
    searchQuery = value || "";
    render();
  }

  // ----- messaging --------------------------------------------------------
  function handleMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "bookmarks" && Array.isArray(msg.tree)) {
      bookmarkTree = msg.tree;
      render();
    } else if (msg.type === "shortcut" && typeof msg.label === "string") {
      setShortcutBadge(msg.label);
    } else if (msg.type === "openAndFocus") {
      openAndFocus();
    }
  }

  function connectPort() {
    try {
      port = chrome.runtime.connect({ name: PORT_NAME });
      portDead = false;
      port.onMessage.addListener(handleMessage);
      port.onDisconnect.addListener(() => {
        port = null;
        // Context invalidated (extension reloaded) or tab going away. We'll
        // lazily reconnect on the next edge-hover. Don't spam reconnects.
        portDead = true;
      });
    } catch (err) {
      // Runtime context may be gone; stay quiet.
      port = null;
      portDead = true;
    }
  }

  /** Reconnect on demand (e.g. after the extension was reloaded). */
  function ensureConnected() {
    if (port && !portDead) return;
    if (reconnecting) return;
    reconnecting = true;
    try {
      connectPort();
    } finally {
      reconnecting = false;
    }
  }

  // ----- keyboard shortcut badge -----------------------------------------
  // The badge starts hidden (class "hidden" in the markup) and is only revealed
  // once the background sends the real configured shortcut. It's hidden again
  // while the user is typing in the search field (so it doesn't sit under the
  // clear button), matching the template's behavior.
  let currentShortcut = "";
  function setShortcutBadge(rawLabel) {
    currentShortcut = rawLabel || "";
    const badge = ref("searchShortcut");
    const formatted = formatShortcut(currentShortcut);
    badge.textContent = formatted;
    const typing = searchQuery.trim().length > 0;
    // Hide when there's no real shortcut, or while the user is typing.
    badge.classList.toggle("hidden", !formatted || typing);
  }

  function formatShortcut(label) {
    if (!label) return "";
    // Chromium reports e.g. "Ctrl+Shift+K" / "Command+Shift+K". Convert to
    // the compact glyphs the template uses.
    return label
      .split("+")
      .map((part) => {
        const p = part.trim();
        switch (p.toLowerCase()) {
          case "command":
          case "cmd":
            return "\u2318"; // ⌘
          case "ctrl":
          case "control":
            return "\u2303"; // ⌃
          case "shift":
            return "\u21E7"; // ⇧
          case "alt":
          case "option":
          case "opt":
            return "\u2325"; // ⌥
          default:
            return p;
        }
      })
      .join("");
  }

  // ----- open + focus (action button / keyboard command) ------------------
  function openAndFocus() {
    ensureConnected();
    setOpen(true);
    const input = ref("searchInput");
    input.focus();
    input.select();
  }

  // ----- event wiring -----------------------------------------------------
  function wireEvents() {
    const edgeTrigger = ref("edgeTrigger");
    const sidebar = ref("sidebar");

    edgeTrigger.addEventListener("mouseenter", () => {
      ensureConnected();
      scheduleOpen();
    });
    edgeTrigger.addEventListener("mouseleave", cancelOpen);

    sidebar.addEventListener("mouseenter", () => clearTimeout(closeTimer));
    sidebar.addEventListener("mouseleave", scheduleClose);

    // Clicks inside the sidebar must never close it or navigate the page from
    // non-link elements. (Real <a class="bookmark"> links keep native behavior.)
    sidebar.addEventListener("click", (e) => {
      // Allow native anchor navigation; just don't schedule a close.
      clearTimeout(closeTimer);
    });

    ref("pinButton").addEventListener("click", () => setPinned(!pinned));

    const input = ref("searchInput");
    input.addEventListener("input", () => applySearch(input.value));

    ref("clearSearch").addEventListener("click", () => {
      input.value = "";
      applySearch("");
      input.focus();
    });

    // Escape behavior (template): first Esc clears search if present, else
    // closes the sidebar (when unpinned) and blurs the field.
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if (searchQuery) {
          e.stopPropagation();
          input.value = "";
          applySearch("");
          return;
        }
        if (!pinned) setOpen(false);
        input.blur();
      }
    });

    // Recompute overflow fades on viewport resize.
    const resizeObserver = new ResizeObserver(() => updateOverflowFades());
    resizeObserver.observe(ref("scroll"));
  }

  // ----- bootstrap --------------------------------------------------------
  function attach() {
    // Wait for a document body to attach to.
    const mount = () => {
      if (document.body) {
        document.body.appendChild(host);
      } else if (document.documentElement) {
        document.documentElement.appendChild(host);
      } else {
        return false;
      }
      return true;
    };
    if (!mount()) {
      // Body not ready yet (early injection); wait for it.
      const obs = new MutationObserver(() => {
        if (mount()) obs.disconnect();
      });
      obs.observe(document.documentElement || document, { childList: true });
    }
  }

  async function start() {
    await loadStyles();
    await loadState();
    // Reflect loaded pinned state in the button.
    setPinned(pinned, false);
    connectPort();
    render();
    wireEvents();
    attach();

    // If pinned at load, show open immediately. Otherwise stay hidden until
    // edge-hover / action / shortcut.
    if (pinned) setOpen(true);

    // React to storage changes from other tabs/windows (e.g. pinned toggled
    // elsewhere) so the local UI stays consistent.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes[STORAGE_PINNED]) {
        pinned = changes[STORAGE_PINNED].newValue === true;
        const btn = ref("pinButton");
        btn.classList.toggle("active", pinned);
        btn.setAttribute("aria-pressed", String(pinned));
        btn.setAttribute("aria-label", pinned ? "Unpin sidebar" : "Pin sidebar");
        if (pinned) setOpen(true);
      }
      if (changes[STORAGE_COLLAPSED]) {
        const next = changes[STORAGE_COLLAPSED].newValue;
        collapsed = next && typeof next === "object" ? next : {};
        render();
      }
    });

    // React to one-shot messages (used when no port exists yet, e.g. action
    // button pressed on a freshly injected tab).
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      handleMessage(msg);
      // Indicate we're alive so the background's tabs.sendMessage doesn't warn.
      if (msg && msg.type === "openAndFocus") {
        try {
          sendResponse({ ok: true });
        } catch {}
      }
      return false;
    });
  }

  start().catch((err) => {
    console.error("[helium-bookmarks] failed to start:", err);
  });
})();
