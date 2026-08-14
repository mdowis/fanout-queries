/**
 * Interceptor regression tests.
 *
 * The interceptor runs in the page world, so it is loaded into a `vm` context
 * with a minimal fake page. The tests that matter most are the ones proving it
 * does NOT disturb the page: a broken chat site is far worse than a missed
 * capture.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const INTERCEPTOR_SRC = readFileSync(
  fileURLToPath(new URL('../content/interceptor.js', import.meta.url)),
  'utf8',
);

const SSE_FRAMES = [
  'data: {"type":"tool_use","name":"web_search","input":{"query":"claude 5 release"}}\n\n',
  'data: {"type":"web_search_result","content":[{"url":"https://example.com/a","title":"A"}]}\n\n',
  'data: [DONE]\n\n',
];

class FakeCustomEvent {
  constructor(type, init) {
    this.type = type;
    this.detail = init && init.detail;
  }
}

/** Build a page world with the interceptor installed. */
function createPage({ fetchImpl } = {}) {
  const captures = [];
  const listeners = new Map();

  const documentStub = {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    dispatchEvent(event) {
      for (const fn of listeners.get(event.type) || []) fn(event);
      return true;
    },
  };

  const originalFetch =
    fetchImpl ||
    ((input) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/completion')) {
        const stream = new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            for (const frame of SSE_FRAMES) controller.enqueue(encoder.encode(frame));
            controller.close();
          },
        });
        return Promise.resolve(
          new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
        );
      }
      if (url.includes('/boom')) return Promise.reject(new Error('network down'));
      return Promise.resolve(
        new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }),
      );
    });

  const sandbox = {
    window: { fetch: originalFetch, WebSocket: undefined },
    document: documentStub,
    location: { href: 'https://claude.ai/chat/abc' },
    URL,
    Response,
    Request,
    ReadableStream,
    TextDecoder,
    TextEncoder,
    URLSearchParams,
    Promise,
    Date,
    setTimeout,
    console,
    CustomEvent: FakeCustomEvent,
    XMLHttpRequest: undefined,
    WebSocket: undefined,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  documentStub.addEventListener('__fq_capture', (event) => {
    captures.push(JSON.parse(event.detail));
  });

  vm.runInContext(INTERCEPTOR_SRC, sandbox);

  return {
    sandbox,
    captures,
    originalFetch,
    fetch: (...args) => sandbox.window.fetch.apply(sandbox.window, args),
    /** Let queued microtasks and the stream reader finish. */
    settle: () => new Promise((resolve) => setTimeout(resolve, 60)),
    emitConfig: (config) =>
      documentStub.dispatchEvent(new FakeCustomEvent('__fq_config', { detail: JSON.stringify(config) })),
  };
}

test('patches fetch on install', () => {
  const page = createPage();
  assert.notEqual(page.sandbox.window.fetch, page.originalFetch);
});

test('installs only once', () => {
  const page = createPage();
  const patched = page.sandbox.window.fetch;
  vm.runInContext(INTERCEPTOR_SRC, page.sandbox);
  assert.equal(page.sandbox.window.fetch, patched, 're-running must not double-wrap fetch');
});

// --------------------------------------------------------- prime directive ---

test('the page still receives its complete response body', async () => {
  const page = createPage();
  const response = await page.fetch(
    'https://claude.ai/api/organizations/o1/chat_conversations/c1/completion',
    { method: 'POST', body: JSON.stringify({ prompt: 'hi' }) },
  );
  assert.equal(await response.text(), SSE_FRAMES.join(''));
});

test('the page can still read a Request-object fetch', async () => {
  const page = createPage();
  const request = new Request('https://claude.ai/api/organizations/o/x/completion', {
    method: 'POST',
    body: JSON.stringify({ prompt: 'what shipped today?' }),
  });
  const response = await page.fetch(request);
  assert.equal(await response.text(), SSE_FRAMES.join(''));
});

test('rejections still propagate to the page', async () => {
  const page = createPage();
  await assert.rejects(() => page.fetch('https://claude.ai/boom'), /network down/);
});

