/**
 * Adapter + engine tests against recorded-shape fixtures.
 *
 * Each site is exercised end to end: fixture text -> adapter decode -> rules
 * paths -> heuristics -> ExtractionResult. Payloads are fed in split chunks to
 * mirror how they actually arrive, so a parser that only works on a whole body
 * fails here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CaptureContext,
  ingestRequest,
  ingestChunk,
  finishCapture,
  matchesEndpoint,
  normalizeDomCapture,
} from '../lib/extraction/engine.js';
import { unwrapRedirect, promptFromUrl } from '../lib/extraction/adapters/google-aimode.js';
import { promptFromBatchExecute } from '../lib/extraction/adapters/gemini.js';
import { decodeBatchExecuteRequest } from '../lib/extraction/adapters/base.js';

const RULES = JSON.parse(
  readFileSync(fileURLToPath(new URL('../rules/default-rules.json', import.meta.url)), 'utf8'),
);

function fixture(name) {
  return readFileSync(fileURLToPath(new URL(`fixtures/${name}`, import.meta.url)), 'utf8');
}

/**
 * Run a fixture through the engine, split into chunks at `size` characters to
 * simulate streaming delivery.
 */
function runCapture(siteId, url, body, options = {}) {
  return runCaptureWithSite(siteId, RULES.sites[siteId], url, body, options);
}

/** Same, but against a caller-supplied site block (for drift simulations). */
function runCaptureWithSite(siteId, site, url, body, { requestBody, chunkSize = 64 } = {}) {
  const context = new CaptureContext(siteId, site, url);
  if (requestBody !== undefined) ingestRequest(context, requestBody);

  const queries = [];
  const sources = [];
  let prompt;
  const strategies = new Set();

  const absorb = (result) => {
    if (!result) return;
    queries.push(...result.queries);
    sources.push(...result.sources);
    if (result.prompt && prompt === undefined) prompt = result.prompt;
    strategies.add(result.strategy);
  };

  for (let i = 0; i < body.length; i += chunkSize) {
    absorb(ingestChunk(context, body.slice(i, i + chunkSize)));
  }
  absorb(finishCapture(context));

  return {
    queries,
    sources,
    prompt,
    strategies,
    conversationKey: context.conversationKey,
    queryTexts: queries.map((q) => q.text),
    sourceUrls: sources.map((s) => s.url),
  };
}

// ------------------------------------------------------------------ Claude ---

test('claude: recovers queries streamed as input_json_delta fragments', () => {
  const result = runCapture(
    'claude',
    'https://claude.ai/api/organizations/o1/chat_conversations/conv-42/completion',
    fixture('claude-sse.txt'),
    { requestBody: JSON.stringify({ prompt: 'when did claude 5 ship?' }) },
  );

  assert.deepEqual(result.queryTexts, ['claude 5 release date', 'mythos class model tier']);
  assert.equal(result.prompt, 'when did claude 5 ship?');
  assert.equal(result.conversationKey, 'conv-42');
});

test('claude: captures web_search_tool_result sources', () => {
  const result = runCapture(
    'claude',
    'https://claude.ai/api/organizations/o1/chat_conversations/conv-42/completion',
    fixture('claude-sse.txt'),
  );

  assert.ok(result.sourceUrls.includes('https://www.anthropic.com/news/claude-fable-5-mythos-5'));
  assert.ok(result.sourceUrls.includes('https://docs.claude.com/en/docs/about-claude/models'));
  const titled = result.sources.find((s) => s.url.includes('anthropic.com'));
  assert.equal(titled.title, 'Introducing Claude Fable 5 and Mythos 5');
});

test('claude: a query split across chunk boundaries is still recovered', () => {
  // A pathologically small chunk size splits nearly every SSE frame.
  const result = runCapture(
    'claude',
    'https://claude.ai/api/organizations/o/x/completion',
    fixture('claude-sse.txt'),
    { chunkSize: 7 },
  );
  assert.ok(result.queryTexts.includes('claude 5 release date'));
});

// ----------------------------------------------------------------- ChatGPT ---

test('chatgpt: reads queries from search metadata', () => {
  const result = runCapture(
    'chatgpt',
    'https://chatgpt.com/backend-api/f/conversation',
    fixture('chatgpt-sse.txt'),
    {
      requestBody: JSON.stringify({
        messages: [{ content: { parts: ['what happened in tech today?'] } }],
      }),
    },
  );

  assert.ok(result.queryTexts.includes('tech news august 2026'));
  assert.ok(result.queryTexts.includes('ai model launches this week'));
  assert.equal(result.prompt, 'what happened in tech today?');
  assert.equal(result.conversationKey, '7f3c1a20-1111-4bbb-9999-abcdef012345');
});

