/*
  Leaves the page's temporary Fullscreen API state before its tab is moved.

  The main video controller has already captured and marked the exact fullscreen
  player by the time this message arrives. Exiting document fullscreen returns
  the original Helium window to its normal macOS Space without losing that
  captured target, which is then used in the temporary fullscreen window.
*/

(() => {
  "use strict";

  if (window.top !== window.self) return;

  const PREPARE_MESSAGE = "heliumVideoSpacePrepareTransfer";

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== PREPARE_MESSAGE) return false;
    if (sender.id && sender.id !== chrome.runtime.id) return false;

    leaveDocumentFullscreen()
      .then((exited) => sendResponse({ ok: true, exited }))
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error?.message || "Could not leave document fullscreen",
        });
      });

    return true;
  });

  async function leaveDocumentFullscreen() {
    const fullscreenElement =
      document.fullscreenElement || document.webkitFullscreenElement || null;

    if (!fullscreenElement) return false;

    const exitFullscreen =
      document.exitFullscreen || document.webkitExitFullscreen;

    if (typeof exitFullscreen !== "function") {
      throw new Error("This page does not expose a fullscreen exit method");
    }

    await Promise.resolve(exitFullscreen.call(document));
    await waitForFullscreenExit();
    return true;
  }

  async function waitForFullscreenExit() {
    const deadline = Date.now() + 2500;

    while (Date.now() < deadline) {
      const current =
        document.fullscreenElement || document.webkitFullscreenElement || null;
      if (!current) return;
      await delay(40);
    }

    throw new Error("The page did not leave document fullscreen in time");
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();
