/*
  Overlay scrollbar for the bookmark sidebar.

  Helium's native vertical tab strip uses Chromium's Views ScrollView and, on
  macOS, an overlay scrollbar that does not subtract width from the tab rows.
  This controller reproduces that behavior inside the extension's closed
  Shadow DOM: the browser scrollbar is visually hidden, while a thin draggable
  thumb is positioned over the sidebar edge only when the list overflows.
*/

(() => {
  "use strict";

  const MIN_THUMB_HEIGHT = 24;
  const TRACK_INSET = 2;

  let shadowRoot = null;
  let sidebar = null;
  let scrollArea = null;
  let foldersRoot = null;
  let track = null;
  let thumb = null;
  let resizeObserver = null;
  let mutationObserver = null;
  let updateScheduled = false;
  let dragging = null;

  const previousAttachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function overlayScrollbarAttachShadow(init) {
    const root = previousAttachShadow.call(this, init);
    if (!shadowRoot) {
      shadowRoot = root;
      queueMicrotask(setupOverlayScrollbar);
    }
    return root;
  };

  function setupOverlayScrollbar() {
    if (!shadowRoot) return;

    sidebar = shadowRoot.getElementById("sidebar");
    scrollArea = shadowRoot.getElementById("scroll");
    foldersRoot = shadowRoot.getElementById("folders");

    if (!sidebar || !scrollArea || !foldersRoot) {
      queueMicrotask(setupOverlayScrollbar);
      return;
    }

    injectStyles();
    createScrollbar();

    scrollArea.addEventListener("scroll", scheduleUpdate, { passive: true });
    foldersRoot.addEventListener("transitionrun", scheduleUpdate, true);
    foldersRoot.addEventListener("transitionend", scheduleUpdate, true);
    window.addEventListener("resize", scheduleUpdate, { passive: true });

    mutationObserver = new MutationObserver(scheduleUpdate);
    mutationObserver.observe(foldersRoot, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style"],
      characterData: true,
    });

    if (typeof ResizeObserver === "function") {
      resizeObserver = new ResizeObserver(scheduleUpdate);
      resizeObserver.observe(sidebar);
      resizeObserver.observe(scrollArea);
      resizeObserver.observe(foldersRoot);
    }

    scheduleUpdate();
  }

  function injectStyles() {
    if (shadowRoot.getElementById("overlayScrollbarStyles")) return;

    const style = document.createElement("style");
    style.id = "overlayScrollbarStyles";
    style.textContent = `
      .sidebar {
        position: relative;
      }

      /* Keep the complete content width. Scrolling still works normally through
         wheel, trackpad, keyboard, touch, and scrollIntoView. */
      .scroll {
        scrollbar-width: none;
        -ms-overflow-style: none;
      }

      .scroll::-webkit-scrollbar {
        display: none;
        width: 0;
        height: 0;
      }

      .overlay-scrollbar {
        position: absolute;
        z-index: 12;
        right: 1px;
        width: 7px;
        overflow: hidden;
        border-radius: 999px;
        opacity: 0;
        pointer-events: none;
        transition: opacity 110ms ease;
      }

      .overlay-scrollbar.visible {
        opacity: 1;
        pointer-events: auto;
      }

      .overlay-scrollbar-thumb {
        position: absolute;
        top: 0;
        right: 1px;
        width: 3px;
        min-height: ${MIN_THUMB_HEIGHT}px;
        border-radius: 999px;
        background: rgba(132, 138, 140, .58);
        cursor: default;
        transform: translateY(0);
        transition:
          width 90ms ease,
          right 90ms ease,
          background 90ms ease;
        will-change: transform;
      }

      .overlay-scrollbar:hover .overlay-scrollbar-thumb,
      .overlay-scrollbar.dragging .overlay-scrollbar-thumb {
        right: 0;
        width: 4px;
        background: rgba(157, 163, 165, .82);
        cursor: ns-resize;
      }

      @media (prefers-reduced-motion: reduce) {
        .overlay-scrollbar,
        .overlay-scrollbar-thumb {
          transition: none;
        }
      }
    `;
    shadowRoot.appendChild(style);
  }

  function createScrollbar() {
    if (shadowRoot.getElementById("overlayScrollbar")) return;

    track = document.createElement("div");
    track.id = "overlayScrollbar";
    track.className = "overlay-scrollbar";
    track.setAttribute("aria-hidden", "true");

    thumb = document.createElement("div");
    thumb.className = "overlay-scrollbar-thumb";
    thumb.setAttribute("aria-hidden", "true");
    track.appendChild(thumb);
    sidebar.appendChild(track);

    track.addEventListener("pointerdown", handleTrackPointerDown);
  }

  function scheduleUpdate() {
    if (updateScheduled) return;
    updateScheduled = true;
    requestAnimationFrame(() => {
      updateScheduled = false;
      updateScrollbar();
    });
  }

  function updateScrollbar() {
    if (!sidebar || !scrollArea || !track || !thumb) return;

    const clientHeight = scrollArea.clientHeight;
    const scrollHeight = scrollArea.scrollHeight;
    const scrollRange = Math.max(0, scrollHeight - clientHeight);
    const hasOverflow = clientHeight > 0 && scrollRange > 1;

    track.classList.toggle("visible", hasOverflow);
    track.setAttribute("aria-hidden", String(!hasOverflow));

    if (!hasOverflow) {
      thumb.style.height = "0px";
      thumb.style.transform = "translateY(0px)";
      return;
    }

    const trackTop = scrollArea.offsetTop + TRACK_INSET;
    const trackHeight = Math.max(0, clientHeight - TRACK_INSET * 2);
    track.style.top = `${trackTop}px`;
    track.style.height = `${trackHeight}px`;

    const thumbHeight = Math.min(
      trackHeight,
      Math.max(MIN_THUMB_HEIGHT, trackHeight * (clientHeight / scrollHeight))
    );
    const thumbRange = Math.max(0, trackHeight - thumbHeight);
    const scrollProgress = scrollRange > 0 ? scrollArea.scrollTop / scrollRange : 0;
    const thumbTop = thumbRange * clamp(scrollProgress, 0, 1);

    thumb.style.height = `${thumbHeight}px`;
    thumb.style.transform = `translateY(${thumbTop}px)`;
  }

  function handleTrackPointerDown(event) {
    if (!track.classList.contains("visible") || event.button !== 0) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    event.stopPropagation();

    if (event.target === thumb) {
      beginThumbDrag(event);
      return;
    }

    const trackRect = track.getBoundingClientRect();
    const thumbRect = thumb.getBoundingClientRect();
    const clickY = event.clientY - trackRect.top;
    const page = Math.max(24, scrollArea.clientHeight * 0.82);

    if (clickY < thumbRect.top - trackRect.top) {
      scrollArea.scrollBy({ top: -page, behavior: "smooth" });
    } else {
      scrollArea.scrollBy({ top: page, behavior: "smooth" });
    }
  }

  function beginThumbDrag(event) {
    const trackHeight = track.clientHeight;
    const thumbHeight = thumb.getBoundingClientRect().height;
    const thumbRange = Math.max(1, trackHeight - thumbHeight);
    const scrollRange = Math.max(0, scrollArea.scrollHeight - scrollArea.clientHeight);

    dragging = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startScrollTop: scrollArea.scrollTop,
      pixelsToScroll: scrollRange / thumbRange,
    };

    track.classList.add("dragging");
    track.setPointerCapture(event.pointerId);
    track.addEventListener("pointermove", handleThumbDrag);
    track.addEventListener("pointerup", endThumbDrag);
    track.addEventListener("pointercancel", endThumbDrag);
  }

  function handleThumbDrag(event) {
    if (!dragging || event.pointerId !== dragging.pointerId) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    event.stopPropagation();

    const delta = event.clientY - dragging.startY;
    scrollArea.scrollTop = dragging.startScrollTop + delta * dragging.pixelsToScroll;
  }

  function endThumbDrag(event) {
    if (!dragging || event.pointerId !== dragging.pointerId) return;

    if (track.hasPointerCapture(event.pointerId)) {
      track.releasePointerCapture(event.pointerId);
    }

    track.classList.remove("dragging");
    track.removeEventListener("pointermove", handleThumbDrag);
    track.removeEventListener("pointerup", endThumbDrag);
    track.removeEventListener("pointercancel", endThumbDrag);
    dragging = null;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }
})();
