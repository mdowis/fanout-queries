/**
 * FANOUT_QUERIES — isolated-world relay (ISOLATED world, document_start).
 *
 * Bridges the page-world interceptor to the service worker:
 *   interceptor --CustomEvent--> relay --chrome.runtime--> service worker
 *
 * Also pushes rules-driven URL patterns down into the page world, and (from
 * Phase 6) runs the DOM-scraping fallback layer and the turn detector.
 *
 * Not an ES module — content scripts can't be. Self-contained IIFE.
 */
(() => {
  'use strict';

  const CAPTURE_EVENT = '__fq_capture';
  const CONFIG_EVENT = '__fq_config';

  /** Flush cadence: SSE chunks arrive dozens per second; batching keeps IPC sane. */
  const FLUSH_INTERVAL_MS = 150;
  /** Split oversized payloads before they hit the runtime message channel. */
  const MAX_MESSAGE_BYTES = 512 * 1024;

  let queue = [];
  let queuedBytes = 0;
  let flushTimer = null;
  let contextAlive = true;

  function send(message) {
    if (!contextAlive) return;
    try {
      chrome.runtime.sendMessage(message, () => {
        // Reading lastError suppresses "Unchecked runtime.lastError" noise when
        // the service worker is asleep or mid-restart.
        void chrome.runtime.lastError;
      });
    } catch (_) {
      // "Extension context invalidated" — the extension was reloaded or removed.
      // Stop relaying; this page's scripts will be replaced on next navigation.
      contextAlive = false;
    }
  }

  function flush() {
    flushTimer = null;
    if (!queue.length) return;
    const batch = queue;
    queue = [];
    queuedBytes = 0;
    send({ type: 'raw-capture', captures: batch, href: location.href });
  }

  function scheduleFlush() {
    if (flushTimer !== null) return;
    flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS);
  }

  /** Split a single oversized capture body across several envelopes. */
  function enqueueChunked(capture) {
    const body = capture.body;
    if (typeof body !== 'string' || body.length <= MAX_MESSAGE_BYTES) {
      enqueue(capture);
      return;
    }
    for (let offset = 0, part = 0; offset < body.length; offset += MAX_MESSAGE_BYTES, part++) {
      enqueue({
        ...capture,
        body: body.slice(offset, offset + MAX_MESSAGE_BYTES),
        split: part,
      });
    }
  }

  function enqueue(capture) {
    queue.push(capture);
    queuedBytes += (capture.body && capture.body.length) || 0;
    // Flush early when a burst is large, rather than holding megabytes in memory.
    if (queuedBytes >= MAX_MESSAGE_BYTES) {
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      flush();
      return;
    }
    scheduleFlush();
  }

  document.addEventListener(CAPTURE_EVENT, (event) => {
    if (!contextAlive) return;
    try {
      // detail is a JSON string from the page world: untrusted data, never eval'd.
      const capture = JSON.parse(event.detail);
      if (!capture || typeof capture.url !== 'string' || typeof capture.phase !== 'string') return;
      enqueueChunked(capture);
    } catch (_) {
      /* malformed capture — drop it */
    }
  });

  /** Push URL patterns from the service worker's rules into the page world. */
  function applyConfig(config) {
    try {
      document.dispatchEvent(
        new CustomEvent(CONFIG_EVENT, { detail: JSON.stringify(config) }),
      );
    } catch (_) {
      /* ignore */
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'config') applyConfig(message.config || {});
  });

  // Ask for config once the service worker is up. Failures are fine: the
  // interceptor ships with broad built-in defaults.
  send({ type: 'relay-ready', href: location.href });

  window.addEventListener('pagehide', flush);
})();
