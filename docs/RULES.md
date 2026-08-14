# Extraction Rules

Extraction rules live in [`rules/default-rules.json`](../rules/default-rules.json). The same document serves two roles:

1. **Bundled** with the extension as the built-in fallback.
2. **Fetched remotely** from this repo's raw URL — so the repo is its own rules CDN, and a fix ships by pushing to `main`.

Rules resolve as: cached remote if it is valid and at least as new as the bundled copy, otherwise bundled. Validation is strict and failure is silent — **a bad remote push cannot disable capture**, it simply leaves the bundled rules in force.

## Shipping a fix

1. Edit `rules/default-rules.json`.
2. **Bump the top-level `version`.** A version that is not strictly newer is ignored.
3. Push to `main`.

Installed extensions pick it up on their next scheduled fetch (every 6 hours), immediately when a site's health monitor escalates, or when the user clicks **REFETCH RULES** in the panel's site-status popover.

## Document shape

```jsonc
{
  "schemaVersion": 1,          // must be 1; anything else is rejected
  "version": 3,                // bump to publish
  "fetch": {
    "url": "https://raw.githubusercontent.com/.../default-rules.json",
    "intervalHours": 6,
    "failureRefetchMinutes": 30
  },
  "sites": { /* see below */ },
  "heuristics": { /* layer 3 tuning */ }
}
```

### A site block

```jsonc
"chatgpt": {
  "label": "ChatGPT",                              // shown in the panel
  "hosts": ["chatgpt.com"],                        // matched against the tab hostname
  "strategyOrder": ["network", "dom", "heuristic"],// starting precedence

  "network": {
    "endpoints": [                                 // which requests to parse
      { "urlPattern": "/backend-api/f/conversation", "kind": "sse" }
    ],
    "promptPaths": ["$req.messages[*].content.parts[*]"],
    "conversationKeyPaths": ["$.conversation_id"],
    "queryPaths": ["$..search_queries[*].q"],
    "sourcePaths": [
      { "root": "$..search_result_groups[*].entries[*]",
        "url": "url", "title": "title", "snippet": "snippet", "query": "attribution" }
    ]
  },

  "dom": {
    "turnContainer":     "article[data-testid^='conversation-turn']",
    "promptSelector":    "[data-message-author-role='user'] .whitespace-pre-wrap",
    "querySelectors":    ["[data-testid='search-queries'] span"],
    "citationSelectors": ["a[href^='http'][target='_blank']"],
    "composerSubmit":    "button[data-testid='send-button']",
    "settleDebounceMs":  1200
  }
}
```

Other fields available in `network`:

| Field | Use |
|---|---|
| `promptFromUrlParam` | Read the prompt from a URL query parameter (Google) |
| `promptFromForm` | Read it from a form-encoded request field (Gemini) |
| `arrayMiner` | `{queryMarkers, maxDepth}` for positional array payloads |

And in `dom`: `linkUnwrap` (`{param, pathPrefix}`) unwraps redirect links such as Google's `/url?q=`.

## Path syntax

A deliberately small JSONPath dialect, sized for these rules and nothing more.

| Syntax | Meaning |
|---|---|
| `$` | root of the response payload |
| `$req` | root of the request payload |
| `.key` or `['key']` | property access (use brackets for names containing dots) |
| `[0]`, `[-1]` | array index; negative counts from the end |
| `[*]` | every element of an array, or every value of an object |
| `..` | recursive descent |
| `[?key]` | keep only current nodes that are objects owning `key` |

Anything that does not match yields nothing rather than an error, so listing several candidate paths is free — and is the recommended way to survive a rename:

```json
"queryPaths": ["$..search_queries[*].q", "$..search_queries[*].query", "$..search_queries[*]"]
```

**Prefer `..` over literal paths.** Deep scan is the drift-resistance workhorse: `$..search_queries[*].q` keeps working when a site renests its payload, where `$.message.metadata.search_queries[*].q` breaks.

`[?key]` filters the current node set rather than descending on its own, so it composes predictably: `$..[?input]` matches each owner of `input` exactly once, and `$.content[*][?input]` filters that array's elements.

## Source mapping

Each entry in `sourcePaths` names a `root` selecting result objects, plus the field names to read from them:

```jsonc
{ "root": "$..web_results[*]",
  "url": "url", "title": "name", "snippet": "snippet",
  "query": "attribution" }   // optional: field holding the query that found it
```

Objects under `root` without a usable URL are skipped, so a broad root is safe.

## Diagnosing a broken site

Open the panel and click the site's row in **SITE STATUS**. The popover shows each strategy's last success, hit count, and current miss streak, plus the rules version in force.

- **network misses climbing, dom or heuristic still succeeding** → the endpoint pattern or the JSON paths are stale. Most common fix.
- **every strategy missing** → the endpoint is probably not being seen at all. Check `endpoints[].urlPattern` against a real request URL in DevTools.
- **queries captured, no sources** → `sourcePaths` roots are stale.
- **nothing anywhere, and the site changed its UI** → update the `dom` selectors too.

The heuristic layer usually keeps some capture alive while a fix is prepared, which is exactly what it is there for.

## Testing a rules change

```bash
npm test
```

`test/adapters.test.js` runs each site's fixture through the real engine using the real rules file, so a path you break there fails immediately. To confirm the *heuristic* backstop still covers a site, see the drift simulation in that file — it breaks every configured path deliberately and asserts capture survives.
