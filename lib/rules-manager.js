/**
 * FANOUT_QUERIES — extraction rules loading.
 *
 * Rules resolve in precedence order: remote (cached) if valid and newer,
 * otherwise the copy bundled with the extension. A bad remote push must never
 * be able to disable capture, so validation is strict and failure is silent —
 * the bundled rules simply stay in force.
 */

const CACHE_KEY = 'rules:cache';
const META_KEY = 'rules:meta';
const BUNDLED_PATH = 'rules/default-rules.json';

/** Fetches no more often than this, however many failures escalate. */
const MIN_REFETCH_INTERVAL_MS = 30 * 60 * 1000;

/**
 * Validate a rules document well enough to trust it.
 * @param {unknown} rules
 * @returns {rules is object}
 */
export function isValidRules(rules) {
  if (!rules || typeof rules !== 'object') return false;
  if (rules.schemaVersion !== 1) return false;
  if (typeof rules.version !== 'number') return false;
  if (!rules.sites || typeof rules.sites !== 'object') return false;

  for (const site of Object.values(rules.sites)) {
    if (!site || typeof site !== 'object') return false;
    if (!Array.isArray(site.hosts) || !site.hosts.length) return false;
  }
  return true;
}

/**
 * Read the copy bundled with the extension.
 * @returns {Promise<object>}
 */
export async function loadBundledRules() {
  const response = await fetch(chrome.runtime.getURL(BUNDLED_PATH));
  return response.json();
}

/**
 * Every URL substring the interceptor should watch, across all sites.
 * @param {object} rules
 * @returns {string[]}
 */
export function collectUrlPatterns(rules) {
  const patterns = new Set();
  for (const site of Object.values(rules.sites || {})) {
    for (const endpoint of (site.network && site.network.endpoints) || []) {
      if (endpoint && typeof endpoint.urlPattern === 'string') patterns.add(endpoint.urlPattern);
    }
  }
  return [...patterns];
}

/**
 * Find the site whose hosts match a hostname.
 * @param {object} rules
 * @param {string} hostname
 * @returns {{siteId: string, site: object}|null}
 */
export function siteForHostname(rules, hostname) {
  if (!hostname) return null;
  for (const [siteId, site] of Object.entries(rules.sites || {})) {
    for (const host of site.hosts || []) {
      if (hostname === host || hostname.endsWith(`.${host}`)) return { siteId, site };
    }
  }
  return null;
}

/**
 * Resolve the rules in force: cached remote if it is valid and at least as new
 * as the bundled copy, otherwise bundled.
 * @returns {Promise<{rules: object, source: 'remote'|'bundled'}>}
 */
export async function resolveRules() {
  const bundled = await loadBundledRules();

  let cached = null;
  try {
    const stored = await chrome.storage.local.get(CACHE_KEY);
    cached = stored[CACHE_KEY] || null;
  } catch (_) {
    cached = null;
  }

  if (isValidRules(cached) && cached.version >= bundled.version) {
    return { rules: cached, source: 'remote' };
  }
  return { rules: bundled, source: 'bundled' };
}

/**
 * Read rules metadata (last fetch time, version, last error).
 * @returns {Promise<object>}
 */
export async function readMeta() {
  const stored = await chrome.storage.local.get(META_KEY);
  return (
    stored[META_KEY] || {
      source: 'bundled',
      version: null,
      fetchedAt: 0,
      lastAttemptAt: 0,
      lastError: null,
    }
  );
}

async function writeMeta(patch) {
  const meta = await readMeta();
  const next = { ...meta, ...patch };
  await chrome.storage.local.set({ [META_KEY]: next });
  return next;
}

/**
 * Fetch remote rules and cache them when they are valid and newer.
 *
 * @param {object} currentRules Rules currently in force (supplies the fetch URL).
 * @param {{force?: boolean}} [options] `force` bypasses the interval floor but
 *   never the hard throttle — repeated red-health escalations must not hammer
 *   the network.
 * @returns {Promise<{updated: boolean, reason: string, version?: number}>}
 */
export async function refetchRules(currentRules, options = {}) {
  const url = currentRules && currentRules.fetch && currentRules.fetch.url;
  if (!url) return { updated: false, reason: 'no-fetch-url' };

  const meta = await readMeta();
  const now = Date.now();
  const sinceAttempt = now - (meta.lastAttemptAt || 0);

  if (!options.force) {
    const intervalMs =
      ((currentRules.fetch && currentRules.fetch.intervalHours) || 6) * 60 * 60 * 1000;
    if (sinceAttempt < intervalMs) return { updated: false, reason: 'too-soon' };
  } else if (sinceAttempt < MIN_REFETCH_INTERVAL_MS) {
    return { updated: false, reason: 'throttled' };
  }

  await writeMeta({ lastAttemptAt: now });

  let fetched;
  try {
    const response = await fetch(url, { cache: 'no-cache' });
    if (!response.ok) {
      await writeMeta({ lastError: `http ${response.status}` });
      return { updated: false, reason: `http-${response.status}` };
    }
    fetched = await response.json();
  } catch (err) {
    await writeMeta({ lastError: String(err && err.message ? err.message : err) });
    return { updated: false, reason: 'network-error' };
  }

  if (!isValidRules(fetched)) {
    await writeMeta({ lastError: 'invalid schema' });
    return { updated: false, reason: 'invalid' };
  }

  if (fetched.version <= (currentRules.version || 0)) {
    await writeMeta({ lastError: null, fetchedAt: now });
    return { updated: false, reason: 'not-newer', version: fetched.version };
  }

  await chrome.storage.local.set({ [CACHE_KEY]: fetched });
  await writeMeta({
    source: 'remote',
    version: fetched.version,
    fetchedAt: now,
    lastError: null,
  });
  return { updated: true, reason: 'updated', version: fetched.version };
}

/** Drop cached remote rules, reverting to the bundled copy. */
export async function clearCachedRules() {
  await chrome.storage.local.remove(CACHE_KEY);
  await writeMeta({ source: 'bundled', version: null, fetchedAt: 0, lastError: null });
}
