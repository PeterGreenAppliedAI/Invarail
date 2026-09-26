# Invarail Architecture

## Overview

Invarail is a local-model-first AI agent framework running entirely on personal hardware. Foreground reasoning runs on ONE swappable model (currently qwen3.8:27B on a 24GB A5000, Ollama-native, selected by a single `defaultModel` config line; glm-5.3-flash on the Spark keeps coding only); the utility tier (router, extraction, NER, voice) runs on a 3060, and the embedder runs alone on a Mac Mini. It uses a **Router + Specialist** architecture where the default execution mode is the **arena** — an open ReAct loop inside rigid walls — and **deterministic pipelines** survive only where their stages are verification (research claim-checking, system heartbeat). Doctrine, measured not asserted (DECISIONS "The Arena Duel" / "The Harness Duel"): *the loop is a commodity; the walls are the product.*

Three inference backend kinds (OpenAI-compat, Ollama-native hosts, primary Ollama), ~75 tools (incl. MCP), 2 deterministic pipelines + arena for everything else, 4 channel adapters + Chrome extension with browser control, FalkorDB graph memory with epistemic provenance and continuous capture, live self-modification rail (SIP), read-only email steward, a System-One shadow router, ~970 tests across ~95 suites. Web search runs on a self-hosted **SearXNG** metasearch instance (no API key, no rate limit); Brave/Perplexity/Grok/Tavily remain config-selectable fallbacks.

## Design Principles

1. **Constrain the arena, not every move** — The model owns control flow inside a bounded loop (iteration caps, budgets, drift/streak guards, run journal); code owns everything the loop may not do. Pipelines remain only where stages ARE the verification. Authority is never model judgment.
2. **Specialist isolation** — Each specialist sees only its configured tools. No model chooses from the full registry.
3. **Code computes, model interprets** — Numbers, aggregations, temporal logic computed in code. The model only adds "so what" — interpretation, risk assessment, recommendations.
4. **Fail predictably** — Guards, gates, and ledgers fail closed; a broken subsystem degrades to silence or an honest error, never invented output.
5. **Local-first** — Zero cloud dependencies, no API costs, all data stays on your hardware. The steward tier (email/calendar/CRM) exists precisely because that data never goes to frontier models.

## System Flow

