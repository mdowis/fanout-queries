import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SseReassembler,
  parseSse,
  parseSseJson,
  parseAntiXssiJson,
  tryParseJson,
} from '../lib/extraction/sse.js';

test('parses simple frames', () => {
  const frames = parseSse('data: one\n\ndata: two\n\n');
  assert.deepEqual(frames.map((f) => f.data), ['one', 'two']);
});

test('reassembles frames split across chunk boundaries', () => {
  const reassembler = new SseReassembler();
  assert.deepEqual(reassembler.push('data: hel'), []);
  assert.deepEqual(reassembler.push('lo\n\nda'), [{ event: null, data: 'hello', id: null }]);
  assert.deepEqual(reassembler.push('ta: world\n\n'), [
    { event: null, data: 'world', id: null },
  ]);
});

test('handles CRLF line endings', () => {
  const frames = parseSse('data: alpha\r\n\r\ndata: beta\r\n\r\n');
  assert.deepEqual(frames.map((f) => f.data), ['alpha', 'beta']);
});

test('joins multi-line data fields with newlines', () => {
  const frames = parseSse('data: line one\ndata: line two\n\n');
  assert.equal(frames.length, 1);
  assert.equal(frames[0].data, 'line one\nline two');
});

test('captures event and id fields', () => {
  const frames = parseSse('event: delta\nid: 42\ndata: payload\n\n');
  assert.deepEqual(frames[0], { event: 'delta', data: 'payload', id: '42' });
});

test('ignores comments and keep-alives', () => {
  const frames = parseSse(': keep-alive\n\ndata: real\n\n');
  assert.deepEqual(frames.map((f) => f.data), ['real']);
});

test('drops the [DONE] sentinel', () => {
  const frames = parseSse('data: {"a":1}\n\ndata: [DONE]\n\n');
  assert.equal(frames.length, 1);
});

test('flush emits a trailing frame with no terminating blank line', () => {
  const reassembler = new SseReassembler();
  assert.deepEqual(reassembler.push('data: trailing'), []);
  assert.deepEqual(reassembler.flush().map((f) => f.data), ['trailing']);
  assert.deepEqual(reassembler.flush(), [], 'flush is idempotent');
});

test('preserves data values containing colons', () => {
  const frames = parseSse('data: {"url":"https://example.com/x"}\n\n');
  assert.equal(frames[0].data, '{"url":"https://example.com/x"}');
});

test('strips exactly one space after the field colon', () => {
  const frames = parseSse('data:  two spaces\n\n');
  assert.equal(frames[0].data, ' two spaces');
});

test('parseSseJson decodes payloads and skips non-JSON frames', () => {
  const values = parseSseJson('data: {"n":1}\n\ndata: not json\n\ndata: [2]\n\n');
  assert.deepEqual(values, [{ n: 1 }, [2]]);
});

test('tryParseJson returns undefined instead of throwing', () => {
  assert.equal(tryParseJson('{bad'), undefined);
  assert.equal(tryParseJson(''), undefined);
  assert.equal(tryParseJson('plain text'), undefined);
  assert.deepEqual(tryParseJson('{"ok":true}'), { ok: true });
});

test('parseAntiXssiJson strips the Google prefix', () => {
  const values = parseAntiXssiJson(')]}\'\n\n[["wrb.fr","abc","[1,2]"]]');
  assert.equal(values.length, 1);
  assert.equal(values[0][0][0], 'wrb.fr');
});

test('parseAntiXssiJson skips length-prefix framing lines', () => {
  const body = ')]}\'\n\n26\n[["a",1]]\n15\n[["b",2]]\n';
  const values = parseAntiXssiJson(body);
  assert.deepEqual(values, [[['a', 1]], [['b', 2]]]);
});

test('parseAntiXssiJson falls back to a single multi-line document', () => {
  const values = parseAntiXssiJson(')]}\'\n{\n  "a": 1\n}');
  assert.deepEqual(values, [{ a: 1 }]);
});

test('parseAntiXssiJson tolerates empty and malformed input', () => {
  assert.deepEqual(parseAntiXssiJson(''), []);
  assert.deepEqual(parseAntiXssiJson('garbage'), []);
});
