# Feature Guides

Setup and usage detail for Invarail's features. The [README](../README.md) is the front door — this is the reference. How things work internally lives in [ARCHITECTURE.md](ARCHITECTURE.md); install tiers in [INSTALL.md](../INSTALL.md).

## Capabilities at a Glance

| Capability | Tools | Description |
|-----------|-------|-------------|
| Web Search | `web_search`, `web_fetch`, `browser` | SearXNG (self-hosted, the reference build; the schema default is `brave`) or Perplexity/Grok/Tavily, Readability extraction, headless Chromium. A daily outbound query ceiling (`tools.web.search.dailyQueryCeiling`; the wizard writes 250) bounds volume beside the per-provider rate throttle — [SEARXNG.md](SEARXNG.md) |
| Personal web index | `local_search` | Owner-seeded RSS-first honest crawler (`src/webindex/`), tried before any SERP by `web_search` and `research` |
| Research | `web_search`, `web_fetch`, `code_session` | Multi-facet deep research → analytical PDF report with charts and evidence verification (cited-source + independent cross-check of claims) |
| Memory | `memory_save`, `memory_search`, `memory_get`, `memory_forget` (+ `docs_search`/`docs_store`/`docs_read` on the vault tier) | Per-user structured facts with categories, tags, entities, confidence scores, and interactive review via `!heartbeat`. Four tiers via `memory.backend`: `graph` (FalkorDB + embedder), `flat` (JSONL, keyword recall), `vault` (flat facts + your markdown/Obsidian folder, lexical search; `vault.okf` makes it an Open Knowledge Format bundle — `npm run vault:okf` converts an existing folder), or legacy `markdown` (graph if it answers, else flat). `embeddingModel: "none"` runs with no embedder — [MEMORY-SYSTEM.md](MEMORY-SYSTEM.md) |
| Personal | `gmail_search`, `gmail_read`, `calendar_list`, `calendar_search` | Google Calendar + Gmail read-only access — owner-only code gate; served by `multi` since the `personal` category was retired (2026-08-10) |
| Execution | `exec`, `code_session`, `read_file`, `write_file` | Allowlisted shell commands or Docker sandbox, persistent Python/Node/Bash REPL sessions (inside the sandbox container under `security: "docker"`, owned per principal), safe file I/O. A requested sandbox that is missing means no `exec`/`code_session` at all — never a host fallback |
| Scheduling | `cron_add`, `cron_list`, `cron_remove`, `cron_edit`, `cron_run` | Real cron expressions, timezone-aware, persistent; `cron_run` triggers any job immediately without touching its schedule |
| Task Board | `task_add`, `task_list`, `task_update`, `task_done`, `task_remove` | Persistent kanban-style task system with TASKS.md rendering |
| Reasoning | ~~`reason`~~ | Removed 2026-08-10 (0 uses in 30 days; the forced-reasoning engine paths went with it — DECISIONS). Synthesis is a pipeline stage or the arena's own turn |
| Messaging | `send_message` | Cross-channel message delivery (confirm-gated, grant-eligible) |
| Browsing | `browser` | Dual-mode browser: DOM-first with automatic visual escalation (Xvfb + vision model). Click, type, select, fill forms on any site including SPAs |
| Vision | *(automatic)* | Image analysis via the multimodal foreground model — descriptions injected into context for natural Q&A |
| Voice | TTS/STT | Kokoro TTS + Whisper STT over OpenAI-shaped HTTP (the reference build uses mlx-audio on Apple silicon) — voice in, voice out, with toggle hands-free mode. Detected, never asked: the wizard turns voice on only when a server answers |
| Multi-task | `multi` (arena) | Open ReAct loop over the widest tool set, incl. the owner-only Gmail/Calendar reads; natural stop. Replaced the plan pipeline 2026-08-21 (DECISIONS "The Arena Duel": 7/7 vs 7/7 at 4.7× the cost) |
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
| Setup + Doctor | `npm run setup`, `npm run doctor` | Detect-first wizard (probes Ollama, Docker, FalkorDB, SearXNG, LibreOffice, Python, Obsidian, voice servers; ranks installed models by measured eval score + fit; writes `promptProfile`) and a doctor that checks what the config enables → PASS/WARN/FAIL + the fix. Sidecars are offered; system software is never installed unasked |
| Specialist reroute | `router.reroute` *(automatic, default on)* | An arena answer that claims, or ends announcing, an action whose tool the specialist lacks gets one re-dispatch through the full security path (never cron/forced/twice). Category descriptions state what each specialist cannot do (2026-09-29) |

## Channels