```
Channel (Discord / Telegram / Web / Gmail / Chrome Extension)
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

Foreground reasoning runs on **ONE model selected by one config line** — `defaultModel` (currently
**qwen3.8:27B**, Ollama-native on a 24GB A5000) is filled into every specialist/briefing/heartbeat/vision
slot that doesn't override it. A model cutover is that line + the backend entry: the slot has been
MiniMax-M2.7 → DeepSeek-V4-Flash → qwen3.8-27B → glm-5.3-flash → qwen3.8:27B again (2026-09-19, on
owned hardware), each swap cheaper than the last (the 2026-08-26 cutover motivated the one-line
mechanism — 19 scattered model strings violated the config-not-code principle). A `MultiBackendClient`
routes each call by model id across three backend kinds — `inference.backends[]` (OpenAI-compat: the
Spark's vLLM, coding only), `inference.ollamaBackends[]` (extra Ollama-native hosts: the A5000, the
3060, the Mini), and the primary Ollama for anything unrouted — and since 2026-09-19 `embed()` routes
by model id too, so the embedder can live on its own box (router/embedder VRAM contention used to blow
the 8s priming cap and silently skip memory injection). Per-model quirks live in **model-caps** (`src/ollama/model-caps.ts`), including think
capability and `noThinkLeaksDeliberation` (glm-5.3 leaks deliberation prose into content when thinking
is suppressed — the client always enables thinking on such models and routes it to the separated
reasoning channel, mapped to `<think>` and stripped at delivery).

| Role | Model | Backend | Why |
|------|-------|---------|-----|
| Chat + ALL foreground specialists + vision + briefing/heartbeat reasoning | `defaultModel` (qwen3.8:27B) | A5000, Ollama-native | One model, one line; 921 tok/s prefill; native tool calls; think honored |
| `code_gen` + Pi coding substrate | glm-5.3-flash / `pi.model` | vLLM / Spark | Speed where quality compounds and the merge gate catches slop; 262K context |
| Router · fact extraction · steward judgment | phi4:latest | 3060 | Fast classification, dense JSON (tag is `:latest` — `:14b` 404s there) |
| NER · consolidation | phi4-mini | 3060 | Entity typing with bootstrapped graph context |
| Voice replies | `voice.model` (= `defaultModel`, qwen3.8:27B) | A5000 | The lean voice flow made the big model fast, not a small model: every 4–7GB "fast" model placed beside the 27B split to CPU and decoded at 13 tok/s (DECISIONS, voice round three) |
| Embedding | qwen3-embedding:8b | Mac Mini | 4096-dim vectors; resident alone so priming never waits on a reload |
| Shadow router (observation) | Laya 421M fine-tune | `/v1/systemone` | Same question as the router, logged beside it, never decides |

**Context:** `session.contextSize` (32768 — the A5000 has 24GB and a large KV allocation competes with
the 17.7GB of weights) budgets compaction; `research` is the slot to watch and a one-line `model:`
override moves it to GLM's 262K if verification depth drops. Per-specialist `contextSize` override lets small-context models stay low.
**Prompt order is a prefix-cache contract** — `[static system][append-only history][volatile state+memory][user]` in both the tool loop and bare chat. On a plain transformer any divergence only re-prefills what follows it. The 27B is a **hybrid** (`qwen35`: Gated-DeltaNet SSM layers with full attention every 4th), whose recurrent state restores only from checkpoints: measured 2026-09-26, an exact extension costs 283ms, a tail-side change ~850ms, and a history window slid by one exchange 4036ms — the same as cold. Hence the voice window is anchored with hysteresis (`voiceWindowStart`), the per-turn memory block is bounded (a user-model node that had drifted to 41 keys was ~2K tokens of it), and every foreground call passes `num_ctx` explicitly (a call without it takes the host default and Ollama reloads the model at that size — 7s each way). Bare chat prints `[Chat] … prompt=Ntok/Xms gen=Ntok/Yms load=Zms`; read it before theorizing about latency.

Long completions stream by construction (`chat()` rides SSE internally) so generation length can
never hit undici's response-headers deadline; the only clock is `OLLAMA_CHAT_TIMEOUT_MS`.

## Inference Routing

**Since July 2026: single-gateway topology.** The custom inference gateway
(`ollama.url` — the name is historical; it's a proxy speaking the Ollama wire
protocol) fronts EVERYTHING: Ollama-served models and vLLM/DeepSeek behind it.
The gateway does the cross-protocol translation itself (verified: reasoning
headroom, Ollama-shaped tool_calls with object arguments). `inference.backends`
is empty; Invarail talks to one endpoint and doesn't know what serves each model.

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
2. **Model** — `router.model` (phi4:latest on the 3060) classifies into the 12 configured categories, enum-grammar-constrained when the backend supports `format`; bounded by an ENFORCED `router.timeout` (a dead backend costs the timeout, not the client's retry loop)
3. **Keywords** — Pattern matching when model fails or times out
4. **Default** — Falls back to `chat`

**Shadow tier (2026-09-25, observation only):** with `router.shadow` enabled, the final decision — whatever produced it — is compared against a System-One decision model (`src/router/shadow.ts` → `/v1/systemone`, Jev wire protocol) asked the identical question with `router.categories` descriptions as its option text. Both land in `data/router-shadow.jsonl`; the shadow never decides and is never awaited. A fine-tuned Laya (421M) beat phi4 80.8% vs 76.9% at 63ms vs 270ms on the held-out set; the switch (`router.backend`) waits on the disagreement rate over real traffic (DECISIONS "A 421M Encoder Out-Routes phi4").

Post-classification layers: sticky routing (keeps follow-ups on chat), conversational guard (blocks pipeline misroutes), silent re-route (if chat specialist admits capability gap). Sticky is the incumbent's main leak in the shadow log — it carries a fragment into the previous turn's *category* without knowing the previous turn's *state* ("Awesome." after "Done, scheduled" is chat, not cron). A System-One router fed the previous turn as state makes that distinction zero-shot (DECISIONS 2026-09-26); the planned v4 fine-tune trains on it.

## Dispatch Modes (arena fleet-wide, 2026-08-21)

**Arena (the default)** — categories `chat`, `web_search`, `memory`, `exec`, `cron`, `message`, `website`, `task`, `code_gen`, `multi` run an open ReAct loop (`dispatchMode: "arena"`): the model sequences its configured tools with session history and stops naturally, bounded by iteration caps, drift/streak guards, observation budgets + spill, the crash-durable run journal, and `!stop`. Measured basis: the arena duel (plan pipeline 7/7 vs arena 7/7 at 4.7× the cost) and a week of production. The former per-category pipelines (extract→tool choreography) and the plan/foreman pipeline are retired from dispatch; each category's old flow is preserved in git history and the `pipeline:` config fields remain as one-line reverts. `multi` additionally carries `pi_build` — code-shaped subtasks delegate to the Pi substrate in one call instead of tool-per-turn chains.

**Deterministic pipelines (the two survivors — stages as ORACLES, not choreography):**

| Category | Pipeline | Flow |
|----------|----------|------|
| research | Complex | [flow_gather] → decompose → per-facet research (search+fetch+synthesize) → gap-fill → analytical synthesis → claim verification (cited-source + Tier-1 cross-check) → charts → render PDF. `flow_gather` fires only when the request EXPLICITLY names an available flow tool (code gate): the flow's `##` sections become the facets, its links the source pool, decompose is skipped, and everything downstream is unchanged — verification works on flow-gathered pages because the fetch/cache path is identical. Flow failure degrades to normal decompose+search. |
| heartbeat | Deterministic | fact diff (code) → LLM reasoning → task board (code) → SIP proposal step → email-steward digest → LLM summary |

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
  Graph: invarail_memory

  (:Fact {text, importance, embedding, category, confidence, provenance})
    -[:ABOUT]->      (:Entity {name, canonical, type})
    -[:TAGGED]->     (:Tag {name})
    -[:SUPERSEDES]-> (:Fact)           // temporal evolution
    -[:EXTRACTED_FROM]-> (:Turn)       // provenance

  (:Turn {text, role, sessionKey})
    -[:MENTIONS]->   (:Entity)         // conversation linking

  (:UserModel {communicationStyle, decisionPattern, topicInterests, frustrationTriggers})   // closed schema — writer + renderer ignore any other key
