/**
 * FANOUT_QUERIES — chatgpt.com adapter.
 *
 * Conversation responses are SSE. Search activity surfaces two ways:
 *   - message metadata carrying `search_queries` and `search_result_groups`
 *   - assistant messages addressed to the `web` tool, whose text is the
 *     search command itself (e.g. `search("tech news august 2026")`)
 *
 * The stream also delivers delta-patch events (`{o: "patch", p: "...", v: ...}`)
 * that mutate a previously sent message rather than repeating it. Rather than
 * reconstructing the document, the rules paths deep-scan each event and the
 * patch values are scanned here — drift-resistant and far simpler.
 */

import { createSseAdapter } from './base.js';

/** `search("...")` / `search('...')` as issued to the web tool. */
const SEARCH_CALL = /\bsearch\(\s*(["'])((?:(?!\1)[\s\S]){1,300}?)\1/g;

export const chatgptAdapter = createSseAdapter({
  siteId: 'chatgpt',

  initState: () => ({ seenText: new Set() }),

  extraQueries(state, values) {
    const queries = [];

    for (const value of values) {
      for (const text of collectToolText(value)) {
        if (state.seenText.has(text)) continue;
        state.seenText.add(text);

        SEARCH_CALL.lastIndex = 0;
        let match;
        while ((match = SEARCH_CALL.exec(text)) !== null) {
          const query = match[2].trim();
          if (query) queries.push(query);
        }
      }
    }

    return queries;
  },

  conversationKey(url, values) {
    for (const value of values) {
      const found = findConversationId(value, 0);
      if (found) return found;
    }
    // Fall back to the conversation id in the page URL.
    const match = /\/c\/([0-9a-f-]{8,})/i.exec(url || '');
    return match ? match[1] : null;
  },
});

/**
 * Gather message text addressed to the search tool, plus patch values that
 * carry it.
 * @param {unknown} value
 * @returns {string[]}
 */
function collectToolText(value) {
  const out = [];

  const walk = (node, depth, recipient) => {
    if (node === null || node === undefined || depth > 12) return;

    if (Array.isArray(node)) {
      for (const child of node) walk(child, depth + 1, recipient);
      return;
    }
    if (typeof node !== 'object') return;

    const nextRecipient =
      (node.message && node.message.recipient) || node.recipient || recipient;

    // Message parts addressed to the web tool.
    if (nextRecipient === 'web' || nextRecipient === 'browser') {
      const content = (node.message && node.message.content) || node.content;
      if (content) {
        for (const part of contentParts(content)) out.push(part);
      }
    }

    // Patch events: the value may itself be the tool text.
    if (typeof node.v === 'string' && node.v.includes('search(')) out.push(node.v);

    for (const key of Object.keys(node)) {
      walk(node[key], depth + 1, nextRecipient);
    }
  };

  walk(value, 0, null);
  return out;
}

/**
 * @param {unknown} content
 * @returns {string[]}
 */
function contentParts(content) {
  if (typeof content === 'string') return [content];
  if (Array.isArray(content)) return content.filter((part) => typeof part === 'string');
  if (content && typeof content === 'object') {
    if (Array.isArray(content.parts)) {
      return content.parts.filter((part) => typeof part === 'string');
    }
    if (typeof content.text === 'string') return [content.text];
  }
  return [];
}

/**
 * @param {unknown} node
 * @param {number} depth
 * @returns {string|null}
 */
function findConversationId(node, depth) {
  if (node === null || node === undefined || depth > 8 || typeof node !== 'object') return null;
  if (typeof node.conversation_id === 'string') return node.conversation_id;
  for (const key of Object.keys(node)) {
    const found = findConversationId(node[key], depth + 1);
    if (found) return found;
  }
  return null;
}
