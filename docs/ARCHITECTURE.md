# Architecture

> Stub — full documentation lands with the implementation phases.

Fanout Queries is a Manifest V3 extension with no build step: plain ES modules, loaded unpacked from the repo root.

## Components

- `content/interceptor.js` — MAIN-world content script (document_start). Patches `fetch`, `XMLHttpRequest`, and `WebSocket` to observe request/response bodies (including SSE streams) without disturbing the page. Emits captures via `CustomEvent`.
- `content/relay.js` — ISOLATED-world content script. Relays captures to the service worker, runs the DOM-scraping fallback layer, and detects chat turns.
- `background/service-worker.js` — message hub: rules manager, extraction engine, session manager, health monitor, storage.
- `lib/` — pure ES modules (parsers, health state machine, export) shared by the service worker, side panel, and the Node test suite.
- `sidepanel/` — the dashboard UI.

## Message flow

```
page traffic → interceptor (MAIN) → CustomEvent → relay (ISOLATED)
            → chrome.runtime message → service worker
            → extraction engine → session manager → chrome.storage.local
            → port broadcast → side panel
```

More detail to come.
