/**
 * FANOUT_QUERIES — session assembly.
 *
 * Pure functions that fold extraction results into sessions and turns. Keeping
 * this free of chrome APIs means the merge rules — deduping, attribution, turn
 * boundaries — are directly testable, which matters because they are where
 * captured data is most easily lost.
 */

import { STRATEGY_CONFIDENCE } from './types.js';

/** A turn goes stale after this much silence; the next capture opens a new one. */
export const TURN_IDLE_MS = 60 * 1000;

/** Query strings are compared with this normalization applied. */
export function normalizeQuery(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * Canonicalize a URL for dedupe: drop tracking parameters and the fragment.
 * @param {string} url
 * @returns {string}
 */
export function canonicalizeUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    const drop = [];
    for (const key of parsed.searchParams.keys()) {
      if (/^(utm_|ref$|referrer$|fbclid$|gclid$|igshid$|mc_[ce]id$|_ga$)/i.test(key)) {
        drop.push(key);
      }
    }
    for (const key of drop) parsed.searchParams.delete(key);
    // Trailing slash on a bare origin is noise, but a real path keeps its shape.
    let out = parsed.toString();
    if (parsed.pathname === '/' && !parsed.search) out = out.replace(/\/$/, '');
    return out;
  } catch (_) {
    return String(url || '');
  }
}

/**
 * @param {{siteId: string, conversationKey?: string|null, tabUrl?: string, tabId?: number, now?: number}} options
 * @returns {import('./types.js').Session}
 */
export function createSession(options) {
  const now = options.now ?? Date.now();
  const key = options.conversationKey || `tab${options.tabId ?? 0}:${now}`;
  return {
    id: `${options.siteId}:${key}`,
    siteId: options.siteId,
    tabUrl: options.tabUrl || '',
    startedAt: now,
    updatedAt: now,
    turns: [],
  };
}

/**
 * @param {import('./types.js').Session} session
 * @returns {import('./types.js').Turn|null}
 */
export function currentTurn(session) {
  const turns = session.turns || [];
  return turns.length ? turns[turns.length - 1] : null;
}

/**
 * Open a new turn on a session.
 * @param {import('./types.js').Session} session
 * @param {{prompt?: string|null, strategy?: string|null, now?: number}} [options]
 * @returns {import('./types.js').Turn}
 */
export function openTurn(session, options = {}) {
  const now = options.now ?? Date.now();
  const turn = {
    id: `t${now.toString(36)}${(session.turns.length + 1).toString(36)}`,
    prompt: options.prompt || null,
    promptStrategy: options.prompt ? options.strategy || null : null,
    ts: now,
    queries: [],
    sources: [],
    strategiesUsed: [],
  };
  session.turns.push(turn);
  session.updatedAt = now;
  return turn;
}

/**
 * Decide which turn a result belongs to, opening one when needed.
 *
 * A result starts a new turn when it carries a prompt different from the
 * current turn's, or when the current turn has been idle past TURN_IDLE_MS.
 *
 * @param {import('./types.js').Session} session
 * @param {import('./types.js').ExtractionResult} result
 * @param {number} now
 * @returns {import('./types.js').Turn}
 */
function turnForResult(session, result, now) {
  const turn = currentTurn(session);

  if (!turn) {
    return openTurn(session, { prompt: result.prompt, strategy: result.strategy, now });
  }

  if (result.prompt) {
    if (!turn.prompt) {
      // Backfill: the prompt often arrives after the first queries.
      turn.prompt = result.prompt;
      turn.promptStrategy = result.strategy;
      return turn;
    }
    if (normalizeQuery(turn.prompt) !== normalizeQuery(result.prompt)) {
      return openTurn(session, { prompt: result.prompt, strategy: result.strategy, now });
    }
    return turn;
  }

  if (now - turn.ts > TURN_IDLE_MS && (turn.queries.length || turn.sources.length)) {
    return openTurn(session, { now });
  }

  return turn;
}

/**
 * Fold an extraction result into a session.
 *
 * Deduping keeps the highest-confidence copy of each query, so a later network
 * hit upgrades an earlier heuristic guess rather than duplicating it.
 *
 * @param {import('./types.js').Session} session
 * @param {import('./types.js').ExtractionResult} result
 * @param {{now?: number}} [options]
 * @returns {{turn: import('./types.js').Turn, addedQueries: number, addedSources: number,
 *            promptSet: boolean, changed: boolean}}
 */
export function mergeResult(session, result, options = {}) {
  const now = options.now ?? Date.now();

  const priorTurn = currentTurn(session);
  const priorPrompt = priorTurn ? priorTurn.prompt : null;
  const turn = turnForResult(session, result, now);
  const promptSet = turn !== priorTurn || turn.prompt !== priorPrompt;

  let addedQueries = 0;
  let addedSources = 0;

  for (const query of result.queries || []) {
    const key = normalizeQuery(query.text);
    if (!key) continue;
    const existing = turn.queries.find((entry) => normalizeQuery(entry.text) === key);
    if (existing) {
      const incoming = query.confidence ?? STRATEGY_CONFIDENCE[query.strategy] ?? 0;
      if (incoming > (existing.confidence ?? 0)) {
        existing.strategy = query.strategy;
        existing.confidence = incoming;
      }
      continue;
    }
    turn.queries.push({
      text: query.text,
      ts: query.ts || now,
      strategy: query.strategy,
      confidence: query.confidence ?? STRATEGY_CONFIDENCE[query.strategy] ?? 0,
    });
    addedQueries += 1;
  }

  for (const source of result.sources || []) {
    const canonical = canonicalizeUrl(source.url);
    if (!canonical) continue;
    const existing = turn.sources.find((entry) => canonicalizeUrl(entry.url) === canonical);
    if (existing) {
      // Fill gaps from a later, richer copy rather than duplicating the row.
      if (!existing.title && source.title) existing.title = source.title;
      if (!existing.snippet && source.snippet) existing.snippet = source.snippet;
      if (!existing.queryText && source.queryText) existing.queryText = source.queryText;
      continue;
    }
    // Normalize the stored shape so consumers never see a missing field.
    turn.sources.push({ ...source, url: canonical, queryText: source.queryText || null });
    addedSources += 1;
  }

  if (result.strategy && !turn.strategiesUsed.includes(result.strategy)) {
    turn.strategiesUsed.push(result.strategy);
  }

  if (addedQueries || addedSources) {
    turn.ts = Math.max(turn.ts, now);
  }
  session.updatedAt = now;

  return {
    turn,
    addedQueries,
    addedSources,
    promptSet,
    changed: Boolean(addedQueries || addedSources || promptSet),
  };
}

/**
 * Attribute sources to queries after the fact.
 *
 * When a turn ran exactly one query, every source it found belongs to that
 * query — a safe inference that recovers attribution most payloads omit.
 * @param {import('./types.js').Turn} turn
 */
export function inferAttribution(turn) {
  if (!turn || turn.queries.length !== 1) return;
  const only = turn.queries[0].text;
  for (const source of turn.sources) {
    if (!source.queryText) source.queryText = only;
  }
}
