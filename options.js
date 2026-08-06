"use strict";

const SETTING_KEY = "videoSeparateSpaceEnabled";
const LEGACY_SETTING_KEY = "youtubeSeparateSpaceEnabled";
const STATUS_MESSAGE = "heliumYoutubeSpaceStatus";
const EXIT_MESSAGE = "heliumYoutubeSpaceExit";
const COMMAND_NAME = "toggle-bookmarks-sidebar";

const AUTO_PIP_DEFAULTS = {
  autoPipEnabled: true,
  autoPipExitOnReturn: true,
  autoPipDelayMs: 500,
  autoPipExcludedSites: [],
};

const toggle = document.getElementById("videoSeparateSpace");
const autoPipEnabled = document.getElementById("autoPipEnabled");
const autoPipExitOnReturn = document.getElementById("autoPipExitOnReturn");
const autoPipDelayMs = document.getElementById("autoPipDelayMs");
const autoPipExcludedSites = document.getElementById("autoPipExcludedSites");
const saveStatus = document.getElementById("saveStatus");
const videoStatus = document.getElementById("videoStatus");
const exitVideo = document.getElementById("exitVideo");
const shortcut = document.getElementById("bookmarkShortcut");
const platformNote = document.getElementById("platformNote");

let statusTimer = null;

initialize().catch((error) => {
  saveStatus.textContent = error?.message || "Settings could not be loaded";
});

async function initialize() {
  document.getElementById("version").textContent =
    `v${chrome.runtime.getManifest().version}`;

  const settings = await chrome.storage.sync.get({
    [SETTING_KEY]: null,
    [LEGACY_SETTING_KEY]: true,
    ...AUTO_PIP_DEFAULTS,
  });

  toggle.checked =
    settings[SETTING_KEY] == null
      ? settings[LEGACY_SETTING_KEY] !== false
      : settings[SETTING_KEY] !== false;

  if (settings[SETTING_KEY] == null) {
    await chrome.storage.sync.set({ [SETTING_KEY]: toggle.checked });
  }

  autoPipEnabled.checked = settings.autoPipEnabled !== false;
  autoPipExitOnReturn.checked = settings.autoPipExitOnReturn !== false;
  autoPipDelayMs.value = String(normalizeDelay(settings.autoPipDelayMs));
  autoPipExcludedSites.value = normalizeSites(settings.autoPipExcludedSites).join(", ");

  const platform = await chrome.runtime.getPlatformInfo();
  if (platform.os === "mac") {
    platformNote.textContent =
      "macOS normally places the temporary fullscreen window in its own Space.";
  } else {
    platformNote.textContent =
      "This still creates a separate fullscreen window, but automatic Spaces are macOS-specific.";
    platformNote.classList.add("warning");
  }

  await refreshShortcut();
  await refreshVideoStatus();
  statusTimer = setInterval(refreshVideoStatus, 1500);
}

toggle.addEventListener("change", async () => {
  await chrome.storage.sync.set({ [SETTING_KEY]: toggle.checked });
  showSaved(
    toggle.checked
      ? "Fullscreen video Spaces enabled"
      : "Fullscreen video Spaces disabled"
  );
});

autoPipEnabled.addEventListener("change", async () => {
  await chrome.storage.sync.set({ autoPipEnabled: autoPipEnabled.checked });
  showSaved(autoPipEnabled.checked ? "Automatic PiP enabled" : "Automatic PiP disabled");
});

autoPipExitOnReturn.addEventListener("change", async () => {
  await chrome.storage.sync.set({
    autoPipExitOnReturn: autoPipExitOnReturn.checked,
  });
  showSaved("Automatic PiP settings saved");
});

autoPipDelayMs.addEventListener("change", async () => {
  const value = normalizeDelay(autoPipDelayMs.value);
  autoPipDelayMs.value = String(value);
  await chrome.storage.sync.set({ autoPipDelayMs: value });
  showSaved("Automatic PiP delay saved");
});

autoPipExcludedSites.addEventListener("change", async () => {
  const sites = normalizeSites(autoPipExcludedSites.value);
  autoPipExcludedSites.value = sites.join(", ");
  await chrome.storage.sync.set({ autoPipExcludedSites: sites });
  showSaved("Excluded sites saved");
});

document.getElementById("manageShortcuts").addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
});

document.getElementById("openBookmarks").addEventListener("click", async () => {
  try {
    const response = await sendMessage({ type: "heliumOpenBookmarksSidebar" });
    if (!response?.ok) throw new Error(response?.error || "Could not open bookmarks");
  } catch (error) {
    showSaved(error?.message || "Could not open bookmarks");
  }
});

exitVideo.addEventListener("click", async () => {
  exitVideo.disabled = true;
  videoStatus.textContent = "Restoring video…";
  try {
    const status = await sendMessage({ type: STATUS_MESSAGE });
    if (status?.active && status.sessionId) {
      await sendMessage({
        type: EXIT_MESSAGE,
        sessionId: status.sessionId,
        reason: "options-page",
      });
    }
  } finally {
    await refreshVideoStatus();
  }
});

window.addEventListener("unload", () => clearInterval(statusTimer));

async function refreshShortcut() {
  const commands = await chrome.commands.getAll();
  const item = commands.find((command) => command.name === COMMAND_NAME);
  shortcut.textContent = item?.shortcut || "Not assigned";
}

async function refreshVideoStatus() {
  try {
    const status = await sendMessage({ type: STATUS_MESSAGE });
    const active = Boolean(status?.active);
    exitVideo.disabled = !active;
    videoStatus.textContent = active
      ? `${status.count || 1} fullscreen video session active`
      : "No fullscreen video session";
  } catch {
    exitVideo.disabled = true;
    videoStatus.textContent = "Session status unavailable";
  }
}

function normalizeDelay(value) {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.min(3000, Math.max(100, Math.round(number)))
    : AUTO_PIP_DEFAULTS.autoPipDelayMs;
}

function normalizeSites(value) {
  const entries = Array.isArray(value)
    ? value
    : String(value || "").split(/[\n,]+/);
  return [...new Set(entries
    .map((entry) => String(entry).trim().toLowerCase())
    .map((entry) => entry.replace(/^https?:\/\//, "").split("/")[0])
    .filter(Boolean))];
}

function showSaved(message) {
  saveStatus.textContent = message;
  clearTimeout(showSaved.timer);
  showSaved.timer = setTimeout(() => {
    saveStatus.textContent = "";
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
