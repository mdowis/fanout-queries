/**
 * FANOUT_QUERIES — gemini.google.com adapter.
 *
 * Gemini talks over `batchexecute`: the response is an anti-XSSI-prefixed array
 * of `wrb.fr` envelopes whose payloads are JSON encoded *inside* JSON, and the
 * decoded result has no field names at all — just deeply nested positional
 * arrays.
 *
 * Nothing here can be a stable path, so extraction leans on the array miner
 * (URL/title adjacency) and the shared heuristics. Expect sources to capture
 * reliably and queries to be best-effort; this is the documented tradeoff for
 * Google-family surfaces.
 */

import { createBatchedAdapter, decodeBatchExecuteRequest } from './base.js';

export const geminiAdapter = createBatchedAdapter({
  siteId: 'gemini',
  unwrapWrbFr: true,
  decodeRequest: decodeBatchExecuteRequest,

  conversationKey(url) {
    const match = /\/app\/([0-9a-f]{8,})/i.exec(url || '');
    return match ? match[1] : null;
  },
});

/**
 * Recover the prompt from a decoded `batchexecute` request.
 *
 * The prompt sits at a positional offset rather than under a name, so this
 * takes the first plausible free-text string in the decoded structure.
 * @param {unknown} decoded Output of decodeBatchExecuteRequest.
 * @returns {string|null}
 */
export function promptFromBatchExecute(decoded) {
  if (!decoded) return null;
  const candidates = [];

  const walk = (value, depth) => {
    if (depth > 10 || value === null || value === undefined) return;
    if (typeof value === 'string') {
      const text = value.trim();
      // Skip framing tokens, ids, locale codes, and the nested JSON documents
      // that wrap the payload — those are structure, not the user's words.
      if (
        text.length >= 3 &&
        text.length <= 2000 &&
        /[a-z]/i.test(text) &&
        !/^https?:\/\//i.test(text) &&
        !/^[0-9a-f]{16,}$/i.test(text) &&
        !/^[a-z]{2}(-[A-Z]{2})?$/.test(text) &&
        text[0] !== '[' &&
        text[0] !== '{' &&
        text.includes(' ')
      ) {
        candidates.push(text);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const child of value) walk(child, depth + 1);
      return;
    }
    if (typeof value === 'object') {
      for (const key of Object.keys(value)) walk(value[key], depth + 1);
    }
  };

  walk(decoded, 0);
  return candidates.length ? candidates[0] : null;
}
