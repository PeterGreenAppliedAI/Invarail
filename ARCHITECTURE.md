# LocalClaw Architecture

## Overview

LocalClaw is a local-model-first AI agent framework running entirely on personal hardware. Foreground reasoning runs on a large model (currently DeepSeek-V4-Flash) served by **vLLM**; small utility/modality models run behind an **Ollama-compatible gateway**. It uses a **Router + Specialist** architecture with **deterministic pipelines** — code controls the workflow, models only extract parameters and synthesize text.

9+ models across two inference backends (vLLM + Ollama gateway), 39 tools, 12 pipelines, 15 categories, 8 channel adapters (including Chrome extension with browser control), FalkorDB graph memory with 1,000+ nodes, 451 tests across 33 suites. Web search runs on a self-hosted **SearXNG** metasearch instance (no API key, no rate limit); Brave/Perplexity/Grok/Tavily remain config-selectable fallbacks.

## Design Principles

1. **Code decides, model executes** — Deterministic pipelines for most categories. The model never decides tool ordering, parallel execution, or error recovery.
2. **Specialist isolation** — Each specialist sees 3-6 tools. No model chooses from 39 tools.
3. **Code computes, model interprets** — Numbers, aggregations, temporal logic computed in code. The model only adds "so what" — interpretation, risk assessment, recommendations.
4. **Fail predictably** — Each pipeline fails in its own lane. A broken analytics pipeline doesn't affect chat or web search.
5. **Local-first** — Zero cloud dependencies, no API costs, all data stays on your hardware.

## System Flow

```
Channel (Discord / Telegram / WhatsApp / Web / Gmail / Slack / iMessage / Chrome Extension)
  ↓
Orchestrator
  - Rate limiting (10/min/user)
  - Attachment pre-processing (images → vision, PDFs → text, data files → analytics)
  - Typing indicators, streaming
  - Commands (!reset, !save, !forget, !heartbeat)
  ↓
resolveRoute() → agentId + sessionKey
  ↓
dispatchMessage()
  - Load session history (budget-aware compaction)
  - Router classification (pre-model overrides → phi4:14b → keywords → default)
  - 6-layer security filtering
  - Memory auto-injection (FalkorDB vector KNN + entity traversal)
  - Conversational guard (prevents pipeline misroutes mid-conversation)
  ↓
Pipeline (deterministic)          OR          ReAct Loop (model-driven)
  - web_search, research,                      - chat, config, personal,
    exec, task, memory,                          image, website
    cron, message, analytics,
    plan, code_gen, heartbeat
  ↓
Response → channel (thinking stripped) → transcript (thinking preserved)
```

## Multi-Model Strategy (two backends)

Foreground reasoning runs on **DeepSeek-V4-Flash** via **vLLM** (256K context) on the DGX Spark.
This is the swappable *foreground slot*, not a hard dependency — it was MiniMax-M2.7 before, and the
whole tier moves by config (no model literals in logic). Small utility + modality models run on the
**A5000 node behind an OpenAI-compatible gateway** (Ollama wire protocol). A `MultiBackendClient` routes
each call by model id — purely additive, so the Ollama path is unchanged. See "Inference Routing" below.

| Role | Model | Backend | Why |
|------|-------|---------|-----|
| Chat + all foreground specialists (web_search, exec, memory, multi, research, analytics, image, code_gen, etc.) | DeepSeek-V4-Flash | vLLM / Spark | Strong multi-step reasoning + tool sequencing; 256K context |
| Reasoning (`reason` tool) | DeepSeek-V4-Flash | vLLM / Spark | One model for foreground reasoning — no separate reasoning model |
| Router | phi4:14b | gateway / A5000 | Fast classification (~50ms), few-shot |
| Fact Extraction | phi4:14b | gateway / A5000 | Dense, reliable JSON |
| NER | phi4-mini | gateway / A5000 | Entity typing with bootstrapped graph context |
| Embedding | qwen3-embedding:8b | gateway / A5000 | 4096-dim vectors for memory search |
| Vision | qwen3.6:27b (multimodal) | gateway / A5000 | Image analysis (DeepSeek is text-only) |
| Briefing + Heartbeat reasoning | DeepSeek-V4-Flash | vLLM / Spark | Background reasoning on the foreground model |
| Voice fast-path | qwen2.5:7b | gateway / A5000 | Small + fast for voice-originated messages |

