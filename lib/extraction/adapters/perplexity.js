/**
 * FANOUT_QUERIES — perplexity.ai adapter.
 *
 * Answers stream over SSE (and, on some builds, WebSocket frames — the engine
 * feeds both through here). Payloads carry step entities describing the search
 * plan, with `sub_queries` and `web_results` reachable by rules paths.
 *
 * The site also nests JSON *as strings* inside its step entities, so a second
 * decode pass is needed before the rules paths can see those fields.
 */

import { createSseAdapter } from './base.js';
import { tryParseJson } from '../sse.js';

export const perplexityAdapter = createSseAdapter({
  siteId: 'perplexity',

  initState: () => ({ seen: new Set() }),

  extraQueries(state, values) {
    const queries = [];

    for (const value of values) {
      for (const nested of expandNestedJson(value, 0)) {
        for (const query of collectStepQueries(nested)) {
          const key = query.toLowerCase();
          if (state.seen.has(key)) continue;
          state.seen.add(key);
          queries.push(query);
        }
      }
    }

    return queries;
  },

  conversationKey(url, values) {
    for (const value of values) {
      for (const key of ['context_uuid', 'backend_uuid', 'frontend_uuid']) {
        if (value && typeof value === 'object' && typeof value[key] === 'string') {
          return value[key];
        }
      }
    }
    const match = /\/search\/([^/?#]+)/.exec(url || '');
    return match ? match[1] : null;
  },
});

/**
 * Yield a value plus any JSON documents encoded as strings inside it.
 * @param {unknown} node
 * @param {number} depth
 * @returns {unknown[]}
 */
export function expandNestedJson(node, depth) {
  const out = [node];
  if (depth > 4 || node === null || typeof node !== 'object') return out;

  const walk = (value, currentDepth) => {
    if (currentDepth > 6 || value === null || value === undefined) return;
    if (typeof value === 'string') {
      // Only strings that plausibly hold a document, to avoid parsing prose.
      if (value.length > 2 && (value[0] === '{' || value[0] === '[')) {
        const parsed = tryParseJson(value);
        if (parsed !== undefined) out.push(parsed);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const child of value) walk(child, currentDepth + 1);
      return;
    }
    if (typeof value === 'object') {
      for (const key of Object.keys(value)) walk(value[key], currentDepth + 1);
    }
  };

  walk(node, 0);
  return out;
}

/**
 * Pull search strings out of Perplexity's step entities.
 * @param {unknown} node
 * @returns {string[]}
 */
function collectStepQueries(node) {
  const out = [];

  const walk = (value, depth) => {
    if (value === null || value === undefined || depth > 12) return;
    if (Array.isArray(value)) {
      for (const child of value) walk(child, depth + 1);
      return;
    }
    if (typeof value !== 'object') return;

    for (const key of ['sub_queries', 'search_queries', 'queries']) {
      const field = value[key];
      if (!Array.isArray(field)) continue;
      for (const entry of field) {
        if (typeof entry === 'string' && entry.trim()) out.push(entry.trim());
        else if (entry && typeof entry === 'object') {
          for (const inner of ['query', 'text', 'q']) {
            if (typeof entry[inner] === 'string' && entry[inner].trim()) {
              out.push(entry[inner].trim());
              break;
            }
          }
        }
      }
    }

    // Step entities name their query directly — both search steps and the
    // initial-query step, which encodes its payload as a nested JSON string.
    if (typeof value.query === 'string' && value.query.trim()) {
      out.push(value.query.trim());
    }

    for (const key of Object.keys(value)) walk(value[key], depth + 1);
  };

  walk(node, 0);
  return out;
}
