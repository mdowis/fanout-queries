import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createHealth,
  createSiteHealth,
  siteHealth,
  recordTurn,
  recordSuccess,
  expireOpenTurn,
  shouldEscalate,
  resetForNewRules,
  DEMOTE_AFTER_MISSES,
  DEMOTION_MS,
  RED_AFTER_UNCAPTURED,
  TURN_WINDOW_MS,
  ESCALATE_AFTER_YELLOW_TURNS,
} from '../lib/health.js';

const T0 = Date.UTC(2026, 7, 14, 12, 0, 0);

/** Ask a question and get nothing back. */
function missedTurn(site, at) {
  recordTurn(site, at);
  expireOpenTurn(site, at + TURN_WINDOW_MS + 1);
}

/** Ask a question and capture something. The turn is then judged. */
function capturedTurn(site, at, strategy = 'network') {
  recordTurn(site, at);
  recordSuccess(site, strategy, at + 100);
  expireOpenTurn(site, at + TURN_WINDOW_MS + 1);
}

test('a fresh site is idle', () => {
  const site = createSiteHealth();
  assert.equal(site.status, 'idle');
  assert.deepEqual(site.activeOrder, ['network', 'dom', 'heuristic']);
});

test('the rules supply the starting strategy order', () => {
  const site = createSiteHealth(['dom', 'network', 'heuristic']);
  assert.deepEqual(site.activeOrder, ['dom', 'network', 'heuristic']);
});

test('siteHealth creates a record on first use and reuses it after', () => {
  const health = createHealth();
  const first = siteHealth(health, 'chatgpt');
  first.turnsObserved = 5;
  assert.equal(siteHealth(health, 'chatgpt').turnsObserved, 5);
});

test('a captured turn turns the site green', () => {
  const site = createSiteHealth();
  capturedTurn(site, T0);

  assert.equal(site.status, 'green');
  assert.equal(site.turnsCaptured, 1);
  assert.equal(site.strategies.network.successCount, 1);
  assert.equal(site.uncapturedStreak, 0);
});

test('one missed turn goes yellow, three go red', () => {
  const site = createSiteHealth();

  missedTurn(site, T0);
  assert.equal(site.status, 'yellow');

  missedTurn(site, T0 + 60_000);
  assert.equal(site.status, 'yellow');

  missedTurn(site, T0 + 120_000);
  assert.equal(site.status, 'red');
  assert.equal(site.uncapturedStreak, RED_AFTER_UNCAPTURED);
});

test('a turn still inside its window is not yet a miss', () => {
  const site = createSiteHealth();
  recordTurn(site, T0);

  assert.equal(expireOpenTurn(site, T0 + TURN_WINDOW_MS - 1), false);
  assert.equal(site.uncapturedStreak, 0);
});

test('a new turn charges the previous unanswered one as a miss', () => {
  const site = createSiteHealth();
  recordTurn(site, T0);
  recordTurn(site, T0 + 5_000);

  assert.equal(site.uncapturedStreak, 1, 'the user moved on without a capture');
  assert.equal(site.strategies.network.missStreak, 1);
});

test('a capture clears the miss streak and restores green', () => {
  const site = createSiteHealth();
  missedTurn(site, T0);
  missedTurn(site, T0 + 60_000);
  assert.equal(site.status, 'yellow');

  capturedTurn(site, T0 + 120_000);
  assert.equal(site.status, 'green');
  assert.equal(site.uncapturedStreak, 0);
  assert.equal(site.strategies.network.missStreak, 0);
});

// ------------------------------------------------------------- demotion ---

test('the head strategy is demoted after repeated misses', () => {
  const site = createSiteHealth();
  for (let i = 0; i < DEMOTE_AFTER_MISSES; i += 1) missedTurn(site, T0 + i * 60_000);

  assert.deepEqual(site.activeOrder, ['dom', 'heuristic', 'network']);
  assert.ok(site.strategies.network.demotedUntil > T0, 'demotion has an expiry');
});

