/**
 * FANOUT_QUERIES — isolated-world relay (ISOLATED world, document_start).
 *
 * Three jobs:
 *   1. Bridge page-world captures to the service worker.
 *   2. Run the DOM scraping strategy (layer 2), driven entirely by selectors
 *      from the rules file so a site redesign is a rules fix, not a release.
 *   3. Detect chat turns, which is what lets the health monitor tell
 *      "the user asked nothing" apart from "capture is broken".
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
  /** Ignore DOM rescans triggered more often than this. */
  const MIN_SCRAPE_INTERVAL_MS = 800;
  /**
   * Ceiling on how long a scrape may be deferred. A streaming answer mutates
   * continuously, so pure debounce would starve the scrape until the response
   * finished — this keeps the panel live mid-stream.
   */
  const MAX_SCRAPE_WAIT_MS = 3000;
  /** Cap on nodes read per scrape, so a huge page can't stall the tab. */
  const MAX_NODES_PER_SELECTOR = 200;

  let queue = [];
  let queuedBytes = 0;
  let flushTimer = null;
  let contextAlive = true;

  /** Site rules for this page, once the service worker sends them. */
  let siteRules = null;
  let siteId = null;

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
      contextAlive = false;
      teardown();
    }
  }

  // ------------------------------------------------------- capture relay ---

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

  function enqueue(capture) {
    queue.push(capture);
    queuedBytes += (capture.body && capture.body.length) || 0;
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

  /** Split a single oversized capture body across several envelopes. */
  function enqueueChunked(capture) {
    const body = capture.body;
    if (typeof body !== 'string' || body.length <= MAX_MESSAGE_BYTES) {
      enqueue(capture);
      return;
    }
    for (let offset = 0, part = 0; offset < body.length; offset += MAX_MESSAGE_BYTES, part++) {
      enqueue({ ...capture, body: body.slice(offset, offset + MAX_MESSAGE_BYTES), split: part });
    }
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

  // ------------------------------------------------------ DOM scraping ---

  let lastScrapeAt = 0;
  let scrapeTimer = null;
  let scrapePendingSince = 0;
  let observer = null;
  /** Text already reported, so repeat scrapes don't resend the same page. */
  const reportedQueries = new Set();
  const reportedSources = new Set();
  let reportedPrompt = null;

  /**
   * Read text from every node matching any of the given selectors.
   * A selector that no longer matches simply contributes nothing — which is
   * precisely the failure the health monitor watches for.
   * @param {string[]} selectors
   * @returns {string[]}
   */
  function readTexts(selectors) {
    const out = [];
    for (const selector of selectors || []) {
      let nodes;
      try {
        nodes = document.querySelectorAll(selector);
      } catch (_) {
        continue; // a malformed selector from rules must not break the scrape
      }
      let count = 0;
      for (const node of nodes) {
        if (count >= MAX_NODES_PER_SELECTOR) break;
        count += 1;
        const text = (node.textContent || '').trim();
        if (text && text.length <= 300) out.push(text);
      }
    }
    return out;
  }

  /**
   * Read links from every node matching any of the given selectors.
   * @param {string[]} selectors
   * @returns {Array<{url: string, title: string}>}
   */
  function readLinks(selectors) {
    const out = [];
    for (const selector of selectors || []) {
      let nodes;
      try {
        nodes = document.querySelectorAll(selector);
      } catch (_) {
        continue;
      }
      let count = 0;
      for (const node of nodes) {
        if (count >= MAX_NODES_PER_SELECTOR) break;
        count += 1;
        const href = node.getAttribute && node.getAttribute('href');
        if (!href) continue;
        let absolute;
        try {
          absolute = new URL(href, location.href).href;
        } catch (_) {
          continue;
        }
        if (!/^https?:\/\//i.test(absolute)) continue;
        out.push({ url: absolute, title: (node.textContent || '').trim().slice(0, 300) });
      }
    }
    return out;
  }

  /** Read the first selector that yields text. */
  function readFirstText(selector) {
    if (!selector) return null;
    let node;
    try {
      node = document.querySelector(selector);
    } catch (_) {
      return null;
    }
    if (!node) return null;
    const text = (node.value !== undefined ? node.value : node.textContent) || '';
    const trimmed = String(text).trim();
    return trimmed ? trimmed.slice(0, 2000) : null;
  }

  /** Scrape the page per the site's DOM rules and report anything new. */
  function scrape() {
    scrapeTimer = null;
    scrapePendingSince = 0;
    if (!contextAlive || !siteRules || !siteRules.dom) return;

    lastScrapeAt = Date.now();
    const dom = siteRules.dom;

    const queries = [];
    for (const text of readTexts(dom.querySelectors)) {
      const key = text.toLowerCase();
      if (reportedQueries.has(key)) continue;
      reportedQueries.add(key);
      queries.push(text);
    }

    const sources = [];
    for (const link of readLinks(dom.citationSelectors)) {
      if (reportedSources.has(link.url)) continue;
      reportedSources.add(link.url);
      sources.push(link);
    }

    const prompt = readFirstText(dom.promptSelector);
    const promptIsNew = prompt && prompt !== reportedPrompt;
    if (promptIsNew) reportedPrompt = prompt;

    if (!queries.length && !sources.length && !promptIsNew) return;

    send({
      type: 'dom-capture',
      href: location.href,
      capture: {
        siteId,
        href: location.href,
        prompt: promptIsNew ? prompt : null,
        queries,
        sources,
        ts: Date.now(),
      },
    });
  }

  /** Debounce scrapes until the DOM settles after a burst of mutations. */
  function scheduleScrape() {
    if (!siteRules || !siteRules.dom) return;
    const now = Date.now();
    if (!scrapePendingSince) scrapePendingSince = now;

    // Deferred too long by a continuous mutation stream — read the page now.
    if (now - scrapePendingSince >= MAX_SCRAPE_WAIT_MS) {
      if (scrapeTimer !== null) clearTimeout(scrapeTimer);
      scrape();
      return;
    }

    const debounce = siteRules.dom.settleDebounceMs || 1200;
    const sinceLast = now - lastScrapeAt;
    const delay = sinceLast < MIN_SCRAPE_INTERVAL_MS ? MIN_SCRAPE_INTERVAL_MS : debounce;

    if (scrapeTimer !== null) clearTimeout(scrapeTimer);
    scrapeTimer = setTimeout(scrape, delay);
  }

  function startObserving() {
    if (observer || !siteRules || !siteRules.dom) return;
    observer = new MutationObserver(() => scheduleScrape());
    const start = () => {
      if (!document.body) {
        // document_start runs before body exists.
        requestAnimationFrame(start);
        return;
      }
      observer.observe(document.body, { childList: true, subtree: true });
      scheduleScrape();
    };
    start();
  }

  // ------------------------------------------------------ turn detection ---

  let lastTurnAt = 0;

  /**
   * Report that the user asked something. This is what separates "quiet" from
   * "broken" for the health monitor: a turn with no capture is a real miss.
   */
  function reportTurn(trigger) {
    const now = Date.now();
    if (now - lastTurnAt < 1500) return; // one turn per submission, not per keystroke
    lastTurnAt = now;
    // A new question invalidates the previous prompt, so it can be re-reported.
    reportedPrompt = null;
    send({ type: 'turn-observed', href: location.href, siteId, trigger, ts: now });
    scheduleScrape();
  }

  function watchForTurns() {
    // Submitting with Enter (without Shift) is the common path.
    document.addEventListener(
      'keydown',
      (event) => {
        if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
        const target = event.target;
        if (!target) return;
        const editable =
          target.isContentEditable ||
          target.tagName === 'TEXTAREA' ||
          (target.tagName === 'INPUT' && target.type !== 'checkbox');
        if (editable) reportTurn('enter');
      },
      true,
    );

    // Clicking the send button covers the rest.
    document.addEventListener(
      'click',
      (event) => {
        if (!siteRules || !siteRules.dom || !siteRules.dom.composerSubmit) return;
        const target = event.target;
        if (!target || !target.closest) return;
        try {
          if (target.closest(siteRules.dom.composerSubmit)) reportTurn('submit');
        } catch (_) {
          /* malformed selector from rules */
        }
      },
      true,
    );
  }

  // ----------------------------------------------------------- lifecycle ---

  /** Push URL patterns from the service worker into the page world. */
  function applyConfig(config) {
    try {
      document.dispatchEvent(new CustomEvent(CONFIG_EVENT, { detail: JSON.stringify(config) }));
    } catch (_) {
      /* ignore */
    }

    // Find this page's site block so the DOM layer knows what to look for.
    if (config && config.sites) {
      for (const [id, site] of Object.entries(config.sites)) {
        for (const host of site.hosts || []) {
          if (location.hostname === host || location.hostname.endsWith(`.${host}`)) {
            siteId = id;
            siteRules = site;
            break;
          }
        }
        if (siteRules) break;
      }
    }

    if (siteRules) {
      startObserving();
      // Rules may have changed the selectors, so let the page be re-read.
      reportedQueries.clear();
      reportedSources.clear();
      reportedPrompt = null;
    }
  }

  function teardown() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (scrapeTimer !== null) clearTimeout(scrapeTimer);
    if (flushTimer !== null) clearTimeout(flushTimer);
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'config') applyConfig(message.config || {});
  });

  // Ask for config once the service worker is up. Failures are fine: the
  // interceptor ships with broad built-in defaults.
  send({ type: 'relay-ready', href: location.href });

  watchForTurns();

  window.addEventListener('pagehide', () => {
    flush();
    teardown();
  });
})();
