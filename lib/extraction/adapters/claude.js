/**
 * FANOUT_QUERIES — claude.ai adapter.
 *
 * Completion responses are SSE. Web searches appear as `tool_use` content
 * blocks named `web_search`, and results as `web_search_tool_result` blocks.
 *
 * The wrinkle: a tool block's `input` streams in as `input_json_delta` frames
 * carrying fragments of JSON text, so the query is not present in any single
 * event. Fragments are accumulated per block index and parsed once complete —
 * which is exactly the kind of stateful decoding rules paths cannot express.
 */

import { createSseAdapter, matchUrl } from './base.js';
import { tryParseJson } from '../sse.js';

const CONVERSATION_URL_PATTERN = '/chat_conversations/([^/?]+)';

export const claudeAdapter = createSseAdapter({
  siteId: 'claude',

  initState: () => ({
    /** @type {Map<number, {name: string|null, json: string, done: boolean}>} */
    toolBlocks: new Map(),
  }),

  extraQueries(state, values) {
    const queries = [];

    for (const value of values) {
      if (!value || typeof value !== 'object') continue;

      // Block opened: remember its index and tool name, seed any inline input.
      if (value.type === 'content_block_start' && value.content_block) {
        const block = value.content_block;
        if (block.type === 'tool_use') {
          const entry = { name: block.name || null, json: '', done: false };
          if (block.input && typeof block.input === 'object') {
            const inline = readQuery(block.input);
            if (inline) {
              queries.push(inline);
              entry.done = true;
            }
          }
          state.toolBlocks.set(value.index ?? 0, entry);
        }
        continue;
      }

      // Input fragment: append to that block's accumulating JSON text.
      if (value.type === 'content_block_delta' && value.delta) {
        const delta = value.delta;
        if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          const entry = state.toolBlocks.get(value.index ?? 0);
          if (entry && !entry.done) {
            entry.json += delta.partial_json;
            // Parse eagerly: the query is usually complete well before the
            // block closes, and capturing it early keeps the panel live.
            const parsed = tryParseJson(entry.json);
            const query = parsed && readQuery(parsed);
            if (query) {
              queries.push(query);
              entry.done = true;
            }
          }
        }
        continue;
      }

      // Block closed: last chance to parse whatever accumulated.
      if (value.type === 'content_block_stop') {
        const entry = state.toolBlocks.get(value.index ?? 0);
        if (entry && !entry.done && entry.json) {
          const parsed = tryParseJson(entry.json);
          const query = parsed && readQuery(parsed);
          if (query) {
            queries.push(query);
            entry.done = true;
          }
        }
      }
    }

    return queries;
  },

  conversationKey(url) {
    return matchUrl(url, CONVERSATION_URL_PATTERN);
  },
});

/**
 * Read the search string out of a tool input object.
 * @param {Record<string, unknown>} input
 * @returns {string|null}
 */
function readQuery(input) {
  for (const key of ['query', 'q', 'search_query']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}
