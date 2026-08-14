/**
 * FANOUT_QUERIES — extraction engine.
 *
 * Turns decoded payloads into queries and sources by running, in order:
 *
 *   layer 1  rules paths over the adapter's decoded values  (confidence 1.0)
 *   layer 3  shape-based heuristics / array mining          (confidence 0.4)
 *
 * Layer 2 (DOM) is produced in the content script and normalized separately by
 * `normalizeDomCapture`, since it arrives already structured.
 *
 * Both network layers always run. They are cheap relative to the network I/O
 * that produced the payload, and results dedupe by normalized text — so a
 * heuristic hit costs nothing when the rules paths already found the same
 * query, and saves the capture when they didn't. The health monitor decides
 * which layer is *reported* as active; it does not gate execution.
 */

import { queryAll } from './json-path.js';
import { scan, mineArrays, DEFAULT_HEURISTICS } from './heuristics.js';
import { adapterFor } from './registry.js';
import { unwrapRedirect } from './adapters/google-aimode.js';
import { STRATEGY_CONFIDENCE } from '../types.js';

const MAX_SNIPPET = 500;

/**
 * Per-request accumulation. One context per intercepted request id; the engine
 * feeds it chunks and collects results incrementally so the panel stays live.
 */
export class CaptureContext {
  /**
   * @param {string} siteId
   * @param {object} site Site block from the rules file.
   * @param {string} url
   */
  constructor(siteId, site, url) {
    this.siteId = siteId;
    this.site = site;
    this.url = url;
    this.adapter = adapterFor(siteId);
    this.state = this.adapter.createState();
    this.requestValue = undefined;
    this.conversationKey = null;
    this.seenQueries = new Set();
    this.seenSources = new Set();
    this.lastActivity = Date.now();
  }
}

/**
 * Should this URL be parsed by the network layer for this site?
 * @param {string} url
 * @param {object} site
 * @returns {boolean}
 */
export function matchesEndpoint(url, site) {
  const endpoints = (site && site.network && site.network.endpoints) || [];
  for (const endpoint of endpoints) {
    if (endpoint && typeof endpoint.urlPattern === 'string' && url.includes(endpoint.urlPattern)) {
      return true;
    }
  }
  return false;
}

/**
 * Feed a request body into a context.
 * @param {CaptureContext} context
 * @param {string} text
 */
export function ingestRequest(context, text) {
  try {
    context.requestValue = context.adapter.decodeRequest(text);
  } catch (_) {
    context.requestValue = undefined;
  }
  context.lastActivity = Date.now();
}

/**
 * Feed one response chunk into a context and extract whatever is now visible.
 * @param {CaptureContext} context
 * @param {string} text
 * @returns {import('../types.js').ExtractionResult|null} new findings only
 */
export function ingestChunk(context, text) {
  let values;
  try {
    values = context.adapter.decodeChunk(context.state, text) || [];
  } catch (_) {
    return null;
  }
  return extractFrom(context, values);
}

/**
 * Flush anything still buffered when the response ends.
 * @param {CaptureContext} context
 * @returns {import('../types.js').ExtractionResult|null}
 */
export function finishCapture(context) {
  let values;
  try {
    values = context.adapter.finish(context.state) || [];
  } catch (_) {
    return null;
  }
  return extractFrom(context, values);
}

/**
 * Run both network layers over a batch of decoded values.
 * @param {CaptureContext} context
 * @param {unknown[]} values
 * @returns {import('../types.js').ExtractionResult|null}
 */
