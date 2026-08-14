/**
 * FANOUT_QUERIES — shared adapter machinery.
 *
 * Adapters exist to decode a site's *transport* (SSE, batchexecute frames,
 * anti-XSSI arrays) into plain JSON values. Field extraction is deliberately
 * left to the rules file, so a site renaming a field is a rules fix rather than
 * a code change.
 *
 * Every adapter exposes:
 *   createState()              per-request accumulator
 *   decodeChunk(state, text)   incremental: chunk text -> decoded values
 *   decodeRequest(text)        request body -> decoded value
 *   finish(state)              values still buffered when the stream ends
 *   extraQueries(state, vals)  site-specific queries the rules paths can't reach
 *   conversationKey(url, vals) stable per-conversation id, when derivable
 */

import { SseReassembler, tryParseJson, parseAntiXssiJson } from '../sse.js';

/**
 * Adapter for sites that stream JSON over Server-Sent Events.
 * @param {object} config
 * @returns {object} adapter
 */
/** Cap on the plain-body buffer, so a large download cannot grow unbounded. */
const MAX_PLAIN_BODY = 5 * 1024 * 1024;

export function createSseAdapter(config) {
  return {
    siteId: config.siteId,

    createState() {
      return {
        sse: new SseReassembler(),
        /** Raw body, kept in case this response turns out not to be SSE at all. */
        plain: '',
        sawFrames: false,
        ...(config.initState ? config.initState() : {}),
      };
    },

    decodeChunk(state, text) {
      const values = [];
      for (const frame of state.sse.push(text)) {
        const value = tryParseJson(frame.data);
        if (value !== undefined) values.push(value);
      }
      if (values.length) state.sawFrames = true;

      // The same endpoint family also serves plain JSON documents — loading an
      // existing conversation returns the whole thing at once rather than as a
      // stream. Those carry the same prompts, queries, and results, so keep the
      // raw body until we know which shape this response is.
      if (!state.sawFrames && state.plain.length < MAX_PLAIN_BODY) state.plain += text;

      return values;
    },

    finish(state) {
      const values = [];
      for (const frame of state.sse.flush()) {
        const value = tryParseJson(frame.data);
        if (value !== undefined) values.push(value);
      }
      if (values.length) state.sawFrames = true;

      if (!state.sawFrames && state.plain) {
        const whole = tryParseJson(state.plain);
        if (whole !== undefined) values.push(whole);
      }
      state.plain = '';

      return values;
    },

    decodeRequest(text) {
      return tryParseJson(text);
    },

    extraQueries(state, values) {
      return config.extraQueries ? config.extraQueries(state, values) : [];
    },

    extraPrompt(values) {
      return config.extraPrompt ? config.extraPrompt(values) : null;
    },

    conversationKey(url, values) {
      return config.conversationKey ? config.conversationKey(url, values) : null;
    },
  };
}

/**
 * Adapter for Google-family endpoints: anti-XSSI-prefixed JSON arrays,
 * buffered whole because frames are length-prefixed rather than self-delimiting.
 * @param {object} config
 * @returns {object} adapter
 */
export function createBatchedAdapter(config) {
  return {
    siteId: config.siteId,

    createState() {
      return { buffer: '', ...(config.initState ? config.initState() : {}) };
    },

    decodeChunk(state, text) {
      // Batched payloads are not incrementally parseable; accumulate and decode
      // what is complete so far, letting the engine dedupe repeated results.
      state.buffer += text;
      return decodeBatched(state.buffer, config);
    },

    finish(state) {
      const values = decodeBatched(state.buffer, config);
      state.buffer = '';
      return values;
    },

    decodeRequest(text) {
      return config.decodeRequest ? config.decodeRequest(text) : tryParseJson(text);
    },

    extraQueries(state, values) {
      return config.extraQueries ? config.extraQueries(state, values) : [];
    },

    extraPrompt(values) {
      return config.extraPrompt ? config.extraPrompt(values) : null;
    },

    conversationKey(url, values) {
      return config.conversationKey ? config.conversationKey(url, values) : null;
    },
  };
}

/**
 * Decode an anti-XSSI body, unwrapping `wrb.fr` envelopes when present.
 * @param {string} text
 * @param {{unwrapWrbFr?: boolean}} config
 * @returns {unknown[]}
 */
function decodeBatched(text, config) {
  const values = parseAntiXssiJson(text);
  if (!config.unwrapWrbFr) return values;

  const unwrapped = [];
  for (const value of values) {
    unwrapped.push(value);
    for (const frame of collectWrbFrames(value)) {
      const inner = tryParseJson(frame);
      if (inner !== undefined) unwrapped.push(inner);
    }
  }
  return unwrapped;
}

/**
 * Pull the JSON-string payloads out of `wrb.fr` envelopes.
 *
 * Frames look like `["wrb.fr", "<rpc id>", "<JSON string>", ...]`, so the real
 * data is JSON encoded inside JSON.
 * @param {unknown} node
 * @returns {string[]}
 */
export function collectWrbFrames(node) {
  const out = [];
  const walk = (value, depth) => {
    if (depth > 8 || !Array.isArray(value)) return;
    if (value[0] === 'wrb.fr' && typeof value[2] === 'string') out.push(value[2]);
    for (const child of value) walk(child, depth + 1);
  };
  walk(node, 0);
  return out;
}

/**
 * Decode a `batchexecute` request body: form-encoded `f.req` holding
 * double-encoded JSON.
 * @param {string} text
 * @returns {unknown}
 */
export function decodeBatchExecuteRequest(text) {
  if (typeof text !== 'string' || !text) return undefined;
  let raw = text;
  try {
    const params = new URLSearchParams(text);
    const field = params.get('f.req');
    if (field) raw = field;
  } catch (_) {
    /* not form-encoded; treat the whole body as the field */
  }

  const outer = tryParseJson(raw);
  if (outer === undefined) return undefined;

  // The useful payload is usually a JSON string nested inside the outer array.
  const nested = [];
  const walk = (value, depth) => {
    if (depth > 6) return;
    if (typeof value === 'string') {
      const inner = tryParseJson(value);
      if (inner !== undefined) nested.push(inner);
      return;
    }
    if (Array.isArray(value)) for (const child of value) walk(child, depth + 1);
  };
  walk(outer, 0);

  return nested.length ? { outer, nested } : outer;
}

/**
 * Extract a capture group from a URL.
 * @param {string} url
 * @param {string} pattern Regular expression source with one capture group.
 * @returns {string|null}
 */
export function matchUrl(url, pattern) {
  if (!url || !pattern) return null;
  try {
    const match = new RegExp(pattern).exec(url);
    return match && match[1] ? match[1] : null;
  } catch (_) {
    return null;
  }
}
