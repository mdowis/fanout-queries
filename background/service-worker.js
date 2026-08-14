// FANOUT_QUERIES service worker.
// Phase 1 scaffold: side-panel behavior + install hook.
// Message hub, extraction engine, sessions, health, and rules land in later phases.

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error('[fq] sidePanel behavior failed:', err));
});