test('demotion needs a fallback to demote to', () => {
  const site = createSiteHealth(['network']);
  for (let i = 0; i < DEMOTE_AFTER_MISSES + 2; i += 1) missedTurn(site, T0 + i * 60_000);

  assert.deepEqual(site.activeOrder, ['network'], 'a lone strategy stays put');
});

test('a demoted strategy is not promoted back while serving its demotion', () => {
  const site = createSiteHealth();
  for (let i = 0; i < DEMOTE_AFTER_MISSES; i += 1) missedTurn(site, T0 + i * 60_000);

  const soon = T0 + DEMOTE_AFTER_MISSES * 60_000 + 1000;
  recordTurn(site, soon);
  recordSuccess(site, 'network', soon + 100);

  assert.equal(site.activeOrder[0], 'dom', 'still demoted');
  assert.equal(site.strategies.network.missStreak, 0, 'but the miss streak is cleared');
});

test('a recovered strategy is promoted once its demotion expires', () => {
  const site = createSiteHealth();
  for (let i = 0; i < DEMOTE_AFTER_MISSES; i += 1) missedTurn(site, T0 + i * 60_000);
  assert.equal(site.activeOrder[0], 'dom');

  const later = T0 + DEMOTION_MS + 60 * 60_000;
  recordTurn(site, later);
  recordSuccess(site, 'network', later + 100);

  assert.deepEqual(site.activeOrder, ['network', 'dom', 'heuristic']);
  assert.equal(site.status, 'green');
});

test('running on a fallback layer reads as yellow, not green', () => {
  const site = createSiteHealth();
  for (let i = 0; i < DEMOTE_AFTER_MISSES; i += 1) missedTurn(site, T0 + i * 60_000);

  // The DOM layer picks up the slack while network is still demoted.
  const at = T0 + DEMOTE_AFTER_MISSES * 60_000 + 1000;
  recordTurn(site, at);
  recordSuccess(site, 'dom', at + 100);

  assert.equal(site.status, 'yellow', 'capture works, but not the way it should');
  assert.equal(site.activeOrder[0], 'dom');
});

test('a fallback covering for the head still charges the head a miss', () => {
  const site = createSiteHealth();
  // Network extraction is dead, but DOM scraping keeps capturing.
  capturedTurn(site, T0, 'dom');

  assert.equal(site.strategies.network.missStreak, 1, 'the preferred layer did not deliver');
  assert.equal(site.strategies.dom.successCount, 1);
  assert.equal(site.uncapturedStreak, 0, 'but the turn was still captured');
});

test('a broken head demotes even while a fallback covers for it', () => {
  const site = createSiteHealth();
  let at = T0;
  for (let i = 0; i < DEMOTE_AFTER_MISSES; i += 1, at += 60_000) capturedTurn(site, at, 'dom');

  assert.deepEqual(site.activeOrder, ['dom', 'heuristic', 'network']);
  assert.equal(site.status, 'yellow', 'capture never stopped, but it is running degraded');
});

test('a late result from the head strategy still counts for that turn', () => {
  const site = createSiteHealth();
  recordTurn(site, T0);
  recordSuccess(site, 'dom', T0 + 100);
  recordSuccess(site, 'network', T0 + 2000);
  expireOpenTurn(site, T0 + TURN_WINDOW_MS + 1);

  assert.equal(site.strategies.network.missStreak, 0, 'the head did deliver, just later');
});

test('misses are charged to whichever strategy currently leads', () => {
  const site = createSiteHealth();
  for (let i = 0; i < DEMOTE_AFTER_MISSES; i += 1) missedTurn(site, T0 + i * 60_000);
  assert.equal(site.activeOrder[0], 'dom');

  missedTurn(site, T0 + 10 * 60_000);
  assert.equal(site.strategies.dom.missStreak, 1, 'the new head takes the blame');
});

// ----------------------------------------------------------- escalation ---

test('red escalates to a rules refetch', () => {
  const site = createSiteHealth();
  for (let i = 0; i < RED_AFTER_UNCAPTURED; i += 1) missedTurn(site, T0 + i * 60_000);

  assert.equal(site.status, 'red');
  assert.ok(shouldEscalate(site));
});

