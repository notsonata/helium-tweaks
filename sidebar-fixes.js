/*
  Interaction and layout corrections loaded before content.js.

  This prelude stays deliberately narrow. It corrects browser-control,
  keyboard, persistence-startup, pin alignment, and flat folder presentation
  without owning the sidebar's state.
*/

(() => {
  "use strict";

  const STORAGE_COLLAPSED = "heliumBmSidebar:collapsed:v1";
  const BROWSER_ROOT_IDS = new Set(["1", "2", "3"]);

  let shadowRoot = null;
  let bookmarkTreeReceived = false;
  let flattenScheduled = false;
  let flattening = false;

  /*
    content.js loads persisted state before bookmark data arrives, then performs
    one empty render. Its deleted-folder cleanup sees an empty bookmark tree and
    would erase every saved folder id. Suppress only that premature empty write.

    There is intentionally no per-page snapshot or restore write here. The
    previous implementation restored a stale snapshot after the first bookmark
    message, allowing a refreshed tab to overwrite newer state from another
    page. Once a real tree has arrived, content.js may prune genuinely deleted
    folder ids normally. chrome.storage.onChanged remains the single source of
    cross-page synchronization.
  */
  const nativeStorageSet = chrome.storage.local.set.bind(chrome.storage.local);

  chrome.storage.local.set = function guardedStorageSet(items, callback) {
    const next = items?.[STORAGE_COLLAPSED];
    const isPrematureEmptyPrune =
      !bookmarkTreeReceived &&
      next &&
      typeof next === "object" &&
      Object.keys(next).length === 0;

    if (isPrematureEmptyPrune) {
      if (typeof callback === "function") queueMicrotask(callback);
      return;
    }

    return nativeStorageSet(items, callback);
  };

  /* Mark persistence as ready before content.js handles the first bookmark
     payload and calls render(), so its normal deleted-folder cleanup is safe. */
  const nativeConnect = chrome.runtime.connect.bind(chrome.runtime);
  chrome.runtime.connect = function observedConnect(...args) {
    const port = nativeConnect(...args);
    port.onMessage.addListener((message) => {
      if (message?.type === "bookmarks" && Array.isArray(message.tree)) {
        bookmarkTreeReceived = true;
      }
    });
    return port;
  };

  /* Capture only the extension's closed shadow root, then immediately restore
     attachShadow so no later component is affected. */
  const nativeAttachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function capturedAttachShadow(init) {
    const root = nativeAttachShadow.call(this, init);
    if (!shadowRoot) {
      shadowRoot = root;
      Element.prototype.attachShadow = nativeAttachShadow;
      queueMicrotask(setupSidebarCorrections);
    }
    return root;
  };

  function setupSidebarCorrections() {
    if (!shadowRoot) return;

    const searchInput = shadowRoot.getElementById("searchInput");
    const pinButton = shadowRoot.getElementById("pinButton");
    const foldersRoot = shadowRoot.getElementById("folders");

    if (!searchInput || !pinButton || !foldersRoot) {
      queueMicrotask(setupSidebarCorrections);
      return;
    }

    /* Chromium supplies its own cancel control for type=search. content.js also
       renders an explicit clear button, so use text input and keep only the
       designed right-side control. */
    searchInput.type = "text";

    /* Keep search keystrokes inside the extension. Without this, composed
       keyboard events cross the shadow boundary and activate webpage commands. */
    const stopSearchEvent = (event) => {
      event.stopImmediatePropagation();
      event.stopPropagation();
    };

    const handleSearchKeydown = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchInput.select();
      } else if (event.key === "Escape") {
        event.preventDefault();
        if (searchInput.value) {
          searchInput.value = "";
          searchInput.dispatchEvent(new Event("input", { bubbles: true }));
        } else if (!pinButton.classList.contains("active")) {
          shadowRoot.getElementById("sidebarShell")?.classList.remove("open");
          searchInput.blur();
        }
      }
      stopSearchEvent(event);
    };

    searchInput.addEventListener("keydown", handleSearchKeydown);

    /* Installed at document_start, before ordinary page shortcut handlers. */
    window.addEventListener(
      "keydown",
      (event) => {
        if (shadowRoot?.activeElement === searchInput) {
          handleSearchKeydown(event);
        }
      },
      true
    );

    for (const eventName of ["keyup", "keypress"]) {
      window.addEventListener(
        eventName,
        (event) => {
          if (shadowRoot?.activeElement === searchInput) {
            stopSearchEvent(event);
          }
        },
        true
      );
    }

    for (const eventName of [
      "keyup",
      "keypress",
      "beforeinput",
      "compositionstart",
      "compositionupdate",
      "compositionend",
    ]) {
      searchInput.addEventListener(eventName, stopSearchEvent);
    }

    /* Same-target content.js input listeners still run; the event simply does
       not escape the shadow UI and trigger webpage behavior. */
    searchInput.addEventListener("input", (event) => {
      event.stopPropagation();
    });

    /* Center the asymmetric pin glyph from its geometric midpoint. */
    pinButton.style.position = "relative";
    pinButton.style.display = "block";
    const pinIcon = pinButton.querySelector("svg");
    if (pinIcon) {
      pinIcon.style.position = "absolute";
      pinIcon.style.left = "50%";
      pinIcon.style.top = "50%";
      pinIcon.style.display = "block";
      pinIcon.style.transform = "translate(-50%, -50%)";
    }

    const observer = new MutationObserver(scheduleFlatten);
    observer.observe(foldersRoot, { childList: true, subtree: true });
    scheduleFlatten();
  }

  function scheduleFlatten() {
    if (!shadowRoot || flattenScheduled || flattening) return;
    flattenScheduled = true;
    requestAnimationFrame(() => {
      flattenScheduled = false;
      flattenFolderHierarchy();
    });
  }

  /* Flatten every rendered folder into a peer section. Browser containers may
     keep bookmarks directly stored in them, but their child folders are moved
     out instead of appearing as a tree under Bookmarks bar / Other bookmarks. */
  function flattenFolderHierarchy() {
    const foldersRoot = shadowRoot?.getElementById("folders");
    if (!foldersRoot || flattening) return;

    const orderedFolders = [...foldersRoot.querySelectorAll(".folder")];
    const alreadyFlat = orderedFolders.every(
      (folder) =>
        folder.parentElement === foldersRoot &&
        !folder.classList.contains("nested")
    );

    if (!alreadyFlat) {
      flattening = true;
      const fragment = document.createDocumentFragment();
      for (const folder of orderedFolders) {
        folder.classList.remove("nested");
        fragment.appendChild(folder);
      }
      foldersRoot.replaceChildren(fragment);
      flattening = false;
    }

    for (const folder of [...foldersRoot.children]) {
      if (!folder.classList.contains("folder")) continue;

      const inner = folder.querySelector(
        ":scope > .folder-content > .folder-inner"
      );
      const directBookmarks = inner
        ? [...inner.children].filter((child) =>
            child.classList.contains("bookmark")
          ).length
        : 0;

      const count = folder.querySelector(
        ":scope > .folder-header .folder-count"
      );
      if (count) count.textContent = String(directBookmarks);

      /* Empty Chromium root containers add no information once their child
         folders are peers. User-created empty folders remain visible. */
      if (
        BROWSER_ROOT_IDS.has(folder.dataset.folderId || "") &&
        directBookmarks === 0
      ) {
        folder.remove();
      }
    }
  }
})();
