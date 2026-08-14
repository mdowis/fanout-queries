<div align="center">

# ⟨⟩ FANOUT_QUERIES

### See what the AI *actually* searched.

**A self-healing Chrome extension that exposes the hidden web searches behind every AI answer — live, in a neon side panel.**

</div>

---

Every time you ask ChatGPT, Claude, Perplexity, Gemini, or Google AI Mode a question, the model quietly **fans out** — decomposing your prompt into a swarm of web searches you never see, pulling sources you never chose.

**Fanout Queries pulls back the curtain.** Ask your question, and watch the side panel light up with:

- 🧠 **The original prompt** — what you actually asked
- 🔍 **Every fan-out query** — the exact searches the AI ran behind the scenes
- 🔗 **Every cited source** — the URLs the answer was built from, attributed to the query that found them

All rendered in a **cyberpunk dashboard** that streams captures in real time.

## Why you'd want this

- **SEO & AI visibility research** — learn which queries AI assistants generate for your topic, and which pages they cite. This is the new search ranking.
- **Prompt engineering** — see how phrasing changes the search strategy the model picks.
- **Transparency** — know where an AI answer really came from before you trust it.
- **Curiosity** — it's genuinely fascinating to watch a model think in queries.

## It heals itself

AI chat sites change their internals *constantly*. Capture tools usually die in a week. Fanout Queries is built to survive:

- **Three extraction layers per site** — network interception → DOM scraping → generic heuristics. When one layer goes dark, the next takes over automatically.
- **Live health monitor** — green/amber/red status LEDs per site show exactly which strategy is active and when it last captured.
- **Remote rules** — selectors and endpoint patterns load from a versioned rules file in this repo. When a site ships a breaking change, a rules update fixes it — no reinstall, no waiting for a new release.

## Supported platforms

| Platform | Capture |
|---|---|
| ChatGPT (chatgpt.com) | ✅ queries + sources |
| Claude (claude.ai) | ✅ queries + sources |
| Perplexity | ✅ queries + sources |
| Gemini (gemini.google.com) | ✅ sources + best-effort queries |
| Google AI Mode / AI Overviews | ✅ DOM-first capture |

## Quick start

1. **Clone** this repo (or download it as a ZIP and unzip):
   ```bash
   git clone https://github.com/mdowis/fanout-queries.git
   ```
2. Open **`chrome://extensions`**, flip on **Developer mode** (top right).
3. Click **Load unpacked** and pick the repo folder.
4. Click the ⟨⟩ toolbar icon to open the side panel, then ask any AI assistant something that needs the web — *"what happened in tech news today?"*
5. Watch the fan-out.

Requires Chrome 116+.

## Your data stays yours

Everything is captured **locally** and stored **locally** (`chrome.storage.local`). Nothing is transmitted anywhere — the only network request the extension itself makes is fetching its own rules file from GitHub. Export your captures anytime as **JSON** or **CSV**.

> Built for personal research and development use, loaded unpacked. Respect the terms of service of the sites you use it with.

## Documentation

| Doc | What's inside |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How capture works: message flow, adapters, the self-healing state machine |
| [docs/RULES.md](docs/RULES.md) | The remote rules schema + how to ship a fix when a site changes |
| [docs/TESTING.md](docs/TESTING.md) | Running the offline test suite + the per-site manual verification matrix |

---

<div align="center">
<sub>⟨⟩ FANOUT_QUERIES — the searches behind the answers.</sub>
</div>
