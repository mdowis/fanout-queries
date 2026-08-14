# Testing

> Stub — the offline suite and the full manual matrix land with the implementation phases.

## Offline test suite

The parsing/health/export logic is pure, `chrome`-free JavaScript, tested with Node's built-in runner (no dependencies):

```bash
node --test test/
```

## Manual verification matrix

For each supported site:

1. Open the side panel (⟨⟩ toolbar icon).
2. Ask a freshness-forcing question — e.g. *"latest news about the stock market today"*.
3. Confirm: the prompt is captured, at least one fan-out query appears, at least one cited source appears, the strategy badge (N/D/H) is correct, and the site's LED is green.
4. **Regression check that matters most:** the site itself must behave completely normally — the interceptor must never alter page behavior.