```

**Auto-injection:** Every message triggers vector KNN + entity traversal. Relevant facts silently injected into specialist context. Multi-signal scoring: `similarity * 0.5 + recency * 0.2 + importance * 0.3` — with a **relevance floor** (raw cosine ≥ 0.55): scoring only orders results, so without the floor a fresh high-importance fact injected on every turn regardless of topic. Contextual facts capped at 3; multi-hop traversal only fires when at least one result passed the floor.

**Entity extraction:** NER with typed taxonomy (person, organization, hardware, software, etc.). Bootstrapped from graph — existing typed entities injected as reference for consistent classification. Canonical normalization prevents duplicates.

**Importance tiers:** 5=critical (health/family), 4=identity (job/projects), 3=preference, 2=context, 1=ephemeral. Few-shot examples in extraction prompt.

**Provenance (2026-09-20):** `stated | observed | inferred` — HOW a fact is known, orthogonal to `source` (WHERE). Only `!save` may write `stated`; consolidation merges are `inferred`; everything else is `observed`. Legacy nodes coalesce DOWN to `observed`. Injection marks the weak classes only when the injected set is mixed.

**Intake (2026-09-20):** `MemoryCapture` (`src/services/memory-capture.ts`) extracts from the unprocessed window every N turns, after delivery, fire-and-forget on the utility tier, hard-bounded — the code-triggered alternative to a model deciding when a topic shifted. `!reset` extracts only the tail capture hasn't read (never re-reads an 80-turn transcript into a 4K window — that overflow truncated the instructions and made phi4 continue the chat) and lists the session's captures; `!save` promotes them to `stated`. Extraction receives `USER.md` as an authoritative do-not-re-extract block, is bounded to `memory.extractionContextSize`, and is told not to infer (first live capture turned "make me redundant" into "no recurring revenue"; the next message said the opposite). Priming embeds the user's words only (`primingQueryFrom` strips page/PDF bodies, caps at 800 chars). Entity clusters exclude the owner's names (config principals) and per-corpus stopword entities; a heartbeat synthesis pass is designed but NOT built — the gate (`scripts/memory-cluster-check.ts`) failed on 24 facts.

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

External MCP servers become first-class Invarail tools:

```
tools.mcp.servers[] → McpManager
  ├── transport: stdio  → McpStdioClient (zero-dep JSON-RPC 2.0, spawned child)
  ├── transport: http   → McpHttpClient  (streamable HTTP: JSON + SSE, Mcp-Session-Id)
  └── translation layer → InvarailTool per server tool
        names <server>_<tool>, sanitized to [A-Za-z0-9_-]{1,64} (OpenAI-path charset)
        descriptions capped 500 chars on sentence boundary (small-model budget)
        readOnlyHint → silent · everything else requiresConfirm (trust:'auto' waives)
        per-server toolAllowlist / toolDescriptions / maxResultChars / cwd
        params filtered to the declared inputSchema before calling (small models
          pad arguments; strict fail-closed servers reject them — accommodation
          is the bridge's job, strictness the server's)
        image content → [FILE:] tokens on the existing media pipeline
