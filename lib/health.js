/**
 * FANOUT_QUERIES — health monitor and self-healing state machine.
 *
 * The premise: a site changing its internals is normal, not exceptional. What
 * matters is noticing quickly and routing around it.
 *
 * Signals in:
 *   turn-observed        the user asked something (from the relay)
 *   extraction result    a strategy produced data
 *
 * Decisions out:
 *   demotion   a strategy that keeps missing while others succeed drops in the
 *              order — it still runs, but stops being reported as active
 *   status     green / yellow / red per site, shown as LEDs in the panel
 *   escalation red (or persistent yellow) asks for a rules refetch, which is
 *              how the fallback layers hand off to the remote-config repair path
 *
 * Every function here is pure: state in, state out. That keeps the transitions
 * testable without a browser, which matters because these are exactly the paths
 * that only fire when something has already gone wrong.
 */

/** Misses in a row before the head strategy is demoted. */
export const DEMOTE_AFTER_MISSES = 3;
/** How long a demoted strategy stays demoted before it can be promoted back. */
export const DEMOTION_MS = 30 * 60 * 1000;
/** Turns with no capture at all before a site goes red. */
export const RED_AFTER_UNCAPTURED = 3;
/** How long a turn stays open for a result to land against it. */
export const TURN_WINDOW_MS = 20 * 1000;
/** Consecutive turns in yellow before escalating to a rules refetch. */
export const ESCALATE_AFTER_YELLOW_TURNS = 5;

const ALL_STRATEGIES = ['network', 'dom', 'heuristic'];

/**
 * @param {string[]} [order]
 * @returns {import('./types.js').SiteHealth}
 */
export function createSiteHealth(order) {
  /** @type {Record<string, import('./types.js').StrategyHealth>} */
  const strategies = {};
  for (const name of ALL_STRATEGIES) {
    strategies[name] = { lastSuccess: 0, successCount: 0, missStreak: 0, demotedUntil: 0 };
  }
  return {
    status: 'idle',
    activeOrder: order && order.length ? [...order] : [...ALL_STRATEGIES],
    strategies,
    turnsObserved: 0,
    turnsCaptured: 0,
    uncapturedStreak: 0,
    yellowTurns: 0,
    lastTurnAt: 0,
    lastCaptureAt: 0,
    /** When the turn currently being judged began; 0 when none is open. */
    openTurnAt: 0,
    /** Whether any strategy has delivered for the open turn. */
    openTurnCredited: false,
    /** Which strategies delivered for the open turn. */
    openTurnStrategies: [],
  };
}

/**
 * @param {object} health Root health record.
 * @param {string} siteId
 * @param {string[]} [order] Default order from the rules file.
 * @returns {import('./types.js').SiteHealth}
 */
export function siteHealth(health, siteId, order) {
  if (!health.sites) health.sites = {};
  if (!health.sites[siteId]) health.sites[siteId] = createSiteHealth(order);
  return health.sites[siteId];
}

/** @returns {object} an empty health root */
export function createHealth() {
  return { sites: {} };
}

/**
 * Record that the user asked something.
 *
 * If the previous turn never produced a capture, it is charged as a miss
 * against whichever strategy was leading — that is the signal that the site
 * changed under us.
 *
 * @param {import('./types.js').SiteHealth} site
 * @param {number} now
 */
export function recordTurn(site, now) {
  closeOpenTurn(site, now);

  site.turnsObserved += 1;
  site.lastTurnAt = now;
  site.openTurnAt = now;
  site.openTurnCredited = false;
  site.openTurnStrategies = [];
  recomputeStatus(site, now);
}

/**
 * Finalize the open turn and judge the strategies against it.
 *
 * Two distinct failures are charged here:
 *   - nothing captured at all: a miss, and the streak that drives red
 *   - captured, but not by the preferred strategy: still a miss for that
 *     strategy, which is what lets a broken network layer demote itself even
 *     while DOM scraping quietly covers for it
 *
 * @param {import('./types.js').SiteHealth} site
 * @param {number} now
 * @returns {boolean} whether a turn was closed
 */
function closeOpenTurn(site, now) {
  if (!site.openTurnAt) return false;

  const head = site.activeOrder[0];
  const delivered = site.openTurnStrategies || [];

  if (!site.openTurnCredited) {
    site.uncapturedStreak += 1;
    if (head && site.strategies[head]) site.strategies[head].missStreak += 1;
  } else if (head && !delivered.includes(head) && site.strategies[head]) {
    site.strategies[head].missStreak += 1;
  }

  site.openTurnAt = 0;
  site.openTurnCredited = false;
  site.openTurnStrategies = [];

  maybeDemote(site, now);
  return true;
}

/**
 * Record that a strategy produced data.
 * @param {import('./types.js').SiteHealth} site
 * @param {'network'|'dom'|'heuristic'} strategy
 * @param {number} now
 */