test('chatgpt: captures sources with per-query attribution', () => {
  const result = runCapture(
    'chatgpt',
    'https://chatgpt.com/backend-api/f/conversation',
    fixture('chatgpt-sse.txt'),
  );

  const verge = result.sources.find((s) => s.url.includes('theverge.com'));
  assert.ok(verge, 'the verge result captured');
  assert.equal(verge.queryText, 'tech news august 2026', 'attribution carried through');
  assert.equal(verge.snippet, 'A roundup of the biggest stories.');

  const ars = result.sources.find((s) => s.url.includes('arstechnica.com'));
  assert.equal(ars.queryText, 'ai model launches this week');
});

test('chatgpt: recovers a search() call addressed to the web tool', () => {
  // Metadata stripped, leaving only the tool-call message the assistant emits.
  const body =
    'data: {"message":{"recipient":"web","content":{"parts":["search(\\"quantum computing milestone\\")"]}}}\n\n';
  const result = runCapture('chatgpt', 'https://chatgpt.com/backend-api/f/conversation', body);
  assert.deepEqual(result.queryTexts, ['quantum computing milestone']);
});

test('chatgpt: deduplicates a query seen in both metadata and a tool call', () => {
  const result = runCapture(
    'chatgpt',
    'https://chatgpt.com/backend-api/f/conversation',
    fixture('chatgpt-sse.txt'),
  );
  const occurrences = result.queryTexts.filter((t) => t === 'tech news august 2026');
  assert.equal(occurrences.length, 1);
});

// -------------------------------------------------------------- Perplexity ---

test('perplexity: reads sub-queries and step queries', () => {
  const result = runCapture(
    'perplexity',
    'https://www.perplexity.ai/rest/sse/perplexity_ask',
    fixture('perplexity-sse.txt'),
    { requestBody: JSON.stringify({ query_str: 'best espresso machine' }) },
  );

  assert.ok(result.queryTexts.includes('best espresso machine under 1000'));
  assert.ok(result.queryTexts.includes('espresso machine reliability ratings'));
  assert.ok(result.queryTexts.includes('best espresso machine 2026 reviews'));
  assert.equal(result.prompt, 'best espresso machine');
  assert.equal(result.conversationKey, 'c9f0e1d2-2222-4ccc-8888-112233445566');
});

test('perplexity: maps web_results including the name field as title', () => {
  const result = runCapture(
    'perplexity',
    'https://www.perplexity.ai/rest/sse/perplexity_ask',
    fixture('perplexity-sse.txt'),
  );

  const serious = result.sources.find((s) => s.url.includes('seriouseats.com'));
  assert.equal(serious.title, 'The 8 Best Espresso Machines');
  assert.equal(serious.snippet, 'We tested 40 machines over six months.');
});

test('perplexity: decodes JSON nested as a string inside a step', () => {
  const result = runCapture(
    'perplexity',
    'https://www.perplexity.ai/rest/sse/perplexity_ask',
    fixture('perplexity-sse.txt'),
  );
  assert.ok(
    result.queryTexts.includes('best espresso machine 2026'),
    'the INITIAL_QUERY step encodes its payload as a JSON string',
  );
});

// ------------------------------------------------------------------ Gemini ---

test('gemini: mines sources out of wrb.fr batchexecute frames', () => {
  const result = runCapture(
    'gemini',
    'https://gemini.google.com/_/BardChatUi/data/batchexecute',
    fixture('gemini-batchexecute.txt'),
  );

  assert.ok(result.sourceUrls.some((u) => u.includes('blog.google')));
  assert.ok(result.sourceUrls.some((u) => u.includes('deepmind.google')));
  const blog = result.sources.find((s) => s.url.includes('blog.google'));
  assert.equal(blog.title, 'Google AI blog: August update', 'title read from the adjacent slot');
});

test('gemini: finds queries under a named key even in positional payloads', () => {
  const result = runCapture(
    'gemini',
    'https://gemini.google.com/_/BardChatUi/data/batchexecute',
    fixture('gemini-batchexecute.txt'),
  );
  assert.ok(result.queryTexts.includes('ai launches august 2026'));
});

test('gemini: decodes a double-encoded batchexecute request body', () => {
  const body = `f.req=${encodeURIComponent(
    JSON.stringify([null, JSON.stringify([['what shipped in ai this week'], null, ['c_1']])]),
  )}&at=abc`;
  const decoded = decodeBatchExecuteRequest(body);
  assert.equal(promptFromBatchExecute(decoded), 'what shipped in ai this week');
});

// -------------------------------------------------------------- Google AI ----

