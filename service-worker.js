/* Classic MV3 service-worker entry point. */
importScripts(
  "background.js",
  "bookmark-dnd-background.js",
  "bookmark-rename-background.js",
  "fallback-background.js",
  "shortcut-background.js",
  "video-space-debug-background.js",
  "video-space-window-state.js",
  "video-space-background.js"
);