**Context:** `session.contextSize` raised to 128K (was 32K). Per-specialist `contextSize` override
in the schema lets small-context models stay low. DeepSeek-V4-Flash ignores `num_ctx` (vLLM serves
256K at launch), so the value mainly drives the compaction budget.

## Inference Routing

**Since July 2026: single-gateway topology.** The custom inference gateway
(`ollama.url` — the name is historical; it's a proxy speaking the Ollama wire
protocol) fronts EVERYTHING: Ollama-served models and vLLM/DeepSeek behind it.
The gateway does the cross-protocol translation itself (verified: reasoning
headroom, Ollama-shaped tool_calls with object arguments). `inference.backends`
is empty; LocalClaw talks to one endpoint and doesn't know what serves each model.

```
client.chat({ model })
  model matches inference.backends[].models  → OpenAICompatClient → direct OpenAI-compatible endpoint
  everything else (i.e. ALL models today)    → OllamaClient → gateway /api/chat → {Ollama | vLLM}
embed() always → gateway
```

The `MultiBackendClient`/`OpenAICompatClient` machinery is retained — re-adding
a `backends[]` entry points specific models at a direct endpoint again with no
code changes. Watch item: constrained decoding (`format`) for every model now
depends on the gateway's format passthrough (GATEWAY-REQUIREMENTS.md item 1).

`OpenAICompatClient` (src/ollama/openai-client.ts) translates Ollama↔OpenAI: maps `options.*` to
top-level params, JSON-parses tool-call arguments (vLLM returns a string, Ollama an object), stitches
`tool_call_id`s onto tool-result messages, SSE streaming, `usage`→token counts. `MultiBackendClient`
(src/ollama/multi-backend.ts) extends OllamaClient and routes by model id — a drop-in replacement.

**Structured outputs (`format`):** structured tasks (param extraction, `llm_branch`, router
classification, research claim extraction) pass a JSON schema via Ollama `format` / vLLM
`guided_json` for grammar-constrained decoding — the backend physically cannot emit invalid JSON.
Every call site falls back to prompt-only parsing when a backend rejects `format`, so an older
gateway degrades gracefully instead of breaking.

**Tool-calling convention (`toolStyle` per specialist):** `'native'` (default) passes tools via the
API tools field ONLY — no tool text or `Action:` format rules in the prompt (roughly halves fixed
prompt overhead). `'text'` is the inverse, for models whose template lacks tool support. One
convention per model, never both; the tolerant fallback parsers (DSML, `<invoke>`, `Action:`,
JSON5 repair) stay active in both modes as a safety net.

## Router Classification (4-tier)

