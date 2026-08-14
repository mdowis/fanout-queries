import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSession,
  openTurn,
  currentTurn,
  mergeResult,
  inferAttribution,
  canonicalizeUrl,
  normalizeQuery,
  TURN_IDLE_MS,
} from '../lib/sessions.js';

const T0 = Date.UTC(2026, 7, 14, 12, 0, 0);

function result(overrides = {}) {
  return {
    queries: [],
    sources: [],
    strategy: 'network',
    confidence: 1,
    ...overrides,
  };
}

function q(text, strategy = 'network', confidence = 1) {
  return { text, ts: T0, strategy, confidence };
}

test('session id prefers the conversation key', () => {
  const session = createSession({ siteId: 'claude', conversationKey: 'conv-9', now: T0 });
  assert.equal(session.id, 'claude:conv-9');
});

test('session id falls back to the tab when no conversation key exists', () => {
  const session = createSession({ siteId: 'google', tabId: 7, now: T0 });
  assert.equal(session.id, `google:tab7:${T0}`);
});

test('the first result opens a turn carrying the prompt', () => {
  const session = createSession({ siteId: 'claude', now: T0 });
  mergeResult(session, result({ prompt: 'why is the sky blue?', queries: [q('sky color')] }), {
    now: T0,
  });

  assert.equal(session.turns.length, 1);
  assert.equal(currentTurn(session).prompt, 'why is the sky blue?');
  assert.equal(currentTurn(session).promptStrategy, 'network');
});

test('a prompt arriving after the queries backfills the open turn', () => {
  const session = createSession({ siteId: 'claude', now: T0 });
  mergeResult(session, result({ queries: [q('sky color')] }), { now: T0 });
  mergeResult(session, result({ prompt: 'why is the sky blue?' }), { now: T0 + 100 });

  assert.equal(session.turns.length, 1, 'no second turn is opened');
  assert.equal(currentTurn(session).prompt, 'why is the sky blue?');
});

test('a different prompt opens a new turn', () => {
  const session = createSession({ siteId: 'claude', now: T0 });
  mergeResult(session, result({ prompt: 'first question', queries: [q('a')] }), { now: T0 });
  mergeResult(session, result({ prompt: 'second question', queries: [q('b')] }), { now: T0 + 500 });

  assert.equal(session.turns.length, 2);
  assert.deepEqual(session.turns.map((t) => t.prompt), ['first question', 'second question']);
});

test('the same prompt restated keeps the turn open', () => {
  const session = createSession({ siteId: 'claude', now: T0 });
  mergeResult(session, result({ prompt: 'same question', queries: [q('a')] }), { now: T0 });
  mergeResult(session, result({ prompt: '  SAME Question ', queries: [q('b')] }), { now: T0 + 10 });

  assert.equal(session.turns.length, 1);
  assert.equal(currentTurn(session).queries.length, 2);
});

test('a long silence opens a new turn even with no prompt', () => {
  const session = createSession({ siteId: 'claude', now: T0 });
  mergeResult(session, result({ queries: [q('early')] }), { now: T0 });
  mergeResult(session, result({ queries: [q('much later')] }), { now: T0 + TURN_IDLE_MS + 1 });

  assert.equal(session.turns.length, 2);
});

test('an empty turn is not split by silence', () => {
  const session = createSession({ siteId: 'claude', now: T0 });
  openTurn(session, { prompt: 'waiting', now: T0 });
  mergeResult(session, result({ queries: [q('late arrival')] }), { now: T0 + TURN_IDLE_MS + 1 });

  assert.equal(session.turns.length, 1, 'the pending turn receives the result');
});

test('repeated queries are deduplicated case- and whitespace-insensitively', () => {
  const session = createSession({ siteId: 'claude', now: T0 });
  mergeResult(session, result({ queries: [q('Tokyo  Weather'), q('tokyo weather')] }), { now: T0 });
  assert.equal(currentTurn(session).queries.length, 1);
});

test('a network hit upgrades an earlier heuristic guess in place', () => {
  const session = createSession({ siteId: 'claude', now: T0 });
  mergeResult(session, result({ queries: [q('tokyo weather', 'heuristic', 0.4)], strategy: 'heuristic' }), {
    now: T0,
  });
  mergeResult(session, result({ queries: [q('tokyo weather', 'network', 1)] }), { now: T0 + 10 });

  const queries = currentTurn(session).queries;
  assert.equal(queries.length, 1, 'not duplicated');
  assert.equal(queries[0].strategy, 'network', 'upgraded to the higher-confidence strategy');
  assert.equal(queries[0].confidence, 1);
});

