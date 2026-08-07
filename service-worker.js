/* Classic MV3 service-worker entry point. */
importScripts(
  "background.js",
  "bookmark-dnd-background.js",
  "bookmark-rename-background.js",
  "shortcut-background.js",
  "auto-pip-background.js",
  "video-space-background.js"
);