```

Stdio servers accept a `cwd` (servers that resolve their own relative paths — config files, downstream child processes — need their repo root, not Invarail's). Reference downstream: [FlowMCP](https://github.com/PeterGreenAppliedAI/FlowMCP) — a workflow-first MCP server whose compiled flows power the research pipeline's `flow_gather` stage (see README "Add an MCP server" for setup).

**Explicit tool mentions (code gate):** at pipeline dispatch, `findExplicitToolMentions` scans the message against the allowed tool names (word-boundary, case-insensitive; MCP-prefixed tools also match their bare downstream name — "weekly_gather" finds `flows_weekly_gather`). Hits are injected as `_explicitToolMentions`/`_explicitFlowMentions`. Two consumers: the research `flow_gather` gate, and the plan pipeline's skill guard — a matched skill whose steps never mention an explicitly named tool is ignored (explicit instruction outranks learned habit). Deliberately strict: no semantic flow-matching — "close enough" selection is the skill-hijack bug class, one layer up.

Deliberately NOT the official SDK — ~10% of the protocol (initialize/tools-list/tools-call), owned end to end; swap path stays behind `McpManager`. Failing servers never block boot; crashed servers lazily respawn (3×, 5s backoff). Specialists opt in per server with the `mcp:<server>` token (expanded at dispatch). Remote auth is OAuth 2.1 + PKCE + **Dynamic Client Registration**, fully local (no broker); tokens in the 0600 SecretStore, silent refresh at runtime — the browser-opening flow exists ONLY in `scripts/mcp-oauth-setup.ts`, so background paths can never pop an authorize page.

## Chrome Extension (Browser Companion)

```
Chrome Side Panel (React) → HTTP fetch (SSE streaming) → Invarail Web API (localhost:3100)
  ├── Content script extracts: URL, title, selected text, page content (~10K chars)
  ├── [PAGE:] token injected → console/api/chat detects → overrideCategory: chat
  ├── Context menus: "Ask Invarail about '%s'" (selection), "Summarize this page" (page)
  └── No fetching needed — model reads injected page content directly
```

Built with WXT (Manifest V3), React, TypeScript. Connects to existing Web channel API — no new backend. Works cross-network (extension on Windows, Invarail on Mac Mini).

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
