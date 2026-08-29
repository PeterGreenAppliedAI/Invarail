# Feature Guides

Setup and usage detail for Invarail's features. The [README](README.md) is the front door — this is the reference. How things work internally lives in [ARCHITECTURE.md](ARCHITECTURE.md); install tiers in [INSTALL.md](INSTALL.md).

## Management Console

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

## Voice (TTS/STT)

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

## Vision

Incoming images run through the multimodal foreground model automatically: attachment saved → base64 to the vision model → description injected into the message context → routed as answerable chat. If vision fails, the message still processes with a note. Console chat accepts paste/drag-drop/paperclip uploads.

```json5
vision: { enabled: true, model: "qwen3.8-27b", maxTokens: 512 },
```

## WhatsApp

Connects via [Baileys](https://github.com/WhiskeySockets/Baileys) (WebSocket, no Puppeteer/Chrome).

1. `whatsapp: { enabled: true }` in config, start the bot
2. A QR code appears in the terminal
3. Phone: **WhatsApp → Settings → Linked Devices → Link a Device**, scan with WhatsApp's built-in scanner
4. Session persists in `.baileys_auth/` — restarts reconnect automatically

Re-link (expired session): `rm -rf .baileys_auth` and restart. WhatsApp may unlink devices after ~14 days of inactivity; reconnection is automatic, full logout needs a re-scan.

## Document Generation

```
document[{"action": "create", "content": "# Report\n...", "format": "pdf", "filename": "report"}]
document[{"action": "convert", "inputPath": "data.csv", "format": "xlsx"}]
```

Formats: PDF, DOCX, XLSX, PPTX, HTML, CSV, TXT, ODT, ODS, ODP. Models write markdown; code owns styling and HTML — models never author publish-path structure. Output delivered as channel attachments via the `[FILE:]` token system (stripped from model observations so paths can't be rewritten, re-appended for delivery). Requires LibreOffice (`brew install --cask libreoffice`; `SOFFICE_PATH` env override).

## Task Board

Persistent kanban tasks (`tasks.json` → rendered `TASKS.md`): priorities, assignees, due dates, tags. "Add a task to buy groceries" / "show my tasks" / "mark a1b2c3d4 done". `TASKS.md` is protected — the bot mutates it only through the TaskStore. Urgency tiers and calendar-day labels are computed **in code** (`src/temporal/`); models receive pre-labeled data with labels marked authoritative — no hallucinated urgency, no wrong-day events.

## Heartbeat

Every 2 hours, fully deterministic in structure — code decides what to review, the LLM reasons about it: transcript review (fact extraction), learning promotion (3+ recurrences → `LEARNINGS.md`), media cleanup, fact auto-expiry, dedup, fact diff + LLM reasoning over new/removed facts, code-driven task urgency, and 2-3 review candidates surfaced during waking hours.

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

Per-agent markdown injected into context: `SOUL.md` (persona + per-channel behavior), `USER.md`, `IDENTITY.md`, `MEMORY.md`, `HEARTBEAT.md`, `TOOLS.md`, `TASKS.md` (protected). Channel-aware: the bot knows its source channel per message, so SOUL.md can define different rules per platform. Tool-using specialists get minimal workspace context to preserve token budget; chat gets full.

## CLI

`npm run cli` — terminal interface with streaming, markdown rendering, tool-call visualization, and slash commands (`/status`, `/model`, `/tools`, `/pipelines`, `/tasks`, `/sessions`, `/research`, `/compress`, `/reset`).

## Self-Improvement Layers

1. **Error learning store** — tool failures recorded to `.learnings/errors.jsonl`; matching hints prepended before future executions
2. **Pattern matching** — observations scanned for 8 known error patterns, enriched with tool-specific recovery guidance
3. **Drift detection** — repeated calls, hedging language, growing responses → re-anchor prompt with the original request
4. **Post-task review** — quality check on tool-heavy responses, corrections logged
5. **Learning promotion** — recurring patterns (3+) promoted to `LEARNINGS.md` by heartbeat

## Router Training Data

Every `!reset` and compaction harvests `{message, category}` pairs into `data/training/router-pairs.jsonl` — a dataset of the *owner's actual phrasing*, not generic benchmarks, for eventually fine-tuning a smaller, faster router than few-shot phi4.
