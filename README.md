# Invarail

**The authority plane for local AI agents — freedom below, governance above.**

*(Formerly LocalClaw. The name is invariant + rail: authority that cannot move, structure that exists so things move fast.)*

Invarail runs entirely on your own hardware: no cloud APIs, no per-token costs, no data leaving your machines. It is a **systems answer** to the agent problem, deliberately separated into layers:

- **An authority plane** — permissions, target-bound grants, a confirmation ledger, audit trails, and tool exposure the agent *cannot modify from inside*. Learning may inform execution; it may never expand authority.
- **A daily driver** — chat with graph memory, verified research reports, briefings, scheduling, image generation — on Discord/Telegram/Slack/WhatsApp/Gmail/web/Chrome through pluggable adapters.
- **A host for interchangeable workers** — coding runs through the [Pi](https://pi.dev) agent, repeatable procedures through [FlowMCP](https://github.com/PeterGreenAppliedAI/FlowMCP) flows, open-ended tasks through a governed ReAct loop. Workers have been swapped whole (OpenCode out, Pi in) without the architecture noticing.

Built for small local models (7-30B), where every failure is legible the same evening — which is exactly how this architecture was learned.

## The Doctrine: Constrain the Arena, Not Every Move

Two agent patterns both work, and Invarail runs both on purpose:

1. **Reduce the decision surface before the model sees it.** A router classifies intent; a specialist gets only the tools its category needs; deterministic pipelines own the workflow and the model only extracts parameters or synthesizes text. Correct for **known procedures** — a weekly research report should never pay a model to rediscover "collect N sources, validate claims, stop."
2. **Give the model a tiny set of general primitives inside a bounded space, and let it compose freely.** The Pi coding worker gets read/edit/write/bash — bash is a meta-tool — scoped to one directory, with acceptance criteria. Correct for **open problems**, where the procedure isn't known until the worker finds it.

The synthesis: define the arena — scope, authority, capability set, evidence required for success — then let the worker work. **Execution freedom is not authority freedom.** A worker may write 200 lines of helper code and retry twenty times; Invarail still decides which paths are writable, whether the network is reachable, which actions require confirmation, and what evidence makes the result count.

```
                     Invarail
                        │
              classify + authorize
                        │
         ┌──────────────┴──────────────┐
         │                             │
  known procedure                unknown / open task
         │                             │
         ▼                             ▼
  deterministic pipeline          bounded worker (Pi)
  known stop rules                small tool surface,
  validation stages               freedom inside the arena
         │                             │
         └──────────────┬──────────────┘
                        ▼
              external validation
                        ▼
              memory / outcomes / audit
```

## Why This Exists

Frontier-model agent frameworks assume a model that reliably handles 15+ tools, complex system prompts, and strict JSON. Local 7-30B models don't. They **narrate** tool calls instead of executing them, **hallucinate** tool names when given too many options, **burn budgets** on thinking and return empty completions, and **fail** complex schemas.

Invarail's response is structural, not prompt-hopeful:

- **Router + Specialist** — a fast model (phi4:14b) classifies intent into one category; each specialist sees only its tools. No 80-tool menus.
- **Deterministic pipelines** — most categories run typed stage sequences (extract → tool → synthesize → validate) where code decides "what step next," with grammar-constrained extraction, JSON repair, and per-stage degrade-not-abort fallbacks.
- **Everything measured** — a [published 39-row engine-in-the-loop model eval](evals/2026-08-local-model-eval/) drives model/config choices. The same model swung 82%→100% on one thinking flag; there are no universal settings, only measured ones.
- **Code gates, never model judgment** — every security boundary is enforced in code before any model is involved.

## The Authority Plane

Every message passes six layered filters in `src/dispatch.ts` before any model sees a tool:

1. `allowedCategories` — what this channel may do at all
2. `restrictedCategories` — blocked for untrusted users
3. `ownerOnlyTools` — **invisible** to everyone but the owner (stripped from the model's vocabulary — prompt injection cannot request what the model cannot see)
4. `blockedTools` — stripped for everyone on the channel
5. `restrictedTools` — stripped for untrusted users
6. `confirmTools` — preview first, execute only on confirmation

On top of the filters:

- **Pending-action ledger** — confirmations execute the *stored* call: sender-bound, single-use, 10-minute expiry, never model-regenerated parameters. Confirm/Deny buttons on Discord/Telegram synthesize the typed reply — never a second security path.
- **Autonomy ladder** — tools declare `{tier: silent | act_then_notify | propose_confirm, reversible, blastRadius}`. New externally-visible tools enter at `propose_confirm`. Every autonomous action is logged (`logAutonomousAction`) — the track record that justifies promotion, per action type, by evidence.
- **Target-bound standing grants** — reply `always <id>` to a confirmation and that exact tool→target pair stops asking. Never the whole tool. Principal-bound, minted only on successful execution, revocable via `!grants`. Tools without a target argument (exec) are structurally grant-ineligible.
- **Sandboxing** — exec runs in a Docker sandbox or against a command allowlist; all URL-fetching tools pass SSRF checks (scheme whitelist, DNS pre-flight, redirect hop validation); cron jobs run with write tools stripped and inherit owner identity only because the schedule itself is owner-authored (the code gate).

The invariant, pinned by tests: **experience informs execution; it never expands authority.** Learning modules cannot import from `security/`.

## Workers

### Pi — the coding substrate

All coding runs through the [Pi coding agent](https://pi.dev) (`@earendil-works/pi-coding-agent`, MIT, embedded via SDK, version-pinned) behind a single adapter (`src/coding/pi-session.ts` — every SDK surface in one swappable module). Invarail stopped competing as a coding harness and kept what is actually its own: routing, memory, governance, evaluation, pipelines, channels.

- **Bounded arena** — sessions are cwd-scoped to an isolated build directory; context-file discovery is suppressed so unrelated builds never inherit this repo's instructions; the tool surface is the config-declared allowlist.
- **Observed, not trusted** — lifecycle events (agent/turn boundaries, tool executions with durations and error flags) stream to metrics; every session's full JSONL transcript path is recorded, so "why do we believe this build worked" has provenance all the way down.
- **Validated externally** — the `code_gen` pipeline owns the workflow (enrich → build → test → bounded fix loop → local commit); the gate is the actual test outcome, never the model's self-assessment. Remote push is opt-in and off by default.

```json5
// invarail.config.json5
pi: {
  enabled: true,
  model: "sglang/qwen3.8-27b",   // provider/id from ~/.pi/agent/models.json — any OpenAI-compat server
}
```

Chosen on evidence: in an instrumented duel on a hidden 12-check acceptance suite, Pi + a local 27B produced contract-grade work with a self-authored 11-test behavioral suite in 384 seconds (artifacts in `evals/`). Roadmap: the same rail extends to Invarail modifying *itself* — worktree-isolated sessions, deterministic merge gates, ledger-confirmed merges, and a deliberately dumb supervisor (see DECISIONS.md, "Pi Becomes the Coding Substrate").

### FlowMCP — compiled procedures

Repeatable multi-step workflows live as [FlowMCP](https://github.com/PeterGreenAppliedAI/FlowMCP) flows served through the MCP bridge — the model picks a flow and fills 2-3 parameters instead of improvising orchestration. Naming a gathering flow in a research request makes the research pipeline use the flow's output as its facets and sources (strict explicit naming only — no semantic matching; that's an authority-hijack class).

### MCP bridge — external tools, small-model safe

Any MCP server's tools auto-register as Invarail tools (stdio or streamable-HTTP, fully-local OAuth with PKCE + DCR, no cloud broker). The bridge does the accommodation small models need: description curation and caps, schema-filtered params (model-padded arguments stripped before strict servers fail on them), per-server result budgets, and confirm-gating for tools without `readOnlyHint`.

### ReAct loop — governed freedom for open categories

Open-ended categories (`chat`, `config`, `personal`) use a ReAct tool loop with guardrails learned from measured failure modes: hallucinated-action detection, drift detection with re-anchoring, repair prompts that always offer a no-tool exit (the eval showed 13/16 models will fabricate tool calls rather than defy a coercive order), one calling convention per model, and error-learning hints injected before execution.

## Memory

A **FalkorDB graph database** (Docker, native HNSW vector search) is the institutional memory; a flat JSONL store is the fallback.

```
(:Fact {text, importance, embedding}) -[:ABOUT]->          (:Entity {name, type})
(:Fact) -[:TAGGED]->    (:Tag)
(:Fact) -[:SUPERSEDES]-> (:Fact)            // evolving truth, history preserved
(:Fact) -[:EXTRACTED_FROM]-> (:Turn)        // provenance to the conversation
(:Turn) -[:MENTIONS]->  (:Entity)           // cross-session search
(:UserModel {communicationStyle, decisionPattern, ...})
```

- **Importance tiers** — 5=critical (never expires) … 1=ephemeral (7 days). Eviction drops lowest importance first; identity facts are never silently trimmed.
- **Auto-injection with a floor** — vector KNN + multi-hop entity traversal on every message, but injection requires raw cosine ≥ 0.55: scoring orders, the floor rejects. Relevance is earned, not assumed.
- **Semantic dedup on write**, typed-entity NER bootstrapped from the graph's own prior decisions, `SUPERSEDES` edges instead of overwrites, behavioral user modeling refreshed by heartbeat.
- **Extraction is user-visible** — `!reset` shows candidates before saving; the 2-hourly heartbeat extracts autonomously with existing facts shown to prevent re-extraction; `!forget` removes with re-extraction protection.
- **Experience & Lessons** — approach-level memory judged only by code-detected signals (👍/👎 reactions, confirm denials, steering — never model self-assessment). Lessons (negative procedural memory) inject only after recurrence (evidence ≥ 2). The retired skills system is the cautionary tale: replayed recipes quietly became an authority surface, so its successors keep the learning, not the power.

Deep dive: [MEMORY-SYSTEM.md](MEMORY-SYSTEM.md).

## Research: Verified, Not Vibed

The `research` pipeline produces an analytical PDF report whose claims are checked before delivery:

1. **Local-first gathering** — an owner-seeded **personal web index** (RSS-first honest crawler: named UA, robots.txt, per-domain pacing) is tried before any SERP; healthy facets never hit external search at all. Flow-first gathering when a flow is explicitly named.
2. **Decompose → per-facet research → gap-fill → synthesize** — concurrent facets, inline citations, an explicit *Contradictions & Gaps* section.
3. **Evidence verification** — atomic claims extracted (grammar-constrained), checked against the cached pages that actually mention them, corrections spliced by code at sentence granularity (the report body is never handed back for wholesale rewriting). A bounded **Tier-1 cross-check** escalates high-impact falsifiable claims to one independent search each — contradicted facts get corrected with quoted evidence.
4. **Honest failure** — zero sources fetched aborts the run with "search is down — I won't answer from memory." No verifier can rescue a report whose sources are imaginary, so fabrication is refused at the front door.
5. **Deterministic rendering** — the model writes markdown; code owns HTML/CSS, the Sources section, and chart embedding (matplotlib, only charts that actually rendered). LibreOffice converts to PDF; a `## Verification` appendix and auditable `verification.json` ship with every report.

## Models

One measured principle: **the harness holds the value, not the weights.** The entire foreground tier has been swapped three times (qwen → MiniMax → DeepSeek-V4-Flash → qwen3.8) purely via config and the multi-backend client — memory graph, pipelines, and channels untouched.

| Role | Model | Backend |
|------|-------|---------|
| Foreground: chat, specialists, briefing, reasoning, vision (native VL), Pi builds | Qwen3.8 27B (NVFP4, served as `qwen3.8-27b`) | SGLang, direct OpenAI-compat (continuous batching, MTP speculative decoding, 262K context) |
| Router | phi4:14b | Ollama gateway |
| NER | phi4-mini | Ollama gateway |
| Embeddings | qwen3-embedding:8b | Ollama gateway |
| Voice fast-path | qwen2.5:7b | Ollama gateway |
| Image generation | flux2-klein:4b-fp8 | dedicated Ollama box |

The foreground promotion was decided by four instrumented head-to-heads (deep eval, blind synthesis, build duel, Pi duel — a 27B went 4-0 against a 284B; artifacts in `evals/`). **Thinking is a per-stage property, not a per-model one**: structured stages pin `think: false`, synthesis stages think when a blind human read said it pays, and the config is validated at boot against a per-model capability matrix. Concurrency, budgets, and think policy are config, not code — model-shaped accommodations hardcoded into logic are a bug class this project has paid for twice.

A `MultiBackendClient` routes each call by model id: foreground models to OpenAI-compatible servers (SGLang, vLLM, ds4), utility models to an Ollama-compatible gateway. Ollama-only setups work — see the eval for measured picks.

## Capabilities at a Glance

| Capability | Tools | Description |
|-----------|-------|-------------|
| Web Search | `web_search`, `web_fetch`, `browser` | SearXNG (self-hosted, default) or Brave/Perplexity/Grok/Tavily, Readability extraction, headless Chromium |
| Research | `web_search`, `web_fetch`, `code_session`, `reason` | Multi-facet deep research → analytical PDF report with charts and evidence verification (cited-source + independent cross-check of claims) |
| Memory | `memory_save`, `memory_search`, `memory_get`, `memory_forget` | Per-user structured facts with categories, tags, entities, confidence scores, and interactive review via `!heartbeat` |
| Personal | `gmail_search`, `gmail_read`, `calendar_list`, `calendar_search` | Google Calendar + Gmail read-only access — owner-only security gate |
| Execution | `exec`, `code_session`, `read_file`, `write_file` | Allowlisted shell commands or Docker sandbox, persistent Python/Node/Bash REPL sessions, safe file I/O |
| Scheduling | `cron_add`, `cron_list`, `cron_remove`, `cron_edit`, `cron_run` | Real cron expressions, timezone-aware, persistent; `cron_run` triggers any job immediately without touching its schedule |
| Task Board | `task_add`, `task_list`, `task_update`, `task_done`, `task_remove` | Persistent kanban-style task system with TASKS.md rendering |
| Reasoning | `reason` | Forced synthesis pass over gathered tool observations — deep analysis, content formatting |
| Messaging | `send_message` | Cross-channel message delivery (confirm-gated, grant-eligible) |
| Browsing | `browser` | Dual-mode browser: DOM-first with automatic visual escalation (Xvfb + vision model). Click, type, select, fill forms on any site including SPAs |
| Vision | *(automatic)* | Image analysis via the multimodal foreground model — descriptions injected into context for natural Q&A |
| Voice | TTS/STT | Kokoro TTS + faster-whisper STT — voice in, voice out, with toggle hands-free mode |
| Multi-task | `plan` pipeline | LLM decomposes goal into steps, self-reflects, code executes with browser/tools, learns from outcomes |
| Data files | `code_session`, `read_file` | Upload CSV/Excel/JSON → pandas analysis in a persistent code session → charts + interpretation on request |
| Experience Memory | *(automatic)* | Graph-stored approach memory judged by the user's ACTUAL reactions (👍/👎, steering, denials — code-detected, never model self-assessment). Experience informs execution; it never expands authority |
| Lessons | `!lessons` *(+ automatic)* | Negative procedural memory — approach-level boundaries harvested from observed failures, injected only after recurrence (evidence ≥ 2) |
| MCP Bridge | `tools.mcp.servers[]` | Any MCP server's tools become Invarail tools — stdio or streamable-HTTP, small-model description curation, schema-filtered params, per-server result budgets, readOnlyHint-aware confirm gating, fully-local OAuth |
| Flow-first research | explicit tool naming | Name a [FlowMCP](https://github.com/PeterGreenAppliedAI/FlowMCP) gathering flow in a research request and the pipeline uses its compiled searches as the facets+sources, then verifies and renders exactly as normal |
| Standing Grants | `!grants` | Target-bound autonomy: reply `always <id>` and that exact tool→target pair stops asking — never the whole tool. Principal-bound, revocable |
| Heartbeat | *(autonomous)* | Deterministic fact diff + LLM reasoning, auto-expire stale facts, interactive memory review |
| Briefing | *(scheduled)* | 3x daily CoT reasoning about calendar + tasks + memory — contextual insights, not status dumps |
| Knowledge Import | `knowledge_import` | Import PDFs, CSVs, markdown into a vector-searchable knowledge base |
| Context Compaction | *(automatic)* | Structured compression (Goal/Progress/Next Steps), proactive at budget pressure, tool-pair sanitization |
| Document Gen | `document` | Create and convert documents via LibreOffice headless — markdown in, code-owned styling out → PDF/DOCX/XLSX/PPTX |
| Image Gen | `image_generate` | Text-to-image and img2img via Flux on dedicated hardware |
| Code Generation | `pi_build` | Build code with the embedded [Pi](https://pi.dev) SDK — scaffold projects, write tests, auto-commit. Cwd-scoped arena, lifecycle-observed, externally test-gated |
| Browser Companion | Chrome Extension | Side panel rides shotgun while you browse — summarize pages, ask about selected text, right-click context menus. Page content injected directly, no fetching |
| Self-Improvement | *(automatic)* | Error learning store, tool-specific recovery guidance, drift detection, observation summarization, learning promotion via heartbeat |
| CLI | `npm run cli` | Terminal interface with streaming, slash commands, markdown rendering, session persistence |

## Channels & Console

**Channels:** Discord, Telegram, Slack, WhatsApp (Baileys, no Chrome), Gmail, Microsoft Graph, iMessage (BlueBubbles), Web API, and a **Chrome extension** side panel (page context injected directly — summarize/ask about any page, no fetching). Any platform can be added by implementing a 5-method `ChannelAdapter` — zero core changes. All adapters deliver file attachments (PDFs, images, documents).

**Management console** at `http://localhost:3100/console/` (React + Vite + Tailwind, served from the same process): dashboard, full chat with voice mode (VAD hands-free loop), session transcripts with tool-call details, kanban task board, cron management, memory browser, channel status, tool registry, config viewer (secrets redacted). REST API + SSE streaming underneath.

**Voice:** Kokoro TTS + faster-whisper STT (both OpenAI-compatible HTTP). Voice in → voice out, text in → text out. Vision: images auto-analyzed by the multimodal foreground model and answered naturally.

## Autonomy That Reports for Duty

- **Heartbeat** (every 2h) — deterministic maintenance: transcript fact extraction, learning promotion, media cleanup, fact expiry/dedup, code-driven task urgency (models receive pre-labeled data; labels are authoritative), interactive memory review (`!heartbeat yes/no`).
- **Briefings** (8am / 1:15pm / 5pm) — calendar + tasks + memory gathered by code, reasoned over by the model: contextual insight, not a status dump.
- **Cron** — real cron expressions, validated before persisting; jobs run as continuable sessions with artifact capture, retry with backoff, and failure notification. `cron_run` fires any job now without touching its schedule.

## Quick Start

> **Fifteen minutes to a working agent:** [INSTALL.md](INSTALL.md) has the tier ladder — Tier 0 is Node + Ollama + one model + the web console (`npm run setup`, choose **Starter**). Everything else is optional and degrades gracefully when absent.

```bash
git clone https://github.com/PeterGreenAppliedAI/Invarail.git
cd Invarail
npm install
cd console && npm install && npm run build && cd ..
npm run setup        # interactive wizard: models, channels, security, memory, voice, preflight
npx tsx src/index.ts
```

**Prerequisites:** Node 22+, [Ollama](https://ollama.ai) reachable, and models for the roles you enable (the wizard detects what you have). Python 3 + matplotlib/pandas for research charts. Docker for the exec sandbox and FalkorDB graph memory (the wizard offers auto-install). LibreOffice for document/PDF generation.

**Search:** defaults to self-hosted **SearXNG** (`tools.web.search: { provider: "searxng", baseUrl: "..." }`, JSON format enabled in its settings). Brave/Perplexity/Grok/Tavily available by switching `provider`. Note from experience: a metasearch host spends its IP reputation with every upstream engine — Invarail ships per-provider politeness throttles because agents are out-of-distribution callers for human-paced infrastructure.

**Security minimums** before exposing anything:

```json5
web: { host: "127.0.0.1" },   // or set `token` if binding 0.0.0.0
// per channel:
security: {
  trustedUsers: ["user-id"],
  ownerOnlyTools: ["exec", "write_file", "gmail_search", "calendar_list"],
  confirmTools: ["send_message"],
},
```

Set `ownerId`. `ownerOnlyTools` is a code gate — the tools don't exist in the model's world for anyone else.

## Feature Guides

### Management Console

<img width="2554" height="1302" alt="Invarail management console" src="https://github.com/user-attachments/assets/a309e3d2-0bd5-4cf0-9806-0cbfeb1f0663" />

- **Dashboard** — system status, backend health, channel connections, cron/memory stats
- **Chat** — markdown rendering, inline charts, file uploads (images, PDFs), toggle voice mode with VAD
- **Sessions** — browse all conversation transcripts across channels, with tool-call details
- **Tasks** — kanban board with drag-to-advance, priorities
- **Cron & Heartbeats** — view, toggle, run now, delete
- **Memory** — search facts by sender, browse categories/tags/entities, consolidate
- **Channels** — live connection status with reconnect buttons
- **Tools** — all registered tools grouped by category with parameter schemas
- **Config** — collapsible tree of the running configuration (secrets redacted)

The console REST API lives at `/console/api/`:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/status` | System health, model count, channel statuses |
| GET | `/models` | List available models |
| GET | `/config` | Running configuration (secrets redacted) |
| GET | `/channels` · POST `/channels/:id/reconnect` | Channel status / reconnect |
| GET/DELETE | `/sessions[/:agent/:key]` | List, load, delete transcripts |
| GET/POST/PATCH/DELETE | `/tasks[/:id]` | Task CRUD |
| GET/POST/PATCH/DELETE | `/cron[/:id]` · POST `/cron/:id/run` | Cron CRUD + run now |
| GET | `/facts/all` · POST `/facts/consolidate` | Memory browse + consolidate |
| GET | `/tools` | Registered tools with schemas |
| POST | `/chat` | SSE-streaming chat (with image extraction) |
| GET | `/files/:path` | Serve workspace files (charts, etc.) |

### Voice (TTS/STT)

- **STT** — [faster-whisper](https://github.com/SYSTRAN/faster-whisper) server; incoming voice messages are transcribed automatically.
- **TTS** — [Kokoro](https://github.com/remsky/Kokoro-FastAPI); near-real-time synthesis (~150ms/sentence). Voice responses get a TTS-friendly prompt injection (no emojis, no markdown).

The rule: **voice in → voice out, text in → text out.** Adapters without audio support ignore it gracefully.

Two services on your inference node:

```bash
docker run -p 5005:8880 ghcr.io/remsky/kokoro-fastapi     # Kokoro TTS (OpenAI-compatible)
faster-whisper-server --model large-v3 --device cuda       # STT (port 8000)
```

```env
QWEN_TTS_URL=http://your-gpu-node:5005
WHISPER_URL=http://your-gpu-node:8000
```

```json5
tts: { enabled: true, url: "${QWEN_TTS_URL}", voice: "af_bella", format: "mp3" },
stt: { enabled: true, url: "${WHISPER_URL}", model: "whisper-large-v3", language: "en" },
```

The console chat's **toggle voice mode** is hands-free: VAD detects when you stop speaking, transcribes, dispatches, plays the TTS reply, and resumes recording. A standalone hold-to-talk voice UI lives at `http://localhost:3100` with SSE progress streaming. Voice-originated chat uses a lighter model (`qwen2.5:7b`) for latency; tool-using categories keep the full specialist model.

### Vision

Incoming images run through the multimodal foreground model automatically: attachment saved → base64 to the vision model → description injected into the message context → routed as answerable chat. If vision fails, the message still processes with a note. Console chat accepts paste/drag-drop/paperclip uploads.

```json5
vision: { enabled: true, model: "qwen3.8-27b", maxTokens: 512 },
```

### WhatsApp

Connects via [Baileys](https://github.com/WhiskeySockets/Baileys) (WebSocket, no Puppeteer/Chrome).

1. `whatsapp: { enabled: true }` in config, start the bot
2. A QR code appears in the terminal
3. Phone: **WhatsApp → Settings → Linked Devices → Link a Device**, scan with WhatsApp's built-in scanner
4. Session persists in `.baileys_auth/` — restarts reconnect automatically

Re-link (expired session): `rm -rf .baileys_auth` and restart. WhatsApp may unlink devices after ~14 days of inactivity; reconnection is automatic, full logout needs a re-scan.

### Document Generation

```
document[{"action": "create", "content": "# Report\n...", "format": "pdf", "filename": "report"}]
document[{"action": "convert", "inputPath": "data.csv", "format": "xlsx"}]
```

Formats: PDF, DOCX, XLSX, PPTX, HTML, CSV, TXT, ODT, ODS, ODP. Models write markdown; code owns styling and HTML — models never author publish-path structure. Output delivered as channel attachments via the `[FILE:]` token system (stripped from model observations so paths can't be rewritten, re-appended for delivery). Requires LibreOffice (`brew install --cask libreoffice`; `SOFFICE_PATH` env override).

### Task Board

Persistent kanban tasks (`tasks.json` → rendered `TASKS.md`): priorities, assignees, due dates, tags. "Add a task to buy groceries" / "show my tasks" / "mark a1b2c3d4 done". `TASKS.md` is protected — the bot mutates it only through the TaskStore. Urgency tiers and calendar-day labels are computed **in code** (`src/temporal/`); models receive pre-labeled data with labels marked authoritative — no hallucinated urgency, no wrong-day events.

### Heartbeat

Every 2 hours, fully deterministic in structure — code decides what to review, the LLM reasons about it: transcript review (fact extraction), learning promotion (3+ recurrences → `LEARNINGS.md`), media cleanup, fact auto-expiry, dedup, fact diff + LLM reasoning over new/removed facts, code-driven task urgency, and 2-3 review candidates surfaced during waking hours.

Interactive review: `!heartbeat yes` (confirm all) · `!heartbeat no` (remove all — recorded, won't re-extract) · `!heartbeat no 2` (remove only #2). Manual triggers: `!cleanup`, `!promote`.

### Briefing

Separate from heartbeat: 8:00am, 1:15pm, 5:00pm. Gathers calendar + tasks + memory directly via the tool executor, flags stale facts, then CoT reasoning about connections and conflicts — morning ("what to prepare for"), afternoon ("what's left"), evening ("anything to prep tonight").

```json5
heartbeat: {
  enabled: true,
  schedule: "0 */2 * * *",
  delivery: { channel: "discord", target: "<channel-or-user-id>" },
},
```

### Plan Pipeline (multi-step tasks)

For "search Eventbrite for tech events near X, then add one to my task list"-class requests — the model plans, code executes:

1. **Plan** — LLM emits steps as `{tool, params, purpose}` JSON
2. **Self-reflect** — LLM critiques its own plan (missing snapshots, bad ordering, placeholder params, blind first-result selection) and revises
3. **Execute loop** — code iterates, calling tools directly: smart content selection from rendered page text, dynamic param resolution from real page data, DOM-first browser with automatic visual-mode escalation (Xvfb + vision model + pixel coordinates) only when DOM interaction fails
4. **Verify** — per-step success checks; failures get one LLM-adjusted retry
5. **Summarize + record** — outcomes become graph `:Experience` nodes judged by the user's actual reaction

**Foreman handoffs:** specialists receive structured briefings (task, plan context, prior-step status + artifact paths) with full results on disk at `.plan-artifacts/step-N.txt` — `read_file` on demand instead of prompt bloat. All pipeline dispatches run context-isolated (no parent session history).

### Context Compaction

Budget-aware sliding window: short conversations pass through untouched; long ones split into a verbatim recent zone and an archive zone that gets memory-flushed (facts → MEMORY.md, hash-deduped) and summarized. Tool observations trim in-place during long loops. Compaction failure degrades to turn-count truncation; raw transcripts are never modified.

```json5
session: { contextSize: 32768, recentTurnsToKeep: 6, maxHistoryTurns: 100 },
```

### Workspace System

Per-agent markdown injected into context: `SOUL.md` (persona + per-channel behavior), `USER.md`, `IDENTITY.md`, `MEMORY.md`, `HEARTBEAT.md`, `TOOLS.md`, `TASKS.md` (protected). Channel-aware: the bot knows its source channel per message, so SOUL.md can define different rules per platform. Tool-using specialists get minimal workspace context to preserve token budget; chat gets full.

### CLI

`npm run cli` — terminal interface with streaming, markdown rendering, tool-call visualization, and slash commands (`/status`, `/model`, `/tools`, `/pipelines`, `/tasks`, `/sessions`, `/research`, `/compress`, `/reset`).

### Self-Improvement Layers

1. **Error learning store** — tool failures recorded to `.learnings/errors.jsonl`; matching hints prepended before future executions
2. **Pattern matching** — observations scanned for 8 known error patterns, enriched with tool-specific recovery guidance
3. **Drift detection** — repeated calls, hedging language, growing responses → re-anchor prompt with the original request
4. **Post-task review** — quality check on tool-heavy responses, corrections logged
5. **Learning promotion** — recurring patterns (3+) promoted to `LEARNINGS.md` by heartbeat

### Router Training Data

Every `!reset` and compaction harvests `{message, category}` pairs into `data/training/router-pairs.jsonl` — a dataset of the *owner's actual phrasing*, not generic benchmarks, for eventually fine-tuning a smaller, faster router than few-shot phi4.

## Repository Map

```
src/
  dispatch.ts          # router → pipeline/specialist + the six security layers
  router/              # classification: pre-model overrides → model → keyword fallback
  pipeline/            # deterministic stage engine + per-category definitions
  tool-loop/           # governed ReAct engine (guardrails, drift/hallucination repair)
  coding/              # Pi SDK adapter — the coding substrate boundary
  tools/               # ~40 tool implementations behind one interface
  mcp/                 # MCP bridge: stdio/HTTP clients, local OAuth, curation layer
  memory/              # FalkorDB graph store, fact store, embeddings, consolidation
  learnings/           # error store, lessons, experience harvesting (code-detected only)
  security/            # pending-action ledger, standing grants
  channels/            # adapters: Discord/Telegram/Slack/WhatsApp/Gmail/Graph/iMessage/Web
  console/             # management console API
  exec/                # Docker sandbox + persistent code sessions
  webindex/            # personal vertical index (RSS-first honest crawler)
  cron/ tasks/ sessions/ services/ context/ config/
console/               # React management console
chrome-extension/      # WXT + React side panel companion
evals/                 # published model evals + duel artifacts
test/                  # 756 tests across 67 files
```

Architecture deep-dives: [ARCHITECTURE.md](ARCHITECTURE.md) · [ROUTING.md](ROUTING.md) · [SPECIALISTS.md](SPECIALISTS.md) · [MEMORY-SYSTEM.md](MEMORY-SYSTEM.md) · decision history with failed experiments: [DECISIONS.md](DECISIONS.md).

## Extending

**New tool:** implement `InvarailTool` in `src/tools/`, register in `register-all.ts`, add to a specialist's `tools` array. Tools declare structured parameters, an autonomy tier, and WHEN TO USE / DO NOT descriptions.

**New channel:** implement the 5-method `ChannelAdapter`, register, add config.

**New MCP server:**

```json5
tools: { mcp: { servers: [{
  name: "flows",
  command: "npx", args: ["tsx", "/path/to/server.ts"],
  cwd: "/path/to/server-repo",          // servers resolving their own paths need their root
  maxResultChars: 14000,                 // raise for gathering tools
  toolDescriptions: { my_tool: "my_tool — WHEN TO USE: ..." },
}]}}
```

Then `"mcp:flows"` in a specialist's tools array exposes the whole server.

**AI-assisted development:** `CLAUDE.md` carries the full pattern/anti-pattern set (error factory, Zod-derived types, ESM, security gates, the 9-gate review rubric) — AI tools that read it generate code that lands in the right place, correctly.

## Safety Summary

Exec allowlist or Docker sandbox · SSRF protection on all fetchers · path-traversal validation on writes and file serving · per-user rate limiting · cron write-stripping + owner-authored identity · confirmation ledger with sender-bound single-use actions · target-bound revocable grants · owner-only code gate · per-channel category/tool/trust filtering · bearer-token web auth · TLS verification on by default · atomic writes (tmp + rename).

## Attribution

Several architectural patterns were adapted from open source agent frameworks:

| Project | What We Adapted |
|---------|----------------|
| **[Hermes Agent](https://github.com/nousresearch/hermes-agent)** (NousResearch) | Structured context compression (Goal/Progress/Next Steps), frozen memory snapshots, character-bounded memory, smart model routing, tool-pair sanitization, CLI inspiration |
| **[Deep Agents](https://github.com/langchain-ai/deepagents)** (LangChain) | Progressive disclosure (compact index, read on demand), subagent context isolation, tool argument truncation in older messages |
| **[agent-reasoning](https://github.com/jasperan/agent-reasoning)** (jasperan) | Self-reflection stage for the plan pipeline (draft → critique → improve) |
| **[Goose](https://github.com/aaif-goose/goose)** (AAIF/Block) | Tool-specific error recovery (errors as actionable prompts), structured sub-dispatch results, LLM-based observation summarization |

Those frameworks assume frontier models drive the agent. Invarail's contribution is making the patterns hold when a local 27B is driving — deterministic pipelines control flow, code owns authority, and the model does only the parts that require judgment.

Coding substrate: **[Pi](https://pi.dev)** by Earendil Works (MIT, embedded via SDK).

## Roadmap

**Recently shipped:** Pi SDK adapter with lifecycle observability (coding-substrate Phase A) · the published 39-row model eval · per-stage thinking control with boot-time capability validation · evidence gates and research claim verification with Tier-1 cross-checks · the personal web index (local-first research) · MCP bridge with fully-local OAuth · target-bound standing grants + confirm buttons · the Lessons system · SGLang foreground cutover with real continuous batching.

| Priority | Direction |
|----------|-----------|
| Next | **Coding substrate Phase B** — worktree-isolated self-modification: deterministic merge gates (tsc + suite + smoke batteries + rubric tiering), ledger-confirmed merges, a deliberately dumb supervisor with auto-rollback. Open design: the arena as worktree-inside-container. |
| Next | **Config-not-code Phase 1** — a machine-writable, code-clamped overlay for all model-shaped tuning (per-backend concurrency, budgets, think policy); Phase 2: evidence-driven self-tuning proposals on the confirmation ledger. |
| Planned | **Coding substrate Phase C** — Falkor experience briefs into Pi sessions; post-session harvest (events → graph); memory verified only by the merge gate's own validation event. |
| Planned | **Weekly research newsletter** — cron-scheduled verified research digest with flow-powered gathering. |

## License

MIT
