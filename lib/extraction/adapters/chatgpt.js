/**
 * FANOUT_QUERIES — chatgpt.com adapter.
 *
 * Conversation responses are SSE. Search activity surfaces two ways:
 *   - message metadata carrying `search_queries` and `search_result_groups`
 *   - assistant messages addressed to the `web` tool, whose text is the
 *     search command itself (e.g. `search("tech news august 2026")`)
 *
 * The stream also delivers delta-patch events (`{p: "...", o: "append", v: "..."}`)
 * that mutate a previously sent message rather than repeating it. The tool call
 * arrives this way, a few characters at a time — `sea`, `rch("tech ne`, … — so
 * it is never whole in any single event. Fragments are therefore accumulated per
 * patch path and the assembled text is rescanned, the same way Claude's
 * `input_json_delta` fragments have to be reassembled.
 *
 * Search *results*, by contrast, arrive as one complete object. That asymmetry
 * is why a naive per-event scan captures sources but no queries.
 */

import { createSseAdapter } from './base.js';

/** `search("...")` / `search('...')` as issued to the web tool. */
const SEARCH_CALL = /\bsearch\(\s*(["'])((?:(?!\1)[\s\S]){1,300}?)\1/g;

/** Cap per accumulated path, so a long answer stream cannot grow unbounded. */
const MAX_BUFFER = 64 * 1024;

export const chatgptAdapter = createSseAdapter({
  siteId: 'chatgpt',

  initState: () => ({
    seenText: new Set(),
    /** @type {Map<string, string>} patch path -> text assembled so far */
    buffers: new Map(),
    /** Queries already emitted, so rescanning a growing buffer cannot repeat. */
    emitted: new Set(),
  }),

  extraQueries(state, values) {
    const queries = [];

    const scan = (text) => {
      SEARCH_CALL.lastIndex = 0;
      let match;
      while ((match = SEARCH_CALL.exec(text)) !== null) {
        const query = match[2].trim();
        if (!query) continue;
        const key = query.toLowerCase();
        if (state.emitted.has(key)) continue;
        state.emitted.add(key);
        queries.push(query);
      }
    };

    for (const value of values) {
      // Whole messages addressed to the web tool.
      for (const text of collectToolText(value)) {
        if (state.seenText.has(text)) continue;
        state.seenText.add(text);
        scan(text);
      }

      // Streamed fragments, reassembled per path before scanning.
      for (const { path, text } of collectAppends(value)) {
        const grown = (state.buffers.get(path) || '') + text;
        state.buffers.set(path, grown.length > MAX_BUFFER ? grown.slice(-MAX_BUFFER) : grown);
        scan(state.buffers.get(path));
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

  extraPrompt(values) {
    // Loading a conversation returns the whole document, where the prompt is a
    // user-authored message rather than a request body. Rules paths cannot
    // express "the part belonging to the message whose author.role is user",
    // so pick it out here.
    for (const value of values) {
      const found = findUserPrompt(value, 0);
      if (found) return found;
    }
    return null;
  },
});

/**
 * Find the most recent user message's text in a conversation document.
 * @param {unknown} node
 * @param {number} depth
 * @returns {string|null}
 */
function findUserPrompt(node, depth) {
  if (node === null || node === undefined || depth > 10) return null;

  if (Array.isArray(node)) {
    for (let i = node.length - 1; i >= 0; i -= 1) {
      const found = findUserPrompt(node[i], depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof node !== 'object') return null;

  const message = node.message && typeof node.message === 'object' ? node.message : node;
  const role = message.author && message.author.role;
  if (role === 'user' && message.content) {
    for (const part of contentParts(message.content)) {
      const text = part.trim();
      if (text) return text;
    }
  }

  for (const key of Object.keys(node)) {
    const found = findUserPrompt(node[key], depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * Collect streamed text fragments from delta-patch events.
 *
 * Two shapes appear in practice: a flat `{p, o: "append", v: "text"}`, and a
 * batched `{o: "patch", v: [{p, o: "append", v: "text"}, …]}`. Both are handled,
 * and the path is used as the accumulation key so fragments belonging to
 * different message parts do not run together.
 *
 * @param {unknown} value
 * @returns {Array<{path: string, text: string}>}
 */
function collectAppends(value) {
  const out = [];

  const walk = (node, depth, inheritedPath) => {
    if (node === null || node === undefined || depth > 8) return;

    if (Array.isArray(node)) {
      for (const child of node) walk(child, depth + 1, inheritedPath);
      return;
    }
    if (typeof node !== 'object') return;

    const path = typeof node.p === 'string' && node.p ? node.p : inheritedPath;

    if (typeof node.v === 'string') {
      // An append, or a patch entry with no explicit operation (append is the
      // default when `o` is omitted).
      if (node.o === 'append' || node.o === undefined) {
        out.push({ path: path || '', text: node.v });
      }
    } else if (node.v !== undefined) {
      walk(node.v, depth + 1, path);
    }

    for (const key of Object.keys(node)) {
      if (key === 'v' || key === 'p' || key === 'o') continue;
      walk(node[key], depth + 1, path);
    }
  };

  walk(value, 0, '');
  return out;
}

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

    // Message parts addressed to the web tool. The recipient has been `web`,
    // `browser`, and `web.run` across versions, so match the family.
    if (typeof nextRecipient === 'string' && /^(web|browser)\b/.test(nextRecipient)) {
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
