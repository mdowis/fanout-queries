/**
 * FANOUT_QUERIES — service worker.
 *
 * Message hub for the extension. The service worker can be evicted at any
 * time, so it holds no authoritative state in memory: everything meaningful is
 * written through to chrome.storage.local and rehydrated on demand.
 *
 * Phase 2 wires the capture pipeline end to end (relay -> hub). The extraction
 * engine, session manager, and health monitor plug into `handleRawCapture` in
 * later phases.
 */

const DEBUG_KEY = 'debug:captureLog';
const DEBUG_LOG_LIMIT = 50;

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error('[fq] sidePanel behavior failed:', err));
});

/**
 * Record a compact summary of recent captures so the pipeline can be verified
 * without a debugger attached to every page.
 * @param {Array<object>} captures
 * @param {chrome.runtime.MessageSender} sender
 */
async function recordDebugSummary(captures, sender) {
  const summaries = captures.map((capture) => ({
    ts: capture.ts,
    url: capture.url,
    method: capture.method,
    transport: capture.transport,
    phase: capture.phase,
    bytes: (capture.body && capture.body.length) || 0,
    tabId: sender.tab ? sender.tab.id : null,
  }));

  const stored = await chrome.storage.local.get(DEBUG_KEY);
  const log = Array.isArray(stored[DEBUG_KEY]) ? stored[DEBUG_KEY] : [];
  const next = [...log, ...summaries].slice(-DEBUG_LOG_LIMIT);
  await chrome.storage.local.set({ [DEBUG_KEY]: next });
}

/**
 * Entry point for page traffic. Later phases run each capture through the
 * extraction engine here.
 * @param {{captures: Array<object>, href: string}} message
 * @param {chrome.runtime.MessageSender} sender
 */
async function handleRawCapture(message, sender) {
  const captures = Array.isArray(message.captures) ? message.captures : [];
  if (!captures.length) return;

  console.debug(
    `[fq] ${captures.length} capture(s) from ${new URL(message.href).hostname}`,
    captures.map((c) => `${c.transport}:${c.phase} ${c.url.slice(0, 80)} (${(c.body || '').length}b)`),
  );

  await recordDebugSummary(captures, sender);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return undefined;

  switch (message.type) {
    case 'raw-capture':
      handleRawCapture(message, sender).catch((err) =>
        console.error('[fq] raw-capture failed:', err),
      );
      return undefined;

    case 'relay-ready':
      // Later phases answer with the active rules' URL patterns.
      sendResponse({ ok: true });
      return true;

    default:
      return undefined;
  }
});
