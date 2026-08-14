/**
 * FANOUT_QUERIES — shared type definitions.
 *
 * JSDoc-only module: no runtime exports beyond constants. Importing this gives
 * editors full IntelliSense without a TypeScript build step.
 */

/** Extraction strategy identifiers, in default precedence order. */
export const STRATEGIES = /** @type {const} */ (['network', 'dom', 'heuristic']);

/** Confidence assigned to each strategy; drives dedupe precedence. */
export const STRATEGY_CONFIDENCE = {
  network: 1.0,
  dom: 0.7,
  heuristic: 0.4,
};

/** Single-letter badges shown in the side panel. */
export const STRATEGY_BADGE = {
  network: 'N',
  dom: 'D',
  heuristic: 'H',
};

/**
 * A raw payload observed by the interceptor and relayed to the service worker.
 * @typedef {object} RawCapture
 * @property {string} id            Correlates chunks belonging to one request.
 * @property {string} url
 * @property {string} method
 * @property {'fetch'|'xhr'|'ws'} transport
 * @property {'request'|'chunk'|'end'} phase
 * @property {string} [body]        Text payload for request/chunk phases.
 * @property {number} [seq]         Chunk ordinal within the request.
 * @property {string|null} [contentType]
 * @property {number} ts
 */

/**
 * Structured data scraped from the page DOM by the relay (strategy layer 2).
 * @typedef {object} DomCapture
 * @property {string} siteId
 * @property {string} href
 * @property {string|null} prompt
 * @property {string[]} queries
 * @property {Array<{url: string, title?: string}>} sources
 * @property {number} ts
 */

/**
 * One fan-out query attributed to a turn.
 * @typedef {object} FanoutQuery
 * @property {string} text
 * @property {number} ts
 * @property {'network'|'dom'|'heuristic'} strategy
 * @property {number} confidence
 */

/**
 * A source cited by the assistant, ideally attributed to the query that found it.
 * @typedef {object} Source
 * @property {string} url
 * @property {string} [title]
 * @property {string} [snippet]
 * @property {string|null} [queryText]  Attribution, when the payload provides it.
 * @property {'network'|'dom'|'heuristic'} strategy
 */

/**
 * What an adapter returns for a single payload.
 * @typedef {object} ExtractionResult
 * @property {string} [prompt]
 * @property {FanoutQuery[]} queries
 * @property {Source[]} sources
 * @property {'network'|'dom'|'heuristic'} strategy
 * @property {number} confidence
 * @property {string} [conversationKey]
 */

/**
 * One prompt and everything the assistant searched and cited to answer it.
 * @typedef {object} Turn
 * @property {string} id
 * @property {string|null} prompt
 * @property {'network'|'dom'|'heuristic'|null} promptStrategy
 * @property {number} ts
 * @property {FanoutQuery[]} queries
 * @property {Source[]} sources
 * @property {string[]} strategiesUsed
 */

/**
 * A conversation's worth of turns on one site.
 * @typedef {object} Session
 * @property {string} id
 * @property {string} siteId
 * @property {string} tabUrl
 * @property {number} startedAt
 * @property {number} updatedAt
 * @property {Turn[]} turns
 */

/**
 * Compact session record kept in the history index.
 * @typedef {object} SessionSummary
 * @property {string} id
 * @property {string} siteId
 * @property {number} startedAt
 * @property {number} updatedAt
 * @property {number} turnCount
 * @property {number} queryCount
 * @property {string|null} firstPrompt
 */

/**
 * Per-strategy health counters used by the self-healing state machine.
 * @typedef {object} StrategyHealth
 * @property {number} lastSuccess
 * @property {number} successCount
 * @property {number} missStreak
 * @property {number} demotedUntil
 */

/**
 * @typedef {object} SiteHealth
 * @property {'green'|'yellow'|'red'|'idle'} status
 * @property {string[]} activeOrder
 * @property {Record<string, StrategyHealth>} strategies
 * @property {number} turnsObserved
 * @property {number} turnsCaptured
 * @property {number} uncapturedStreak
 * @property {number} lastTurnAt
 * @property {number} yellowSince
 */
