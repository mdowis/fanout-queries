/**
 * FANOUT_QUERIES — heuristic extraction (strategy layer 3).
 *
 * The last-resort layer. Instead of following configured paths, it walks a
 * payload looking for *shapes*: keys that tend to hold search queries, and
 * objects that look like search results. When a site renames or renests its
 * fields, literal paths break but shapes usually survive — which is what makes
 * this the backstop that keeps capture alive until rules catch up.
 */

/** Defaults used when the rules file supplies no heuristics block. */
export const DEFAULT_HEURISTICS = {
  queryKeys: [
    'query',
    'q',
    'search_query',
    'searchQuery',
    'search_queries',
    'searchQueries',
    'sub_queries',
    'subQueries',
    'queries',
    'search_terms',
    'searchTerms',
  ],
  /** Keys that hold the query string inside a query-shaped object. */
  queryValueKeys: ['q', 'query', 'text', 'term', 'value', 'name'],
  resultShape: {
    requireKeys: ['url'],
    anyKeys: ['title', 'name', 'snippet', 'text', 'description'],
  },
  /** Alternate keys some payloads use for the result URL. */
  urlKeys: ['url', 'link', 'source_url', 'sourceUrl', 'uri'],
  minQueryLength: 3,
  maxQueryLength: 300,
  urlDenylist: [
    'googleusercontent',
    'gstatic.com',
    'oaistatic.com',
    'oaiusercontent.com',
    'cdn.',
    'fonts.googleapis',
    'schema.org',
    'w3.org',
  ],
  maxDepth: 30,
};

const MAX_SNIPPET = 500;

/**
 * Does this string plausibly read as a search query rather than an id or blob?
 * @param {unknown} value
 * @param {typeof DEFAULT_HEURISTICS} config
 */
function looksLikeQuery(value, config) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (text.length < config.minQueryLength || text.length > config.maxQueryLength) return false;
  if (!/[a-z]/i.test(text)) return false; // needs letters
  if (/^https?:\/\//i.test(text)) return false; // that's a URL, not a query
  // Opaque identifiers: long unbroken hex/base64-ish runs with no spaces.
  if (!text.includes(' ') && /^[0-9a-f-]{16,}$/i.test(text)) return false;
  if (!text.includes(' ') && text.length > 60) return false;
  return true;
}

/**
 * @param {unknown} value
 * @param {typeof DEFAULT_HEURISTICS} config
 */
function acceptableUrl(value, config) {
  if (typeof value !== 'string') return false;
  if (!/^https?:\/\//i.test(value)) return false;
  const lower = value.toLowerCase();
  for (const blocked of config.urlDenylist) {
    if (lower.includes(blocked)) return false;
  }
  return true;
}

/**
 * Pull a query string out of a query-shaped value (string, or object with a
 * recognizable text field).
 * @param {unknown} value
 * @param {typeof DEFAULT_HEURISTICS} config
 * @returns {string|null}
 */
function readQueryValue(value, config) {
  if (looksLikeQuery(value, config)) return String(value).trim();
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of config.queryValueKeys) {
      if (key in value && looksLikeQuery(value[key], config)) {
        return String(value[key]).trim();
      }
    }
  }
  return null;
}

/**
 * Read a result-shaped object into a source record.
 * @param {Record<string, unknown>} node
 * @param {typeof DEFAULT_HEURISTICS} config
 * @returns {{url: string, title?: string, snippet?: string}|null}
 */
function readSource(node, config) {
  let url = null;
  for (const key of config.urlKeys) {
    if (acceptableUrl(node[key], config)) {
      url = String(node[key]);
      break;
    }
  }
  if (!url) return null;

  const hasDescriptor = config.resultShape.anyKeys.some(
    (key) => typeof node[key] === 'string' && node[key].trim(),
  );
  if (!hasDescriptor) return null;

  const source = { url };
  for (const key of ['title', 'name']) {
    if (typeof node[key] === 'string' && node[key].trim()) {
      source.title = node[key].trim().slice(0, MAX_SNIPPET);
      break;
    }
  }
  for (const key of ['snippet', 'description', 'text']) {
    if (typeof node[key] === 'string' && node[key].trim()) {
      source.snippet = node[key].trim().slice(0, MAX_SNIPPET);
      break;
    }
  }
  return source;
}

/**
 * Scan an arbitrary payload for fan-out queries and cited sources.
 *
 * Sources found beneath an object that also carries a query are attributed to
 * that query, which is how heuristic results keep their per-query grouping.
 *
 * @param {unknown} payload
 * @param {Partial<typeof DEFAULT_HEURISTICS>} [overrides]
 * @returns {{queries: string[], sources: Array<{url: string, title?: string, snippet?: string, queryText: string|null}>}}
 */
