/*
  Rename/edit controls for bookmark folders and sites.

  This script extends the existing edit-mode UI without exposing the closed
  Shadow DOM to page scripts. A pencil button becomes available when exactly
  one editable folder or bookmark is selected.
*/

(() => {
  "use strict";

  const BOOKMARK_PORT = "helium-bookmarks";
  const UPDATE_MESSAGE = "heliumBookmarkUpdate";
  const PROTECTED_ROOT_IDS = new Set(["0", "1", "2", "3"]);

  let shadowRoot = null;
  let nodeById = new Map();
  let renameButton = null;
  let modalLayer = null;
  let renameModalOpen = false;
  let updatePending = false;
  let syncScheduled = false;
  let toastTimer = null;

  const previousConnect = chrome.runtime.connect.bind(chrome.runtime);
  chrome.runtime.connect = function renameObservedConnect(...args) {
    const port = previousConnect(...args);
    const requestedName = args[0] && args[0].name;

    if (requestedName === BOOKMARK_PORT) {
      port.onMessage.addListener((message) => {
        if (message?.type === "bookmarks" && Array.isArray(message.tree)) {
          indexBookmarkTree(message.tree);
          scheduleSync();
        }
      });
    }

    return port;
  };

  const previousAttachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function renameCapturedAttachShadow(init) {
    const root = previousAttachShadow.call(this, init);
    if (!shadowRoot) {
      shadowRoot = root;
      queueMicrotask(setupRenameUi);
    }
    return root;
  };

  function setupRenameUi() {
    if (!shadowRoot) return;

    const sidebar = shadowRoot.getElementById("sidebar");
    const foldersRoot = shadowRoot.getElementById("folders");
    const secondary = shadowRoot.querySelector(".editor-secondary-actions");
    const deleteButton = shadowRoot.getElementById("bookmarkDeleteSelection");
    modalLayer = shadowRoot.querySelector(".editor-modal-layer");

    if (!sidebar || !foldersRoot || !secondary || !deleteButton || !modalLayer) {
      queueMicrotask(setupRenameUi);
      return;
    }

    injectStyles();
    createRenameButton(secondary, deleteButton);

    const observer = new MutationObserver(scheduleSync);
    observer.observe(sidebar, {
      attributes: true,
      attributeFilter: ["class"],
    });
    observer.observe(foldersRoot, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "data-item-id", "data-bookmark-id"],
    });

    modalLayer.addEventListener(
      "mousedown",
      (event) => {
        if (!renameModalOpen || event.target !== modalLayer) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        closeRenameModal();
      },
      true
    );

    for (const eventName of ["keydown", "keyup", "keypress"]) {
      window.addEventListener(
        eventName,
        (event) => {
          if (!renameModalOpen || !modalLayer) return;
          const active = shadowRoot.activeElement;
          if (!active || !modalLayer.contains(active)) return;

          if (eventName === "keydown" && event.key === "Escape") {
            event.preventDefault();
            closeRenameModal();
          }

          event.stopImmediatePropagation();
          event.stopPropagation();
        },
        true
      );
    }

    scheduleSync();
  }

  function injectStyles() {
    if (shadowRoot.getElementById("bookmarkRenameStyles")) return;

    const style = document.createElement("style");
    style.id = "bookmarkRenameStyles";
    style.textContent = `
      .sidebar.editor-mode .editor-secondary-actions {
        max-width: 81px;
      }

      .rename-field {
        display: grid;
        gap: 4px;
        margin-bottom: 9px;
      }

      .rename-field-label {
        color: #919799;
        font-size: 9px;
        font-weight: 600;
        line-height: 1;
      }

      .rename-field .editor-dialog-input {
        margin: 0;
      }

      .rename-field-error {
        min-height: 12px;
        margin: -3px 0 7px;
        color: #e49a9a;
        font-size: 9px;
        line-height: 1.35;
      }
    `;
    shadowRoot.appendChild(style);
  }

  function createRenameButton(secondary, deleteButton) {
    if (shadowRoot.getElementById("bookmarkRenameSelection")) return;

    renameButton = document.createElement("button");
    renameButton.id = "bookmarkRenameSelection";
    renameButton.type = "button";
    renameButton.className = "editor-button editor-icon-button";
    renameButton.title = "Select one bookmark or folder to edit";
    renameButton.setAttribute(
      "aria-label",
      "Select one bookmark or folder to edit"
    );
    renameButton.disabled = true;
    renameButton.innerHTML = `
      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <path d="M4.2 14.9 5 11.6 12.8 3.8a1.35 1.35 0 0 1 1.9 0l1.5 1.5a1.35 1.35 0 0 1 0 1.9L8.4 15l-3.3.8-.9-.9Z"
          stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="m11.8 4.8 3.4 3.4M5 11.6 8.4 15"
          stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/>
      </svg>
    `;
    renameButton.addEventListener("click", openRenameDialog);

    secondary.insertBefore(renameButton, deleteButton);
  }

  function indexBookmarkTree(tree) {
    nodeById = new Map();

    const walk = (nodes) => {
      for (const node of nodes || []) {
        if (!node || node.id == null) continue;
        nodeById.set(String(node.id), node);
        if (!node.url) walk(node.children || []);
      }
    };

    walk(tree);
  }

  function scheduleSync() {
    if (!shadowRoot || syncScheduled) return;
    syncScheduled = true;
    requestAnimationFrame(() => {
      syncScheduled = false;
      syncRenameButton();
    });
  }

  function selectedItem() {
    if (!shadowRoot) return null;

    const checked = [
      ...shadowRoot.querySelectorAll(".editor-checkbox.checked"),
    ];
    if (checked.length !== 1) return null;

    const checkbox = checked[0];
    const kind = checkbox.dataset.selectionType;
    const id = String(checkbox.dataset.itemId || "");
    const node = nodeById.get(id);

    if (!node || (kind !== "folder" && kind !== "bookmark")) return null;
    if (kind === "folder" && PROTECTED_ROOT_IDS.has(id)) return null;
    if (kind === "folder" && typeof node.url === "string") return null;
    if (kind === "bookmark" && typeof node.url !== "string") return null;

    return { kind, id, node };
  }

  function syncRenameButton() {
    if (!renameButton || !shadowRoot) return;

    const editing = shadowRoot
      .getElementById("sidebar")
      ?.classList.contains("editor-mode");
    const selection = selectedItem();
    const enabled = Boolean(editing && selection && !updatePending && !renameModalOpen);

    renameButton.disabled = !enabled;

    if (!editing) {
      setRenameButtonLabel("Edit selected bookmark or folder");
    } else if (!selection) {
      const count = shadowRoot.querySelectorAll(
        ".editor-checkbox.checked"
      ).length;
      setRenameButtonLabel(
        count > 1
          ? "Select only one item to edit"
          : "Select one bookmark or folder to edit"
      );
    } else {
      setRenameButtonLabel(
        selection.kind === "folder"
          ? `Rename folder ${displayTitle(selection.node)}`
          : `Edit bookmark ${displayTitle(selection.node)}`
      );
    }
  }

  function setRenameButtonLabel(label) {
    renameButton.title = label;
    renameButton.setAttribute("aria-label", label);
  }

  function openRenameDialog() {
    if (updatePending || renameModalOpen) return;

    const selection = selectedItem();
    if (!selection || !modalLayer) return;

    const isFolder = selection.kind === "folder";
    const dialog = createDialog(
      isFolder ? "Rename folder" : "Edit bookmark",
      isFolder
        ? "Change the folder name."
        : "Change the bookmark name or destination URL."
    );
    const form = document.createElement("form");
    form.noValidate = true;

    const titleInput = createField({
      label: "Name",
      value: selection.node.title || "",
      placeholder: isFolder ? "Folder name" : "Bookmark name",
      type: "text",
      maxLength: 255,
    });
    form.appendChild(titleInput.wrapper);

    let urlInput = null;
    if (!isFolder) {
      urlInput = createField({
        label: "URL",
        value: selection.node.url || "",
        placeholder: "https://example.com",
        type: "url",
        maxLength: 8192,
      });
      form.appendChild(urlInput.wrapper);
    }

    const error = document.createElement("div");
    error.className = "rename-field-error";
    error.setAttribute("role", "alert");

    const actions = document.createElement("div");
    actions.className = "editor-dialog-actions";
    const cancel = createDialogButton("Cancel");
    const save = createDialogButton("Save", "primary");

    const syncSaveState = () => {
      const title = titleInput.input.value.trim();
      let valid = title.length > 0;
      let changed = title !== String(selection.node.title || "").trim();
      let url = null;

      if (!isFolder) {
        try {
          url = normalizeHttpUrl(urlInput.input.value);
          changed = changed || url !== normalizeHttpUrl(selection.node.url || "");
          error.textContent = "";
        } catch (validationError) {
          valid = false;
          error.textContent = validationError.message;
        }
      } else {
        error.textContent = title ? "" : "Enter a folder name";
      }

      save.disabled = !valid || !changed;
      return { title, url };
    };

    titleInput.input.addEventListener("input", syncSaveState);
    urlInput?.input.addEventListener("input", syncSaveState);

    cancel.addEventListener("click", closeRenameModal);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const values = syncSaveState();
      if (save.disabled) return;

      closeRenameModal();
      await updateSelectedItem({
        id: selection.id,
        kind: selection.kind,
        title: values.title,
        url: values.url,
      });
    });

    actions.append(cancel, save);
    form.append(error, actions);
    dialog.appendChild(form);

    showRenameModal(dialog, titleInput.input);
    titleInput.input.select();
    syncSaveState();
  }

  function createField({ label, value, placeholder, type, maxLength }) {
    const wrapper = document.createElement("label");
    wrapper.className = "rename-field";

    const caption = document.createElement("span");
    caption.className = "rename-field-label";
    caption.textContent = label;

    const input = document.createElement("input");
    input.className = "editor-dialog-input";
    input.type = type;
    input.value = value;
    input.placeholder = placeholder;
    input.maxLength = maxLength;
    input.autocomplete = "off";
    input.spellcheck = false;

    wrapper.append(caption, input);
    return { wrapper, input };
  }

  function createDialog(title, copy) {
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

  function createDialogButton(label, variant = "") {
    const button = document.createElement("button");
    button.type = label === "Save" ? "submit" : "button";
    button.className = "editor-dialog-button";
    if (variant) button.classList.add(variant);
    button.textContent = label;
    return button;
  }

  function showRenameModal(dialog, focusTarget) {
    modalLayer.replaceChildren(dialog);
    modalLayer.classList.add("visible");
    modalLayer.setAttribute("aria-hidden", "false");
    renameModalOpen = true;
    syncRenameButton();
    requestAnimationFrame(() => focusTarget?.focus());
  }

  function closeRenameModal() {
    if (!modalLayer || !renameModalOpen) return;
    modalLayer.classList.remove("visible");
    modalLayer.setAttribute("aria-hidden", "true");
    modalLayer.replaceChildren();
    renameModalOpen = false;
    syncRenameButton();
  }

  async function updateSelectedItem(payload) {
    updatePending = true;
    syncRenameButton();

    try {
      const response = await sendUpdate(payload);
      if (!response?.ok) {
        throw new Error(response?.error || "The bookmark could not be updated");
      }
      showToast(payload.kind === "folder" ? "Folder renamed" : "Bookmark updated");
    } catch (error) {
      showToast(error?.message || "The bookmark could not be updated");
    } finally {
      updatePending = false;
      syncRenameButton();
    }
  }

  function sendUpdate(payload) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(
          { type: UPDATE_MESSAGE, ...payload },
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

  function normalizeHttpUrl(value) {
    const raw = String(value || "").trim();
    if (!raw) throw new Error("Enter a URL");

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

  function displayTitle(node) {
    return String(node?.title || "Untitled").trim() || "Untitled";
  }

  function showToast(message) {
    const toast = shadowRoot?.getElementById("toast");
    if (!toast) return;

    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.add("visible");
    toastTimer = setTimeout(() => toast.classList.remove("visible"), 1800);
  }
})();
