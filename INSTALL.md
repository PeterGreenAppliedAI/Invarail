# Installing Invarail

Invarail is built as a ladder: start with almost nothing, add capabilities one
config block at a time. **Every tier degrades gracefully to the one below** —
remove a piece and the feature disappears; nothing breaks.

| Tier | You need | You get | Time |
|------|----------|---------|------|
| **0 — Try** | Node 22+, [Ollama](https://ollama.com), one ~8GB model | Chat with persistent memory in the web console | ~15 min |
| **1 — Run** | + `docker compose up -d` (2 sidecars), + a Discord/Telegram token | Daily-driver assistant: graph memory, real web search, heartbeat, briefings, cron reminders | +30 min |
| **2 — Own** | + Docker exec sandbox, Google OAuth (read-only), a vision model | Sandboxed code execution, email/calendar, documents & PDFs, image understanding, browser extension | +1–2 h |
| **3 — Fleet** | Multiple inference hosts | The reference build: vLLM backends, compiled [FlowMCP](https://github.com/PeterGreenAppliedAI/FlowMCP) workflows, verified research reports | a weekend |

## Tier 0 — fifteen minutes to a working agent

```bash
# 1. A local model (any capable 7-14B instruct model works)
ollama pull qwen3:8b

# 2. Invarail
git clone <this repo> && cd Invarail && npm install

# 3. Either run the wizard…
npm run setup        # choose "Starter" at the first question

# …or copy the preset by hand:
cp invarail.config.starter.json5 invarail.config.json5

# 4. Start, then open http://localhost:3100
npm start
```

That's the whole thing: one model routes and chats, memory persists to flat
files under `data/`, and the web console needs no accounts. The starter preset
is commented with exactly where each upgrade plugs in.

## Tier 1 — the daily driver

```bash
docker compose up -d      # FalkorDB (graph memory) + SearXNG (web search)
```

Then in your config:
- Graph memory needs **no config** — Invarail finds FalkorDB on localhost:6379
  and upgrades memory in place (flat files remain the automatic fallback).
- Web search: add `tools.web.search` pointing at SearXNG
  (`http://localhost:8080`) and a `web_search` router category + specialist.
- A chat channel: `channels.discord: { enabled: true, token: "${DISCORD_TOKEN}" }`
  (token in `.env`). Telegram, Slack, and WhatsApp follow the same shape.

## Tier 2 — power user

- **Sandboxed execution:** `tools.exec` with the Docker backend (or a strict
  command allowlist).
- **Email/calendar (read-only):** Google OAuth via `scripts/` setup; tools are
  owner-gated in code — only `ownerId` ever sees them.
- **Documents:** LibreOffice headless gives PDF/DOCX/XLSX creation. Models
  write markdown; code owns the styling.
- **Vision:** any Ollama vision model in the `vision` block; the Chrome
  extension (in `chrome-extension/`) adds page context and screenshots.

## Tier 3 — the reference fleet

The maintainer's build: DGX Spark running vLLM for the foreground model
(`inference.backends[]` routes by model id), a dedicated image-gen host,
self-hosted SearXNG, and [FlowMCP](https://github.com/PeterGreenAppliedAI/FlowMCP)
serving compiled workflows through the MCP bridge (see README → "Add an MCP
server"). Nothing at this tier is required by the tiers below — it's what the
architecture grows into, not what it demands.

## Sanity checks

- `npm test` — the suite includes a starter-preset boot check: the Tier 0
  config must always parse and boot with zero sidecars running.
- `npx tsc --noEmit` — type check.
- The web console's status page shows which subsystems found their
  dependencies (graph vs. flat memory, which channels connected, which tools
  registered).
