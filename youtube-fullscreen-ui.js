/*
  YouTube presentation layer for separate-Space fullscreen.

  The core controller still owns tab transfer and restoration. This script only
  adapts YouTube's page while that session is active: it enables YouTube's
  fullscreen player class, keeps the watch page scrollable below the first
  viewport, and exposes recommendations when the user scrolls down.
*/

(() => {
  "use strict";

  if (window.top !== window.self) return;
  if (!/(^|\.)youtube\.com$/i.test(location.hostname)) return;

  const ROOT = "data-helium-video-space";
  const TARGET = "data-helium-video-space-target";
  const PATH = "data-helium-video-space-path";
  const YOUTUBE = "data-helium-youtube-space";
  const STYLE_ID = "helium-youtube-space-style";
  const HINT_ID = "helium-youtube-space-scroll-hint";
  const OFFSET_PROPERTY = "--helium-youtube-space-offset";

  let active = false;
  let player = null;
  let playerHadFullscreenClass = false;
  let savedScroll = null;
  let hint = null;
  let pageObserver = null;
  let scrollFrame = 0;
  const addedPathMarkers = new Set();

  const rootObserver = new MutationObserver(sync);
  rootObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: [ROOT],
  });

  document.addEventListener("yt-navigate-finish", sync, true);
  sync();

  function sync() {
    const sessionActive = document.documentElement.hasAttribute(ROOT);
    const target = document.querySelector(
      `#movie_player.html5-video-player[${TARGET}]`
    );

    if (sessionActive && target) {
      if (!active || player !== target) activate(target);
      return;
    }

    if (active) deactivate();
  }

  function activate(target) {
    if (active) deactivate();

    active = true;
    player = target;
    savedScroll = { x: window.scrollX, y: window.scrollY };
    playerHadFullscreenClass = player.classList.contains("ytp-fullscreen");

    document.documentElement.setAttribute(YOUTUBE, "");
    document.documentElement.style.setProperty(OFFSET_PROPERTY, "0px");
    player.classList.add("ytp-fullscreen");

    ensureStyle();
    markScrollablePage();
    observeScrollablePage();
    createScrollHint();

    window.addEventListener("scroll", scheduleScrollUpdate, { passive: true });
    window.addEventListener("resize", scheduleScrollUpdate, { passive: true });

    window.scrollTo(0, 0);
    scheduleScrollUpdate();
    requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
  }

  function deactivate() {
    active = false;

    window.removeEventListener("scroll", scheduleScrollUpdate);
    window.removeEventListener("resize", scheduleScrollUpdate);
    cancelAnimationFrame(scrollFrame);
    scrollFrame = 0;

    pageObserver?.disconnect();
    pageObserver = null;

    hint?.remove();
    hint = null;

    for (const element of addedPathMarkers) {
      element.removeAttribute(PATH);
    }
    addedPathMarkers.clear();

    if (player && !playerHadFullscreenClass) {
      player.classList.remove("ytp-fullscreen");
    }

    document.documentElement.removeAttribute(YOUTUBE);
    document.documentElement.style.removeProperty(OFFSET_PROPERTY);

    const restore = savedScroll;
    player = null;
    savedScroll = null;
    playerHadFullscreenClass = false;

    if (restore) {
      requestAnimationFrame(() => window.scrollTo(restore.x, restore.y));
    }
  }

  function markScrollablePage() {
    const watch = document.querySelector("ytd-watch-flexy");
    const columns = watch?.querySelector("#columns");

    markElementAndAncestors(watch);
    markSubtree(columns);

    const below = watch?.querySelector("#below");
    const secondary = watch?.querySelector("#secondary");
    markSubtree(below);
    markSubtree(secondary);
  }

  function observeScrollablePage() {
    pageObserver?.disconnect();

    const watch = document.querySelector("ytd-watch-flexy");
    if (!watch) return;

    pageObserver = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          markSubtree(node);
        }
      }
    });

    pageObserver.observe(watch, { childList: true, subtree: true });
  }

  function markElementAndAncestors(element) {
    let current = element;
    while (current && current !== document.documentElement) {
      addPathMarker(current);
      current = current.parentElement;
    }
  }

  function markSubtree(element) {
    if (!(element instanceof Element)) return;
    addPathMarker(element);
    for (const descendant of element.querySelectorAll("*")) {
      addPathMarker(descendant);
    }
  }

  function addPathMarker(element) {
    if (element.hasAttribute(PATH)) return;
    element.setAttribute(PATH, "");
    addedPathMarkers.add(element);
  }

  function createScrollHint() {
    hint?.remove();

    hint = document.createElement("button");
    hint.id = HINT_ID;
    hint.type = "button";
    hint.textContent = "Scroll for details";
    hint.setAttribute(
      "aria-label",
      "Scroll for video details and recommended videos"
    );
    hint.addEventListener("click", () => {
      const destination = document.querySelector(
        "ytd-watch-flexy #below, ytd-watch-flexy #secondary"
      );
      const destinationTop = destination
        ? destination.getBoundingClientRect().top + window.scrollY - 20
        : window.innerHeight;

      window.scrollTo({
        top: Math.max(window.innerHeight, destinationTop),
        behavior: "smooth",
      });
    });

    (document.body || document.documentElement).appendChild(hint);
  }

  function scheduleScrollUpdate() {
    if (!active || scrollFrame) return;
    scrollFrame = requestAnimationFrame(updateScrollPresentation);
  }

  function updateScrollPresentation() {
    scrollFrame = 0;
    if (!active) return;

    const scrollY = Math.max(0, window.scrollY);
    const offset = Math.min(scrollY, window.innerHeight);

    document.documentElement.style.setProperty(
      OFFSET_PROPERTY,
      `${-offset}px`
    );

    if (hint) {
      hint.toggleAttribute("data-hidden", scrollY > 24);
    }
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      html[${ROOT}][${YOUTUBE}] {
        width: 100% !important;
        height: auto !important;
        min-height: 100% !important;
        overflow-x: hidden !important;
        overflow-y: auto !important;
        background: #0f0f0f !important;
        scroll-behavior: smooth !important;
      }

      html[${ROOT}][${YOUTUBE}] body {
        width: 100% !important;
        height: auto !important;
        min-height: calc(200vh + 1px) !important;
        margin: 0 !important;
        padding: 100vh 0 0 !important;
        overflow: visible !important;
        background: #0f0f0f !important;
      }

      html[${ROOT}][${YOUTUBE}] #masthead-container,
      html[${ROOT}][${YOUTUBE}] ytd-masthead,
      html[${ROOT}][${YOUTUBE}] #cinematics {
        display: none !important;
      }

      html[${ROOT}][${YOUTUBE}] #page-manager {
        margin-top: 0 !important;
      }

      html[${ROOT}][${YOUTUBE}] ytd-watch-flexy,
      html[${ROOT}][${YOUTUBE}] ytd-watch-flexy #columns {
        width: 100% !important;
        max-width: none !important;
        margin: 0 !important;
        padding: 0 !important;
      }

      html[${ROOT}][${YOUTUBE}] ytd-watch-flexy #columns {
        display: flex !important;
        flex-direction: column !important;
        align-items: stretch !important;
      }

      html[${ROOT}][${YOUTUBE}] ytd-watch-flexy #primary,
      html[${ROOT}][${YOUTUBE}] ytd-watch-flexy #secondary {
        box-sizing: border-box !important;
        width: min(1280px, calc(100% - 48px)) !important;
        max-width: none !important;
        margin: 0 auto !important;
        padding: 0 !important;
      }

      html[${ROOT}][${YOUTUBE}] ytd-watch-flexy #secondary,
      html[${ROOT}][${YOUTUBE}] ytd-watch-flexy #secondary-inner,
      html[${ROOT}][${YOUTUBE}] ytd-watch-next-secondary-results-renderer {
        display: block !important;
        visibility: visible !important;
      }

      html[${ROOT}][${YOUTUBE}] ytd-watch-flexy #player,
      html[${ROOT}][${YOUTUBE}] ytd-watch-flexy #full-bleed-container,
      html[${ROOT}][${YOUTUBE}] ytd-watch-flexy #player-container-outer,
      html[${ROOT}][${YOUTUBE}] ytd-watch-flexy #player-container-inner,
      html[${ROOT}][${YOUTUBE}] ytd-watch-flexy ytd-player {
        width: 100% !important;
        height: 0 !important;
        min-height: 0 !important;
        max-height: 0 !important;
        margin: 0 !important;
        padding: 0 !important;
        overflow: visible !important;
      }

      html[${ROOT}][${YOUTUBE}] #movie_player[${TARGET}] {
        position: fixed !important;
        z-index: 2147483647 !important;
        inset: 0 !important;
        width: 100vw !important;
        height: 100vh !important;
        min-width: 100vw !important;
        min-height: 100vh !important;
        max-width: none !important;
        max-height: none !important;
        margin: 0 !important;
        padding: 0 !important;
        border: 0 !important;
        border-radius: 0 !important;
        overflow: hidden !important;
        background: #000 !important;
        transform: translate3d(
          0,
          var(${OFFSET_PROPERTY}, 0px),
          0
        ) !important;
      }

      html[${ROOT}][${YOUTUBE}]
        #movie_player[${TARGET}] .html5-video-container {
        position: absolute !important;
        inset: 0 !important;
        width: 100% !important;
        height: 100% !important;
      }

      html[${ROOT}][${YOUTUBE}]
        #movie_player[${TARGET}] video.html5-main-video {
        position: absolute !important;
        left: 0 !important;
        top: 0 !important;
        width: 100% !important;
        height: 100% !important;
        max-width: none !important;
        max-height: none !important;
        margin: 0 !important;
        object-fit: contain !important;
        transform: none !important;
      }

      html[${ROOT}][${YOUTUBE}] #${HINT_ID} {
        position: fixed;
        z-index: 2147483647;
        left: 50%;
        bottom: 72px;
        min-height: 34px;
        padding: 0 15px;
        border: 0;
        border-radius: 18px;
        color: #fff;
        background: rgba(0, 0, 0, .62);
        box-shadow: 0 1px 8px rgba(0, 0, 0, .32);
        font: 500 13px system-ui, -apple-system, BlinkMacSystemFont,
          "SF Pro Text", sans-serif;
        cursor: pointer;
        opacity: 1;
        transform: translateX(-50%);
        transition: opacity 140ms ease, transform 140ms ease;
      }

      html[${ROOT}][${YOUTUBE}] #${HINT_ID}::after {
        content: "↓";
        display: inline-block;
        margin-left: 8px;
        font-size: 15px;
      }

      html[${ROOT}][${YOUTUBE}] #${HINT_ID}[data-hidden] {
        pointer-events: none;
        opacity: 0;
        transform: translate(-50%, 6px);
      }

      html[${ROOT}][${YOUTUBE}] #${HINT_ID}:focus-visible {
        outline: 2px solid #fff;
        outline-offset: 3px;
      }

      @media (prefers-reduced-motion: reduce) {
        html[${ROOT}][${YOUTUBE}] #${HINT_ID} {
          transition: none;
        }
      }
    `;

    (document.head || document.documentElement).appendChild(style);
  }
})();