1. **Pre-model overrides** — bare URLs → website (a URL inside a larger request does NOT hijack routing), explicit task/image commands, speculative language → chat
2. **Model** — phi4:14b classifies into 15 categories, enum-grammar-constrained when the backend supports `format`; bounded by an ENFORCED `router.timeout` (a dead backend costs the timeout, not the client's retry loop)
3. **Keywords** — Pattern matching when model fails or times out
4. **Default** — Falls back to `chat`

Post-classification layers: sticky routing (keeps follow-ups on chat), conversational guard (blocks pipeline misroutes), silent re-route (if chat specialist admits capability gap).

## Pipelined Categories

| Category | Pipeline | Flow |
|----------|----------|------|
| web_search | Linear | extract → search → pick URLs → parallel fetch → synthesize → quality review → [revision] |
| research | Complex | [flow_gather] → decompose → per-facet research (search+fetch+synthesize) → gap-fill → analytical synthesis → claim verification (cited-source + Tier-1 cross-check) → charts → render PDF. `flow_gather` fires only when the request EXPLICITLY names an available flow tool (code gate): the flow's `##` sections become the facets, its links the source pool, decompose is skipped, and everything downstream is unchanged — verification works on flow-gathered pages because the fetch/cache path is identical. Flow failure degrades to normal decompose+search. |
| analytics | Data-driven | extract file → pandas report (code) → charts (code) → LLM interpretation |
| exec | Linear | extract → tool → format |
| task | Branched (5) | llm_branch → extract → tool → confirm |
| memory | Branched (2) | llm_branch → extract → tool → format |
| cron | Branched (4) | llm_branch → extract → tool → confirm |
| message | Linear | extract → tool → confirm |
| plan (multi) | Meta | LLM plan → self-reflect → execute loop (sub-dispatches) → summarize |
| code_gen | Linear | list projects → enrich → Pi build (cwd-scoped) → verify (tests) → [fix] → commit → report |
| heartbeat | Deterministic | fact diff (code) → LLM reasoning → task board (code) → LLM summary |
| website | ReAct | web_fetch → browser fallback → summarize |

## Research Claim Verification

After the research pipeline drafts its markdown report, an evidence-verification stage (`src/pipeline/verification.ts`) checks it before rendering. Principle: **no claim should outrun its evidence.**

1. **Extract** atomic, checkable claims (fast model), prioritizing corporate events / market-share over routine specs.
2. **Cited-source check** — each claim is judged against the *cached* pages that actually mention it (research persists fetched page text, so zero new searches). Overstated/single-sourced claims are **hedged or attributed** ("according to X") — never deleted.
3. **Tier-1 cross-check** — a bounded set of high-impact, falsifiable claims (corporate events, market-share; capped at `maxCrossChecks`) get ONE independent search each; an authoritative contradiction (e.g. "license" vs "acquisition") flips the claim to `CONTRADICTED → correct`.
4. **Correction pass** — code-driven sentence splice: `locateClaimSentence` fuzzy-locates each flagged claim's sentence by token overlap (URLs and decimal numbers are masked with same-length filler before segmentation — any dot that isn't a sentence terminator splices corrections mid-URL or mid-version-number otherwise), the model rewrites ONE sentence, code splices it back with sanity bounds. The report body is never handed to a model for wholesale rewriting. Publishes with a `## Verification` appendix + auditable `verification.json`.

Config-gated via the `verification` block (`enabled`, `crossCheck` — both default on). Known ceiling: cited-source checking can't disprove a faithfully-cited wrong fact without the Tier-1 pass; Tier-1 itself trusts a single independent source, so disputed claims are better attributed than silently rewritten.

## Memory System (FalkorDB)

```
FalkorDB (Docker, localhost:6379)
  Graph: localclaw_memory

  (:Fact {text, importance, embedding, category, confidence})
    -[:ABOUT]->      (:Entity {name, canonical, type})
    -[:TAGGED]->     (:Tag {name})
    -[:SUPERSEDES]-> (:Fact)           // temporal evolution
    -[:EXTRACTED_FROM]-> (:Turn)       // provenance

  (:Turn {text, role, sessionKey})
    -[:MENTIONS]->   (:Entity)         // conversation linking

  (:UserModel {communicationStyle, decisionPattern, topicInterests})
```

**Auto-injection:** Every message triggers vector KNN + entity traversal. Relevant facts silently injected into specialist context. Multi-signal scoring: `similarity * 0.5 + recency * 0.2 + importance * 0.3` — with a **relevance floor** (raw cosine ≥ 0.55): scoring only orders results, so without the floor a fresh high-importance fact injected on every turn regardless of topic. Contextual facts capped at 3; multi-hop traversal only fires when at least one result passed the floor.

