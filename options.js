"use strict";

const VIDEO_SETTING_KEY = "videoSeparateSpaceEnabled";
const LEGACY_VIDEO_SETTING_KEY = "youtubeSeparateSpaceEnabled";
const STATUS_MESSAGE = "heliumYoutubeSpaceStatus";
const EXIT_MESSAGE = "heliumYoutubeSpaceExit";
const COMMAND_NAME = "toggle-bookmarks-sidebar";
const PINNED_KEY = "heliumBmSidebar:pinned:v1";
const COLLAPSED_KEY = "heliumBmSidebar:collapsed:v1";

const SYNC_DEFAULTS = Object.freeze({
  bookmarkSidebarWidth: 210,
  bookmarkRowHeight: 30,
  bookmarkFontSize: 12,
  bookmarkEdgeWidth: 6,
  bookmarkShowFolderCounts: true,
  bookmarkRowHover: true,
  bookmarkScrollbarMode: "auto",

  autoPipEnabled: true,
  autoPipExitOnReturn: true,
  autoPipDelayMs: 500,
  autoPipExcludedSites: [],

  [VIDEO_SETTING_KEY]: true,
  videoSpaceControlClickEnabled: true,
  videoSpaceKeyboardEnabled: true,
  videoSpaceFallbackEnabled: true,
  videoSpaceExcludedSites: [],
});

const saveTimers = new Map();
let statusTimer = null;

initialize().catch((error) => {
  showSaved(error?.message || "Settings could not be loaded", true);
});

async function initialize() {
  document.getElementById("version").textContent =
    `v${chrome.runtime.getManifest().version}`;

  const [syncSettings, localSettings, platform] = await Promise.all([
    chrome.storage.sync.get({
      ...SYNC_DEFAULTS,
      [VIDEO_SETTING_KEY]: null,
      [LEGACY_VIDEO_SETTING_KEY]: true,
    }),
    chrome.storage.local.get({ [PINNED_KEY]: false }),
    chrome.runtime.getPlatformInfo(),
  ]);

  if (syncSettings[VIDEO_SETTING_KEY] == null) {
    syncSettings[VIDEO_SETTING_KEY] =
      syncSettings[LEGACY_VIDEO_SETTING_KEY] !== false;
    await chrome.storage.sync.set({
      [VIDEO_SETTING_KEY]: syncSettings[VIDEO_SETTING_KEY],
    });
  }

  populateBookmarks(syncSettings, localSettings);
  populateAutoPip(syncSettings);
  populateFullscreen(syncSettings);
  bindControls();
  setPlatformNote(platform);

  await refreshShortcut();
  await refreshVideoStatus();
  statusTimer = setInterval(refreshVideoStatus, 1500);
}

function populateBookmarks(sync, local) {
  setRange("bookmarkSidebarWidth", sync.bookmarkSidebarWidth, "px");
  setRange("bookmarkFontSize", sync.bookmarkFontSize, "px");
  setRange("bookmarkEdgeWidth", sync.bookmarkEdgeWidth, "px");

  document.getElementById("bookmarkRowHeight").value = String(
    normalizeNumber(sync.bookmarkRowHeight, 26, 38, 30)
  );
  document.getElementById("bookmarkPinned").checked =
    local[PINNED_KEY] === true;
  document.getElementById("bookmarkShowFolderCounts").checked =
    sync.bookmarkShowFolderCounts !== false;
  document.getElementById("bookmarkRowHover").checked =
    sync.bookmarkRowHover !== false;
  document.getElementById("bookmarkScrollbarMode").value =
    sync.bookmarkScrollbarMode === "hidden" ? "hidden" : "auto";

  updateReservedBookmarkWidth(sync.bookmarkSidebarWidth);
}

function populateAutoPip(sync) {
  document.getElementById("autoPipEnabled").checked =
    sync.autoPipEnabled !== false;
  document.getElementById("autoPipExitOnReturn").checked =
    sync.autoPipExitOnReturn !== false;
  document.getElementById("autoPipDelayMs").value = String(
    normalizeNumber(sync.autoPipDelayMs, 100, 3000, 500)
  );
  document.getElementById("autoPipExcludedSites").value =
    normalizeSites(sync.autoPipExcludedSites).join(", ");
}

