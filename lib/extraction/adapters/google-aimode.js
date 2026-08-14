/**
 * FANOUT_QUERIES — Google AI Mode / AI Overviews adapter.
 *
 * The highest-risk surface. Responses arrive as anti-XSSI-prefixed positional
 * arrays over chunked XHR with no field names, so network extraction is
 * best-effort array mining. The rules ship `strategyOrder: ["dom", ...]` for
 * this site: the rendered AI Mode panel is the more reliable source, and the
 * network layer is the fallback rather than the other way round.
 *
 * Cited links are wrapped in `/url?q=` redirects, which are unwrapped here so
 * exports carry real destinations.
 */

import { createBatchedAdapter } from './base.js';

export const googleAiModeAdapter = createBatchedAdapter({
  siteId: 'google',
  unwrapWrbFr: true,

  decodeRequest() {
    // The prompt lives in the `q` URL parameter, not the body.
    return undefined;
  },

  conversationKey(url) {
    // Google has no conversation id; the query string identifies the search.
    const prompt = promptFromUrl(url);
    return prompt ? `q:${prompt.slice(0, 80)}` : null;
  },
});

/**
 * Read the search terms from a Google search URL.
 * @param {string} url
 * @returns {string|null}
 */
export function promptFromUrl(url) {
  if (!url) return null;
  try {
    const value = new URL(url).searchParams.get('q');
    return value && value.trim() ? value.trim() : null;
  } catch (_) {
    return null;
  }
}

/**
 * Unwrap a Google redirect link to its destination.
 *
 * `https://www.google.com/url?q=https://example.com/page&sa=U` -> the target.
 * Non-redirect URLs are returned unchanged.
 * @param {string} url
 * @param {{param?: string, pathPrefix?: string}} [config]
 * @returns {string}
 */
export function unwrapRedirect(url, config = {}) {
  if (typeof url !== 'string' || !url) return url;
  const param = config.param || 'q';
  const pathPrefix = config.pathPrefix || '/url';

  try {
    const parsed = new URL(url);
    if (!parsed.pathname.startsWith(pathPrefix)) return url;
    const target = parsed.searchParams.get(param) || parsed.searchParams.get('url');
    if (target && /^https?:\/\//i.test(target)) return target;
    return url;
  } catch (_) {
    return url;
  }
}
