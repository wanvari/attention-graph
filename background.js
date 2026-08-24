// Background script for Browser History Topic Graph Extension

chrome.action.onClicked.addListener((tab) => {
  // Create or focus the history graph tab
  chrome.tabs.query({ url: chrome.runtime.getURL('ui/map.html') }, (existingTabs) => {
    if (existingTabs.length > 0) {
      // If tab already exists, focus it
      chrome.tabs.update(existingTabs[0].id, { active: true });
      chrome.windows.update(existingTabs[0].windowId, { focused: true });
    } else {
      // Create new tab
      chrome.tabs.create({
        url: chrome.runtime.getURL('ui/map.html'),
        active: true
      });
    }
  });
});
