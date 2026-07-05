// Chrome Extension MV3 Background Script

// Enable the side panel to open on action button click
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
    .then(() => console.log("[Background] SidePanel behavior set to open on action click."))
    .catch((error) => console.error("[Background] Error setting panel behavior:", error));
});