test('a weaker later hit does not downgrade an existing query', () => {
  const session = createSession({ siteId: 'claude', now: T0 });
  mergeResult(session, result({ queries: [q('tokyo weather', 'network', 1)] }), { now: T0 });
  mergeResult(session, result({ queries: [q('tokyo weather', 'dom', 0.7)] }), { now: T0 + 10 });

  assert.equal(currentTurn(session).queries[0].strategy, 'network');
});

test('sources deduplicate by canonical URL and fill in missing fields', () => {
  const session = createSession({ siteId: 'claude', now: T0 });
  mergeResult(
    session,
    result({ sources: [{ url: 'https://example.com/a?utm_source=x', strategy: 'network' }] }),
    { now: T0 },
  );
  mergeResult(
    session,
    result({
      sources: [
        { url: 'https://example.com/a', title: 'Page A', queryText: 'a query', strategy: 'network' },
      ],
    }),
    { now: T0 + 10 },
  );

  const sources = currentTurn(session).sources;
  assert.equal(sources.length, 1, 'tracking parameters do not create a duplicate');
  assert.equal(sources[0].title, 'Page A', 'the richer copy fills the gap');
  assert.equal(sources[0].queryText, 'a query');
});

test('strategiesUsed records every layer that contributed', () => {
  const session = createSession({ siteId: 'claude', now: T0 });
  mergeResult(session, result({ queries: [q('a')], strategy: 'network' }), { now: T0 });
  mergeResult(session, result({ queries: [q('b')], strategy: 'dom' }), { now: T0 + 5 });
  mergeResult(session, result({ queries: [q('c')], strategy: 'dom' }), { now: T0 + 6 });

  assert.deepEqual(currentTurn(session).strategiesUsed, ['network', 'dom']);
});

test('merging reports what was actually added', () => {
  const session = createSession({ siteId: 'claude', now: T0 });
  const first = mergeResult(session, result({ queries: [q('a')], sources: [{ url: 'https://x.example/1', strategy: 'network' }] }), { now: T0 });
  assert.deepEqual([first.addedQueries, first.addedSources], [1, 1]);

  const second = mergeResult(session, result({ queries: [q('a')] }), { now: T0 + 1 });
  assert.deepEqual([second.addedQueries, second.addedSources], [0, 0]);
});

test('single-query turns attribute their sources to that query', () => {
  const session = createSession({ siteId: 'claude', now: T0 });
  mergeResult(
    session,
    result({
      queries: [q('only query')],
      sources: [
        { url: 'https://a.example/1', strategy: 'network' },
        { url: 'https://b.example/2', strategy: 'network', queryText: 'explicit' },
      ],
    }),
    { now: T0 },
  );

  inferAttribution(currentTurn(session));
  const sources = currentTurn(session).sources;
  assert.equal(sources[0].queryText, 'only query', 'inferred');
  assert.equal(sources[1].queryText, 'explicit', 'existing attribution is preserved');
});

test('multi-query turns are left unattributed rather than guessed', () => {
  const session = createSession({ siteId: 'claude', now: T0 });
  mergeResult(
    session,
    result({ queries: [q('one'), q('two')], sources: [{ url: 'https://a.example/1', strategy: 'network' }] }),
    { now: T0 },
  );

  inferAttribution(currentTurn(session));
  assert.equal(currentTurn(session).sources[0].queryText, null);
});

test('canonicalizeUrl strips tracking parameters and fragments', () => {
  assert.equal(
    canonicalizeUrl('https://example.com/p?utm_source=a&utm_medium=b&id=7#section'),
    'https://example.com/p?id=7',
  );
  assert.equal(canonicalizeUrl('https://example.com/'), 'https://example.com');
  assert.equal(canonicalizeUrl('https://example.com/path/'), 'https://example.com/path/');
  assert.equal(canonicalizeUrl('not a url'), 'not a url');
});

test('normalizeQuery collapses whitespace and case', () => {
  assert.equal(normalizeQuery('  Tokyo   Weather  '), 'tokyo weather');
  assert.equal(normalizeQuery(null), '');
});

test('empty query text is ignored', () => {
  const session = createSession({ siteId: 'claude', now: T0 });
  const merged = mergeResult(session, result({ queries: [q('   ')] }), { now: T0 });
  assert.equal(merged.addedQueries, 0);
});

test('sources with unusable URLs are ignored', () => {
  const session = createSession({ siteId: 'claude', now: T0 });
  const merged = mergeResult(session, result({ sources: [{ url: '', strategy: 'network' }] }), {
    now: T0,
  });
  assert.equal(merged.addedSources, 0);
});