function populateFullscreen(sync) {
  document.getElementById("videoSeparateSpace").checked =
    sync[VIDEO_SETTING_KEY] !== false;
  document.getElementById("videoSpaceControlClickEnabled").checked =
    sync.videoSpaceControlClickEnabled !== false;
  document.getElementById("videoSpaceKeyboardEnabled").checked =
    sync.videoSpaceKeyboardEnabled !== false;
  document.getElementById("videoSpaceFallbackEnabled").checked =
    sync.videoSpaceFallbackEnabled !== false;
  document.getElementById("videoSpaceExcludedSites").value =
    normalizeSites(sync.videoSpaceExcludedSites).join(", ");
}

function bindControls() {
  bindRange("bookmarkSidebarWidth", "bookmarkSidebarWidth", "px", (value) => {
    updateReservedBookmarkWidth(value);
  });
  bindRange("bookmarkFontSize", "bookmarkFontSize", "px");
  bindRange("bookmarkEdgeWidth", "bookmarkEdgeWidth", "px");

  bindSelect("bookmarkRowHeight", "bookmarkRowHeight", (value) =>
    normalizeNumber(value, 26, 38, 30)
  );
  bindSelect("bookmarkScrollbarMode", "bookmarkScrollbarMode", (value) =>
    value === "hidden" ? "hidden" : "auto"
  );
  bindSyncToggle("bookmarkShowFolderCounts", "bookmarkShowFolderCounts");
  bindSyncToggle("bookmarkRowHover", "bookmarkRowHover");

  document.getElementById("bookmarkPinned").addEventListener("change", async (event) => {
    await chrome.storage.local.set({ [PINNED_KEY]: event.target.checked });
    showSaved(event.target.checked ? "Bookmark sidebar pinned" : "Bookmark sidebar unpinned");
  });

  bindSyncToggle("autoPipEnabled", "autoPipEnabled");
  bindSyncToggle("autoPipExitOnReturn", "autoPipExitOnReturn");
  bindNumber("autoPipDelayMs", "autoPipDelayMs", 100, 3000, 500);
  bindSiteList("autoPipExcludedSites", "autoPipExcludedSites");

  bindSyncToggle("videoSeparateSpace", VIDEO_SETTING_KEY);
  bindSyncToggle(
    "videoSpaceControlClickEnabled",
    "videoSpaceControlClickEnabled"
  );
  bindSyncToggle("videoSpaceKeyboardEnabled", "videoSpaceKeyboardEnabled");
  bindSyncToggle("videoSpaceFallbackEnabled", "videoSpaceFallbackEnabled");
  bindSiteList("videoSpaceExcludedSites", "videoSpaceExcludedSites");

  document.getElementById("resetCollapsedFolders").addEventListener("click", async () => {
    await chrome.storage.local.remove(COLLAPSED_KEY);
    showSaved("All bookmark folders expanded");
  });

  document.getElementById("openStandaloneBookmarks").addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("bookmarks.html") });
  });

  document.getElementById("manageShortcuts").addEventListener("click", () => {
    chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
  });

  document.getElementById("refreshShortcut").addEventListener("click", async () => {
    await refreshShortcut();
    showSaved("Shortcut assignment refreshed");
  });

  document.getElementById("exitVideo").addEventListener("click", exitActiveVideo);
  document.getElementById("resetAllSettings").addEventListener("click", resetAllSettings);

  window.addEventListener("unload", () => clearInterval(statusTimer));
}

function bindRange(id, key, suffix, onInput = null) {
  const input = document.getElementById(id);
  input.addEventListener("input", () => {
    const value = Number(input.value);
    updateRangeOutput(id, suffix);
    onInput?.(value);
    scheduleSyncSave(key, value, `${labelFor(id)} saved`);
  });
}

function bindSelect(id, key, normalizeValue = (value) => value) {
  const input = document.getElementById(id);
  input.addEventListener("change", async () => {
    const value = normalizeValue(input.value);
    await chrome.storage.sync.set({ [key]: value });
    showSaved(`${labelFor(id)} saved`);
  });
}

function bindSyncToggle(id, key) {
  const input = document.getElementById(id);
  input.addEventListener("change", async () => {
    await chrome.storage.sync.set({ [key]: input.checked });
    showSaved(`${labelFor(id)} ${input.checked ? "enabled" : "disabled"}`);
  });
}