**Entity extraction:** NER with typed taxonomy (person, organization, hardware, software, etc.). Bootstrapped from graph — existing typed entities injected as reference for consistent classification. Canonical normalization prevents duplicates.

**Importance tiers:** 5=critical (health/family), 4=identity (job/projects), 3=preference, 2=context, 1=ephemeral. Few-shot examples in extraction prompt.

## Thinking Tag Handling

Models that emit thinking blocks (`<think>` for Qwen, `<|channel>thought` for Gemma 4) have thinking preserved in session transcripts for model continuity across turns. Stripped only for: channel delivery, graph memory, session state, continuation context, handoff summaries, and when feeding to other LLMs (compactor, extractor, NER).

## Autonomous Systems

- **Heartbeat** (every 2h) — Transcript review, fact extraction, learning promotion, media cleanup, memory consolidation, task urgency computation, review candidates. Model-flagged stale facts are PROPOSED into the `!heartbeat yes/no` review flow, never auto-deleted.
- **Briefing** (8am, 1:15pm, 5pm) — Calendar + tasks + memory → CoT reasoning → contextual insights
- **Cron** — User-defined recurring tasks with retry (2x exponential backoff) + failure notification. Jobs only get `exec`/`send_message` when explicitly scheduled as that category (the owner-authored schedule is the code gate). Multi-job adds extract `jobs[]` in one pass with partial-creation disclosure; `once: true` jobs auto-disable after their first successful run. **Every run persists its own session** (`cron:<job>:<run>` — fresh context via a unique key, continuable transcript); deliverables are captured by code (workspace mtime-window scan) into `data/cron-runs.jsonl` and the delivery message. Scheduler: skip-on-overlap, catch-up-once at boot (a reboot can't eat a one-shot reminder); final failures land in the `data/unrouted.jsonl` dead-letter store surfaced by `!autonomy`.

### Autonomy Ladder (structural, code-enforced)

Tools carry `autonomy: {tier, reversible, blastRadius}` metadata. The ladder, keyed to reversibility + blast radius:
- **silent** — reversible, internal (draft, organize)
- **act_then_notify** — low-risk, undoable (task auto-complete, file writes)
- **propose_confirm** — irreversible or visible to others (send_message starts here)

Effective confirm set = channel `confirmTools` ∪ metadata `propose_confirm` tools − channel `autoApproveTools` (the per-channel promotion lever). Every autonomous action logs to metrics (`autonomous_action` events: action/tier/source/reversible/outcome) — the track record promotions are earned against. Bounds are structural: code decides what may run autonomously; the model only decides whether to, inside the envelope.

### Pending-Action Ledger

confirmTools previews record `{id, tool, params, sender, category, expiresAt}` to a file-backed ledger (`src/security/pending-actions.ts`). A "confirm <id>" reply executes the **stored** call — sender-bound, single-use, 10-minute expiry — never a model-regenerated one. `deny|cancel|reject <id>` consumes without executing. Wired into both dispatch paths (ReAct + pipeline) and both confirm surfaces (orchestrator channels + Web console). **Buttons:** Discord components / Telegram inline keyboards render Confirm / Always / Deny under previews; a press synthesizes the equivalent *typed* message through the same choke point — an interactive affordance is never a second security surface. **Continuation:** after a confirmed action succeeds, one follow-up turn dispatches into the originating session with the original category's toolset (`session.continueAfterConfirm`), so multi-step work survives the confirm gap; new gated calls inside it are gated again.

### Target-Bound Standing Grants (`src/security/grants.ts`)

The ladder rung between propose_confirm and blanket `autoApproveTools`. Tools declaring `targetArgs` (params naming their external target; `send_message` → `channel:channelId`) are grant-eligible — replying `always <id>` executes AND mints a grant for that exact tool→target key; identical-target calls then run silently (logged `grant_used` with approval/resource audit columns). Tools without targetArgs (exec) are structurally ineligible. Grants mint only on successful execution, are principal-bound, exact-match, revocable via `!grants revoke <id>`. Implicit reply-origin approval: sending to the conversation the request came from never asks.

### Lessons (negative procedural memory, `src/learnings/lesson-*.ts`)

The runtime agent's own DECISIONS.md: "approach X failed for task-shape Y; the boundary is Z." **Code detects** — candidates harvested from on-disk evidence (max-iteration dispatches with request previews, repeated tool failures, repair clusters, rejected autonomous actions, dead letters), never model self-assessment. **Model explains** — heartbeat-only grammar-constrained synthesis with stale-facts guards (max 3 new/cycle, batch distrust) and a dedup ladder that reinforces existing lessons. **Recurrence is the code gate:** lessons auto-save at evidence:1 (listed in the heartbeat report, `!lessons drop` reverses) but only steer at evidence ≥ 2 — injected as floor-gated one-liners (max 2) in user priming plus tool-tagged boundaries through findHints. Each lesson records the model that produced the failure; a model swap makes it a staleness candidate. Together: FalkorDB remembers the user, skills remember what worked, lessons remember where the boundaries are.

### Skill System (procedural memory, `src/skills/`)

Successful plan-pipeline runs are distilled into markdown skills (generalized description + `triggers:` preserving up to 5 concrete past requests). Matching is **semantic-first** (embeddings in the shared EmbeddingStore under `source:'skill'`, floor 0.65 — measured, not guessed) with keyword scoring as fallback; save-time dedup runs a ladder (slug → hybrid match → grammar-constrained judge) that *revises* existing skills instead of minting near-duplicates. `cronMode` structurally blocks heartbeat/cron from matching or saving skills. ReAct specialists reach skills via the `skill_find` tool (progressive disclosure — catalog stays out of the prompt). All skill events flow through `logAutonomousAction` so the log shows the system living.

## Security (6 layers in dispatch)

1. `allowedCategories` — whitelist per channel
2. `ownerOnlyTools` — code gate, not model-level. Tools invisible to non-owners
3. `restrictedCategories` — blocked for untrusted users
4. `blockedTools` — stripped for everyone on this channel
5. `restrictedTools` — stripped for untrusted users
6. `confirmTools` — preview + pending-action ledger; confirmation executes the exact previewed call (see Autonomy Ladder above). Applies to pipeline dispatches as well as the ReAct loop.

## MCP Bridge (`src/mcp/`)

External MCP servers become first-class LocalClaw tools:

```
tools.mcp.servers[] → McpManager
  ├── transport: stdio  → McpStdioClient (zero-dep JSON-RPC 2.0, spawned child)
  ├── transport: http   → McpHttpClient  (streamable HTTP: JSON + SSE, Mcp-Session-Id)
  └── translation layer → LocalClawTool per server tool
        names <server>_<tool>, sanitized to [A-Za-z0-9_-]{1,64} (OpenAI-path charset)
        descriptions capped 500 chars on sentence boundary (small-model budget)
        readOnlyHint → silent · everything else requiresConfirm (trust:'auto' waives)
        per-server toolAllowlist / toolDescriptions / maxResultChars / cwd
        params filtered to the declared inputSchema before calling (small models
          pad arguments; strict fail-closed servers reject them — accommodation
          is the bridge's job, strictness the server's)
        image content → [FILE:] tokens on the existing media pipeline
```

Stdio servers accept a `cwd` (servers that resolve their own relative paths — config files, downstream child processes — need their repo root, not LocalClaw's). Reference downstream: [FlowMCP](https://github.com/PeterGreenAppliedAI/FlowMCP) — a workflow-first MCP server whose compiled flows power the research pipeline's `flow_gather` stage (see README "Add an MCP server" for setup).

**Explicit tool mentions (code gate):** at pipeline dispatch, `findExplicitToolMentions` scans the message against the allowed tool names (word-boundary, case-insensitive; MCP-prefixed tools also match their bare downstream name — "weekly_gather" finds `flows_weekly_gather`). Hits are injected as `_explicitToolMentions`/`_explicitFlowMentions`. Two consumers: the research `flow_gather` gate, and the plan pipeline's skill guard — a matched skill whose steps never mention an explicitly named tool is ignored (explicit instruction outranks learned habit). Deliberately strict: no semantic flow-matching — "close enough" selection is the skill-hijack bug class, one layer up.

Deliberately NOT the official SDK — ~10% of the protocol (initialize/tools-list/tools-call), owned end to end; swap path stays behind `McpManager`. Failing servers never block boot; crashed servers lazily respawn (3×, 5s backoff). Specialists opt in per server with the `mcp:<server>` token (expanded at dispatch). Remote auth is OAuth 2.1 + PKCE + **Dynamic Client Registration**, fully local (no broker); tokens in the 0600 SecretStore, silent refresh at runtime — the browser-opening flow exists ONLY in `scripts/mcp-oauth-setup.ts`, so background paths can never pop an authorize page.

## Chrome Extension (Browser Companion)

```
Chrome Side Panel (React) → HTTP fetch (SSE streaming) → LocalClaw Web API (localhost:3100)
  ├── Content script extracts: URL, title, selected text, page content (~10K chars)
  ├── [PAGE:] token injected → console/api/chat detects → overrideCategory: chat
  ├── Context menus: "Ask LocalClaw about '%s'" (selection), "Summarize this page" (page)
  └── No fetching needed — model reads injected page content directly
```

Built with WXT (Manifest V3), React, TypeScript. Connects to existing Web channel API — no new backend. Works cross-network (extension on Windows, LocalClaw on Mac Mini).

## File Type Routing (Orchestrator)

```
attachment → check extension
  → image (.png, .jpg, .gif, .webp)  → vision → inject description → chat
  → PDF (.pdf)                         → extract text → inject → route normally
  → data (.csv, .xlsx, .json)          → analytics pipeline (auto)
  → text (.md, .txt, .html, .log)     → ask user: knowledge base or read as text?
  → unknown                            → ask user same choice
```

## Execution Isolation

```
Isolation Layer          What It Protects              Status
─────────────────────────────────────────────────────────────
Docker sandbox           Exec tool commands            Active — allowlisted commands only
Cron mode                Automated task execution      Active — strips write tools; exec/send_message only for explicitly-scheduled categories
Pipeline isolation       Pipeline dispatches           Active — fresh context per dispatch
Owner-only code gate     Sensitive tools               Active — tools invisible to non-owners
6-layer security         Channel + user permissions    Active — static per config
Session-scoped perms     Per-conversation access       Planned
Ephemeral micro-VMs      Untrusted agent execution     Roadmap — Firecracker
Resource limits          CPU/memory per exec           Roadmap
```

**Current gaps:**
- Docker container persists between exec calls (not ephemeral)
- No CPU/memory resource limits on exec tool
- No network isolation for exec (can reach any host the container can)
- Browser control via extension runs in user's actual Chrome (no sandbox)

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js 22+ (ESM) |
| Language | TypeScript 5.7 (strict) |
| AI Backend | vLLM (foreground reasoning) + Ollama gateway (utility/modality models) |
| Web Search | SearXNG (self-hosted, primary) — Brave/Perplexity/Grok/Tavily selectable |
| Graph Memory | FalkorDB (Redis wire protocol, HNSW vectors) |
| Knowledge Store | better-sqlite3 (vector embeddings) |
| Discord | discord.js 14 |
| Telegram | grammy |
| WhatsApp | @whiskeysockets/baileys |
| Browser | playwright-core |
| Charts | matplotlib + seaborn (Python) |
| Document Gen | LibreOffice (headless) |
| Scheduling | croner |
| Config | JSON5 + Zod |
| Chrome Extension | WXT + React + TypeScript (Manifest V3) |
| Testing | Vitest (451 tests, 33 files) |