export function scan(payload, overrides) {
  const config = { ...DEFAULT_HEURISTICS, ...(overrides || {}) };
  if (overrides && overrides.resultShape) {
    config.resultShape = { ...DEFAULT_HEURISTICS.resultShape, ...overrides.resultShape };
  }

  const queryKeys = new Set(config.queryKeys);
  /** @type {string[]} */
  const queries = [];
  const seenQueries = new Set();
  /** @type {Array<{url: string, title?: string, snippet?: string, queryText: string|null}>} */
  const sources = [];
  const seenSources = new Set();

  const addQuery = (text) => {
    const key = text.toLowerCase();
    if (seenQueries.has(key)) return;
    seenQueries.add(key);
    queries.push(text);
  };

  const addSource = (source, queryText) => {
    const key = source.url;
    if (seenSources.has(key)) return;
    seenSources.add(key);
    sources.push({ ...source, queryText: queryText || null });
  };

  /**
   * @param {unknown} node
   * @param {number} depth
   * @param {string|null} inheritedQuery Nearest enclosing query, for attribution.
   */
  const walk = (node, depth, inheritedQuery) => {
    if (node === null || node === undefined || depth > config.maxDepth) return;

    if (Array.isArray(node)) {
      for (const child of node) walk(child, depth + 1, inheritedQuery);
      return;
    }
    if (typeof node !== 'object') return;

    // Does this object itself name a query? If so, its subtree is attributed to it.
    let localQuery = inheritedQuery;
    for (const key of Object.keys(node)) {
      if (!queryKeys.has(key)) continue;
      const value = node[key];
      if (Array.isArray(value)) {
        for (const entry of value) {
          const text = readQueryValue(entry, config);
          if (text) {
            addQuery(text);
            if (value.length === 1) localQuery = text;
          }
        }
      } else {
        const text = readQueryValue(value, config);
        if (text) {
          addQuery(text);
          localQuery = text;
        }
      }
    }

    // Is this object itself a search result?
    const source = readSource(node, config);
    if (source) addSource(source, localQuery);

    for (const key of Object.keys(node)) {
      walk(node[key], depth + 1, localQuery);
    }
  };

  walk(payload, 0, null);
  return { queries, sources };
}

/**
 * Walk deeply nested arrays (Google/Gemini batched RPC payloads) collecting
 * URL-and-title pairs and query-like strings adjacent to marker tokens.
 *
 * These payloads carry no field names at all, so shape scanning cannot apply —
 * position and value type are all there is to go on.
 *
 * @param {unknown} payload
 * @param {{queryMarkers?: string[], maxDepth?: number}} [options]
 * @param {Partial<typeof DEFAULT_HEURISTICS>} [heuristicOverrides]
 * @returns {{queries: string[], sources: Array<{url: string, title?: string, queryText: null}>}}
 */
export function mineArrays(payload, options, heuristicOverrides) {
  const config = { ...DEFAULT_HEURISTICS, ...(heuristicOverrides || {}) };
  const maxDepth = (options && options.maxDepth) || 30;
  const markers = new Set((options && options.queryMarkers) || []);

  /** @type {string[]} */
  const queries = [];
  const seenQueries = new Set();
  /** @type {Array<{url: string, title?: string, queryText: null}>} */
  const sources = [];
  const seenSources = new Set();

  const queryKeys = new Set(config.queryKeys.map((key) => key.toLowerCase()));

  const addQuery = (value) => {
    if (!looksLikeQuery(value, config)) return;
    const text = value.trim();
    const key = text.toLowerCase();
    if (seenQueries.has(key)) return;
    seenQueries.add(key);
    queries.push(text);
  };

  /**
   * A flat array of scalars is the unit of context: a URL's title is usually
   * its neighbor in the same array.
   * @param {unknown[]} array
   */
  const readFlatArray = (array) => {
    let markerSeen = false;

    for (let i = 0; i < array.length; i += 1) {
      const value = array[i];
      if (typeof value !== 'string') continue;

      // Positional payloads label their data instead of keying it: a field name
      // appears as a plain string element, followed by its value.
      if (queryKeys.has(value.toLowerCase())) {
        const labelled = array[i + 1];
        if (typeof labelled === 'string') addQuery(labelled);
        else if (Array.isArray(labelled)) {
          for (const entry of labelled) {
            if (typeof entry === 'string') addQuery(entry);
            else if (Array.isArray(entry) && typeof entry[0] === 'string') addQuery(entry[0]);
          }
        }
        continue;
      }

      if (markers.has(value)) {
        markerSeen = true;
        continue;
      }

      if (acceptableUrl(value, config)) {
        if (seenSources.has(value)) continue;
        seenSources.add(value);
        // Title: nearest neighboring string that isn't itself a URL.
        let title;
        for (const neighbor of [array[i + 1], array[i - 1], array[i + 2]]) {
          if (
            typeof neighbor === 'string' &&
            neighbor.trim() &&
            !/^https?:\/\//i.test(neighbor) &&
            neighbor.length <= MAX_SNIPPET
          ) {
            title = neighbor.trim();
            break;
          }
        }
        sources.push(title ? { url: value, title, queryText: null } : { url: value, queryText: null });
        continue;
      }

      // Queries: only trusted next to a marker token, otherwise these payloads
      // produce enormous amounts of prose noise.
      if (markerSeen) {
        addQuery(value);
        markerSeen = false;
      }
    }
  };

  /**
   * @param {unknown} node
   * @param {number} depth
   */
  const walk = (node, depth) => {
    if (node === null || node === undefined || depth > maxDepth) return;
    if (Array.isArray(node)) {
      readFlatArray(node);
      for (const child of node) walk(child, depth + 1);
      return;
    }
    if (typeof node === 'object') {
      for (const key of Object.keys(node)) walk(node[key], depth + 1);
    }
  };

  walk(payload, 0);
  return { queries, sources };
}
