/**
 * FANOUT_QUERIES — site adapter registry.
 *
 * Maps a site id (as keyed in the rules file) to the adapter that knows how to
 * decode that site's transport. Sites present in the rules but absent here
 * still work: the engine falls back to generic JSON/SSE decoding plus the
 * heuristic layer, so a rules push can add a site before any code ships.
 */

import { claudeAdapter } from './adapters/claude.js';
import { chatgptAdapter } from './adapters/chatgpt.js';
import { perplexityAdapter } from './adapters/perplexity.js';
import { geminiAdapter } from './adapters/gemini.js';
import { googleAiModeAdapter } from './adapters/google-aimode.js';
import { createSseAdapter } from './adapters/base.js';

/** @type {Record<string, object>} */
const ADAPTERS = {
  claude: claudeAdapter,
  chatgpt: chatgptAdapter,
  perplexity: perplexityAdapter,
  gemini: geminiAdapter,
  google: googleAiModeAdapter,
};

/** Generic SSE/JSON decoding for sites with no dedicated adapter. */
const genericAdapter = createSseAdapter({ siteId: 'generic' });

/**
 * @param {string} siteId
 * @returns {object} adapter (never null — falls back to generic)
 */
export function adapterFor(siteId) {
  return ADAPTERS[siteId] || genericAdapter;
}

/** @returns {string[]} ids of sites with a dedicated adapter */
export function knownSiteIds() {
  return Object.keys(ADAPTERS);
}

/**
 * Strategy order for a site, falling back to the global default.
 * @param {object} site Site block from the rules file.
 * @returns {string[]}
 */
export function strategyOrderFor(site) {
  const order = site && site.strategyOrder;
  if (Array.isArray(order) && order.length) return [...order];
  return ['network', 'dom', 'heuristic'];
}