**Channels:** Discord, Telegram, Gmail (read-only tools), Web API, and a **Chrome extension** side panel (page context injected directly — summarize/ask about any page, no fetching). Any platform can be added by implementing a 5-method `ChannelAdapter` — zero core changes. All adapters deliver file attachments (PDFs, images, documents).

## Management Console

**Management console** at `http://localhost:3100/console/` (React + Vite + Tailwind, served from the same process): dashboard, full chat with voice mode (VAD hands-free loop), session transcripts with tool-call details, kanban task board, cron management, memory browser, channel status, tool registry, config viewer (secrets redacted). REST API + SSE streaming underneath.

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
| GET | `/doctor` | The doctor's PASS/WARN/FAIL checks against the running config |
| GET | `/channels` · POST `/channels/:id/reconnect` | Channel status / reconnect |
| GET/DELETE | `/sessions[/:agent/:key]` | List, load, delete transcripts |
| GET/POST/PATCH/DELETE | `/tasks[/:id]` | Task CRUD |
| GET/POST/PATCH/DELETE | `/cron[/:id]` · POST `/cron/:id/run` | Cron CRUD + run now |
| GET | `/facts/all` · POST `/facts/consolidate` | Memory browse + consolidate |
| GET | `/tools` | Registered tools with schemas |
| POST | `/chat` | SSE-streaming chat (with image extraction) |
| GET · POST | `/chat/history` · `/chat/reset` | Load / reset the console chat session |
| GET | `/facts` · POST `/facts` · GET `/memory/senders` | Fact search / write, senders with memory |
| GET | `/files/:path` | Serve workspace files (charts, etc.) |
| GET · DELETE | `/research` · `/research/:id` | Research run listing / delete a run |
| GET | `/code/builds[/:id]` · POST `/code/build` | Pi build records / start a build |
| GET | `/metrics/overview` · `/metrics/stats` · `/metrics/runs[/:id/steps]` | Metrics, run list, per-run tool-loop steps |
| GET | `/logs` · `/quality` | Recent log lines · quality-judge scores |

## Voice (TTS/STT)

**Voice:** Kokoro TTS (`af_bella`) + whisper-large-v3-turbo STT, served by mlx-audio on the Mac mini (OpenAI-shaped HTTP; 0.3s / 0.9s warm). Voice in → voice out, text in → text out; a `[Voice] stt/dispatch/tts/total` line times every turn. Vision: images auto-analyzed by the multimodal foreground model and answered naturally.

- **STT** — whisper-large-v3-turbo via mlx-audio (~0.9s warm); incoming voice messages are transcribed automatically.
- **TTS** — Kokoro (`af_bella`) via mlx-audio (~0.3s warm for a short reply). Voice responses get a TTS-friendly prompt injection (no emojis, no markdown).

The rule: **voice in → voice out, text in → text out.** Adapters without audio support ignore it gracefully.

Voice is detected, not asked: the setup wizard probes the usual local ports for an OpenAI-shaped TTS (Kokoro) and STT (faster-whisper) server, turns each on only when one answers, and otherwise prints the install command (e.g. the `kokoro-fastapi` and `faster-whisper-server` Docker images) and leaves voice off — no voice path exists without a server.

Any OpenAI-shaped `/v1/audio/speech` + `/v1/audio/transcriptions` server works. The reference deployment (2026-09-25) is **mlx-audio on the Mac mini** — Kokoro and Whisper on Apple silicon, one process, no GPU node:

```bash
# Python 3.12 venv (spaCy has no 3.14 wheels); VIRTUAL_ENV must be exported for Kokoro's G2P
python -m mlx_audio.server --host 0.0.0.0 --port 8000        # tmux serve:voice
```

```json5
tts: { enabled: true, url: "${VOICE_URL}", model: "mlx-community/Kokoro-82M-bf16", voice: "af_bella", format: "mp3" },
stt: { enabled: true, url: "${VOICE_URL}", model: "mlx-community/whisper-large-v3-turbo-asr-fp16", language: "en" },
voice: { model: "qwen3.8:27B", maxTokens: 100, historyTurns: 12 },   // the lean voice flow (see below)
```

Previous stack (kokoro-fastapi in Docker + faster-whisper-server on a GPU node) still works with the same config shape; `tts.model` defaults to `tts-1` for OpenAI-shaped servers that expect it.