test('google: mines fan-out queries adjacent to marker tokens', () => {
  const site = structuredClone(RULES.sites.google);
  site.network.arrayMiner.queryMarkers = ['fanout'];

  const result = runCaptureWithSite(
    'google',
    site,
    'https://www.google.com/search?q=ev+tax+credit&udm=50',
    fixture('google-aimode.txt'),
  );

  assert.ok(result.queryTexts.includes('electric car tax credit 2026'));
  assert.ok(result.queryTexts.includes('ev rebate income limits'));
  assert.ok(result.queryTexts.includes('used ev credit rules'));
});

test('google: takes the prompt from the q parameter', () => {
  const result = runCapture(
    'google',
    'https://www.google.com/search?q=electric+car+tax+credit&udm=50',
    fixture('google-aimode.txt'),
  );
  assert.equal(result.prompt, 'electric car tax credit');
  assert.equal(promptFromUrl('https://www.google.com/search?q=hello+world'), 'hello world');
});

test('google: drops asset URLs while keeping real sources', () => {
  const result = runCapture(
    'google',
    'https://www.google.com/search?q=ev&udm=50',
    fixture('google-aimode.txt'),
  );
  assert.ok(result.sourceUrls.some((u) => u.includes('irs.gov')));
  assert.ok(!result.sourceUrls.some((u) => u.includes('googleusercontent')));
});

test('google: unwraps /url?q= redirect links', () => {
  assert.equal(
    unwrapRedirect('https://www.google.com/url?q=https://example.com/page&sa=U'),
    'https://example.com/page',
  );
  assert.equal(unwrapRedirect('https://example.com/direct'), 'https://example.com/direct');
  assert.equal(unwrapRedirect('not a url'), 'not a url');
});

// ------------------------------------------------------------ engine core ---

test('endpoint matching follows the rules patterns', () => {
  assert.ok(matchesEndpoint('https://chatgpt.com/backend-api/f/conversation', RULES.sites.chatgpt));
  assert.ok(!matchesEndpoint('https://chatgpt.com/static/app.js', RULES.sites.chatgpt));
});

test('a payload with nothing to find yields no result', () => {
  const context = new CaptureContext('claude', RULES.sites.claude, 'https://claude.ai/x/completion');
  assert.equal(ingestChunk(context, 'data: {"type":"ping"}\n\n'), null);
});

test('malformed payloads never throw', () => {
  const context = new CaptureContext('claude', RULES.sites.claude, 'https://claude.ai/x/completion');
  assert.doesNotThrow(() => {
    ingestChunk(context, 'data: {broken json\n\n');
    ingestChunk(context, '  garbage');
    ingestRequest(context, 'not json at all');
    finishCapture(context);
  });
});

test('the heuristic layer rescues a site whose rules paths have gone stale', () => {
  // Simulate drift: every configured path points somewhere that no longer exists.
  const brokenSite = structuredClone(RULES.sites.perplexity);
  brokenSite.network.queryPaths = ['$.nonexistent[*].gone'];
  brokenSite.network.sourcePaths = [{ root: '$.also.missing[*]', url: 'url' }];

  const result = runCaptureWithSite(
    'perplexity',
    brokenSite,
    'https://www.perplexity.ai/rest/sse/perplexity_ask',
    fixture('perplexity-sse.txt'),
  );

  assert.ok(result.queryTexts.length > 0, 'heuristics still find queries');
  assert.ok(result.sources.length > 0, 'heuristics still find sources');
  assert.ok(
    result.sourceUrls.some((url) => url.includes('seriouseats.com')),
    'the same sources are recovered without working rules paths',
  );
});

test('normalizeDomCapture converts a DOM scrape into a dom-strategy result', () => {
  const result = normalizeDomCapture(
    {
      siteId: 'google',
      prompt: 'ev tax credit',
      queries: ['ev rebate limits', '  ev rebate limits  ', ''],
      sources: [
        { url: 'https://www.google.com/url?q=https://irs.gov/credits&sa=U', title: 'IRS' },
        { url: 'javascript:void(0)', title: 'bad' },
      ],
      ts: 1000,
    },
    RULES.sites.google,
  );

  assert.equal(result.strategy, 'dom');
  assert.equal(result.confidence, 0.7);
  assert.deepEqual(result.queries.map((q) => q.text), ['ev rebate limits']);
  assert.deepEqual(result.sources.map((s) => s.url), ['https://irs.gov/credits']);
  assert.equal(result.prompt, 'ev tax credit');
});

test('normalizeDomCapture returns null when the scrape found nothing', () => {
  assert.equal(normalizeDomCapture({ queries: [], sources: [] }, RULES.sites.google), null);
  assert.equal(normalizeDomCapture(null, RULES.sites.google), null);
});
