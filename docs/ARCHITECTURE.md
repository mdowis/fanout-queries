# Architecture

Fanout Queries is a Manifest V3 extension with **no build step**: plain ES modules, no dependencies, loaded unpacked straight from the repo root.

One constraint shapes the layout. Content scripts cannot be ES modules, so `content/interceptor.js` and `content/relay.js` are single self-contained IIFEs with zero imports. Everything shareable — parsers, the health state machine, export — lives in `lib/` as ES modules used only by the service worker, the side panel, and the Node test suite. That is also why `lib/` contains no `chrome.*` calls in its parsing code: it keeps those modules testable without a browser.

## Capture pipeline

```
┌─ PAGE (a chatbot tab) ──────────────────────────────────────────────┐
│                                                                     │
│  MAIN world · content/interceptor.js · document_start               │
│    patches fetch / XMLHttpRequest / WebSocket                       │
│    reads only from response.clone(); never touches the original     │
│                          │ CustomEvent '__fq_capture'               │
│  ISOLATED world · content/relay.js · document_start                 │
│    batches and forwards captures                                    │
│    runs the DOM scraping strategy (layer 2)                         │
│    detects chat turns                                               │
└──────────────────────────┬──────────────────────────────────────────┘
                           │ chrome.runtime messaging
┌──────────────────────────▼──────────────────────────────────────────┐
│  background/service-worker.js                                       │
│    rules-manager  →  extraction engine  →  session assembly          │
│                            │                      │                 │
│                      health monitor         chrome.storage.local    │
└──────────────────────────┬──────────────────────────────────────────┘
                           │ long-lived Port
                    sidepanel/panel.js
```

## The prime directive

The interceptor must never alter page behavior. A missed capture is a nuisance; a broken chat site is unacceptable. Concretely:

- The page's `fetch` promise is returned untouched. Observation happens on a derived promise whose rejection is swallowed, so the page still owns the real one.
- Response bodies are read only from `response.clone()`. The original stream is never consumed, `tee()`d, or locked.
- Every observation path is individually wrapped, down to the event emission itself.
- Reads are capped at 10 MB per response.
- Request bodies are cloned *synchronously* before `fetch` is called, since a `Request` body cannot be read once consumed.

`test/interceptor.test.js` loads the real file into a `vm` and asserts these properties directly — including that a deliberately exploding `CustomEvent` constructor still leaves the page's response readable.

## Extraction: three layers

Every payload runs through both network layers. They are cheap next to the network I/O that produced the payload, and results dedupe by normalized text, so a redundant hit costs nothing while a unique one saves the capture.

| Layer | Source | Confidence | Role |
|---|---|---|---|
| 1 · network | rules-driven JSON paths over decoded payloads | 1.0 | Precise, and the first thing to break when a site changes |
| 2 · DOM | `MutationObserver` scraping via rules selectors | 0.7 | Runs in the relay; strongest where fan-out is rendered visibly |
| 3 · heuristic | shape-based deep scan | 0.4 | Backstop that survives renamed and renested fields |

Confidence drives dedupe precedence: a later network hit *upgrades* an earlier heuristic guess in place rather than duplicating it.

### Adapters decode transport, rules extract fields

An adapter's job is to turn a site's wire format into plain JSON values. Which fields to read is left to the rules file, so a renamed field is a rules push rather than a release.

- **Claude** — SSE. Search queries arrive as `input_json_delta` fragments that are not valid JSON individually, so the adapter accumulates them per content-block index and parses eagerly. This is stateful decoding that no declarative path could express.
- **ChatGPT** — SSE with delta-patch events that mutate previously sent messages. Rather than reconstructing the document, each event is deep-scanned, and `search(...)` calls addressed to the web tool are recovered by pattern.
- **Perplexity** — SSE and WebSocket frames, with JSON documents nested *as strings* inside step entities; those get a second decode pass.
- **Gemini** and **Google AI Mode** — anti-XSSI-prefixed positional arrays, `wrb.fr` envelopes holding JSON-inside-JSON. There are no field names at all, so extraction leans on array mining (URL/title adjacency, and labels that appear as string elements rather than keys).

Sites named in the rules but absent from the adapter registry still work through generic SSE/JSON decoding plus heuristics — a rules push can add a site before any code ships.

## Self-healing

Two mechanisms, joined at one seam.

**Layered fallbacks.** The health monitor watches each site. The relay reports every chat turn, which supplies the denominator: without it, a quiet session and a broken capture look identical.

Two failures are charged distinctly:

- a turn nothing captured — increments the uncaptured streak that drives red
- a turn captured *only by a fallback* — still a miss for the preferred strategy

The second is what matters. Without it, DOM scraping covering for a dead network layer would look perfectly healthy, and the break would stay invisible.

After three misses the head strategy is demoted behind the next. Demotion changes precedence and reporting, never execution — every strategy keeps running. What demotion buys is an accurate answer to *which layer is actually holding this site up right now*. Only a previously demoted strategy is promoted back, so a fallback that happens to win a race cannot claim the lead.

**Remote rules.** When fallbacks are not enough — red, or yellow for five consecutive turns — the site escalates to a rules refetch (throttled to once per 30 minutes, so repeated failures cannot hammer the network). Newly adopted rules reset every site's counters, because the numbers that made a site look broken were earned by the *old* rules; judging a repair on them would either mask it or re-escalate immediately.

Status: **green** capturing normally · **yellow** running on a fallback, or a recent turn was missed · **red** three consecutive turns captured nothing.

## Storage and worker lifetime

MV3 evicts the service worker aggressively, so nothing authoritative is held in memory:

- Extraction results are written through to `chrome.storage.local` as they are produced. An eviction costs at most the tail of one in-flight response.
- Which session a tab is writing to lives in `chrome.storage.session`, so a mid-conversation restart keeps appending to the same session instead of splitting it.
- Per-request decode state is inherently ephemeral — a stream in flight cannot survive eviction anyway — and abandoned contexts are swept on an alarm.

`chrome.storage.local` is used rather than IndexedDB: sessions are small structured text, the API is identical from the worker and the panel, and a ring buffer (200 sessions / 8 MB) bounds growth.

## Untrusted data

Everything captured is page content authored by someone else. The side panel renders all of it with `textContent`, never `innerHTML`, and sets an `href` only after confirming the URL is `http(s)`. The `CustomEvent` bridge carries a JSON string that is parsed and shape-checked, never evaluated.