function bindNumber(id, key, min, max, fallback) {
  const input = document.getElementById(id);
  input.addEventListener("change", async () => {
    const value = normalizeNumber(input.value, min, max, fallback);
    input.value = String(value);
    await chrome.storage.sync.set({ [key]: value });
    showSaved(`${labelFor(id)} saved`);
  });
}

function bindSiteList(id, key) {
  const input = document.getElementById(id);
  input.addEventListener("change", async () => {
    const sites = normalizeSites(input.value);
    input.value = sites.join(", ");
    await chrome.storage.sync.set({ [key]: sites });
    showSaved(`${labelFor(id)} saved`);
  });
}

function scheduleSyncSave(key, value, message) {
  clearTimeout(saveTimers.get(key));
  saveTimers.set(
    key,
    setTimeout(async () => {
      saveTimers.delete(key);
      await chrome.storage.sync.set({ [key]: value });
      showSaved(message);
    }, 120)
  );
}

async function exitActiveVideo() {
  const button = document.getElementById("exitVideo");
  const status = document.getElementById("videoStatus");
  button.disabled = true;
  status.textContent = "Restoring video…";

  try {
    const current = await sendMessage({ type: STATUS_MESSAGE });
    if (current?.active && current.sessionId) {
      await sendMessage({
        type: EXIT_MESSAGE,
        sessionId: current.sessionId,
        reason: "options-page",
      });
    }
  } finally {
    await refreshVideoStatus();
  }
}

async function resetAllSettings() {
  const confirmed = window.confirm(
    "Reset all Helium Tweaks preferences? Browser bookmarks will not be deleted."
  );
  if (!confirmed) return;

  await Promise.all([
    chrome.storage.sync.set({ ...SYNC_DEFAULTS }),
    chrome.storage.local.remove([PINNED_KEY, COLLAPSED_KEY]),
  ]);
  location.reload();
}

async function refreshShortcut() {
  const commands = await chrome.commands.getAll();
  const item = commands.find((command) => command.name === COMMAND_NAME);
  document.getElementById("bookmarkShortcut").textContent =
    item?.shortcut || "Not assigned";
}

async function refreshVideoStatus() {
  const button = document.getElementById("exitVideo");
  const status = document.getElementById("videoStatus");

  try {
    const current = await sendMessage({ type: STATUS_MESSAGE });
    const active = Boolean(current?.active);
    button.disabled = !active;
    status.textContent = active
      ? `${current.count || 1} fullscreen video session active`
      : "No fullscreen video session";
  } catch {
    button.disabled = true;
    status.textContent = "Session status unavailable";
  }
}

function setPlatformNote(platform) {
  const note = document.getElementById("platformNote");
  if (platform.os === "mac") {
    note.textContent =
      "macOS normally places the temporary fullscreen popup in its own Space.";
  } else {
    note.textContent =
      "A separate fullscreen window is still created, but automatic Spaces are macOS-specific.";
    note.classList.add("warning");
  }
}

function setRange(id, value, suffix) {
  const input = document.getElementById(id);
  input.value = String(value);
  updateRangeOutput(id, suffix);
}

function updateRangeOutput(id, suffix) {
  const input = document.getElementById(id);
  document.getElementById(`${id}Value`).textContent = `${input.value}${suffix}`;
}

function updateReservedBookmarkWidth(value) {
  const width = normalizeNumber(value, 180, 420, 210);
  document.documentElement.style.setProperty(
    "--settings-bookmark-width",
    `${width}px`
  );
}

function normalizeNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function normalizeSites(value) {
  const entries = Array.isArray(value)
    ? value
    : String(value || "").split(/[\n,]+/);

  return [
    ...new Set(
      entries
        .map((entry) => String(entry).trim().toLowerCase())
        .map((entry) => entry.replace(/^https?:\/\//, "").split("/")[0])
        .filter(Boolean)
    ),
  ];
}

function labelFor(id) {
  return document.querySelector(`label[for="${id}"]`)?.textContent?.trim() || "Setting";
}

function showSaved(message, error = false) {
  const element = document.getElementById("saveStatus");
  element.textContent = message;
  element.classList.toggle("error", error);
  element.classList.add("visible");
  clearTimeout(showSaved.timer);
  showSaved.timer = setTimeout(() => {
    element.classList.remove("visible", "error");
  }, 1800);
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}