test('a throwing CustomEvent constructor cannot break the page', async () => {
  const page = createPage();
  page.sandbox.CustomEvent = function Broken() {
    throw new Error('emission exploded');
  };
  const response = await page.fetch('https://claude.ai/api/organizations/o/x/completion');
  assert.equal(await response.text(), SSE_FRAMES.join(''), 'page body survives emit failures');
});

test('a response that cannot be cloned is skipped silently', async () => {
  const page = createPage({
    fetchImpl: () =>
      Promise.resolve({
        headers: { get: () => 'text/event-stream' },
        clone() {
          throw new TypeError('already disturbed');
        },
      }),
  });
  const response = await page.fetch('https://claude.ai/x/completion');
  await page.settle();
  assert.ok(response, 'the page still gets its response object');
});

// ------------------------------------------------------------- capturing ---

test('captures the request body, response chunks, and an end marker', async () => {
  const page = createPage();
  await page.fetch('https://claude.ai/api/organizations/o1/chat_conversations/c1/completion', {
    method: 'POST',
    body: JSON.stringify({ prompt: 'what shipped today?' }),
  });
  await page.settle();

  const request = page.captures.find((c) => c.phase === 'request');
  assert.ok(request, 'request phase captured');
  assert.match(request.body, /what shipped today\?/);

  const chunks = page.captures
    .filter((c) => c.phase === 'chunk')
    .sort((a, b) => a.seq - b.seq)
    .map((c) => c.body)
    .join('');
  assert.equal(chunks, SSE_FRAMES.join(''), 'chunks reassemble to the full stream');

  assert.ok(page.captures.some((c) => c.phase === 'end'), 'end phase emitted');
});

test('reads the request body from a Request object', async () => {
  const page = createPage();
  await page.fetch(
    new Request('https://claude.ai/api/organizations/o/x/completion', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'from a Request' }),
    }),
  );
  await page.settle();
  const request = page.captures.find((c) => c.phase === 'request');
  assert.match(request.body, /from a Request/);
});

test('all captures for one request share an id', async () => {
  const page = createPage();
  await page.fetch('https://claude.ai/api/organizations/o/x/completion');
  await page.settle();
  const ids = new Set(page.captures.map((c) => c.id));
  assert.equal(ids.size, 1);
});

test('resolves relative URLs against the page location', async () => {
  const page = createPage();
  await page.fetch('/api/organizations/o/x/completion');
  await page.settle();
  assert.equal(page.captures[0].url, 'https://claude.ai/api/organizations/o/x/completion');
});

test('captures SSE responses even when the URL matches no pattern', async () => {
  const page = createPage({
    fetchImpl: () =>
      Promise.resolve(
        new Response('data: {"x":1}\n\n', { headers: { 'content-type': 'text/event-stream' } }),
      ),
  });
  await page.fetch('https://claude.ai/totally/unknown/endpoint');
  await page.settle();
  assert.ok(page.captures.length > 0, 'SSE is the fan-out transport; always worth capturing');
});

test('ignores unrelated requests', async () => {
  const page = createPage();
  await page.fetch('https://claude.ai/static/config.json');
  await page.settle();
  assert.equal(page.captures.length, 0);
});

test('rules config widens the capture patterns', async () => {
  const page = createPage({
    fetchImpl: () =>
      Promise.resolve(
        new Response('{"data":1}', { headers: { 'content-type': 'application/json' } }),
      ),
  });
  await page.fetch('https://claude.ai/brand/new/path');
  await page.settle();
  assert.equal(page.captures.length, 0, 'not captured before the rule exists');

  page.emitConfig({ urlPatterns: ['/brand/new/'] });
  await page.fetch('https://claude.ai/brand/new/path');
  await page.settle();
  assert.ok(page.captures.length > 0, 'captured once the rule arrives');
});

test('a malformed rules config leaves built-in patterns intact', async () => {
  const page = createPage();
  page.emitConfig({ urlPatterns: 'not-an-array' });
  await page.fetch('https://claude.ai/api/organizations/o/x/completion');
  await page.settle();
  assert.ok(page.captures.length > 0, 'a bad rules push must never blind the interceptor');
});
