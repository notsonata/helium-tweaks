/*
  Interaction and layout corrections loaded before content.js.

  This prelude is intentionally narrow. It does not render the sidebar itself;
  it corrects browser-control, keyboard, persistence, hierarchy, and hover
  behavior in the existing content script.
*/

(() => {
  "use strict";

  const STORAGE_COLLAPSED = "heliumBmSidebar:collapsed:v1";
  const BROWSER_ROOT_IDS = new Set(["1", "2", "3"]);

  let shadowRoot = null;
  let initialCollapsedState = null;
  let bookmarkTreeReceived = false;
  let restoringCollapsedState = false;
  let flattenScheduled = false;
  let flattening = false;

  /* Preserve the user's saved folder state during content.js's initial empty
     render. The original render prunes every saved folder before the bookmark
     tree arrives. Ignore only that premature empty write, then restore the
     saved map as soon as the first bookmark payload is received. */
  const nativeStorageGet = chrome.storage.local.get.bind(chrome.storage.local);
  const nativeStorageSet = chrome.storage.local.set.bind(chrome.storage.local);

  nativeStorageGet([STORAGE_COLLAPSED], (result) => {
    const value = result?.[STORAGE_COLLAPSED];
    initialCollapsedState =
      value && typeof value === "object" ? { ...value } : {};
    maybeRestoreCollapsedState();
  });

  chrome.storage.local.set = function patchedStorageSet(items, callback) {
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

  function maybeRestoreCollapsedState() {
    if (
      restoringCollapsedState ||
      !bookmarkTreeReceived ||
      initialCollapsedState === null
    ) {
      return;
    }

    restoringCollapsedState = true;
    nativeStorageSet(
      { [STORAGE_COLLAPSED]: initialCollapsedState },
      () => {
        restoringCollapsedState = false;
      }
    );
  }

  /* Observe the first bookmark payload without wrapping or replacing Port
     objects. content.js keeps the real Port and all of its normal lifecycle. */
  const nativeConnect = chrome.runtime.connect.bind(chrome.runtime);
  chrome.runtime.connect = function patchedConnect(...args) {
    const port = nativeConnect(...args);
    port.onMessage.addListener((message) => {
      if (message?.type === "bookmarks" && Array.isArray(message.tree)) {
        bookmarkTreeReceived = true;
        maybeRestoreCollapsedState();
        scheduleFlatten();
      }
    });
    return port;
  };

  /* Capture only the extension's closed shadow root, then immediately restore
     attachShadow so no later component is affected. */
  const nativeAttachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function patchedAttachShadow(init) {
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
    const edgeTrigger = shadowRoot.getElementById("edgeTrigger");
    const sidebarShell = shadowRoot.getElementById("sidebarShell");
    const sidebar = shadowRoot.getElementById("sidebar");

    if (
      !searchInput ||
      !pinButton ||
      !foldersRoot ||
      !edgeTrigger ||
      !sidebarShell ||
      !sidebar
    ) {
      queueMicrotask(setupSidebarCorrections);
      return;
    }

    /* The panel slides beneath the pointer when it opens. That movement can
       generate a mouseleave even though the pointer is still inside the final
       panel or the right-edge trigger. Block only those false leaves. Genuine
       exits to the webpage still reach content.js's normal close handler. */
    const pointInside = (x, y, rect) =>
      x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;

    sidebar.addEventListener(
      "mouseleave",
      (event) => {
        const x = event.clientX;
        const y = event.clientY;
        const stillInSidebarRegion =
          pointInside(x, y, sidebarShell.getBoundingClientRect()) ||
          pointInside(x, y, edgeTrigger.getBoundingClientRect());

        if (stillInSidebarRegion) {
          event.stopImmediatePropagation();
          event.stopPropagation();
        }
      },
      true
    );

    /* Entering the edge strip must also cancel any close timer that was started
       just before the pointer crossed from the panel into the strip. Reuse the
       sidebar's existing mouseenter behavior so the private timer stays owned
       by content.js. */
    edgeTrigger.addEventListener(
      "mouseenter",
      () => {
        sidebar.dispatchEvent(
          new MouseEvent("mouseenter", {
            bubbles: false,
            composed: false,
          })
        );
      },
      true
    );

    /* A search input receives a built-in Chromium clear button. content.js also
       renders its own clear button, producing two X controls. Text input keeps
       only the explicit right-side control. */
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

    /* Capture at the window boundary too. Because this prelude runs at
       document_start, it is installed before normal webpage shortcut handlers.
       Stopping propagation does not cancel ordinary text-entry default actions. */
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

    /* Allow content.js's same-target input handler to update the result list,
       but stop the input event before it reaches the webpage. */
    searchInput.addEventListener("input", (event) => {
      event.stopPropagation();
    });

    /* The existing CSS nudges the asymmetric icon down and relies on grid
       centering. Position the glyph from its actual center in both axes. */
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

      const count = folder.querySelector(":scope > .folder-header .folder-count");
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
