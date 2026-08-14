import test from 'node:test';
import assert from 'node:assert/strict';
import { scan, mineArrays } from '../lib/extraction/heuristics.js';

test('finds queries and sources in a conventional payload', () => {
  const payload = {
    search_queries: [{ q: 'best espresso machine 2026' }],
    web_results: [
      { url: 'https://example.com/review', title: 'Reviews', snippet: 'We tested 40 machines.' },
    ],
  };
  const found = scan(payload);
  assert.deepEqual(found.queries, ['best espresso machine 2026']);
  assert.equal(found.sources.length, 1);
  assert.equal(found.sources[0].title, 'Reviews');
});

test('survives renamed containers — the drift-resistance case', () => {
  // Same data, every wrapper key renamed and renested two levels deeper.
  const drifted = {
    v3: { payload: { steps: [{ searchQuery: 'best espresso machine 2026' }] } },
    data: {
      groups: [
        {
          entries: [
            { url: 'https://example.com/review', title: 'Reviews', snippet: 'We tested 40.' },
          ],
        },
      ],
    },
  };
  const found = scan(drifted);
  assert.deepEqual(found.queries, ['best espresso machine 2026']);
  assert.equal(found.sources.length, 1);
  assert.equal(found.sources[0].url, 'https://example.com/review');
});

test('attributes sources to the query they sit beneath', () => {
  const payload = {
    steps: [
      {
        query: 'claude 5 benchmarks',
        results: [{ url: 'https://a.example/1', title: 'Benchmarks' }],
      },
      {
        query: 'mythos tier pricing',
        results: [{ url: 'https://b.example/2', title: 'Pricing' }],
      },
    ],
  };
  const found = scan(payload);
  assert.deepEqual(found.queries, ['claude 5 benchmarks', 'mythos tier pricing']);
  const byUrl = Object.fromEntries(found.sources.map((s) => [s.url, s.queryText]));
  assert.equal(byUrl['https://a.example/1'], 'claude 5 benchmarks');
  assert.equal(byUrl['https://b.example/2'], 'mythos tier pricing');
});

test('leaves attribution null when no query encloses the source', () => {
  const found = scan({ citations: [{ url: 'https://x.example/p', title: 'Page' }] });
  assert.equal(found.sources[0].queryText, null);
});

test('rejects opaque identifiers that sit under query-shaped keys', () => {
  const payload = {
    query: 'a3f9c2e18b7d4f60a1c2',
    q: '9f8e7d6c5b4a39281706',
  };
  assert.deepEqual(scan(payload).queries, []);
});

test('rejects URLs and empty values as queries', () => {
  const payload = { query: 'https://example.com/search?q=x', search_query: '  ' };
  assert.deepEqual(scan(payload).queries, []);
});

test('accepts short multi-word queries but not overlong single tokens', () => {
  const payload = {
    queries: ['ai news', 'x'.repeat(80), 'a very long but perfectly ordinary search query here'],
  };
  const found = scan(payload);
  assert.deepEqual(found.queries, ['ai news', 'a very long but perfectly ordinary search query here']);
});

test('drops denylisted asset URLs', () => {
  const payload = {
    results: [
      { url: 'https://lh3.googleusercontent.com/img.png', title: 'thumb' },
      { url: 'https://real.example/article', title: 'Article' },
    ],
  };
  const found = scan(payload);
  assert.equal(found.sources.length, 1);
  assert.equal(found.sources[0].url, 'https://real.example/article');
});

test('requires a descriptor alongside the URL to count as a result', () => {
  assert.deepEqual(scan({ thing: { url: 'https://example.com/bare' } }).sources, []);
});

test('reads alternate url and title keys', () => {
  const payload = { refs: [{ link: 'https://example.com/z', name: 'Zed' }] };
  const found = scan(payload);
  assert.equal(found.sources.length, 1);
  assert.equal(found.sources[0].title, 'Zed');
});

test('deduplicates repeated queries and sources', () => {
  const payload = {
    a: { query: 'Repeat Me' },
    b: { query: 'repeat me' },
    c: [{ url: 'https://example.com/x', title: 'X' }, { url: 'https://example.com/x', title: 'X' }],
  };
  const found = scan(payload);
  assert.equal(found.queries.length, 1);
  assert.equal(found.sources.length, 1);
});

test('honors rules-supplied overrides', () => {
  const payload = { custom_key: 'weather in tokyo' };
  assert.deepEqual(scan(payload).queries, []);
  assert.deepEqual(scan(payload, { queryKeys: ['custom_key'] }).queries, ['weather in tokyo']);
});

test('handles primitives, null, and deeply nested input without throwing', () => {
  for (const input of [null, undefined, 42, 'text', [], {}]) {
    const found = scan(input);
    assert.deepEqual(found.queries, []);
    assert.deepEqual(found.sources, []);
  }
  let deep = { url: 'https://example.com/deep', title: 'Deep' };
  for (let i = 0; i < 100; i += 1) deep = { nested: deep };
  assert.doesNotThrow(() => scan(deep));
});

test('terminates on cyclic structures', () => {
  const cyclic = { query: 'loop check' };
  cyclic.self = cyclic;
  const found = scan(cyclic);
  assert.deepEqual(found.queries, ['loop check']);
});

// ------------------------------------------------------- array miner ------

test('mineArrays pairs URLs with neighboring titles', () => {
  const payload = [[['https://news.example/story', 'Big Story Today', 1]]];
  const found = mineArrays(payload, {});
  assert.equal(found.sources.length, 1);
  assert.equal(found.sources[0].title, 'Big Story Today');
});

test('mineArrays only takes queries next to a marker token', () => {
  const payload = [['some prose that is not a query', 'fanout', 'tokyo weather forecast']];
  const found = mineArrays(payload, { queryMarkers: ['fanout'] });
  assert.deepEqual(found.queries, ['tokyo weather forecast']);
});

test('mineArrays yields no queries when no markers are configured', () => {
  const payload = [['fanout', 'tokyo weather forecast']];
  assert.deepEqual(mineArrays(payload, {}).queries, []);
});

test('mineArrays deduplicates and skips denylisted URLs', () => {
  const payload = [
    ['https://a.example/1', 'One'],
    ['https://a.example/1', 'One again'],
    ['https://cdn.example/asset.js', 'Asset'],
  ];
  const found = mineArrays(payload, {});
  assert.equal(found.sources.length, 1);
});

test('mineArrays respects its depth cap', () => {
  let nested = ['https://deep.example/x', 'Deep'];
  for (let i = 0; i < 50; i += 1) nested = [nested];
  assert.deepEqual(mineArrays(nested, { maxDepth: 5 }).sources, []);
  assert.equal(mineArrays(nested, { maxDepth: 60 }).sources.length, 1);
});
