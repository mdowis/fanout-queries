# Testing

## Offline suite

The parsing, session, health, and export logic is pure JavaScript with no `chrome` dependencies, tested with Node's built-in runner. No dependencies to install:

```bash
npm test          # or: node --test 'test/*.test.js'
```

| File | Covers |
|---|---|
| `json-path.test.js` | Path evaluator: wildcards, deep scan, negative indices, key filters, missing paths |
| `sse.test.js` | SSE reassembly across chunk boundaries, CRLF, multi-line `data:`, `[DONE]`, anti-XSSI framing |
| `heuristics.test.js` | Shape scanning, attribution, opaque-id rejection, denylists, **drift resistance** |
| `adapters.test.js` | Each site's fixture through the real engine and the real rules file |
| `sessions.test.js` | Turn boundaries, confidence-ranked dedupe, URL canonicalization, attribution inference |
| `health.test.js` | Every state transition: demotion, promotion, escalation, recovery |
| `export.test.js` | CSV escaping, BOM, orphan rows, JSON round-trip |
| `interceptor.test.js` | The prime directive — that the interceptor never disturbs the page |

Two tests deserve special mention, because they cover the claims this project actually rests on:

- **`heuristics.test.js` → "survives renamed containers"** takes a payload, renames every wrapper key, renests it two levels deeper, and asserts the same queries and sources still come out.
- **`adapters.test.js` → "the heuristic layer rescues a site whose rules paths have gone stale"** points every configured path at somewhere that does not exist, and asserts capture continues.

## Manual verification

Load unpacked (`chrome://extensions` → Developer mode → Load unpacked → this folder), open the side panel, then for each site:

| Site | Try |
|---|---|
| ChatGPT | "what happened in tech news today?" |
| Claude | "what shipped in AI this week?" |
| Perplexity | "best espresso machine under $1000" |
| Gemini | "latest news about electric vehicles" |
| Google AI Mode | any query, then open the AI Mode tab |

For each, confirm:

1. The prompt appears in **LIVE CAPTURE**.
2. At least one fan-out query appears as a chip.
3. At least one cited source appears, grouped under its query where the site provides attribution.
4. The strategy badge is what you expect — `N` network, `D` DOM, `H` heuristic.
5. The site's LED is green.
6. **The site itself behaves completely normally.** This is the regression that matters most: navigate, send several messages, reload mid-stream. Any difference in the site's own behavior is a bug that outranks any capture gap.

Expect Google AI Mode and Gemini to lean on DOM and heuristic capture — their payloads carry no field names, and the rules ship `strategyOrder: ["dom", ...]` for Google accordingly.

## Verifying self-healing

You can force the failure the extension is built to survive:

1. Open the service worker console (`chrome://extensions` → **service worker** → Inspect).
2. Break a site's endpoint pattern in the cached rules:
   ```js
   const { 'rules:cache': cached } = await chrome.storage.local.get('rules:cache');
   const rules = cached ?? await (await fetch(chrome.runtime.getURL('rules/default-rules.json'))).json();
   rules.version = 999;
   rules.sites.chatgpt.network.endpoints = [{ urlPattern: '/gone', kind: 'sse' }];
   await chrome.storage.local.set({ 'rules:cache': rules });
   chrome.runtime.reload();
   ```
3. Ask that site three or four questions.
4. Watch the panel: the LED goes yellow, and the site's popover shows `network` accumulating misses and dropping out of the lead while `dom` keeps capturing.
5. Click **REFETCH RULES** to pull the real rules back and confirm the LED returns to green.

## Browser-level checks

The offline suite covers logic; the browser is where integration is proven. These were run during development with Playwright against the unpacked extension, and are worth repeating after significant changes:

- A mock chatbot streams a real SSE fixture; the page reads its own response back byte-for-byte intact while the extension captures from the clone.
- Captured queries, sources, and the conversation key land in `chrome.storage.local` under the expected session id.
- The panel page renders that session, and the LEDs reflect stored health.
- Export buttons produce a parseable JSON document and a BOM-prefixed CSV with one row per query and per source.
- Publishing deliberately broken rules degrades the site to yellow and demotes the network layer; publishing a repair restores network-first capture and green.
