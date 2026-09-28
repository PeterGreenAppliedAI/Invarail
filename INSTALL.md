# Installing Invarail

Invarail is built as a ladder: start with almost nothing, add capabilities one
config block at a time. **Every tier degrades gracefully to the one below** —
remove a piece and the feature disappears; nothing breaks.

| Tier | You need | You get | Time |
|------|----------|---------|------|
| **0 — Try** | Node 22+, [Ollama](https://ollama.com), one model (qwen3.5:9b, 6.6GB; qwen2.5:7b on 8GB RAM) | Chat with persistent memory in the web console | ~15 min |
| **1 — Run** | + `docker compose up -d` (2 sidecars), + a Discord/Telegram token | Daily-driver assistant: graph memory, real web search, heartbeat, briefings, cron reminders | +30 min |
| **2 — Own** | + Docker exec sandbox, Google OAuth (read-only), a vision model | Sandboxed code execution, email/calendar, documents & PDFs, image understanding, browser extension | +1–2 h |
| **3 — Fleet** | Multiple inference hosts | The reference build: Ollama-native hosts by role (plus vLLM for coding), compiled [FlowMCP](https://github.com/PeterGreenAppliedAI/FlowMCP) workflows, verified research reports | a weekend |

## Model minimums (measured)

Two runs of the same harness — [20B–124B in August](evals/2026-08-local-model-eval/) and
[3.8B–14.7B on September 27](evals/2026-09-small-tier/) — draw the lines:

| Role | Floor | Comfortable |
|---|---|---|
| Router · NER · extraction · consolidation | phi4-mini (3.8B) | phi4 (14B) |
| Embeddings | qwen3-embedding:4b | qwen3-embedding:8b |
| **Foreground: chat + tools** | **qwen3.5:9b, `think: false`** (92%, 6.6GB) — or gemma4:12b (92%, better code) | a 27B with thinking off (97–100%) |
| Research (the pipeline does the scaffolding) | qwen2.5:7b runs it end to end — verified claims, PDF | a 27B writes noticeably better prose |
| Coding (Pi) | 27B | 27B+ or a hosted model |

Those are engine numbers. The same models were also run **as Invarail** — a wizard-generated
config through the real router, specialists, stores and pipelines
([evals/2026-09-e2e](evals/2026-09-e2e/)): gemma4:12b 100%, qwen3.5:9b 94%, qwen2.5:7b 92%,
research at 100% on all three. Where a small model misses, it is discipline (answering in
prose instead of calling the tool, or inventing a number when its code fails), not capability.

Native tool use begins at 9–12B; qwen2.5:7b (81%) is the fallback for an 8GB machine.
phi4 and the gemma3 small models cannot native-tool-call on Ollama at all (their chat
templates lack it) — router/extraction only. `npm run doctor` tells you whether your
foreground model fits this machine.

Posture: one owner on a LAN with the web token is the supported shape (SECURITY.md); a
multi-user or internet-facing install is not a claim this project makes.

| Machine | Fits |
|---|---|
| 8GB RAM, no GPU | qwen2.5:7b doing everything — chat, most tools, no code |
| **8GB GPU** | **qwen3.5:9b at 16K context (6.0GB loaded)** — no embedder beside it (`memory.embeddingModel: "none"`, flat or vault tier) |
| 16GB RAM or a 12GB GPU | qwen3.5:9b (or gemma4:12b) foreground + phi4-mini utility |
| 24GB GPU or 32GB unified | a 27B foreground + the utility pair — everything |

Loaded footprints, measured on Ollama (what the card actually holds, KV cache included):

| Model | 8K context | 16K context |
|---|---|---|
| qwen3.5:9b | 5.7GB | 6.0GB — hybrid attention, the KV cache barely grows |
| qwen2.5:7b | 5.1GB | 5.6GB |
| gemma4:12b | 8.4GB | 8.4GB — not an 8GB-card model |

**Windows:** the test suite and the front-door selftest run green on `windows-latest` in
CI on every push, and the wizard's headless smokes run there too — so a clean Windows
checkout installs and passes its checks. It is not yet a *supported install*: no Windows box
has run `npm start` against a real Ollama, and the supervisor (`scripts/supervisor.sh`) is
bash. Docker Desktop, LibreOffice (`soffice.exe`) and the `py`/`python` launcher are all
detected; `python3` is never assumed.

## Tier 0 — fifteen minutes to a working agent

```bash
# 1. A local model — qwen3.5:9b is the measured floor for tool use (6.6GB);
#    qwen2.5:7b on an 8GB machine
ollama pull qwen3.5:9b

# 2. Invarail
git clone <this repo> && cd Invarail && npm install

# 3. Either run the wizard…
npm run setup        # choose "Starter" at the first question

# …or copy the preset by hand:
cp invarail.config.starter.json5 invarail.config.json5

# 4. Check the machine, then start (builds the console the first time)
npm run doctor       # every dependency, found or missing, with the install command
npm start            # runs the doctor quietly first; open http://localhost:3100
```

That's the whole thing: one model routes and chats, memory persists to flat
files under `data/`, and the web console needs no accounts. The starter preset
is commented with exactly where each upgrade plugs in.

The wizard **detects before it asks**: it probes Ollama (and offers to pull a
first model if there are none), Docker, FalkorDB, SearXNG, LibreOffice and
Python, and only asks the questions that are yours — which model, whether the
console should be reachable from other devices (it generates the token), which
channels. The model question is **ranked by the evals above and by what fits
your GPU or RAM**: every installed model shows its measured score, the thinking
mode that scored best, its size and whether it fits; measured models that fit
come first, unmeasured after, and models that cannot native-tool-call say so.
The generated config carries that thinking mode, and a **prompt profile** for the
model's tier: a ≤14B foreground gets `promptProfile: "small"` (chat carries the
minimal workspace set, files are capped, one 16K context for router, extraction and
session) — measured in [evals/2026-09-e2e](evals/2026-09-e2e/). `npm run doctor`
re-checks the same list any time, against what your config enables, warns when the
profile no longer matches the model line, and prints the fix beside each miss.

It also asks **how Invarail should remember**, with the default chosen from what it
found: `graph` (FalkorDB + an embedding model — the reference setup), `flat` (JSONL
facts, keyword recall, nothing to install), `vault` (flat facts plus your markdown folder,
Obsidian-edited, exact-word search, no embedder), or `vault + OKF` (the folder as an
Open Knowledge Format bundle: facts mirrored as notes with provenance, an `index.md`
per folder the model navigates, a `log.md` history). For the vault tiers it creates the
folder if it is new, detects Obsidian, and offers the install command if it is missing
(never runs it unasked — the vault is plain markdown and works with any editor). Details
and the trade-offs:
[MEMORY-SYSTEM.md](MEMORY-SYSTEM.md#memory-tiers-the-same-memory-on-a-machine-that-is-not-this-one).

## Tier 1 — the daily driver

```bash
docker compose up -d      # FalkorDB (graph memory) + SearXNG (web search)
```

Then in your config:
- Graph memory needs **no config** — Invarail finds FalkorDB on localhost:6379
  and upgrades memory in place (flat files remain the automatic fallback).
- Web search: add `tools.web.search` pointing at SearXNG
  (`http://localhost:8080`) and a `web_search` router category + specialist.
  **Read [SEARXNG.md](SEARXNG.md) first** — a metasearch instance spends *your*
  IP's reputation with every engine it queries. The compose file mounts a
  suggested `searxng/settings.yml`; set `dailyQueryCeiling` in the search config.
  A hosted provider key (Brave, Perplexity, Grok, Tavily) avoids the issue.
- A chat channel: `channels.discord: { enabled: true, token: "${DISCORD_TOKEN}" }`
  (token in `.env`). Telegram follows the same shape; Gmail is read-only and uses OAuth (see FEATURES.md).
- **Reaching the console from another device** (phone, the Chrome extension on
  a laptop): the starter binds `127.0.0.1`. To open it to your LAN, set
  `host: "0.0.0.0"` AND `token: "${WEB_TOKEN}"` on `channels.web`, put a
  long random `WEB_TOKEN` in `.env` (`openssl rand -hex 32`), and paste it into
  the console's Login page and the extension's settings. Invarail refuses to
  start network-open without a token — every web page on your network could
  otherwise act as you.

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

The maintainer's build (2026-09): a 24GB A5000 serving the foreground model
Ollama-native (`inference.ollamaBackends[]` routes by model id), a 3060 for the
utility tier (router, extraction, NER), a Mac mini that only embeds, the DGX
Spark running vLLM for coding (`inference.backends[]`), a dedicated image-gen
host, self-hosted SearXNG, mlx-audio for voice and a Laya shadow router on the
Mac mini that runs Invarail itself, and
[FlowMCP](https://github.com/PeterGreenAppliedAI/FlowMCP) serving compiled
workflows through the MCP bridge (see README → Extending). Nothing at this tier
is required by the tiers below — it's what the architecture grows into, not what
it demands.

## Sanity checks

- `npm test` — the suite includes a starter-preset boot check: the Tier 0
  config must always parse and boot with zero sidecars running.
- `npx tsc --noEmit` — type check.
- The web console's status page shows which subsystems found their
  dependencies (graph vs. flat memory, which channels connected, which tools
  registered).
