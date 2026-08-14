/**
 * FANOUT_QUERIES — session serializers.
 *
 * Pure functions: no chrome APIs, no DOM. The side panel wraps the output in a
 * Blob and hands it to chrome.downloads.
 */

/** Columns emitted by the CSV export, in order. */
export const CSV_COLUMNS = [
  'session_id',
  'site',
  'session_started',
  'turn_ts',
  'prompt',
  'fanout_query',
  'query_strategy',
  'source_url',
  'source_title',
  'source_snippet',
  'attribution',
];

/**
 * @param {number} ts
 * @returns {string} ISO-8601, or empty string for missing timestamps
 */
function iso(ts) {
  return Number.isFinite(ts) && ts > 0 ? new Date(ts).toISOString() : '';
}

/**
 * Serialize sessions as JSON.
 * @param {import('./types.js').Session[]} sessions
 * @param {{extensionVersion?: string, rulesVersion?: number|string, exportedAt?: number}} [meta]
 * @returns {string}
 */
export function toJson(sessions, meta = {}) {
  const payload = {
    exportedAt: iso(meta.exportedAt ?? Date.now()),
    extensionVersion: meta.extensionVersion ?? null,
    rulesVersion: meta.rulesVersion ?? null,
    sessionCount: sessions.length,
    sessions,
  };
  return JSON.stringify(payload, null, 2);
}

/**
 * Escape one CSV field per RFC 4180.
 * @param {unknown} value
 * @returns {string}
 */
export function csvField(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * Flatten sessions into CSV rows: one row per (turn, query, source) pairing.
 *
 * Queries with no sources still emit a row (empty source columns) and sources
 * with no attributable query likewise — dropping either would silently lose
 * captured data.
 *
 * @param {import('./types.js').Session[]} sessions
 * @returns {string[][]} rows, excluding the header
 */
export function toCsvRows(sessions) {
  const rows = [];

  for (const session of sessions) {
    const sessionStart = iso(session.startedAt);

    for (const turn of session.turns || []) {
      const turnTs = iso(turn.ts);
      const prompt = turn.prompt || '';
      const queries = turn.queries || [];
      const sources = turn.sources || [];

      const base = [session.id, session.siteId, sessionStart, turnTs, prompt];

      if (!queries.length && !sources.length) {
        rows.push([...base, '', '', '', '', '', '']);
        continue;
      }

      const attributed = new Set();

      for (const query of queries) {
        const matching = sources.filter(
          (source) =>
            source.queryText &&
            source.queryText.trim().toLowerCase() === query.text.trim().toLowerCase(),
        );

        if (!matching.length) {
          rows.push([...base, query.text, query.strategy || '', '', '', '', '']);
          continue;
        }

        for (const source of matching) {
          attributed.add(source);
          rows.push([
            ...base,
            query.text,
            query.strategy || '',
            source.url || '',
            source.title || '',
            source.snippet || '',
            query.text,
          ]);
        }
      }

      for (const source of sources) {
        if (attributed.has(source)) continue;
        rows.push([
          ...base,
          '',
          '',
          source.url || '',
          source.title || '',
          source.snippet || '',
          '',
        ]);
      }
    }
  }

  return rows;
}

/**
 * Serialize sessions as CSV, with a UTF-8 BOM so Excel reads it correctly.
 * @param {import('./types.js').Session[]} sessions
 * @returns {string}
 */
export function toCsv(sessions) {
  const lines = [CSV_COLUMNS.join(',')];
  for (const row of toCsvRows(sessions)) {
    lines.push(row.map(csvField).join(','));
  }
  return `﻿${lines.join('\r\n')}`;
}

/**
 * Build a timestamped export filename.
 * @param {'json'|'csv'} extension
 * @param {number} [now]
 * @returns {string}
 */
export function exportFilename(extension, now = Date.now()) {
  const date = new Date(now);
  const pad = (value) => String(value).padStart(2, '0');
  const stamp =
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}`;
  return `fanout-queries-${stamp}.${extension}`;
}
