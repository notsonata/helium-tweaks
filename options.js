"use strict";

const SETTING_KEY = "youtubeSeparateSpaceEnabled";
const STATUS_MESSAGE = "heliumYoutubeSpaceStatus";
const EXIT_MESSAGE = "heliumYoutubeSpaceExit";
const COMMAND_NAME = "toggle-bookmarks-sidebar";

const toggle = document.getElementById("youtubeSeparateSpace");
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

  const settings = await chrome.storage.sync.get({ [SETTING_KEY]: true });
  toggle.checked = settings[SETTING_KEY] !== false;

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
      ? "YouTube Space fullscreen enabled"
      : "YouTube Space fullscreen disabled"
  );
});

document.getElementById("manageShortcuts").addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
});

document.getElementById("openBookmarks").addEventListener("click", async () => {
  try {
    const response = await sendMessage({ type: "heliumOpenBookmarksSidebar" });
    if (!response?.ok) {
      throw new Error(response?.error || "Could not open bookmarks");
    }
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
