# Extraction Rules

> Stub — full schema reference lands with the rules implementation phase.

Extraction rules (endpoint patterns, JSON paths, DOM selectors) live in [`rules/default-rules.json`](../rules/default-rules.json). The same file is:

1. **Bundled** with the extension as the built-in fallback.
2. **Fetched remotely** from this repo's raw URL, so a rules fix ships by pushing to `main` — no extension update needed.

## Shipping a fix

1. Edit `rules/default-rules.json`.
2. Bump the top-level `version` number.
3. Push to `main`. Installed extensions pick the change up on their next scheduled fetch, or immediately when their health monitor detects a broken site and triggers an out-of-band refetch.
