/*
  Preserve Chromium's native link dragging outside bookmark Edit mode.

  bookmark-dnd.js owns internal bookmark/folder reordering in Edit mode and
  listens for dragstart on #folders. Native bookmark links also emit dragstart,
  so this earlier capture point stops those events before the internal reorder
  controller can cancel them. stopPropagation() does not cancel the browser's
  default link drag, allowing Helium to receive the URL for split view.
*/

(() => {
  "use strict";

  let shadowRoot = null;

  const previousAttachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function nativeBookmarkDragAttachShadow(init) {
    const root = previousAttachShadow.call(this, init);
    if (!shadowRoot) {
      shadowRoot = root;
      queueMicrotask(setupNativeBookmarkDrag);
    }
    return root;
  };

  function setupNativeBookmarkDrag() {
    if (!shadowRoot) return;

    const sidebar = shadowRoot.getElementById("sidebar");
    const folders = shadowRoot.getElementById("folders");
    if (!sidebar || !folders) {
      queueMicrotask(setupNativeBookmarkDrag);
      return;
    }

    shadowRoot.addEventListener(
      "dragstart",
      (event) => {
        if (sidebar.classList.contains("editor-mode")) return;

        const bookmark = event
          .composedPath()
          .find(
            (item) =>
              item instanceof Element &&
              item.matches("a.bookmark[href]")
          );

        if (!bookmark) return;

        // Let Chromium perform its normal anchor drag, but prevent the event
        // from reaching bookmark-dnd.js, whose non-handle guard cancels it.
        event.stopPropagation();
      },
      true
    );
  }
})();
