/* Open the extension settings as a full browser tab from the toolbar action. */

(() => {
  "use strict";

  chrome.action.onClicked.addListener(() => {
    chrome.runtime.openOptionsPage().catch((error) => {
      console.error("[helium-tweaks] could not open settings:", error);
    });
  });
})();
