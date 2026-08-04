/*
  Bookmark editing UI for the Helium sidebar.

  This script is loaded before content.js so it can observe the extension's
  closed shadow root and the existing bookmark-data port without exposing either
  to the webpage. It adds edit-mode controls, mutually exclusive folder/bookmark
  selection, new-folder creation, and confirmed deletion workflows.
*/

(() => {
  "use strict";

  const BOOKMARK_PORT = "helium-bookmarks";
  const MUTATION_MESSAGE = "heliumBookmarkMutation";
  const OTHER_BOOKMARKS_ID = "2";
  const PROTECTED_ROOT_IDS = new Set(["1", "2", "3"]);

  let shadowRoot = null;
  let bookmarkTree = [];
  let folderById = new Map();
  let bookmarkById = new Map();
  let parentById = new Map();

  let editMode = false;
  let selectionKind = null;
  let selectedFolderIds = new Set();
  let selectedBookmarkIds = new Set();
  let mutationPending = false;
  let modalOpen = false;
  let decorateScheduled = false;
  let toastTimer = null;

  let controls = null;
  let editButton = null;
  let newFolderButton = null;
  let deleteButton = null;
  let modalLayer = null;

  /* Observe the existing bookmark-data port before content.js registers its
     own listener. The service worker remains the single owner of bookmark data. */
  const previousConnect = chrome.runtime.connect.bind(chrome.runtime);
  chrome.runtime.connect = function editorObservedConnect(...args) {
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

  /* Capture the closed shadow root while preserving the attachShadow wrapper
     installed by sidebar-fixes.js earlier in the manifest order. */
  const previousAttachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function editorCapturedAttachShadow(init) {
    const root = previousAttachShadow.call(this, init);
    if (!shadowRoot) {
      shadowRoot = root;
      queueMicrotask(setupEditor);
    }
    return root;
  };

  function setupEditor() {
    if (!shadowRoot) return;

    const footer = shadowRoot.querySelector(".sidebar-footer");
    const footerLeft = shadowRoot.querySelector(".footer-left");
    const foldersRoot = shadowRoot.getElementById("folders");
    const searchInput = shadowRoot.getElementById("searchInput");

    if (!footer || !footerLeft || !foldersRoot || !searchInput) {
      queueMicrotask(setupEditor);
      return;
    }

    injectEditorStyles();
    createFooterControls(footerLeft);
    createModalLayer();

    const observer = new MutationObserver(scheduleDecorate);
    observer.observe(foldersRoot, { childList: true, subtree: true });

    foldersRoot.addEventListener("click", handleFoldersClick, true);
    foldersRoot.addEventListener("auxclick", blockBookmarkNavigation, true);
    foldersRoot.addEventListener("keydown", handleFoldersKeydown, true);

    /* Keep dialog typing and shortcuts inside the extension instead of letting
       composed keyboard events reach webpage shortcut handlers. */
    for (const eventName of ["keydown", "keyup", "keypress"]) {
      window.addEventListener(
        eventName,
        (event) => {
          if (!modalOpen || !modalLayer) return;
          const active = shadowRoot.activeElement;
          if (!active || !modalLayer.contains(active)) return;

          if (eventName === "keydown" && event.key === "Escape") {
            event.preventDefault();
            closeModal();
          }
          event.stopImmediatePropagation();
          event.stopPropagation();
        },
        true
      );
    }

    scheduleDecorate();
  }

  function injectEditorStyles() {
    if (shadowRoot.getElementById("bookmarkEditorStyles")) return;

    const style = document.createElement("style");
    style.id = "bookmarkEditorStyles";
    style.textContent = `
      .sidebar {
        position: relative;
      }

      .editor-controls {
        display: flex;
        min-width: 0;
        align-items: center;
        gap: 4px;
      }

      .editor-button {
        display: inline-flex;
        height: 23px;
        align-items: center;
        justify-content: center;
        gap: 4px;
        padding: 0 7px;
        border: 1px solid #383d3e;
        border-radius: 6px;
        color: #9aa0a2;
        background: #222526;
        font-size: 9px;
        font-weight: 560;
        line-height: 1;
        cursor: pointer;
        white-space: nowrap;
      }

      .editor-button.editor-icon-button {
        width: 23px;
        padding: 0;
      }

      .editor-button svg {
        width: 12px;
        height: 12px;
        flex: 0 0 auto;
      }

      .editor-button:hover:not(:disabled),
      .editor-button.active {
        color: #f0f1f1;
        background: #343839;
      }

      .editor-button.delete-ready:hover:not(:disabled) {
        border-color: #714242;
        color: #ffd7d7;
        background: #4b2929;
      }

      .editor-button:disabled {
        opacity: .34;
        cursor: default;
      }

      .editor-secondary-actions {
        display: flex;
        max-width: 0;
        align-items: center;
        gap: 4px;
        overflow: hidden;
        opacity: 0;
        transform: translateX(-3px);
        transition:
          max-width 150ms cubic-bezier(.2,.8,.2,1),
          opacity 110ms ease,
          transform 150ms cubic-bezier(.2,.8,.2,1);
      }

      .sidebar.editor-mode .editor-secondary-actions {
        max-width: 54px;
        opacity: 1;
        transform: translateX(0);
      }

      .sidebar.editor-mode .footer-shortcuts {
        display: none;
      }

      .editor-checkbox {
        display: none;
        width: 15px;
        height: 15px;
        flex: 0 0 15px;
        place-items: center;
        border: 1px solid #4b5152;
        border-radius: 4px;
        color: #111314;
        background: #202324;
        cursor: pointer;
        box-shadow: inset 0 0 0 1px rgba(0,0,0,.22);
      }

      .sidebar.editor-mode .editor-checkbox {
        display: grid;
      }

      .editor-checkbox::after {
        content: "";
        width: 7px;
        height: 4px;
        border-left: 1.8px solid currentColor;
        border-bottom: 1.8px solid currentColor;
        opacity: 0;
        transform: translateY(-1px) rotate(-45deg);
      }

      .editor-checkbox.checked {
        border-color: #c5c9ca;
        color: #161819;
        background: #d7d9da;
      }

      .editor-checkbox.checked::after {
        opacity: 1;
      }

      .editor-checkbox.disabled {
        opacity: .25;
        cursor: not-allowed;
      }

      .folder-header.editor-selected,
      .bookmark.editor-selected {
        color: var(--text-strong);
        background: var(--selected);
      }

      .sidebar.editor-mode .bookmark {
        cursor: pointer;
      }

      .sidebar.editor-mode .bookmark:active {
        transform: none;
      }

      .sidebar.editor-mode .search {
        opacity: .55;
      }

      .editor-modal-layer {
        position: absolute;
        z-index: 20;
        inset: 0;
        display: none;
        align-items: center;
        justify-content: center;
        padding: 10px;
        border-radius: 8px;
        background: rgba(10,12,13,.62);
        -webkit-backdrop-filter: blur(4px);
        backdrop-filter: blur(4px);
      }

      .editor-modal-layer.visible {
        display: flex;
      }

      .editor-dialog {
        width: 100%;
        max-width: 188px;
        padding: 11px;
        border: 1px solid #444a4b;
        border-radius: 9px;
        color: #d9dcdd;
        background: #202324;
        box-shadow: 0 18px 42px rgba(0,0,0,.58);
      }

      .editor-dialog-title {
        margin: 0 0 6px;
        color: #f0f1f1;
        font-size: 12px;
        font-weight: 640;
        line-height: 1.25;
      }

      .editor-dialog-copy {
        margin: 0 0 10px;
        color: #979d9f;
        font-size: 10px;
        line-height: 1.4;
      }

      .editor-dialog-input {
        width: 100%;
        height: 29px;
        margin: 0 0 10px;
        padding: 0 8px;
        border: 1px solid #505657;
        border-radius: 7px;
        outline: none;
        color: #eceeee;
        background: #181b1c;
        font-size: 11px;
      }

      .editor-dialog-input:focus {
        border-color: #777e80;
        box-shadow: 0 0 0 2px rgba(255,255,255,.04);
      }

      .editor-options {
        display: grid;
        gap: 6px;
        margin: 0 0 10px;
      }

      .editor-option {
        display: grid;
        grid-template-columns: 14px 1fr;
        gap: 7px;
        align-items: start;
        padding: 7px;
        border: 1px solid #383d3e;
        border-radius: 7px;
        color: #c5c9ca;
        background: #1b1e1f;
        cursor: pointer;
      }

      .editor-option:hover {
        border-color: #505657;
        background: #242829;
      }

      .editor-option input {
        width: 13px;
        height: 13px;
        margin: 0;
        accent-color: #d7d9da;
      }

      .editor-option-title {
        display: block;
        margin-bottom: 2px;
        font-size: 10px;
        font-weight: 620;
      }

      .editor-option-copy {
        display: block;
        color: #858b8d;
        font-size: 9px;
        line-height: 1.35;
      }

      .editor-dialog-actions {
        display: flex;
        justify-content: flex-end;
        gap: 6px;
      }

      .editor-dialog-button {
        height: 25px;
        padding: 0 9px;
        border: 1px solid #414647;
        border-radius: 6px;
        color: #c8cccd;
        background: #292d2e;
        font-size: 9px;
        font-weight: 600;
        cursor: pointer;
      }

      .editor-dialog-button:hover {
        color: #fff;
        background: #353a3b;
      }

      .editor-dialog-button.primary {
        border-color: #62696b;
        color: #17191a;
        background: #d7d9da;
      }

      .editor-dialog-button.danger {
        border-color: #7b4949;
        color: #ffe2e2;
        background: #542d2d;
      }

      .editor-dialog-button:disabled {
        opacity: .4;
        cursor: default;
      }

      @media (prefers-reduced-motion: reduce) {
        .editor-secondary-actions {
          transition: none;
        }
      }
    `;
    shadowRoot.appendChild(style);
  }

  function createFooterControls(footerLeft) {
    if (shadowRoot.getElementById("bookmarkEditorControls")) return;

    controls = document.createElement("div");
    controls.id = "bookmarkEditorControls";
    controls.className = "editor-controls";

    editButton = makeEditorButton({
      id: "bookmarkEditToggle",
      label: "Edit",
      title: "Edit bookmarks",
    });
    editButton.setAttribute("aria-pressed", "false");
    editButton.addEventListener("click", toggleEditMode);

    const secondary = document.createElement("div");
    secondary.className = "editor-secondary-actions";

    newFolderButton = makeEditorButton({
      id: "bookmarkNewFolder",
      label: "",
      title: "New folder",
      icon: plusIcon(),
      iconOnly: true,
    });
    newFolderButton.disabled = true;
    newFolderButton.addEventListener("click", openNewFolderDialog);

    deleteButton = makeEditorButton({
      id: "bookmarkDeleteSelection",
      label: "",
      title: "Delete selected bookmarks or folders",
      icon: trashIcon(),
      iconOnly: true,
    });
    deleteButton.disabled = true;
    deleteButton.addEventListener("click", openDeleteDialog);

    secondary.append(newFolderButton, deleteButton);
    controls.append(editButton, secondary);
    footerLeft.appendChild(controls);
  }

  function makeEditorButton({ id, label, title, icon, iconOnly = false }) {
    const button = document.createElement("button");
    button.id = id;
    button.type = "button";
    button.className = "editor-button";
    if (iconOnly) button.classList.add("editor-icon-button");
    button.title = title;
    button.setAttribute("aria-label", title);
    if (icon) button.appendChild(icon);
    if (label) button.appendChild(document.createTextNode(label));
    return button;
  }

  function plusIcon() {
    const svg = svgElement("0 0 20 20");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M10 4v12M4 10h12");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.7");
    path.setAttribute("stroke-linecap", "round");
    svg.appendChild(path);
    return svg;
  }

  function trashIcon() {
    const svg = svgElement("0 0 20 20");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M4.5 6h11M8 3.8h4M6.2 6l.7 10h6.2l.7-10M8.2 8.5v5M11.8 8.5v5");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.35");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.appendChild(path);
    return svg;
  }

  function svgElement(viewBox) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", viewBox);
    svg.setAttribute("fill", "none");
    svg.setAttribute("aria-hidden", "true");
    return svg;
  }

  function createModalLayer() {
    if (modalLayer) return;
    const sidebar = shadowRoot.getElementById("sidebar");
    if (!sidebar) return;

    modalLayer = document.createElement("div");
    modalLayer.className = "editor-modal-layer";
    modalLayer.setAttribute("aria-hidden", "true");
    modalLayer.addEventListener("mousedown", (event) => {
      if (event.target === modalLayer) closeModal();
    });
    sidebar.appendChild(modalLayer);
  }

  function indexBookmarkTree() {
    folderById = new Map();
    bookmarkById = new Map();
    parentById = new Map();

    const walk = (nodes, parentId = null) => {
      for (const node of nodes || []) {
        const id = String(node.id);
        parentById.set(id, parentId);
        if (node.url) {
          bookmarkById.set(id, node);
        } else {
          folderById.set(id, node);
          walk(node.children || [], id);
        }
      }
    };

    walk(bookmarkTree);
  }

  function toggleEditMode() {
    if (mutationPending || modalOpen) return;

    editMode = !editMode;
    const sidebar = shadowRoot.getElementById("sidebar");
    const searchInput = shadowRoot.getElementById("searchInput");

    if (editMode) {
      if (searchInput.value) {
        searchInput.value = "";
        searchInput.dispatchEvent(
          new Event("input", { bubbles: true, composed: false })
        );
      }
      searchInput.disabled = true;
      sidebar.classList.add("editor-mode");
      editButton.textContent = "Done";
      editButton.classList.add("active");
      editButton.setAttribute("aria-pressed", "true");
      editButton.title = "Finish editing";
      editButton.setAttribute("aria-label", "Finish editing");
    } else {
      searchInput.disabled = false;
      sidebar.classList.remove("editor-mode");
      editButton.textContent = "Edit";
      editButton.classList.remove("active");
      editButton.setAttribute("aria-pressed", "false");
      editButton.title = "Edit bookmarks";
      editButton.setAttribute("aria-label", "Edit bookmarks");
      clearSelection();
    }

    scheduleDecorate();
    syncSelectionUi();
  }

  function scheduleDecorate() {
    if (!shadowRoot || decorateScheduled) return;
    decorateScheduled = true;
    requestAnimationFrame(() => {
      decorateScheduled = false;
      decorateRenderedRows();
    });
  }

  function decorateRenderedRows() {
    const foldersRoot = shadowRoot?.getElementById("folders");
    if (!foldersRoot) return;

    for (const folderElement of foldersRoot.querySelectorAll(
      ".folder[data-folder-id]"
    )) {
      const folderId = String(folderElement.dataset.folderId || "");
      const folderNode = folderById.get(folderId);
      const header = folderElement.querySelector(":scope > .folder-header");
      if (!folderNode || !header) continue;

      let folderCheckbox = header.querySelector(
        ":scope > .editor-folder-checkbox"
      );
      if (!folderCheckbox) {
        folderCheckbox = makeSelectionCheckbox("folder", folderId);
        folderCheckbox.classList.add("editor-folder-checkbox");
        header.insertBefore(folderCheckbox, header.firstChild);
      }

      const protectedRoot = PROTECTED_ROOT_IDS.has(folderId);
      folderCheckbox.dataset.protected = String(protectedRoot);
      if (protectedRoot) {
        folderCheckbox.title = "Browser root folders cannot be deleted";
      }

      const inner = folderElement.querySelector(
        ":scope > .folder-content > .folder-inner"
      );
      if (!inner) continue;

      const directBookmarks = (folderNode.children || []).filter(
        (child) => typeof child.url === "string"
      );
      const rows = [...inner.children].filter((child) =>
        child.classList.contains("bookmark")
      );

      rows.forEach((row, index) => {
        const bookmark = directBookmarks[index];
        if (!bookmark) {
          row.removeAttribute("data-bookmark-id");
          return;
        }

        const bookmarkId = String(bookmark.id);
        row.dataset.bookmarkId = bookmarkId;
        row.dataset.parentFolderId = folderId;

        let bookmarkCheckbox = row.querySelector(
          ":scope > .editor-bookmark-checkbox"
        );
        if (!bookmarkCheckbox) {
          bookmarkCheckbox = makeSelectionCheckbox("bookmark", bookmarkId);
          bookmarkCheckbox.classList.add("editor-bookmark-checkbox");
          row.insertBefore(bookmarkCheckbox, row.firstChild);
        } else {
          bookmarkCheckbox.dataset.itemId = bookmarkId;
        }
      });
    }

    syncSelectionUi();
  }

  function makeSelectionCheckbox(type, id) {
    const checkbox = document.createElement("span");
    checkbox.className = "editor-checkbox";
    checkbox.dataset.selectionType = type;
    checkbox.dataset.itemId = String(id);
    checkbox.setAttribute("role", "checkbox");
    checkbox.setAttribute("aria-checked", "false");
    checkbox.setAttribute("aria-disabled", "false");
    checkbox.tabIndex = 0;
    checkbox.setAttribute(
      "aria-label",
      type === "folder" ? "Select folder" : "Select bookmark"
    );
    return checkbox;
  }

  function handleFoldersClick(event) {
    if (!editMode) return;

    const checkbox = event.target.closest?.(".editor-checkbox");
    if (checkbox) {
      event.preventDefault();
      event.stopImmediatePropagation();
      event.stopPropagation();
      toggleSelectionFromCheckbox(checkbox);
      return;
    }

    const bookmarkRow = event.target.closest?.(".bookmark[data-bookmark-id]");
    if (bookmarkRow) {
      event.preventDefault();
      event.stopImmediatePropagation();
      event.stopPropagation();
      toggleSelection("bookmark", bookmarkRow.dataset.bookmarkId);
    }
  }

  function blockBookmarkNavigation(event) {
    if (!editMode) return;
    if (event.target.closest?.(".bookmark[data-bookmark-id]")) {
      event.preventDefault();
      event.stopImmediatePropagation();
      event.stopPropagation();
    }
  }

  function handleFoldersKeydown(event) {
    if (!editMode || !["Enter", " "].includes(event.key)) return;
    const checkbox = event.target.closest?.(".editor-checkbox");
    if (!checkbox) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    event.stopPropagation();
    toggleSelectionFromCheckbox(checkbox);
  }

  function toggleSelectionFromCheckbox(checkbox) {
    if (checkbox.classList.contains("disabled")) {
      const type = checkbox.dataset.selectionType;
      if (type === "folder" && checkbox.dataset.protected === "true") {
        showEditorToast("Browser root folders cannot be deleted");
      } else {
        showEditorToast("Select either folders or bookmarks, not both");
      }
      return;
    }

    toggleSelection(checkbox.dataset.selectionType, checkbox.dataset.itemId);
  }

  function toggleSelection(type, id) {
    if (mutationPending || !id) return;
    if (type === "folder" && PROTECTED_ROOT_IDS.has(String(id))) {
      showEditorToast("Browser root folders cannot be deleted");
      return;
    }

    if (selectionKind && selectionKind !== type) {
      showEditorToast("Select either folders or bookmarks, not both");
      return;
    }

    const targetSet =
      type === "folder" ? selectedFolderIds : selectedBookmarkIds;
    const normalizedId = String(id);

    if (targetSet.has(normalizedId)) {
      targetSet.delete(normalizedId);
    } else {
      targetSet.add(normalizedId);
    }

    selectionKind = selectedCount() === 0 ? null : type;
    syncSelectionUi();
  }

  function clearSelection() {
    selectedFolderIds = new Set();
    selectedBookmarkIds = new Set();
    selectionKind = null;
    syncSelectionUi();
  }

  function selectedCount() {
    return selectedFolderIds.size + selectedBookmarkIds.size;
  }

  function syncSelectionUi() {
    if (!shadowRoot || !editButton || !newFolderButton || !deleteButton) return;

    const hasSelection = selectedCount() > 0;

    for (const checkbox of shadowRoot.querySelectorAll(".editor-checkbox")) {
      const type = checkbox.dataset.selectionType;
      const id = String(checkbox.dataset.itemId || "");
      const protectedRoot =
        type === "folder" && PROTECTED_ROOT_IDS.has(id);
      const disabled =
        mutationPending ||
        protectedRoot ||
        Boolean(selectionKind && selectionKind !== type);
      const checked =
        type === "folder"
          ? selectedFolderIds.has(id)
          : selectedBookmarkIds.has(id);

      checkbox.classList.toggle("disabled", disabled);
      checkbox.classList.toggle("checked", checked);
      checkbox.setAttribute("aria-disabled", String(disabled));
      checkbox.setAttribute("aria-checked", String(checked));
      checkbox.tabIndex = disabled ? -1 : 0;

      const selectableRow = checkbox.closest(".folder-header, .bookmark");
      selectableRow?.classList.toggle("editor-selected", checked);
    }

    editButton.disabled = mutationPending;
    newFolderButton.disabled = mutationPending || !editMode || hasSelection;
    deleteButton.disabled = mutationPending || !editMode || !hasSelection;
    deleteButton.classList.toggle(
      "delete-ready",
      editMode && hasSelection && !mutationPending
    );

    if (!hasSelection) {
      deleteButton.title = "Select bookmarks or folders to delete";
      deleteButton.setAttribute(
        "aria-label",
        "Select bookmarks or folders to delete"
      );
    } else {
      const noun = selectionKind === "folder" ? "folders" : "bookmarks";
      deleteButton.title = `Delete ${selectedCount()} selected ${noun}`;
      deleteButton.setAttribute("aria-label", deleteButton.title);
    }
  }

  function openNewFolderDialog() {
    if (!editMode || mutationPending || selectedCount() > 0) return;

    const dialog = baseDialog("New folder", "Create a folder in Other bookmarks.");
    const input = document.createElement("input");
    input.className = "editor-dialog-input";
    input.type = "text";
    input.maxLength = 255;
    input.placeholder = "Folder name";
    input.autocomplete = "off";

    const actions = document.createElement("div");
    actions.className = "editor-dialog-actions";
    const cancel = dialogButton("Cancel");
    const create = dialogButton("Create", "primary");
    create.disabled = true;

    input.addEventListener("input", () => {
      create.disabled = input.value.trim().length === 0;
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !create.disabled) {
        event.preventDefault();
        create.click();
      }
    });

    cancel.addEventListener("click", closeModal);
    create.addEventListener("click", async () => {
      const title = input.value.trim();
      if (!title) return;
      closeModal();
      await runMutation(
        {
          action: "createFolder",
          title,
          parentId: OTHER_BOOKMARKS_ID,
        },
        `Created “${title}”`
      );
    });

    actions.append(cancel, create);
    dialog.append(input, actions);
    showModal(dialog, input);
  }

  function openDeleteDialog() {
    if (!editMode || mutationPending || selectedCount() === 0) return;

    if (selectionKind === "bookmark") {
      openBookmarkDeleteDialog();
    } else if (selectionKind === "folder") {
      openFolderDeleteDialog();
    }
  }

  function openBookmarkDeleteDialog() {
    const count = selectedBookmarkIds.size;
    const noun = count === 1 ? "bookmark" : "bookmarks";
    const dialog = baseDialog(
      `Delete ${count} ${noun}?`,
      "This removes the selected bookmark sites from the browser."
    );

    const actions = document.createElement("div");
    actions.className = "editor-dialog-actions";
    const cancel = dialogButton("Cancel");
    const remove = dialogButton("Delete", "danger");

    cancel.addEventListener("click", closeModal);
    remove.addEventListener("click", async () => {
      const ids = [...selectedBookmarkIds];
      closeModal();
      await runMutation(
        { action: "deleteBookmarks", ids },
        `Deleted ${count} ${noun}`
      );
    });

    actions.append(cancel, remove);
    dialog.appendChild(actions);
    showModal(dialog, cancel);
  }

  function openFolderDeleteDialog() {
    const count = selectedFolderIds.size;
    const noun = count === 1 ? "folder" : "folders";
    const dialog = baseDialog(
      `Delete ${count} ${noun}?`,
      "Choose what should happen to the contents of the selected folders."
    );

    const options = document.createElement("div");
    options.className = "editor-options";
    options.append(
      folderDeleteOption({
        value: "folderOnly",
        title: "Delete folder only",
        copy: "Move its bookmarks and subfolders to Other bookmarks.",
        checked: true,
      }),
      folderDeleteOption({
        value: "everything",
        title: "Delete everything",
        copy: "Delete the folders and every bookmark contained inside them.",
        checked: false,
      })
    );

    const actions = document.createElement("div");
    actions.className = "editor-dialog-actions";
    const cancel = dialogButton("Cancel");
    const remove = dialogButton("Continue", "danger");

    cancel.addEventListener("click", closeModal);
    remove.addEventListener("click", async () => {
      const mode =
        options.querySelector('input[name="folderDeleteMode"]:checked')?.value ||
        "folderOnly";
      const ids = [...selectedFolderIds];
      closeModal();
      await runMutation(
        { action: "deleteFolders", ids, mode },
        mode === "everything"
          ? `Deleted ${count} ${noun} and their contents`
          : `Deleted ${count} ${noun}; contents moved to Other bookmarks`
      );
    });

    actions.append(cancel, remove);
    dialog.append(options, actions);
    showModal(dialog, cancel);
  }

  function folderDeleteOption({ value, title, copy, checked }) {
    const label = document.createElement("label");
    label.className = "editor-option";

    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "folderDeleteMode";
    radio.value = value;
    radio.checked = checked;

    const text = document.createElement("span");
    const heading = document.createElement("span");
    heading.className = "editor-option-title";
    heading.textContent = title;
    const description = document.createElement("span");
    description.className = "editor-option-copy";
    description.textContent = copy;
    text.append(heading, description);

    label.append(radio, text);
    return label;
  }

  function baseDialog(title, copy) {
    const dialog = document.createElement("section");
    dialog.className = "editor-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");

    const heading = document.createElement("h2");
    heading.className = "editor-dialog-title";
    heading.textContent = title;
    const description = document.createElement("p");
    description.className = "editor-dialog-copy";
    description.textContent = copy;
    dialog.append(heading, description);
    return dialog;
  }

  function dialogButton(label, variant = "") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "editor-dialog-button";
    if (variant) button.classList.add(variant);
    button.textContent = label;
    return button;
  }

  function showModal(dialog, focusTarget) {
    if (!modalLayer) return;
    modalLayer.replaceChildren(dialog);
    modalLayer.classList.add("visible");
    modalLayer.setAttribute("aria-hidden", "false");
    modalOpen = true;
    syncSelectionUi();
    requestAnimationFrame(() => focusTarget?.focus());
  }

  function closeModal() {
    if (!modalLayer) return;
    modalLayer.classList.remove("visible");
    modalLayer.setAttribute("aria-hidden", "true");
    modalLayer.replaceChildren();
    modalOpen = false;
    syncSelectionUi();
  }

  async function runMutation(message, successMessage) {
    mutationPending = true;
    syncSelectionUi();

    try {
      const response = await sendMutation(message);
      if (!response?.ok) {
        throw new Error(response?.error || "Bookmark operation failed");
      }
      clearSelection();
      showEditorToast(successMessage);
    } catch (error) {
      showEditorToast(error?.message || "Bookmark operation failed");
    } finally {
      mutationPending = false;
      syncSelectionUi();
    }
  }

  function sendMutation(payload) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(
          { type: MUTATION_MESSAGE, ...payload },
          (response) => {
            const runtimeError = chrome.runtime.lastError;
            if (runtimeError) {
              reject(new Error(runtimeError.message));
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

  function showEditorToast(message) {
    const toast = shadowRoot?.getElementById("toast");
    if (!toast) return;
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.add("visible");
    toastTimer = setTimeout(() => toast.classList.remove("visible"), 1800);
  }
})();
