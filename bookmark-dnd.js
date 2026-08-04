(() => {
  "use strict";

  const BOOKMARK_PORT = "helium-bookmarks";
  const MOVE_MESSAGE = "heliumBookmarkMove";
  const PROTECTED_ROOT_IDS = new Set(["0", "1", "2", "3"]);

  let shadowRoot = null;
  let bookmarkTree = [];
  let nodeById = new Map();
  let parentById = new Map();
  let childrenByParent = new Map();

  let sidebar = null;
  let foldersRoot = null;
  let scrollArea = null;
  let folderInsertionLine = null;

  let dragState = null;
  let activeDrop = null;
  let mutationPending = false;
  let decorateScheduled = false;
  let toastTimer = null;

  const previousConnect = chrome.runtime.connect.bind(chrome.runtime);
  chrome.runtime.connect = function dndObservedConnect(...args) {
    const port = previousConnect(...args);
    const requestedName = args[0] && args[0].name;

    if (requestedName === BOOKMARK_PORT) {
      port.onMessage.addListener((message) => {
        if (message?.type === "bookmarks" && Array.isArray(message.tree)) {
          bookmarkTree = message.tree;
          indexBookmarkTree();
          scheduleDecorate();
        }
      });
    }

    return port;
  };

  const previousAttachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function dndCapturedAttachShadow(init) {
    const root = previousAttachShadow.call(this, init);
    if (!shadowRoot) {
      shadowRoot = root;
      queueMicrotask(setupDragAndDrop);
    }
    return root;
  };

  function setupDragAndDrop() {
    if (!shadowRoot) return;

    sidebar = shadowRoot.getElementById("sidebar");
    foldersRoot = shadowRoot.getElementById("folders");
    scrollArea = shadowRoot.getElementById("scroll");

    if (!sidebar || !foldersRoot || !scrollArea) {
      queueMicrotask(setupDragAndDrop);
      return;
    }

    injectStyles();
    createFolderInsertionLine();

    const observer = new MutationObserver((records) => {
      let shouldDecorate = false;

      for (const record of records) {
        if (record.type === "attributes") {
          if (!isEditMode()) cancelDrag();
          shouldDecorate = true;
        } else if (record.type === "childList") {
          shouldDecorate = true;
        }
      }

      if (shouldDecorate) scheduleDecorate();
    });

    observer.observe(sidebar, {
      attributes: true,
      attributeFilter: ["class"],
    });
    observer.observe(foldersRoot, { childList: true, subtree: true });

    foldersRoot.addEventListener("dragstart", handleDragStart, true);
    foldersRoot.addEventListener("dragover", handleDragOver, true);
    foldersRoot.addEventListener("drop", handleDrop, true);
    foldersRoot.addEventListener("dragend", cancelDrag, true);
    foldersRoot.addEventListener("dragleave", handleDragLeave, true);

    for (const eventName of ["click", "auxclick", "dblclick"]) {
      shadowRoot.addEventListener(
        eventName,
        (event) => {
          if (!eventTargetElement(event)?.closest(".dnd-handle")) return;
          event.preventDefault();
          event.stopImmediatePropagation();
          event.stopPropagation();
        },
        true
      );
    }

    scheduleDecorate();
  }

  function injectStyles() {
    if (shadowRoot.getElementById("bookmarkDndStyles")) return;

    const style = document.createElement("style");
    style.id = "bookmarkDndStyles";
    style.textContent = `
      .dnd-handle {
        display: none;
        width: 15px;
        height: 21px;
        flex: 0 0 15px;
        place-items: center;
        padding: 0;
        border: 0;
        border-radius: 5px;
        color: #72787a;
        background: transparent;
        cursor: grab;
        touch-action: none;
      }

      .sidebar.editor-mode .dnd-handle {
        display: grid;
      }

      .dnd-handle:hover {
        color: #d6d9da;
        background: #343839;
      }

      .dnd-handle:active {
        cursor: grabbing;
      }

      .dnd-handle svg {
        width: 11px;
        height: 15px;
        pointer-events: none;
      }

      .dnd-handle[aria-disabled="true"] {
        display: none !important;
      }

      .dnd-pending .dnd-handle {
        opacity: .32;
        pointer-events: none;
      }

      .dnd-dragging {
        opacity: .42 !important;
      }

      .bookmark.dnd-before,
      .bookmark.dnd-after {
        position: relative;
      }

      .bookmark.dnd-before::before,
      .bookmark.dnd-after::after {
        content: "";
        position: absolute;
        z-index: 8;
        right: 5px;
        left: 5px;
        height: 2px;
        border-radius: 999px;
        background: #d7d9da;
        box-shadow: 0 0 0 1px rgba(0, 0, 0, .45);
        pointer-events: none;
      }

      .bookmark.dnd-before::before {
        top: -2px;
      }

      .bookmark.dnd-after::after {
        bottom: -2px;
      }

      .dnd-folder-insertion-line {
        position: fixed;
        z-index: 2147483647;
        display: none;
        height: 2px;
        border-radius: 999px;
        background: #d7d9da;
        box-shadow: 0 0 0 1px rgba(0, 0, 0, .45);
        pointer-events: none;
      }

      .dnd-folder-insertion-line.visible {
        display: block;
      }

      .folder-header.dnd-folder-target {
        color: #f2f3f3;
        background: #383d3e;
        box-shadow: inset 0 0 0 1px #747b7d;
      }

      .folder-inner.dnd-folder-target {
        border-radius: 7px;
        background: rgba(255, 255, 255, .025);
        box-shadow: inset 0 0 0 1px #596062;
      }

      @media (prefers-reduced-motion: reduce) {
        .dnd-dragging {
          opacity: .55 !important;
        }
      }
    `;

    shadowRoot.appendChild(style);
  }

  function createFolderInsertionLine() {
    if (folderInsertionLine) return;

    folderInsertionLine = document.createElement("div");
    folderInsertionLine.className = "dnd-folder-insertion-line";
    folderInsertionLine.setAttribute("aria-hidden", "true");
    shadowRoot.appendChild(folderInsertionLine);
  }

  function indexBookmarkTree() {
    nodeById = new Map();
    parentById = new Map();
    childrenByParent = new Map();

    const walk = (node, parentId = null) => {
      if (!node || node.id == null) return;

      const id = String(node.id);
      nodeById.set(id, node);
      parentById.set(id, parentId);

      const children = Array.isArray(node.children) ? node.children : [];
      childrenByParent.set(
        id,
        children.map((child) => String(child.id))
      );

      for (const child of children) walk(child, id);
    };

    for (const root of bookmarkTree) walk(root, null);
  }

  function scheduleDecorate() {
    if (!shadowRoot || decorateScheduled) return;

    decorateScheduled = true;
    requestAnimationFrame(() => {
      decorateScheduled = false;
      decorateRows();
    });
  }

  function decorateRows() {
    if (!foldersRoot) return;

    const editing = isEditMode();
    sidebar.classList.toggle("dnd-pending", mutationPending);

    for (const folder of foldersRoot.querySelectorAll(".folder")) {
      const folderId = getFolderId(folder);
      if (!folderId) continue;

      const header = folder.querySelector(":scope > .folder-header");
      if (header) {
        let handle = header.querySelector(":scope > .dnd-handle");
        if (!handle) {
          handle = createHandle("folder");
          const count = header.querySelector(":scope > .folder-count");
          header.insertBefore(handle, count || null);
        }

        configureHandle(handle, {
          kind: "folder",
          id: folderId,
          parentId: parentById.get(folderId) || "",
          disabled: PROTECTED_ROOT_IDS.has(folderId),
          editing,
          label: `Move folder ${folderTitle(folderId)}`,
        });
      }

      decorateBookmarkRows(folder, folderId, editing);
    }
  }

  function decorateBookmarkRows(folder, folderId, editing) {
    const inner = folder.querySelector(
      ":scope > .folder-content > .folder-inner"
    );
    if (!inner) return;

    const rows = [...inner.children].filter((child) =>
      child.classList.contains("bookmark")
    );
    const directBookmarks = (nodeById.get(folderId)?.children || []).filter(
      (node) => typeof node.url === "string"
    );
    const unused = new Set(
      directBookmarks.map((node) => String(node.id))
    );

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const bookmarkId = resolveBookmarkId(
        row,
        directBookmarks,
        unused,
        index
      );
      if (!bookmarkId) continue;

      row.dataset.dndBookmarkId = bookmarkId;
      row.dataset.dndParentId = folderId;

      let handle = row.querySelector(":scope > .dnd-handle");
      if (!handle) {
        handle = createHandle("bookmark");
        row.appendChild(handle);
      }

      configureHandle(handle, {
        kind: "bookmark",
        id: bookmarkId,
        parentId: folderId,
        disabled: false,
        editing,
        label: `Move bookmark ${bookmarkTitle(bookmarkId)}`,
      });
    }
  }

  function resolveBookmarkId(row, candidates, unused, fallbackIndex) {
    const known = findKnownDatasetId(row, "bookmark");
    if (known && unused.has(known)) {
      unused.delete(known);
      return known;
    }

    const href = row.getAttribute("href") || row.href || "";
    const title =
      row.querySelector(".bookmark-title")?.textContent?.trim() || "";

    const exact = candidates.find((node) => {
      const id = String(node.id);
      return (
        unused.has(id) &&
        String(node.url || "") === href &&
        String(node.title || "").trim() === title
      );
    });
    if (exact) {
      const id = String(exact.id);
      unused.delete(id);
      return id;
    }

    const urlMatch = candidates.find((node) => {
      const id = String(node.id);
      return unused.has(id) && String(node.url || "") === href;
    });
    if (urlMatch) {
      const id = String(urlMatch.id);
      unused.delete(id);
      return id;
    }

    const fallback = candidates[fallbackIndex];
    if (fallback && unused.has(String(fallback.id))) {
      const id = String(fallback.id);
      unused.delete(id);
      return id;
    }

    const firstUnused = candidates.find((node) =>
      unused.has(String(node.id))
    );
    if (!firstUnused) return null;

    const id = String(firstUnused.id);
    unused.delete(id);
    return id;
  }

  function findKnownDatasetId(element, expectedKind) {
    const candidates = [
      element,
      ...element.querySelectorAll(
        "[data-node-id], [data-item-id], [data-bookmark-id], [data-editor-id]"
      ),
    ];

    for (const candidate of candidates) {
      for (const value of Object.values(candidate.dataset || {})) {
        const id = String(value || "");
        const node = nodeById.get(id);
        if (!node) continue;

        const kind = typeof node.url === "string" ? "bookmark" : "folder";
        if (kind === expectedKind) return id;
      }
    }

    return null;
  }

  function createHandle(kind) {
    const handle = document.createElement("button");
    handle.type = "button";
    handle.className = "dnd-handle";
    handle.setAttribute("aria-label", `Move ${kind}`);
    handle.title = `Drag to move ${kind}`;
    handle.innerHTML = `
      <svg viewBox="0 0 12 18" fill="none" aria-hidden="true">
        <circle cx="3" cy="4" r="1" fill="currentColor"/>
        <circle cx="9" cy="4" r="1" fill="currentColor"/>
        <circle cx="3" cy="9" r="1" fill="currentColor"/>
        <circle cx="9" cy="9" r="1" fill="currentColor"/>
        <circle cx="3" cy="14" r="1" fill="currentColor"/>
        <circle cx="9" cy="14" r="1" fill="currentColor"/>
      </svg>
    `;
    return handle;
  }

  function configureHandle(handle, options) {
    handle.dataset.dndKind = options.kind;
    handle.dataset.dndId = options.id;
    handle.dataset.dndParentId = options.parentId || "";
    handle.draggable = Boolean(
      options.editing && !options.disabled && !mutationPending
    );
    handle.setAttribute("aria-disabled", String(Boolean(options.disabled)));
    handle.setAttribute("aria-label", options.label);
    handle.title = options.disabled
      ? "Browser root folders cannot be moved"
      : `Drag to move ${options.kind}`;
  }

  function handleDragStart(event) {
    const handle = eventTargetElement(event)?.closest(".dnd-handle");
    if (!handle || !isEditMode() || mutationPending) {
      event.preventDefault();
      return;
    }

    const kind = handle.dataset.dndKind;
    const id = handle.dataset.dndId;
    if (!id || (kind !== "bookmark" && kind !== "folder")) {
      event.preventDefault();
      return;
    }

    if (kind === "folder" && PROTECTED_ROOT_IDS.has(id)) {
      event.preventDefault();
      return;
    }

    dragState = {
      kind,
      id,
      sourceParentId:
        handle.dataset.dndParentId || parentById.get(id) || "",
      sourceElement:
        kind === "folder"
          ? handle.closest(".folder")
          : handle.closest(".bookmark"),
    };

    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData(
        "application/x-helium-bookmark-node",
        JSON.stringify({ kind, id })
      );
      event.dataTransfer.setData("text/plain", bookmarkTitle(id));
    }

    dragState.sourceElement?.classList.add("dnd-dragging");
    clearDropIndicator();
  }

  function handleDragOver(event) {
    if (!dragState || !isEditMode() || mutationPending) return;

    const descriptor = describeDrop(event);
    if (!descriptor || isNoOpDrop(descriptor)) {
      clearDropIndicator();
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";

    setDropIndicator(descriptor);
    autoScroll(event.clientY);
  }

  async function handleDrop(event) {
    if (!dragState || !activeDrop || mutationPending) return;

    const descriptor = activeDrop;
    event.preventDefault();
    event.stopPropagation();

    const moving = { ...dragState };
    clearDropIndicator();
    dragState?.sourceElement?.classList.remove("dnd-dragging");
    dragState = null;

    if (isNoOpDrop(descriptor, moving)) return;

    mutationPending = true;
    scheduleDecorate();

    try {
      const response = await sendMoveRequest({
        id: moving.id,
        parentId: descriptor.parentId,
        beforeId: descriptor.beforeId || null,
        afterId: descriptor.afterId || null,
      });

      if (!response?.ok) {
        throw new Error(response?.error || "The bookmark could not be moved");
      }

      showToast(moving.kind === "folder" ? "Folder moved" : "Bookmark moved");
    } catch (error) {
      showToast(error?.message || "The bookmark could not be moved");
    } finally {
      mutationPending = false;
      scheduleDecorate();
    }
  }

  function handleDragLeave(event) {
    if (!dragState) return;

    const related = event.relatedTarget;
    if (related && foldersRoot.contains(related)) return;
    clearDropIndicator();
  }

  function cancelDrag() {
    dragState?.sourceElement?.classList.remove("dnd-dragging");
    dragState = null;
    clearDropIndicator();
  }

  function describeDrop(event) {
    const target = eventTargetElement(event);
    if (!target || !dragState) return null;

    const bookmarkRow = target.closest(".bookmark");
    const folder = target.closest(".folder");
    const folderHeader = target.closest(".folder-header");

    if (dragState.kind === "bookmark") {
      if (bookmarkRow) {
        const targetId = bookmarkRow.dataset.dndBookmarkId;
        const parentId = bookmarkRow.dataset.dndParentId;
        if (!targetId || !parentId || targetId === dragState.id) return null;

        const rect = bookmarkRow.getBoundingClientRect();
        const before = event.clientY < rect.top + rect.height / 2;

        return {
          kind: "bookmark",
          parentId,
          beforeId: before ? targetId : null,
          afterId: before ? null : targetId,
          indicatorType: "class",
          indicatorElement: bookmarkRow,
          indicatorClass: before ? "dnd-before" : "dnd-after",
        };
      }

      if (folder) {
        const parentId = getFolderId(folder);
        if (!parentId) return null;

        return {
          kind: "bookmark",
          parentId,
          beforeId: null,
          afterId: null,
          indicatorType: "class",
          indicatorElement:
            folderHeader ||
            folder.querySelector(
              ":scope > .folder-content > .folder-inner"
            ),
          indicatorClass: "dnd-folder-target",
        };
      }

      return null;
    }

    if (!folder) return null;

    const targetId = getFolderId(folder);
    if (!targetId || targetId === dragState.id) return null;

    if (PROTECTED_ROOT_IDS.has(targetId)) {
      return {
        kind: "folder",
        parentId: targetId,
        beforeId: null,
        afterId: null,
        indicatorType: "class",
        indicatorElement: folderHeader,
        indicatorClass: "dnd-folder-target",
      };
    }

    const parentId = parentById.get(targetId);
    if (!parentId) return null;

    const hitRect = (folderHeader || folder).getBoundingClientRect();
    const before = event.clientY < hitRect.top + hitRect.height / 2;

    return {
      kind: "folder",
      parentId,
      beforeId: before ? targetId : null,
      afterId: before ? null : targetId,
      indicatorType: "folder-line",
      markerBoundaryElement: folder,
      markerWidthElement: folderHeader || folder,
      markerEdge: before ? "before" : "after",
    };
  }

  function setDropIndicator(descriptor) {
    if (descriptor.indicatorType === "folder-line") {
      clearClassIndicator();
      activeDrop = descriptor;
      positionFolderInsertionLine(descriptor);
      return;
    }

    const same =
      activeDrop?.indicatorType === "class" &&
      activeDrop.indicatorElement === descriptor.indicatorElement &&
      activeDrop.indicatorClass === descriptor.indicatorClass;

    if (same) {
      activeDrop = descriptor;
      return;
    }

    clearDropIndicator();
    activeDrop = descriptor;
    descriptor.indicatorElement?.classList.add(descriptor.indicatorClass);
  }

  function positionFolderInsertionLine(descriptor) {
    if (!folderInsertionLine) return;

    const boundaryRect =
      descriptor.markerBoundaryElement?.getBoundingClientRect();
    const widthRect = descriptor.markerWidthElement?.getBoundingClientRect();
    if (!boundaryRect || !widthRect) {
      hideFolderInsertionLine();
      return;
    }

    const top =
      descriptor.markerEdge === "before"
        ? boundaryRect.top - 1
        : boundaryRect.bottom - 1;
    const left = widthRect.left + 5;
    const width = Math.max(0, widthRect.width - 10);

    folderInsertionLine.style.top = `${Math.round(top)}px`;
    folderInsertionLine.style.left = `${Math.round(left)}px`;
    folderInsertionLine.style.width = `${Math.round(width)}px`;
    folderInsertionLine.classList.add("visible");
  }

  function clearDropIndicator() {
    clearClassIndicator();
    hideFolderInsertionLine();
    activeDrop = null;
  }

  function clearClassIndicator() {
    if (
      activeDrop?.indicatorType === "class" &&
      activeDrop.indicatorElement &&
      activeDrop.indicatorClass
    ) {
      activeDrop.indicatorElement.classList.remove(activeDrop.indicatorClass);
    }
  }

  function hideFolderInsertionLine() {
    folderInsertionLine?.classList.remove("visible");
  }

  function isNoOpDrop(descriptor, moving = dragState) {
    if (!descriptor || !moving) return true;

    const original = childrenByParent.get(moving.sourceParentId) || [];
    const destinationOriginal = childrenByParent.get(descriptor.parentId) || [];
    const filtered = destinationOriginal.filter((id) => id !== moving.id);

    let index = filtered.length;
    if (descriptor.beforeId) {
      index = filtered.indexOf(descriptor.beforeId);
      if (index < 0) return true;
    } else if (descriptor.afterId) {
      const anchor = filtered.indexOf(descriptor.afterId);
      if (anchor < 0) return true;
      index = anchor + 1;
    }

    if (moving.sourceParentId !== descriptor.parentId) return false;

    const expected = [...filtered];
    expected.splice(index, 0, moving.id);
    return arraysEqual(original, expected);
  }

  function arraysEqual(left, right) {
    if (left.length !== right.length) return false;
    return left.every((value, index) => value === right[index]);
  }

  function autoScroll(clientY) {
    if (!scrollArea) return;

    const rect = scrollArea.getBoundingClientRect();
    const threshold = 34;
    const step = 13;

    if (clientY < rect.top + threshold) {
      scrollArea.scrollBy({ top: -step, behavior: "auto" });
    } else if (clientY > rect.bottom - threshold) {
      scrollArea.scrollBy({ top: step, behavior: "auto" });
    }
  }

  function sendMoveRequest(payload) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(
          { type: MOVE_MESSAGE, ...payload },
          (response) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }
            resolve(response);
          }
        );
      } catch (error) {
        reject(error);
      }
    });
  }

  function getFolderId(folder) {
    if (!folder) return null;
    if (folder.dataset.folderId) return String(folder.dataset.folderId);

    const known = findKnownDatasetId(folder, "folder");
    if (known) {
      folder.dataset.folderId = known;
      return known;
    }

    return null;
  }

  function folderTitle(id) {
    return String(nodeById.get(String(id))?.title || "folder").trim() || "folder";
  }

  function bookmarkTitle(id) {
    return (
      String(nodeById.get(String(id))?.title || "bookmark").trim() ||
      "bookmark"
    );
  }

  function isEditMode() {
    return Boolean(sidebar?.classList.contains("editor-mode"));
  }

  function eventTargetElement(event) {
    const direct = event.target;
    if (direct instanceof Element) return direct;
    return event.composedPath().find((item) => item instanceof Element) || null;
  }

  function showToast(message) {
    const toast = shadowRoot?.getElementById("toast");
    if (!toast) return;

    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.add("visible");
    toastTimer = setTimeout(() => toast.classList.remove("visible"), 1500);
  }
})();
