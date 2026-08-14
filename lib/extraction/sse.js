/**
 * FANOUT_QUERIES — incremental Server-Sent Events reassembly.
 *
 * Response chunks arrive split at arbitrary byte offsets, so frames must be
 * buffered across chunk boundaries. Handles LF and CRLF line endings, multi-line
 * `data:` payloads (concatenated with newlines per the SSE spec), comment lines,
 * and the `[DONE]` sentinel used by most chat APIs.
 */

/** Frames whose data is exactly one of these carry no payload. */
const SENTINELS = new Set(['[DONE]', 'DONE']);

/**
 * Stateful splitter: feed it chunks, get back complete frames.
 */
export class SseReassembler {
  constructor() {
    /** @type {string} */
    this.buffer = '';
  }

  /**
   * Feed one chunk of stream text.
   * @param {string} chunk
   * @returns {Array<{event: string|null, data: string, id: string|null}>} complete frames
   */
  push(chunk) {
    if (typeof chunk !== 'string' || !chunk) return [];
    this.buffer += chunk;

    const frames = [];
    // Frames are separated by a blank line; normalize CRLF first.
    const normalized = this.buffer.replace(/\r\n/g, '\n');
    const parts = normalized.split('\n\n');

    // The trailing part may be incomplete — keep it buffered.
    this.buffer = parts.pop() ?? '';

    for (const part of parts) {
      const frame = parseFrame(part);
      if (frame) frames.push(frame);
    }
    return frames;
  }

  /**
   * Flush whatever remains once the stream ends.
   * @returns {Array<{event: string|null, data: string, id: string|null}>}
   */
  flush() {
    const remainder = this.buffer;
    this.buffer = '';
    if (!remainder.trim()) return [];
    const frame = parseFrame(remainder.replace(/\r\n/g, '\n'));
    return frame ? [frame] : [];
  }
}

/**
 * Parse one frame block into its fields.
 * @param {string} block
 * @returns {{event: string|null, data: string, id: string|null}|null}
 */
function parseFrame(block) {
  const dataLines = [];
  let event = null;
  let id = null;

  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue; // blank or comment (keep-alive)

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    // A single leading space after the colon is part of the delimiter, not data.
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    switch (field) {
      case 'data':
        dataLines.push(value);
        break;
      case 'event':
        event = value;
        break;
      case 'id':
        id = value;
        break;
      default:
        break;
    }
  }

  if (!dataLines.length) return null;
  const data = dataLines.join('\n');
  if (SENTINELS.has(data.trim())) return null;
  return { event, data, id };
}

/**
 * Parse a complete SSE body in one shot.
 * @param {string} text
 * @returns {Array<{event: string|null, data: string, id: string|null}>}
 */
export function parseSse(text) {
  const reassembler = new SseReassembler();
  return [...reassembler.push(text), ...reassembler.flush()];
}

/**
 * Parse SSE frames and JSON-decode each payload, skipping non-JSON frames.
 * @param {string} text
 * @returns {unknown[]}
 */
export function parseSseJson(text) {
  const out = [];
  for (const frame of parseSse(text)) {
    const value = tryParseJson(frame.data);
    if (value !== undefined) out.push(value);
  }
  return out;
}

/**
 * JSON.parse that returns undefined instead of throwing.
 * @param {string} text
 * @returns {unknown}
 */
export function tryParseJson(text) {
  if (typeof text !== 'string') return undefined;
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const first = trimmed[0];
  if (first !== '{' && first !== '[' && first !== '"') return undefined;
  try {
    return JSON.parse(trimmed);
  } catch (_) {
    return undefined;
  }
}

/**
 * Strip Google's anti-XSSI prefix and parse each JSON value in the body.
 *
 * Google and Gemini return `)]}'` followed by length-prefixed or newline-
 * separated JSON arrays; this yields every value that parses.
 * @param {string} text
 * @returns {unknown[]}
 */
export function parseAntiXssiJson(text) {
  if (typeof text !== 'string' || !text) return [];
  let body = text.trimStart();
  if (body.startsWith(")]}'")) body = body.slice(4);
  if (body.startsWith(')]}')) body = body.slice(3);

  const out = [];
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    // Length-prefix lines (bare digits) are framing, not payload.
    if (!trimmed || /^\d+$/.test(trimmed)) continue;
    const value = tryParseJson(trimmed);
    if (value !== undefined) out.push(value);
  }

  // Some responses are a single multi-line JSON document.
  if (!out.length) {
    const whole = tryParseJson(body);
    if (whole !== undefined) out.push(whole);
  }
  return out;
}
