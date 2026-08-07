/* Open the extension settings as a full browser tab from the toolbar action. */

(() => {
  "use strict";

  chrome.action.onClicked.addListener(() => {
    try {
      const result = chrome.runtime.openOptionsPage();
      if (result && typeof result.catch === "function") {
        result.catch((error) => {
          console.error("[helium-tweaks] could not open settings:", error);
        });
      }
    } catch (error) {
      console.error("[helium-tweaks] could not open settings:", error);
    }
  });
})();
