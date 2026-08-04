/*
  Interaction and layout corrections loaded before content.js.

  This prelude stays deliberately narrow. It corrects browser-control,
  keyboard, persistence startup, pin alignment, and flat folder presentation
  without rendering the sidebar itself.
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
    content.js loads the persisted collapse map before bookmark data arrives,
    then performs one empty render. pruneDeletedFolders() previously interpreted
    the empty tree as proof that every folder had been deleted and executed:

      delete collapsed[folderId]

    Blocking only chrome.storage.local.set() was insufficient because the map had
    already been erased in memory. Wrap collapse maps in a short-lived Proxy that
    rejects deletion until the first real bookmark tree arrives. Normal property
    writes still work, and deletion becomes normal immediately after tree data is
    available.

    The same wrapper is applied to startup reads and storage-change events, so a
    state update received from another tab cannot be erased by an empty startup
    render either.
  */
  const nativeStorageGet = chrome.storage.local.get.bind(chrome.storage.local);
  const nativeStorageSet = chrome.storage.local.set.bind(chrome.storage.local);
  const storageChangedEvent = chrome.storage.onChanged;
  const nativeStorageChangedAdd =
    storageChangedEvent.addListener.bind(storageChangedEvent);
  const nativeStorageChangedRemove =
    storageChangedEvent.removeListener.bind(storageChangedEvent);
  const nativeStorageChangedHas =
    storageChangedEvent.hasListener.bind(storageChangedEvent);

  const proxyToTarget = new WeakMap();
  const targetToProxy = new WeakMap();
  const changedListenerWrappers = new WeakMap();

  function isStateObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function startupSafeCollapsedState(value) {
    if (!isStateObject(value) || bookmarkTreeReceived) return value;
    if (proxyToTarget.has(value)) return value;

    const existing = targetToProxy.get(value);
    if (existing) return existing;

    const proxy = new Proxy(value, {
      deleteProperty(target, property) {
        if (!bookmarkTreeReceived) return true;
        return Reflect.deleteProperty(target, property);
      },
    });

    targetToProxy.set(value, proxy);
    proxyToTarget.set(proxy, value);
    return proxy;
  }

  function unwrapCollapsedState(value) {
    return proxyToTarget.get(value) || value;
  }

  function wrapStorageResult(result) {
    if (!result || typeof result !== "object") return result;
    const value = result[STORAGE_COLLAPSED];
    if (!isStateObject(value) || bookmarkTreeReceived) return result;

    return {
      ...result,
      [STORAGE_COLLAPSED]: startupSafeCollapsedState(value),
    };
  }

  chrome.storage.local.get = function startupSafeStorageGet(keys, callback) {
    if (typeof callback === "function") {
      return nativeStorageGet(keys, (result) => callback(wrapStorageResult(result)));
    }

    return nativeStorageGet(keys).then(wrapStorageResult);
  };

  /* Proxy objects are not guaranteed to be accepted by extension structured
     cloning. Unwrap and shallow-copy the collapse map before persisting it. */
  chrome.storage.local.set = function serializableStorageSet(items, callback) {
    let serializableItems = items;

    if (
      items &&
      typeof items === "object" &&
      Object.prototype.hasOwnProperty.call(items, STORAGE_COLLAPSED)
    ) {
      const original = items[STORAGE_COLLAPSED];
      const unwrapped = unwrapCollapsedState(original);
      if (unwrapped !== original) {
        serializableItems = {
          ...items,
          [STORAGE_COLLAPSED]: { ...unwrapped },
        };
      }
    }

    return nativeStorageSet(serializableItems, callback);
  };

  function wrapStorageChanges(changes, areaName) {
    if (
      areaName !== "local" ||
      bookmarkTreeReceived ||
      !changes ||
      !changes[STORAGE_COLLAPSED]
    ) {
      return changes;
    }

    const change = changes[STORAGE_COLLAPSED];
    return {
      ...changes,
      [STORAGE_COLLAPSED]: {
        ...change,
        oldValue: startupSafeCollapsedState(change.oldValue),
        newValue: startupSafeCollapsedState(change.newValue),
      },
    };
  }

  storageChangedEvent.addListener = function startupSafeChangedAdd(listener) {
    if (typeof listener !== "function") {
      return nativeStorageChangedAdd(listener);
    }

    let wrapped = changedListenerWrappers.get(listener);
    if (!wrapped) {
      wrapped = (changes, areaName) =>
        listener(wrapStorageChanges(changes, areaName), areaName);
      changedListenerWrappers.set(listener, wrapped);
    }

    return nativeStorageChangedAdd(wrapped);
  };

  storageChangedEvent.removeListener = function startupSafeChangedRemove(listener) {
    return nativeStorageChangedRemove(
      changedListenerWrappers.get(listener) || listener
    );
  };

  storageChangedEvent.hasListener = function startupSafeChangedHas(listener) {
    return nativeStorageChangedHas(changedListenerWrappers.get(listener) || listener);
  };

  /* This listener is registered before content.js receives the Port, so the
     readiness flag is set before its handleMessage() renders the real tree. */
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
