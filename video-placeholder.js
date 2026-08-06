"use strict";

const EXIT_MESSAGE = "heliumYoutubeSpaceExit";
const STATUS_MESSAGE = "heliumYoutubeSpaceStatus";
const button = document.getElementById("restore");
const title = button.querySelector(".title");
const copy = button.querySelector(".copy");
const sessionId = new URLSearchParams(location.search).get("session") || "";
let pending = false;

button.addEventListener("click", restoreVideo);
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") restoreVideo();
});

checkStatus();

async function checkStatus() {
  try {
    const status = await sendMessage({ type: STATUS_MESSAGE, sessionId });
    if (!status?.active) showEnded();
  } catch {
    copy.textContent = "Fullscreen session status is unavailable.";
  }
}

async function restoreVideo() {
  if (pending) return;
  pending = true;
  button.classList.add("pending");
  title.textContent = "Restoring video…";
  copy.textContent = "Returning the video tab to this window.";

  try {
    const response = await sendMessage({
      type: EXIT_MESSAGE,
      sessionId,
      reason: "placeholder",
    });
    if (!response?.ok) throw new Error(response?.error || "Restore failed");
  } catch (error) {
    pending = false;
    button.classList.remove("pending");
    title.textContent = "Could not exit fullscreen";
    copy.textContent = error?.message || "Try pressing Esc in the video Space.";
  }
}

function showEnded() {
  button.disabled = true;
  title.textContent = "Fullscreen session ended";
  copy.textContent = "This placeholder can be closed.";
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