function extractFrom(context, values) {
  if (!values.length) return null;
  context.lastActivity = Date.now();

  const network = context.site.network || {};
  const heuristicConfig = { ...DEFAULT_HEURISTICS, ...(context.site.heuristics || {}) };

  /** @type {import('../types.js').FanoutQuery[]} */
  const queries = [];
  /** @type {import('../types.js').Source[]} */
  const sources = [];
  let prompt;
  let sawNetworkHit = false;

  const addQuery = (text, strategy) => {
    if (typeof text !== 'string') return;
    const trimmed = text.trim();
    if (trimmed.length < heuristicConfig.minQueryLength) return;
    if (trimmed.length > heuristicConfig.maxQueryLength) return;
    const key = trimmed.toLowerCase();
    if (context.seenQueries.has(key)) return;
    context.seenQueries.add(key);
    queries.push({
      text: trimmed,
      ts: Date.now(),
      strategy,
      confidence: STRATEGY_CONFIDENCE[strategy],
    });
  };

  const addSource = (source, strategy) => {
    if (!source || typeof source.url !== 'string') return;
    const url = unwrapRedirect(source.url, (context.site.dom || {}).linkUnwrap);
    if (!/^https?:\/\//i.test(url)) return;
    if (context.seenSources.has(url)) return;
    context.seenSources.add(url);
    const record = { url, strategy };
    if (source.title) record.title = String(source.title).slice(0, MAX_SNIPPET);
    if (source.snippet) record.snippet = String(source.snippet).slice(0, MAX_SNIPPET);
    record.queryText = source.queryText || null;
    sources.push(record);
  };

  for (const value of values) {
    const roots = { response: value, request: context.requestValue };

    // ---- layer 1: rules paths --------------------------------------------
    const before = queries.length + sources.length;

    for (const raw of queryAll(network.queryPaths || [], roots)) {
      if (typeof raw === 'string') addQuery(raw, 'network');
      else if (raw && typeof raw === 'object') {
        for (const key of ['q', 'query', 'text']) {
          if (typeof raw[key] === 'string') {
            addQuery(raw[key], 'network');
            break;
          }
        }
      }
    }

    for (const spec of network.sourcePaths || []) {
      if (!spec || typeof spec.root !== 'string') continue;
      for (const node of queryAll([spec.root], roots)) {
        if (!node || typeof node !== 'object') continue;
        const url = node[spec.url || 'url'];
        if (typeof url !== 'string') continue;
        addSource(
          {
            url,
            title: node[spec.title || 'title'],
            snippet: node[spec.snippet || 'snippet'],
            queryText: spec.query ? node[spec.query] : null,
          },
          'network',
        );
      }
    }

    if (queries.length + sources.length > before) sawNetworkHit = true;

    // ---- adapter-specific queries (stateful decoding rules can't express) --
    try {
      for (const text of context.adapter.extraQueries(context.state, [value]) || []) {
        addQuery(text, 'network');
        sawNetworkHit = true;
      }
    } catch (_) {
      /* an adapter quirk must not sink the whole extraction */
    }

    // ---- prompt -----------------------------------------------------------
    if (prompt === undefined) {
      const found = readPrompt(network, roots, context.url);
      if (found) prompt = found;
    }

    // ---- conversation key -------------------------------------------------
    if (!context.conversationKey) {
      const fromPaths = queryAll(network.conversationKeyPaths || [], roots).find(
        (value_) => typeof value_ === 'string' && value_,
      );
      if (fromPaths) {
        context.conversationKey = fromPaths;
      } else {
        try {
          context.conversationKey = context.adapter.conversationKey(context.url, [value]) || null;
        } catch (_) {
          /* leave unset */
        }
      }
    }

    // ---- layer 3: heuristics ---------------------------------------------
    const heuristic = scan(value, heuristicConfig);
    for (const text of heuristic.queries) addQuery(text, 'heuristic');
    for (const source of heuristic.sources) addSource(source, 'heuristic');

    if (network.arrayMiner) {
      const mined = mineArrays(value, network.arrayMiner, heuristicConfig);
      for (const text of mined.queries) addQuery(text, 'heuristic');
      for (const source of mined.sources) addSource(source, 'heuristic');
    }
  }

  if (!queries.length && !sources.length && prompt === undefined) return null;

  const strategy = sawNetworkHit ? 'network' : 'heuristic';
  return {
    prompt,
    queries,
    sources,
    strategy,
    confidence: STRATEGY_CONFIDENCE[strategy],
    conversationKey: context.conversationKey || undefined,
  };
}

/**
 * Resolve the user's prompt from the request body or the URL.
 * @param {object} network Network block from the rules file.
 * @param {{response: unknown, request: unknown}} roots
 * @param {string} url
 * @returns {string|undefined}
 */
function readPrompt(network, roots, url) {
  for (const value of queryAll(network.promptPaths || [], roots)) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (Array.isArray(value)) {
      const text = value.find((entry) => typeof entry === 'string' && entry.trim());
      if (text) return text.trim();
    }
  }

  if (network.promptFromUrlParam) {
    try {
      const value = new URL(url).searchParams.get(network.promptFromUrlParam);
      if (value && value.trim()) return value.trim();
    } catch (_) {
      /* not a parseable URL */
    }
  }

  return undefined;
}

/**
 * Normalize a DOM capture from the relay into an extraction result.
 * @param {import('../types.js').DomCapture} capture
 * @param {object} site
 * @returns {import('../types.js').ExtractionResult|null}
 */
export function normalizeDomCapture(capture, site) {
  if (!capture) return null;
  const linkUnwrap = (site && site.dom && site.dom.linkUnwrap) || undefined;
  const confidence = STRATEGY_CONFIDENCE.dom;

  const seen = new Set();
  const queries = [];
  for (const text of capture.queries || []) {
    if (typeof text !== 'string') continue;
    const trimmed = text.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    queries.push({ text: trimmed, ts: capture.ts || Date.now(), strategy: 'dom', confidence });
  }

  const seenUrls = new Set();
  const sources = [];
  for (const entry of capture.sources || []) {
    if (!entry || typeof entry.url !== 'string') continue;
    const url = unwrapRedirect(entry.url, linkUnwrap);
    if (!/^https?:\/\//i.test(url) || seenUrls.has(url)) continue;
    seenUrls.add(url);
    const source = { url, strategy: 'dom', queryText: entry.queryText || null };
    if (entry.title) source.title = String(entry.title).slice(0, MAX_SNIPPET);
    sources.push(source);
  }

  if (!queries.length && !sources.length && !capture.prompt) return null;

  return {
    prompt: capture.prompt || undefined,
    queries,
    sources,
    strategy: 'dom',
    confidence,
  };
}