**The lean voice flow** (`config.voice`, DECISIONS voice rounds 1–5): voice turns run bare chat on `voice.model` with `maxTokens`/`contextSize` overrides, an **anchored** history window of `historyTurns`–2×`historyTurns` turns (append-only until re-anchor, because a sliding window is a cold prefill on a hybrid-attention model), minimal workspace context, `think` off, lessons/experiences priming skipped, and the post-turn semantic-state extraction detached. Every turn logs `[Voice] stt=… dispatch=… tts=… total=…` and `[Chat] … prompt=Ntok/Xms gen=Ntok/Yms`.

The console chat's **toggle voice mode** is hands-free: VAD detects when you stop speaking, transcribes, dispatches, plays the TTS reply, and resumes recording. A standalone hold-to-talk voice UI lives at `http://localhost:3100` with SSE progress streaming. Voice replies run on `voice.model` (the foreground 27B in the reference build) through the lean voice flow above; tool-using categories are unaffected.

## Vision

Incoming images run through the multimodal foreground model automatically: attachment saved → base64 to the vision model → description injected into the message context → routed as answerable chat. If vision fails, the message still processes with a note. Console chat accepts paste/drag-drop/paperclip uploads.

```json5
vision: { enabled: true, prompt: "Describe this image in detail…", maxTokens: 1024 },   // model defaults to `defaultModel`
```

## WhatsApp (removed 2026-08-10)

The Baileys adapter was removed on principle, not usage: an agent that answers messages *as* the owner is impersonation — communication identity is not delegable (DECISIONS "the Invarail trim"). Slack, iMessage and MS Graph adapters went in the same trim (zero sessions ever). The 5-method `ChannelAdapter` interface still makes any platform a one-file addition if the identity question is answered differently.

## Document Generation

```
document[{"action": "create", "content": "# Report\n...", "format": "pdf", "filename": "report"}]
document[{"action": "convert", "inputPath": "data.csv", "format": "xlsx"}]
```

