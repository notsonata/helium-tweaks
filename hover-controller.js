/*
  Stable hover controller for the sidebar.

  content.js originally listens directly to mouseenter/mouseleave on an element
  that is being transformed. During the opening animation, that moving element
  passes beneath a stationary pointer and emits false enter/leave events. This
  controller captures the four content.js hover callbacks before registration
  and invokes them from one viewport-coordinate state machine instead.
*/

(() => {
  "use strict";

  const PANEL_WIDTH_FALLBACK = 210;
  const PANEL_INSET_FALLBACK = 5;
  const EDGE_WIDTH_FALLBACK = 6;
  const CAPTURE_TIMEOUT_MS = 15000;

  const nativeAddEventListener = EventTarget.prototype.addEventListener;

  let shadowRoot = null;
  let edgeTrigger = null;
  let sidebarShell = null;
  let sidebar = null;

  let edgeEnterHandler = null;
  let edgeLeaveHandler = null;
  let sidebarEnterHandler = null;
  let sidebarLeaveHandler = null;

  let controllerStarted = false;
  let pointerKnown = false;
  let pointerX = -1;
  let pointerY = -1;
  let activationArmed = false;
  let openRegionActive = false;
  let shellOpen = false;

  const captureTimeout = setTimeout(restorePrototype, CAPTURE_TIMEOUT_MS);

  EventTarget.prototype.addEventListener = function patchedAddEventListener(
    type,
    listener,
    options
  ) {
    if (captureSidebarHoverListener(this, type, listener)) return;
    return nativeAddEventListener.call(this, type, listener, options);
  };

  function captureSidebarHoverListener(target, type, listener) {
    if (type !== "mouseenter" && type !== "mouseleave") return false;
    if (!(target instanceof Element)) return false;
    if (target.id !== "edgeTrigger" && target.id !== "sidebar") return false;
    if (!isContentHoverListener(target.id, type, listener)) return false;

    const root = target.getRootNode();
    if (!(root instanceof ShadowRoot)) return false;

    const shell = root.getElementById("sidebarShell");
    const edge = root.getElementById("edgeTrigger");
    const panel = root.getElementById("sidebar");
    if (!shell || !edge || !panel) return false;

    shadowRoot = root;
    sidebarShell = shell;
    edgeTrigger = edge;
    sidebar = panel;

    if (target === edgeTrigger && type === "mouseenter" && !edgeEnterHandler) {
      edgeEnterHandler = listener;
    } else if (
      target === edgeTrigger &&
      type === "mouseleave" &&
      !edgeLeaveHandler
    ) {
      edgeLeaveHandler = listener;
    } else if (
      target === sidebar &&
      type === "mouseenter" &&
      !sidebarEnterHandler
    ) {
      sidebarEnterHandler = listener;
    } else if (
      target === sidebar &&
      type === "mouseleave" &&
      !sidebarLeaveHandler
    ) {
      sidebarLeaveHandler = listener;
    } else {
      return false;
    }

    maybeStartController();
    return true;
  }

  function isContentHoverListener(targetId, type, listener) {
    if (typeof listener !== "function") return false;

    let source = "";
    try {
      source = Function.prototype.toString.call(listener);
    } catch {
      return false;
    }

    if (targetId === "edgeTrigger" && type === "mouseenter") {
      return source.includes("ensureConnected") && source.includes("scheduleOpen");
    }
    if (targetId === "edgeTrigger" && type === "mouseleave") {
      return source.includes("cancelOpen") || source.includes("openTimer");
    }
    if (targetId === "sidebar" && type === "mouseenter") {
      return source.includes("clearTimeout(closeTimer)");
    }
    if (targetId === "sidebar" && type === "mouseleave") {
      return source.includes("scheduleClose") || source.includes("CLOSE_DELAY_MS");
    }
    return false;
  }

  function maybeStartController() {
    if (
      controllerStarted ||
      !edgeEnterHandler ||
      !edgeLeaveHandler ||
      !sidebarEnterHandler ||
      !sidebarLeaveHandler
    ) {
      return;
    }

    controllerStarted = true;
    clearTimeout(captureTimeout);
    restorePrototype();
    startController();
  }

  function restorePrototype() {
    if (EventTarget.prototype.addEventListener !== nativeAddEventListener) {
      EventTarget.prototype.addEventListener = nativeAddEventListener;
    }
  }

  function startController() {
    shellOpen = sidebarShell.classList.contains("open");

    const shellObserver = new MutationObserver(() => {
      const nextOpen = sidebarShell.classList.contains("open");
      if (nextOpen === shellOpen) return;

      shellOpen = nextOpen;
      if (shellOpen) {
        activationArmed = false;
        if (pointerInsideOpenRegion()) enterOpenRegion();
      } else {
        openRegionActive = false;
        reconcilePointerState();
      }
    });

    shellObserver.observe(sidebarShell, {
      attributes: true,
      attributeFilter: ["class"],
    });

    for (const eventName of [
      "pointerover",
      "pointermove",
      "mouseover",
      "mousemove",
    ]) {
      nativeAddEventListener.call(window, eventName, updatePointer, true);
    }

    nativeAddEventListener.call(window, "resize", reconcilePointerState, true);
    nativeAddEventListener.call(window, "blur", leaveAllRegions, true);
    nativeAddEventListener.call(document, "mouseleave", leaveAllRegions, true);

    /* Recover when the cursor was already resting on the edge before the four
       content.js callbacks finished registering. */
    if (edgeTrigger.matches(":hover")) {
      pointerKnown = true;
      pointerX = window.innerWidth - 1;
      pointerY = Math.max(0, window.innerHeight / 2);
    }

    reconcilePointerState();
  }

  function updatePointer(event) {
    pointerKnown = true;
    pointerX = event.clientX;
    pointerY = event.clientY;
    reconcilePointerState();
  }

  function reconcilePointerState() {
    if (!controllerStarted) return;

    if (shellOpen) {
      cancelArmedOpen();
      if (pointerInsideOpenRegion()) {
        enterOpenRegion();
      } else {
        leaveOpenRegion();
      }
      return;
    }

    openRegionActive = false;

    if (activationArmed) {
      /* Once the edge has armed opening, the pointer may continue into the
         future 210 px panel footprint during the 140 ms delay. Requiring it to
         remain inside a 6 px strip made normal cursor movement cancel opening. */
      if (!pointerInsideOpenRegion()) cancelArmedOpen();
      return;
    }

    if (pointerInsideEdge()) armOpen();
  }

  function armOpen() {
    if (activationArmed) return;
    activationArmed = true;

    /* The content script owns both timers. Entering either hover zone first
       clears any pending close, then schedules the normal delayed open. */
    invoke(sidebarEnterHandler, sidebar, "mouseenter");
    invoke(edgeEnterHandler, edgeTrigger, "mouseenter");
  }

  function cancelArmedOpen() {
    if (!activationArmed) return;
    activationArmed = false;
    invoke(edgeLeaveHandler, edgeTrigger, "mouseleave");
  }

  function enterOpenRegion() {
    if (openRegionActive) return;
    openRegionActive = true;
    invoke(sidebarEnterHandler, sidebar, "mouseenter");
  }

  function leaveOpenRegion() {
    if (!openRegionActive) return;
    openRegionActive = false;

    /* Cancel any leftover open timer before starting the normal close timer. */
    invoke(edgeLeaveHandler, edgeTrigger, "mouseleave");
    invoke(sidebarLeaveHandler, sidebar, "mouseleave");
  }

  function leaveAllRegions() {
    pointerKnown = false;
    cancelArmedOpen();
    if (shellOpen) leaveOpenRegion();
  }

  function pointerInsideEdge() {
    if (!pointerKnown) return false;

    const measuredWidth = edgeTrigger.getBoundingClientRect().width;
    const edgeWidth = Math.max(measuredWidth, EDGE_WIDTH_FALLBACK);

    return (
      pointerX >= window.innerWidth - edgeWidth &&
      pointerX <= window.innerWidth &&
      pointerY >= 0 &&
      pointerY <= window.innerHeight
    );
  }

  function pointerInsideOpenRegion() {
    if (!pointerKnown) return false;

    const panelWidth = readPixelVariable(
      "--panel-width",
      PANEL_WIDTH_FALLBACK
    );
    const panelInset = readPixelVariable(
      "--panel-inset",
      PANEL_INSET_FALLBACK
    );
    const left = window.innerWidth - panelWidth - panelInset;

    /* Include the visual 5 px inset and rounded-corner gaps. They are part of
       the intended interaction corridor even though they are transparent. */
    return (
      pointerX >= left &&
      pointerX <= window.innerWidth &&
      pointerY >= 0 &&
      pointerY <= window.innerHeight
    );
  }

  function readPixelVariable(name, fallback) {
    const value = getComputedStyle(shadowRoot.host)
      .getPropertyValue(name)
      .trim();
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function invoke(handler, target, type) {
    const event = new MouseEvent(type, {
      bubbles: false,
      composed: false,
      clientX: pointerX,
      clientY: pointerY,
    });

    if (typeof handler === "function") {
      handler.call(target, event);
    } else if (handler && typeof handler.handleEvent === "function") {
      handler.handleEvent(event);
    }
  }
})();
