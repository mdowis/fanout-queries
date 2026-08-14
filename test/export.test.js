import test from 'node:test';
import assert from 'node:assert/strict';
import { toJson, toCsv, toCsvRows, csvField, exportFilename, CSV_COLUMNS } from '../lib/export.js';

/** @returns {import('../lib/types.js').Session[]} */
function sampleSessions() {
  return [
    {
      id: 'chatgpt:conv-1',
      siteId: 'chatgpt',
      tabUrl: 'https://chatgpt.com/c/conv-1',
      startedAt: Date.UTC(2026, 7, 14, 12, 0, 0),
      updatedAt: Date.UTC(2026, 7, 14, 12, 5, 0),
      turns: [
        {
          id: 't1',
          prompt: 'what happened in tech today?',
          promptStrategy: 'network',
          ts: Date.UTC(2026, 7, 14, 12, 0, 30),
          queries: [
            { text: 'tech news august 2026', ts: 1, strategy: 'network', confidence: 1 },
            { text: 'ai model releases', ts: 2, strategy: 'dom', confidence: 0.7 },
          ],
          sources: [
            {
              url: 'https://news.example/a',
              title: 'Story A',
              snippet: 'Lead paragraph.',
              queryText: 'tech news august 2026',
              strategy: 'network',
            },
            { url: 'https://news.example/b', title: 'Story B', queryText: null, strategy: 'network' },
          ],
          strategiesUsed: ['network', 'dom'],
        },
      ],
    },
  ];
}

test('toJson emits parseable, metadata-tagged output', () => {
  const json = toJson(sampleSessions(), {
    extensionVersion: '0.1.0',
    rulesVersion: 3,
    exportedAt: Date.UTC(2026, 7, 14, 13, 0, 0),
  });
  const parsed = JSON.parse(json);
  assert.equal(parsed.extensionVersion, '0.1.0');
  assert.equal(parsed.rulesVersion, 3);
  assert.equal(parsed.exportedAt, '2026-08-14T13:00:00.000Z');
  assert.equal(parsed.sessionCount, 1);
  assert.equal(parsed.sessions[0].turns[0].queries.length, 2);
});

test('toJson round-trips sessions without loss', () => {
  const sessions = sampleSessions();
  assert.deepEqual(JSON.parse(toJson(sessions)).sessions, sessions);
});

test('toJson handles an empty archive', () => {
  const parsed = JSON.parse(toJson([]));
  assert.equal(parsed.sessionCount, 0);
  assert.deepEqual(parsed.sessions, []);
});

test('csvField quotes only when required, doubling embedded quotes', () => {
  assert.equal(csvField('plain'), 'plain');
  assert.equal(csvField('has,comma'), '"has,comma"');
  assert.equal(csvField('has"quote'), '"has""quote"');
  assert.equal(csvField('has\nnewline'), '"has\nnewline"');
  assert.equal(csvField(null), '');
  assert.equal(csvField(undefined), '');
  assert.equal(csvField(0), '0');
});

test('CSV pairs each query with its attributed sources', () => {
  const rows = toCsvRows(sampleSessions());
  const attributed = rows.find((row) => row[7] === 'https://news.example/a');
  assert.equal(attributed[5], 'tech news august 2026');
  assert.equal(attributed[6], 'network');
  assert.equal(attributed[10], 'tech news august 2026', 'attribution column is filled');
});

test('CSV keeps queries that found nothing', () => {
  const rows = toCsvRows(sampleSessions());
  const orphanQuery = rows.find((row) => row[5] === 'ai model releases');
  assert.ok(orphanQuery, 'a query with no sources still emits a row');
  assert.equal(orphanQuery[7], '', 'with empty source columns');
});

test('CSV keeps unattributed sources', () => {
  const rows = toCsvRows(sampleSessions());
  const orphanSource = rows.find((row) => row[7] === 'https://news.example/b');
  assert.ok(orphanSource, 'a source with no query still emits a row');
  assert.equal(orphanSource[5], '');
});

test('CSV emits a row for a turn with neither queries nor sources', () => {
  const sessions = sampleSessions();
  sessions[0].turns[0].queries = [];
  sessions[0].turns[0].sources = [];
  const rows = toCsvRows(sessions);
  assert.equal(rows.length, 1);
  assert.equal(rows[0][4], 'what happened in tech today?');
});

test('toCsv writes a header, BOM, and CRLF line endings', () => {
  const csv = toCsv(sampleSessions());
  assert.ok(csv.startsWith('﻿'), 'leads with a UTF-8 BOM for Excel');
  const lines = csv.slice(1).split('\r\n');
  assert.equal(lines[0], CSV_COLUMNS.join(','));
  assert.ok(lines.length > 1);
});

test('toCsv escapes prompts containing commas and quotes', () => {
  const sessions = sampleSessions();
  sessions[0].turns[0].prompt = 'compare "A", then B';
  const csv = toCsv(sessions);
  assert.ok(csv.includes('"compare ""A"", then B"'));
});

test('toCsv on an empty archive is header-only', () => {
  assert.equal(toCsv([]).slice(1), CSV_COLUMNS.join(','));
});

test('attribution matching ignores case and surrounding whitespace', () => {
  const sessions = sampleSessions();
  sessions[0].turns[0].sources[0].queryText = '  TECH NEWS August 2026 ';
  const rows = toCsvRows(sessions);
  const attributed = rows.find((row) => row[7] === 'https://news.example/a');
  assert.equal(attributed[5], 'tech news august 2026');
});

test('exportFilename is timestamped and correctly suffixed', () => {
  const name = exportFilename('csv', new Date('2026-08-14T09:05:00').getTime());
  assert.match(name, /^fanout-queries-20260814-0905\.csv$/);
  assert.ok(exportFilename('json').endsWith('.json'));
});