Formats: PDF, DOCX, XLSX, PPTX, HTML, CSV, TXT, ODT, ODS, ODP. Models write markdown; code owns styling and HTML — models never author publish-path structure. Output delivered as channel attachments via the `[FILE:]` token system (stripped from model observations so paths can't be rewritten, re-appended for delivery). Requires LibreOffice (`brew install --cask libreoffice`; `SOFFICE_PATH` env override).

## Task Board

Persistent kanban tasks (`tasks.json` → rendered `TASKS.md`): priorities, assignees, due dates, tags. "Add a task to buy groceries" / "show my tasks" / "mark a1b2c3d4 done". `TASKS.md` is protected — the bot mutates it only through the TaskStore. Urgency tiers and calendar-day labels are computed **in code** (`src/temporal/`); models receive pre-labeled data with labels marked authoritative — no hallucinated urgency, no wrong-day events.

## Autonomy That Reports for Duty

- **Heartbeat** (every 2h) — deterministic maintenance: transcript fact extraction, learning promotion, media cleanup, fact expiry/dedup, code-driven task urgency (models receive pre-labeled data; labels are authoritative), interactive memory review (`!heartbeat yes/no`).
- **Briefings** (8am / 1:15pm / 5pm) — calendar + tasks + memory gathered by code, reasoned over by the model: contextual insight, not a status dump.
- **Cron** — real cron expressions, validated before persisting; jobs run as continuable sessions with artifact capture, retry with backoff, and failure notification. `cron_run` fires any job now without touching its schedule.

Detail for each below.

## Heartbeat

Every 2 hours, fully deterministic in structure — code decides what to review, the LLM reasons about it: transcript review (fact extraction — since 2026-09-20 mostly already done by incremental capture every 8 turns; the heartbeat keeps reconciliation), learning promotion (3+ recurrences → `LEARNINGS.md`), media cleanup, fact auto-expiry, dedup, fact diff + LLM reasoning over new/removed facts, code-driven task urgency, and 2-3 review candidates surfaced during waking hours.

Interactive review: `!heartbeat yes` (confirm all) · `!heartbeat no` (remove all — recorded, won't re-extract) · `!heartbeat no 2` (remove only #2). Manual triggers: `!cleanup`, `!promote`.

## Briefing

Separate from heartbeat: 8:00am, 1:15pm, 5:00pm. Gathers calendar + tasks + memory directly via the tool executor, flags stale facts, then CoT reasoning about connections and conflicts — morning ("what to prepare for"), afternoon ("what's left"), evening ("anything to prep tonight").

```json5
heartbeat: {
  enabled: true,
  schedule: "0 */2 * * *",
  delivery: { channel: "discord", target: "<channel-or-user-id>" },
},
```

## Email Steward

Read-only email triage, opt-in via the `emailTriage` config block. It never writes email — no send capability exists. Three lanes:

- **Fast lane** — support-alias / VIP senders: 15-minute poll with an immediate ping (the poll cron is not scheduled when the lists are empty)
- **Watch lane** — owner-chosen bulk senders folded into the heartbeat digest (bypasses the automated-mail filter)
- **Judged lane** — everything else gets one constrained model judgment

## Self-Modification (SIP)

Live in production. The heartbeat drafts `!improve` specs from recurring tool errors into the pending-action ledger; every change needs two owner confirms — one to attempt, one to merge (a denial is permanent). Pi implements in isolated worktrees; the merge gate runs `tsc` + the full vitest suite + Tier-3 protected-path checks; deployment is supervised with a health check and rollback. `!improve retry` re-gates a kept worktree after rebasing onto main.

## Multi-step Tasks (arena)

For "search Eventbrite for tech events near X, then add one to my task list"-class requests, the `multi` category runs as an **arena** dispatch: an open ReAct loop with the tools listed in config, session history, and a natural stop — the model decides which tools to call and in what order, under the same 6 security layers and the pending-action confirm ledger. `multi` also carries `pi_build` for code-shaped delegation.

**Historical:** until 2026-08-21, `multi` ran the deterministic plan pipeline (LLM plan → self-reflect → code-driven execute loop with per-step verify → summarize, plus foreman handoffs writing full step results to `.plan-artifacts/step-N.txt`). It was retired after a measured head-to-head duel against the open loop; the code remains in `src/pipeline/definitions/plan.ts`, unused by dispatch.

## Context Compaction

Budget-aware sliding window: short conversations pass through untouched; long ones split into a verbatim recent zone and an archive zone that gets memory-flushed (facts → MEMORY.md, hash-deduped) and summarized. Tool observations trim in-place during long loops. Compaction failure degrades to turn-count truncation; raw transcripts are never modified.

```json5
session: { contextSize: 32768, recentTurnsToKeep: 6, maxHistoryTurns: 100 },
```

## Workspace System

Per-agent markdown injected into context: `SOUL.md` (persona + per-channel behavior), `USER.md`, `IDENTITY.md`, `MEMORY.md`, `HEARTBEAT.md`, `TOOLS.md`, `TASKS.md` (protected). Channel-aware: the bot knows its source channel per message, so SOUL.md can define different rules per platform. Tool-using specialists get minimal workspace context to preserve token budget; chat gets the chat set (adds TOOLS.md, USER.md, AGENTS.md). With `promptProfile: "small"` (the wizard writes it for a ≤14B foreground) chat gets the minimal set too and every injected file is capped at 4K chars; a specialist's explicit `contextLevel: 'full'` still wins.

## CLI

`npm run cli` — terminal interface with streaming, markdown rendering, tool-call visualization, and slash commands (`/status`, `/model`, `/tools`, `/pipelines`, `/tasks`, `/sessions`, `/research`, `/compress`, `/reset`).

## Self-Improvement Layers

1. **Error learning store** — tool failures recorded to `.learnings/errors.jsonl`; matching hints prepended before future executions
2. **Pattern matching** — observations scanned for 8 known error patterns, enriched with tool-specific recovery guidance
3. **Drift detection** — repeated calls, hedging language, growing responses → re-anchor prompt with the original request
4. **Post-task review** — quality check on tool-heavy responses, corrections logged
5. **Learning promotion** — recurring patterns (3+) promoted to `LEARNINGS.md` by heartbeat

## Router Training Data

Every `!reset` and compaction harvests `{message, category}` pairs into `data/training/router-pairs.jsonl` — a dataset of the *owner's actual phrasing*, not generic benchmarks. Two honest caveats learned the hard way (2026-09-25): the `category` is what the router *decided*, not ground truth, so the set has to be re-labeled under the current prompt before it teaches anything; and synthetic turns (pipeline handoffs, `[SYSTEM]` notices, attachment stubs) are now skipped at collection — 85 of the first 1,540 pairs were never the owner's words.

It has since done its job: a 421M Laya encoder fine-tuned on the cleaned set (plus round-trip-validated synthetic examples) out-routes phi4 on the held-out set and runs in shadow mode.

## Shadow Router

`router.shadow { enabled, url }` asks a System-One decision server (Laya at `/v1/systemone`) the same routing question beside the live router on every message and logs both to `data/router-shadow.jsonl` — `[RouterShadow] live=chat(model) shadow=chat conf=0.97 AGREE 71ms` in the console, with a running agreement rate every 25 messages. The shadow never decides and never delays a message. Server: `serve_router.py` from the separate Laya eval project, not this repo (`LAYA_CKPT=<dir> LAYA_PORT=8010`).