export function recordSuccess(site, strategy, now) {
  const entry = site.strategies[strategy];
  if (entry) {
    entry.lastSuccess = now;
    entry.successCount += 1;
    entry.missStreak = 0;
  }

  site.lastCaptureAt = now;
  site.uncapturedStreak = 0;

  if (site.openTurnAt) {
    if (!site.openTurnCredited) {
      site.turnsCaptured += 1;
      site.openTurnCredited = true;
    }
    // The turn stays open until it is judged, so a later result from the
    // preferred strategy still counts toward this turn.
    if (!site.openTurnStrategies.includes(strategy)) site.openTurnStrategies.push(strategy);
  }

  maybePromote(site, strategy, now);
  recomputeStatus(site, now);
}

/**
 * Demote a persistently missing head strategy behind the next one.
 *
 * Demotion changes precedence and reporting, never execution: every strategy
 * keeps running, because they are cheap next to the network I/O that produced
 * the payload and results dedupe anyway. What demotion buys is an accurate
 * answer to "which layer is actually holding this site up right now".
 *
 * @param {import('./types.js').SiteHealth} site
 * @param {number} now
 */
function maybeDemote(site, now) {
  const head = site.activeOrder[0];
  if (!head || site.activeOrder.length < 2) return;

  const entry = site.strategies[head];
  if (!entry || entry.missStreak < DEMOTE_AFTER_MISSES) return;

  entry.demotedUntil = now + DEMOTION_MS;
  site.activeOrder = [...site.activeOrder.slice(1), head];
}

/**
 * Restore a recovered strategy to the front once its demotion has expired.
 * @param {import('./types.js').SiteHealth} site
 * @param {string} strategy
 * @param {number} now
 */
function maybePromote(site, strategy, now) {
  const entry = site.strategies[strategy];
  if (!entry) return;

  const position = site.activeOrder.indexOf(strategy);
  if (position <= 0) return; // absent, or already leading

  // Only a previously demoted strategy is restored. A fallback that happens to
  // succeed must not leapfrog the preferred layer — otherwise DOM scraping
  // quietly becomes "the active strategy" the first time it beats the network
  // layer to a result, and a genuinely broken site would never look degraded.
  if (!entry.demotedUntil) return;

  // Still serving its demotion — succeeding does not jump the queue.
  if (entry.demotedUntil > now) return;

  entry.demotedUntil = 0;
  site.activeOrder = [strategy, ...site.activeOrder.filter((name) => name !== strategy)];
}

/**
 * Recompute the traffic light.
 * @param {import('./types.js').SiteHealth} site
 * @param {number} now
 */
function recomputeStatus(site, now) {
  const previous = site.status;

  if (!site.turnsObserved && !site.lastCaptureAt) {
    site.status = 'idle';
  } else if (site.uncapturedStreak >= RED_AFTER_UNCAPTURED) {
    site.status = 'red';
  } else if (site.uncapturedStreak > 0) {
    site.status = 'yellow';
  } else if (site.activeOrder[0] !== 'network' && site.strategies.network.demotedUntil > now) {
    // Running on a fallback layer: capture works, but not the way it should.
    site.status = 'yellow';
  } else {
    site.status = 'green';
  }

  site.yellowTurns = site.status === 'yellow' ? (previous === 'yellow' ? site.yellowTurns + 1 : 1) : 0;
}

/**
 * Expire an open turn whose window has passed, so a site that stops responding
 * degrades even when the user never asks again.
 * @param {import('./types.js').SiteHealth} site
 * @param {number} now
 * @returns {boolean} whether anything changed
 */
export function expireOpenTurn(site, now) {
  if (!site.openTurnAt) return false;
  if (now - site.openTurnAt < TURN_WINDOW_MS) return false;

  closeOpenTurn(site, now);
  recomputeStatus(site, now);
  return true;
}

/**
 * Should this site's trouble trigger a rules refetch?
 *
 * This is the seam between the two self-healing mechanisms: the layered
 * fallbacks keep capture alive, and when they can't, the remote rules are
 * asked for a repair.
 *
 * @param {import('./types.js').SiteHealth} site
 * @returns {boolean}
 */
export function shouldEscalate(site) {
  if (site.status === 'red') return true;
  return site.status === 'yellow' && site.yellowTurns >= ESCALATE_AFTER_YELLOW_TURNS;
}

/**
 * Give freshly applied rules a clean trial: clear the miss counters and
 * demotions that the old, broken rules earned.
 * @param {import('./types.js').SiteHealth} site
 * @param {string[]} [order] Strategy order from the new rules.
 */
export function resetForNewRules(site, order) {
  for (const entry of Object.values(site.strategies)) {
    entry.missStreak = 0;
    entry.demotedUntil = 0;
  }
  site.uncapturedStreak = 0;
  site.yellowTurns = 0;
  site.openTurnAt = 0;
  site.openTurnCredited = false;
  site.openTurnStrategies = [];
  if (order && order.length) site.activeOrder = [...order];
  site.status = site.lastCaptureAt ? 'green' : 'idle';
}
