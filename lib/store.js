/**
 * FANOUT_QUERIES — persistence.
 *
 * chrome.storage.local rather than IndexedDB: sessions are small structured
 * text, the API is identical from the service worker and the side panel, and
 * it survives service-worker eviction with no rehydration ceremony.
 *
 * A ring buffer bounds growth — oldest sessions are pruned once either limit is
 * crossed, so capture never fills the user's quota.
 */

export const INDEX_KEY = 'sessions:index';
export const SESSION_PREFIX = 'session:';
export const HEALTH_KEY = 'health:v1';

/** Retention limits. */
export const MAX_SESSIONS = 200;
export const MAX_BYTES = 8 * 1024 * 1024;

/**
 * @param {string} id
 * @returns {string}
 */
export function sessionKey(id) {
  return `${SESSION_PREFIX}${id}`;
}

/**
 * Read the history index, newest first.
 * @returns {Promise<import('./types.js').SessionSummary[]>}
 */
export async function readIndex() {
  const stored = await chrome.storage.local.get(INDEX_KEY);
  const index = stored[INDEX_KEY];
  return Array.isArray(index) ? index : [];
}

/**
 * @param {import('./types.js').SessionSummary[]} index
 */
async function writeIndex(index) {
  await chrome.storage.local.set({ [INDEX_KEY]: index });
}

/**
 * @param {string} id
 * @returns {Promise<import('./types.js').Session|null>}
 */
export async function readSession(id) {
  const key = sessionKey(id);
  const stored = await chrome.storage.local.get(key);
  return stored[key] || null;
}

/**
 * @param {string[]} ids
 * @returns {Promise<import('./types.js').Session[]>}
 */
export async function readSessions(ids) {
  if (!ids.length) return [];
  const keys = ids.map(sessionKey);
  const stored = await chrome.storage.local.get(keys);
  return keys.map((key) => stored[key]).filter(Boolean);
}

/**
 * Read every stored session, newest first.
 * @returns {Promise<import('./types.js').Session[]>}
 */
export async function readAllSessions() {
  const index = await readIndex();
  return readSessions(index.map((entry) => entry.id));
}

/**
 * Build the index entry describing a session.
 * @param {import('./types.js').Session} session
 * @returns {import('./types.js').SessionSummary}
 */
export function summarize(session) {
  const turns = session.turns || [];
  const firstPrompt = turns.find((turn) => turn.prompt);
  return {
    id: session.id,
    siteId: session.siteId,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    turnCount: turns.length,
    queryCount: turns.reduce((total, turn) => total + (turn.queries || []).length, 0),
    firstPrompt: firstPrompt ? firstPrompt.prompt : null,
  };
}

/**
 * Persist a session and refresh its index entry, pruning if needed.
 * @param {import('./types.js').Session} session
 */
export async function writeSession(session) {
  await chrome.storage.local.set({ [sessionKey(session.id)]: session });

  const index = await readIndex();
  const summary = summarize(session);
  const existing = index.findIndex((entry) => entry.id === session.id);
  if (existing === -1) index.unshift(summary);
  else index[existing] = summary;

  index.sort((a, b) => b.updatedAt - a.updatedAt);
  await writeIndex(index);
  await prune(index);
}

/**
 * Enforce the retention limits.
 * @param {import('./types.js').SessionSummary[]} [knownIndex]
 */
export async function prune(knownIndex) {
  let index = knownIndex || (await readIndex());
  const doomed = [];

  if (index.length > MAX_SESSIONS) {
    doomed.push(...index.slice(MAX_SESSIONS).map((entry) => entry.id));
    index = index.slice(0, MAX_SESSIONS);
  }

  // Byte-based pruning is a second pass because it needs a real usage figure.
  if (typeof chrome.storage.local.getBytesInUse === 'function') {
    try {
      let used = await chrome.storage.local.getBytesInUse(null);
      while (used > MAX_BYTES && index.length > 1) {
        const oldest = index.pop();
        doomed.push(oldest.id);
        const size = await chrome.storage.local.getBytesInUse(sessionKey(oldest.id));
        used -= size;
      }
    } catch (_) {
      /* quota inspection unavailable — the count limit still applies */
    }
  }

  if (!doomed.length) return;
  await chrome.storage.local.remove(doomed.map(sessionKey));
  await writeIndex(index);
}

/**
 * Delete one session.
 * @param {string} id
 */
export async function deleteSession(id) {
  await chrome.storage.local.remove(sessionKey(id));
  const index = await readIndex();
  await writeIndex(index.filter((entry) => entry.id !== id));
}

/**
 * Read the health record.
 * @returns {Promise<object>}
 */
export async function readHealth() {
  const stored = await chrome.storage.local.get(HEALTH_KEY);
  const health = stored[HEALTH_KEY];
  return health && typeof health === 'object' ? health : { sites: {} };
}

/**
 * @param {object} health
 */
export async function writeHealth(health) {
  await chrome.storage.local.set({ [HEALTH_KEY]: health });
}

/** Delete every stored session, leaving health and rules intact. */
export async function clearSessions() {
  const index = await readIndex();
  const keys = index.map((entry) => sessionKey(entry.id));
  if (keys.length) await chrome.storage.local.remove(keys);
  await writeIndex([]);
}
