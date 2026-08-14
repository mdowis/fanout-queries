import test from 'node:test';
import assert from 'node:assert/strict';
import { query, queryAll, queryFirst } from '../lib/extraction/json-path.js';

const payload = {
  conversation_id: 'abc-123',
  message: {
    metadata: {
      search_queries: [{ q: 'claude 5 release date' }, { q: 'anthropic mythos tier' }],
      search_result_groups: [
        {
          entries: [
            { url: 'https://example.com/a', title: 'A', snippet: 'first' },
            { url: 'https://example.com/b', title: 'B' },
          ],
        },
      ],
    },
  },
};

const roots = { response: payload, request: { prompt: 'what shipped today?' } };

test('reads a literal path', () => {
  assert.deepEqual(query('$.conversation_id', roots), ['abc-123']);
});

test('reads from the request root via $req', () => {
  assert.deepEqual(query('$req.prompt', roots), ['what shipped today?']);
});

test('$req on a payload with no request root yields nothing', () => {
  assert.deepEqual(query('$req.prompt', { response: payload }), []);
});

test('wildcards expand arrays', () => {
  assert.deepEqual(query('$.message.metadata.search_queries[*].q', roots), [
    'claude 5 release date',
    'anthropic mythos tier',
  ]);
});

test('deep scan finds nested keys regardless of nesting depth', () => {
  assert.deepEqual(query('$..search_queries[*].q', roots), [
    'claude 5 release date',
    'anthropic mythos tier',
  ]);
});

test('deep scan survives the payload being renested', () => {
  const renested = { response: { data: { v2: { wrapper: payload } } } };
  assert.deepEqual(query('$..search_queries[*].q', renested), [
    'claude 5 release date',
    'anthropic mythos tier',
  ]);
});

test('deep scan collects result objects', () => {
  const entries = query('$..search_result_groups[*].entries[*]', roots);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].url, 'https://example.com/a');
});

test('array indexing supports negative offsets', () => {
  const data = { response: { items: ['a', 'b', 'c'] } };
  assert.deepEqual(query('$.items[0]', data), ['a']);
  assert.deepEqual(query('$.items[-1]', data), ['c']);
  assert.deepEqual(query('$.items[9]', data), []);
});

test('bracket-quoted keys handle names with dots', () => {
  const data = { response: { 'f.req': 'value' } };
  assert.deepEqual(query("$['f.req']", data), ['value']);
});

test('[?key] filters the current nodes to owners of a key', () => {
  const data = {
    response: {
      content: [
        { type: 'text', text: 'hello' },
        { type: 'tool_use', input: { query: 'weather today' } },
      ],
    },
  };

  assert.deepEqual(query('$..[?tool_use]', data), [], 'matches key presence, not value');

  const byInput = query('$..[?input]', data);
  assert.equal(byInput.length, 1, 'each owner matches exactly once, no descend duplicates');
  assert.equal(byInput[0].input.query, 'weather today');

  // Composes with an explicit wildcard instead of descending on its own.
  assert.deepEqual(query('$.content[*][?input].input.query', data), ['weather today']);
});

test('wildcard over an object yields its values', () => {
  const data = { response: { a: 1, b: 2 } };
  assert.deepEqual(query('$[*]', data), [1, 2]);
});

test('missing paths return an empty array rather than throwing', () => {
  assert.deepEqual(query('$.nope.not.here', roots), []);
  assert.deepEqual(query('', roots), []);
  assert.deepEqual(query('$.message.metadata.search_queries[*].missing', roots), []);
});

test('queryFirst returns the first path that matches', () => {
  const found = queryFirst(['$.missing', '$..search_queries[*].q'], roots);
  assert.equal(found.length, 2);
  assert.deepEqual(queryFirst(['$.missing', '$.alsoMissing'], roots), []);
});

test('queryAll concatenates every match', () => {
  const found = queryAll(['$.conversation_id', '$..search_queries[*].q'], roots);
  assert.deepEqual(found, ['abc-123', 'claude 5 release date', 'anthropic mythos tier']);
});

test('cyclic structures do not hang the evaluator', () => {
  const cyclic = { name: 'root' };
  cyclic.self = cyclic;
  // Depth-capped rather than cycle-tracked; the point is that it terminates.
  const found = query('$..name', { response: cyclic });
  assert.ok(found.length > 0);
});