test('green never escalates', () => {
  const site = createSiteHealth();
  capturedTurn(site, T0);
  assert.equal(shouldEscalate(site), false);
});

test('a brief yellow does not escalate', () => {
  const site = createSiteHealth();
  missedTurn(site, T0);
  assert.equal(site.status, 'yellow');
  assert.equal(shouldEscalate(site), false);
});

test('persistent yellow escalates once it has run long enough', () => {
  const site = createSiteHealth();
  // Demote network so the site sits in fallback-yellow while still capturing.
  for (let i = 0; i < DEMOTE_AFTER_MISSES; i += 1) missedTurn(site, T0 + i * 60_000);

  let at = T0 + DEMOTE_AFTER_MISSES * 60_000;
  for (let i = 0; i < ESCALATE_AFTER_YELLOW_TURNS; i += 1) {
    at += 60_000;
    recordTurn(site, at);
    recordSuccess(site, 'dom', at + 100);
  }

  assert.equal(site.status, 'yellow');
  assert.ok(site.yellowTurns >= ESCALATE_AFTER_YELLOW_TURNS);
  assert.ok(shouldEscalate(site));
});

test('recovering to green resets the yellow run', () => {
  const site = createSiteHealth();
  missedTurn(site, T0);
  assert.equal(site.yellowTurns, 1);

  capturedTurn(site, T0 + 60_000);
  assert.equal(site.yellowTurns, 0);
});

// -------------------------------------------------------- rules refresh ---

test('new rules get a clean trial', () => {
  const site = createSiteHealth();
  for (let i = 0; i < RED_AFTER_UNCAPTURED; i += 1) missedTurn(site, T0 + i * 60_000);
  assert.equal(site.status, 'red');

  resetForNewRules(site, ['network', 'dom', 'heuristic']);

  assert.deepEqual(site.activeOrder, ['network', 'dom', 'heuristic'], 'demotions cleared');
  assert.equal(site.strategies.network.missStreak, 0);
  assert.equal(site.strategies.network.demotedUntil, 0);
  assert.equal(site.uncapturedStreak, 0);
  assert.equal(shouldEscalate(site), false, 'no immediate re-escalation');
});

test('a site that never captured stays idle after a rules reset', () => {
  const site = createSiteHealth();
  missedTurn(site, T0);
  resetForNewRules(site);
  assert.equal(site.status, 'idle');
});

test('a site that had captured returns to green after a rules reset', () => {
  const site = createSiteHealth();
  capturedTurn(site, T0);
  for (let i = 1; i <= RED_AFTER_UNCAPTURED; i += 1) missedTurn(site, T0 + i * 60_000);
  assert.equal(site.status, 'red');

  resetForNewRules(site);
  assert.equal(site.status, 'green');
});

// ------------------------------------------------------ full drift story ---

test('end to end: a site breaks, falls back, then is repaired by new rules', () => {
  const site = createSiteHealth();
  let at = T0;

  // Healthy: network extraction is doing the work.
  for (let i = 0; i < 3; i += 1, at += 60_000) capturedTurn(site, at, 'network');
  assert.equal(site.status, 'green');
  assert.equal(site.activeOrder[0], 'network');

  // The site ships a change and network extraction stops finding anything.
  for (let i = 0; i < DEMOTE_AFTER_MISSES; i += 1, at += 60_000) missedTurn(site, at);
  assert.equal(site.status, 'red', 'the break is visible');
  assert.equal(site.activeOrder[0], 'dom', 'and routed around');
  assert.ok(shouldEscalate(site), 'and a rules repair is requested');

  // DOM scraping keeps capture alive on the degraded path.
  at += 60_000;
  capturedTurn(site, at, 'dom');
  assert.equal(site.status, 'yellow', 'capturing again, but on a fallback');

  // A rules push lands and network extraction works once more.
  resetForNewRules(site, ['network', 'dom', 'heuristic']);
  at += 60_000;
  capturedTurn(site, at, 'network');

  assert.equal(site.status, 'green', 'fully recovered');
  assert.equal(site.activeOrder[0], 'network');
});
