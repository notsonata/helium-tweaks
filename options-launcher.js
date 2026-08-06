"use strict";

document.addEventListener("DOMContentLoaded", async () => {
  try {
    await chrome.runtime.openOptionsPage();
    window.close();
  } catch (error) {
    document.body.textContent = error?.message || "Could not open settings";
  }
});
