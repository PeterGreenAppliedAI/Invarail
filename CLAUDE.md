# CLAUDE.md — Invarail AI Code Generation Guidelines

## Architecture

Invarail uses a **Router + Specialist** pattern with a **tool-loop (ReAct) engine** and **deterministic pipelines**.

```
Channel (Discord/Telegram/Slack/Web/Gmail/WhatsApp/MS Graph/iMessage/Chrome Extension)
  -> Router (phi4:14b, classifies intent into one category)
    -> Pipeline (deterministic stages — most categories)
    -> OR Specialist (config-assigned model + ReAct tool-loop — chat, config, personal)
      -> Tool Executor (sandboxed via Docker or allowlist)
        -> Response back to channel
```

**Inference backends (additive multi-backend):** A `MultiBackendClient` (`src/ollama/multi-backend.ts`, extends `OllamaClient`) routes each `chat`/`chatStream` call by model id. Foreground reasoning models (currently DeepSeek-V4-Flash — the swappable foreground slot) route to an **OpenAI-compatible vLLM** endpoint via `OpenAICompatClient` (`src/ollama/openai-client.ts`); everything else (router phi4, NER phi4-mini, embedding, vision qwen3.6:27b) stays on the **Ollama gateway**. `embed()` always uses Ollama. Configured via `inference.backends[]` in config. The OpenAI client translates Ollama↔OpenAI shapes: `options.*`→top-level params (reserving reasoning headroom on `max_tokens` so a small `num_predict` can't starve a reasoning model into an empty completion), tool-call `arguments` string→object, `tool_call_id` stitching, SSE streaming, `usage`→`eval_count`/`prompt_eval_count`. Purely additive — the Ollama path is unchanged.

**Key components:**
- **Router** — phi4:14b, single-word classification into categories: `chat`, `web_search`, `memory`, `exec`, `cron`, `message`, `website`, `multi`, `config`, `task`, `research`, `personal`. Pre-model overrides for high-confidence patterns (PDF reports, calendar queries; bare URLs → website — a URL inside a larger request does NOT hijack routing). Model output is enum-grammar-constrained via `format` when the backend supports it. `config.router.timeout` is ENFORCED (Promise race → keyword fallback; the client's connection-retry loop no longer stalls messages past the budget). Fallback to `defaultCategory` on timeout/parse failure. Implemented in `src/router/classifier.ts`.
- **Pipeline engine** — `src/pipeline/executor.ts`. Deterministic stage-based workflows: extract, tool, parallel_tool, llm, code, branch, llm_branch, loop. Most categories use pipelines instead of letting the model decide the workflow. Extraction (`src/pipeline/extractor.ts`) uses grammar-constrained decoding (`format` JSON schema, auto-fallback if the backend rejects it), JSON5-tolerant parsing, post-parse required/enum/coercion validation feeding the repair prompt, and best-effort params over aborting; `ExtractStage.fallback(ctx)` provides deterministic degrade-not-abort per stage. `llm_branch` output is enum-constrained.
- **Plan pipeline** — `src/pipeline/definitions/plan.ts`. LLM decomposes goals into specialist sub-tasks, self-reflects, executes via foreman handoffs with write-through artifacts. Used by `multi` category. The skills system was retired 2026-08-10 (successor: graph experience memory — experience informs execution, never expands authority; see DECISIONS).
- **Research pipeline** — `src/pipeline/definitions/research.ts`. [flow_gather] → decompose → per-facet parallel search + fetch + synthesis → analytical markdown report → **evidence verification** → deterministic markdown→HTML→PDF render with charts (absolute img paths — LibreOffice resolves relative src against the temp HTML's dir). **Flow-first gathering:** when the request EXPLICITLY names an available flow tool, `flow_gather` calls it once; `parseFlowGather` turns its `##` sections into facets and links into per-facet source pools; decompose/parse_angles skip (`when` gates); `researchAngle(ctx, angle, presetUrls)` fetches/synthesizes identically so verification works unchanged. Flow failure degrades to normal search. Strict naming only — NO semantic flow-matching (that's the skill-hijack bug class one layer up).
- **Evidence verification** — `src/pipeline/verification.ts` + stages in research.ts. After the draft, extract atomic claims (fast model, grammar-constrained via `CLAIMS_JSON_SCHEMA`), check each against the **cached pages that actually mention it** (`pickRelevantSources` ranks all cached sources by token overlap — no independent search), and **attribute/qualify (never remove)** overstated or single-sourced claims. Corrections are **code-driven sentence splices**: `locateClaimSentence` fuzzy-locates the claim's sentence by token overlap (URLs AND decimal numbers are masked with same-length filler before segmentation — any non-terminator dot splices corrections mid-URL/mid-version-number; skips Sources/headings/charts; skips rather than splicing a wrong match), the model rewrites ONE sentence, code splices it back with sanity bounds — the report body is never handed to a model for wholesale rewriting. A **Tier-1 cross-check** then escalates a bounded set of high-impact, falsifiable claims (corporate events / financials / market-share, capped at `maxCrossChecks`) to ONE independent search each — CONTRADICTED → `correct` the wrong detail (this is what catches the Groq-date class of error); CONFIRMED → un-hedge; SILENT → leave. Publishes with a `## Verification` appendix + auditable `verification.json`. Config-gated via `verification` block (`enabled`, `crossCheck`, both default on).
- **Tool-loop engine** — `runToolLoop()` in `src/tool-loop/engine.ts`. ReAct-style loop with native Ollama tool calls + regex fallback parser. Includes hallucination detection, drift detection, error learning hints.
- **Dispatch pipeline** — `src/dispatch.ts` routes classified messages to specialists/pipelines. Handles 6-layer security enforcement, tool stripping, context isolation.
- **Briefing system** — `src/orchestrator.ts`. Separate from heartbeat. Runs at 8am/1:15pm/5pm. Gathers calendar + tasks + memory, runs CoT reasoning via qwen3.6:35b, delivers contextual insights.
- **OllamaClient** — `src/ollama/client.ts`, REST API wrapper with single retry on connection failure.
- **DockerBackend** — `src/exec/docker-backend.ts`, sandboxed command execution.

**Data flow:** Channel message -> session resolution -> Router classification (pre-model overrides → model → keyword fallback) -> Security filtering (6 layers) -> Pipeline or Specialist dispatch -> tool-loop execution -> [FILE:] token extraction -> response to channel (thinking stripped) -> transcript persistence (thinking preserved).

**Chrome Extension:** Browser companion side panel (WXT + React + Manifest V3) in `chrome-extension/`. Content script extracts page context (URL, title, selected text, page content). Connects to existing Web channel API via SSE streaming (`/console/api/chat`). When `[PAGE:]` token detected in message, `src/console/handlers/chat.ts` forces `overrideCategory: 'chat'` — model reads injected content directly, no fetching. Two dispatch paths exist: orchestrator (Discord/Telegram/etc.) and console API (Web/Extension) — routing overrides must be applied in the correct path.

**Thinking tag handling:** Models that emit thinking blocks (`<think>...</think>` for Qwen, `<|channel>thought\n...<channel|>` for Gemma 4) have their thinking preserved in the session transcript so the model can see its own reasoning on subsequent turns. Thinking is stripped via `stripThinking()` in `src/dispatch.ts` only for: channel delivery, graph memory turns, session state updates, continuation context previews, handoff summarization. The `num_ctx` Ollama option is passed through from `config.session.contextSize` to ensure models have enough context window for the larger history.

### Memory System

Memory uses a **dual-backend** architecture: **FalkorDB graph database** (primary) with flat JSONL FactStore (fallback).

**Graph memory (`src/memory/graph-store.ts`):**
- FalkorDB (GraphBLAS-based graph database, Docker on Mac Mini, Redis wire protocol)
- Native HNSW vector search (4096-dim embeddings via qwen3-embedding:8b)
- Semantic dedup on write (cosine distance < 0.15 rejected)
- Multi-signal search scoring: `similarity * 0.5 + recency * 0.2 + importance * 0.3` — plus a **relevance floor**: injection requires raw cosine ≥ 0.55 (scoring only orders; the floor rejects), contextual facts capped at 3
- Auto-injection: vector KNN + multi-hop entity traversal, silently injected into specialist context. Multi-hop only fires when ≥1 KNN result passed the floor but results are sparse

**Graph schema:**
```
(:Fact {text, importance, embedding})  -[:ABOUT]->       (:Entity {name, type})
(:Fact)                                -[:TAGGED]->      (:Tag {name})
(:Fact)                                -[:SUPERSEDES]->   (:Fact)           // temporal evolution
(:Fact)                                -[:EXTRACTED_FROM]->(:Turn)          // provenance
(:Turn {text, role, sessionKey})       -[:MENTIONS]->     (:Entity)         // conversation links
(:UserModel {communicationStyle, decisionPattern, topicInterests, frustrationTriggers})
```

**Cross-session search:** Turn nodes stored on every dispatch. `memory_search source="conversations"` searches via entity traversal + keyword fallback.

**Behavioral user modeling:** UserModel node updated every heartbeat by qwen3.6 analyzing recent interactions. Injected into specialist context as "User preferences."

**Flat store fallback (`src/memory/fact-store.ts`):**
- JSONL index + facts.json, used when FalkorDB is unavailable
- Still handles heartbeat diffing, review candidates, removed.jsonl tracking
- Embedding dedup (cosine > 0.85) + hash + substring checks
- **Char bound is importance-aware** (`enforceCharBound`): `MAX_FACTS_CHARS=20000`; eviction drops lowest *importance* first, then confidence as tiebreak. Tiers imp≥4 (identity/critical) are NEVER evicted. (Fixed a bug where a confidence-only trim at a 3000-char cap silently deleted identity facts like a spouse's name.)

**Importance tiers on FactEntry:**
- 5=critical (health/family, never expires), 4=identity (job/projects, never expires)
- 3=preference (90 days), 2=context (30 days), 1=ephemeral (7 days)

**Graph provenance edges (now wired):** `addFact(input, senderId, sourceSession)` — callers pass the session key so `(:Fact)-[:EXTRACTED_FROM]->(:Turn)` links to the conversation it came from. Contradiction check creates `(:Fact)-[:SUPERSEDES]->(:Fact)` (new→old) after the new node exists, setting `superseded=true`. (Both edge types were defined but never created until the session-key + edge-creation wiring landed.)

**Known limitation:** Multi-signal scoring uses fixed linear weights. A reranker (cross-encoder or LLM-based) may be needed if wrong facts consistently surface over correct ones. Monitor auto-injection quality before adding complexity.

**Fact extraction paths:**
1. **`!reset` (user-approved)** — On session clear, facts extracted via configurable model (`memory.extractionModel`, defaults to router model) with few-shot importance examples (imp 1-5), candidates shown. On `!save`, facts written to both flat FactStore AND GraphMemory (entity linking, NER, vector embedding).
2. **Heartbeat (autonomous)** — Every 2 hours, `reviewTranscripts()` scans sessions, extracts facts with existing facts shown to prevent re-extraction. Writes to both flat FactStore and GraphMemory.
3. **`memory_forget`** — Removes from both graph and flat store. Records removal to prevent re-extraction.

**Entity extraction:** NER prompt in `graph-store.ts` requests typed entities `[{name, type}]` with closed taxonomy (person, organization, technology, hardware, software, place, event, concept). Entity names are normalized to canonical form (lowercase, collapsed whitespace, singular) before MERGE to prevent duplicates. Entity type upgrades from `unknown` to real type on subsequent encounters via `ON MATCH SET`. NER prompt is **bootstrapped** from the graph — existing typed entities are queried and injected as reference context so the model classifies consistently with prior decisions (self-improving loop).

**Search:** `memory_search` uses graph vector KNN (primary) or flat store keyword scoring (fallback). `source="knowledge"` for vector search over imported documents. `source="conversations"` for cross-session search via entity traversal + keyword matching.

**Commands:** `!forget <term>` — direct command, bypasses router, removes matching facts from both graph and flat store with flexible word-level matching.

**Self-improvement store:** `.learnings/errors.jsonl` records tool failures. Before tool execution, `findHints()` checks for matching past errors and prepends hints. `enrichObservation()` scans tool output for 8 known error patterns (permission denied, timeout, 404, rate limit, etc.) and enriches with **tool-specific recovery instructions** via `TOOL_RECOVERY_MAP` (e.g., web_fetch 404 → "use web_search to find correct URL"). Falls back to generic suggestions for unknown tools. Recurring patterns (3+ occurrences) promoted to `LEARNINGS.md` via heartbeat.

**Lessons (negative procedural memory, `src/learnings/lesson-*.ts`):** approach-level boundaries learned from observed failures — the runtime agent's own DECISIONS.md. Code detects (harvester over metrics/dead-letters, never model self-assessment); the heartbeat's extraction model fills a grammar-constrained lesson slot (max 3 new/cycle, batch-distrust guard, dedup-or-reinforce ladder). **Injection is gated on recurrence: evidence ≥ 2** — floor-gated KNN one-liners (max 2) in user priming + tool-tagged boundaries via findHints. Lessons record the model that produced the failure (point-in-time observations). `!lessons` lists/drops; `memory.lessons.enabled` gates everything.

---

## Code Standards

### Error Handling

Use the error factory in `src/errors.ts` — never ad-hoc try/catch with raw `Error` or `console.error`.

```typescript
// CORRECT — use factory functions
import { toolExecutionError, ollamaUnreachable } from './errors.js';
throw toolExecutionError('web_search', cause);

// WRONG — ad-hoc error
throw new Error('Tool failed');
console.error('Something broke:', err);
```

**Available error codes:** `ROUTER_TIMEOUT`, `ROUTER_PARSE_FAILURE`, `REACT_MAX_ITERATIONS`, `REACT_PARSE_FAILURE`, `TOOL_EXECUTION_ERROR`, `TOOL_NOT_FOUND`, `OLLAMA_UNREACHABLE`, `OLLAMA_INFERENCE_ERROR`, `CONFIG_INVALID`, `CHANNEL_CONNECT_ERROR`, `CHANNEL_SEND_ERROR`, `SSRF_BLOCKED`, `SESSION_IO_ERROR`, `PIPELINE_STAGE_ERROR`, `PIPELINE_EXTRACT_FAILURE`.

Each has a corresponding factory function. All errors are `InvarailError` instances with a `code` property.

### Module System

**ESM only.** Never use `require()`. Always use `import`/`export` with `.js` extensions on relative imports.

```typescript
// CORRECT
import { writeFileSync } from 'node:fs';
import { FactStore } from '../memory/fact-store.js';

// WRONG
const fs = require('node:fs');
```

### Security

Channel security is enforced in `src/dispatch.ts` via 6 layered filters applied in order:

1. `allowedCategories` — whitelist of categories this channel can access
2. `restrictedCategories` — blocked for untrusted users
3. `ownerOnlyTools` — stripped for everyone except `config.ownerId` (code gate, not model-level)
4. `blockedTools` — stripped for everyone on this channel
5. `restrictedTools` — stripped for untrusted users
6. `confirmTools` — preview before execution, requires user confirmation. Backed by the **pending-action ledger** (`src/security/pending-actions.ts`): previews record `{id, tool, params, sender, expiresAt}`; a "confirm" reply executes the STORED call — sender-bound, single-use, 10-min expiry, never model-regenerated params. Applies to pipeline dispatches AND the ReAct loop, on orchestrator channels AND the console path. Effective confirm set = channel `confirmTools` ∪ tools whose `autonomy.tier` metadata is `propose_confirm` − channel `autoApproveTools` (per-channel promotion; explicit confirmTools always wins).

**Autonomy ladder (structural):** tools may declare `autonomy: {tier: silent|act_then_notify|propose_confirm, reversible, blastRadius: self|owner|external}` (`src/tools/types.ts`). New externally-visible tools should declare `propose_confirm`. Every autonomous action (heartbeat auto-complete/cancel, cron runs, stale-fact proposals, ledger confirmations) logs via `logAutonomousAction()` in metrics.ts — the track record that justifies promoting an action type up the ladder via `autoApproveTools`. Bounds are code gates, never model judgment.

**Target-bound standing grants** (`src/security/grants.ts`): the rung between propose_confirm and blanket autoApproveTools. Tools declaring `targetArgs` (the params naming their external target — `send_message` → `['channel','channelId']`) are grant-eligible; replying `always <id>` to a confirm preview executes AND mints a grant for that exact tool→target key, so future identical-target calls run silently (logged `grant_used`). Tools without targetArgs (exec) are structurally ineligible. Grants mint only on successful execution, are principal-bound, exact-match, revocable via `!grants revoke <id>`. Implicit reply-origin approval: a send to the exact conversation the request came from never asks.

**Owner-only tier:** `ownerId` in config is a single string (not a list). Tools in `ownerOnlyTools` are completely invisible to non-owners — the model never sees them in the tool list. This is a **code gate** checked before any model involvement.

Additional security:
- SSRF protection in `src/tools/ssrf.ts` — all URL-fetching tools must use it.
- Exec security: Docker sandbox or command allowlist, configured per `config.tools.exec.security`.
- Cron safety: `cronMode` strips write tools; `exec`/`send_message` are only available when the job was explicitly scheduled as that category (`filterCronTools` — the owner-authored schedule is the code gate). Jobs retry 2x with exponential backoff + notify on final failure. Cron expressions are croner-validated in `cron_add`/`cron_edit` BEFORE persisting.
- Pipeline isolation: all pipeline dispatches get fresh context (no parent session history).

### SOLID / DRY / YAGNI / KISS

- **Single responsibility** per module. Tools do one thing. Adapters implement 5 methods. Router classifies.
- **Open/Closed** — New tools implement `InvarailTool` interface without changing core. New adapters implement `ChannelAdapter` without changing core.
- **No speculative features** — Only build what has a real use case now.
- **Reuse existing utilities** — Check `src/tools/`, `src/errors.ts`, `src/config/` before creating new abstractions.
- **Simple systems fail predictably** — Prefer straightforward logic over clever abstractions.

### Contracts & Types

- Zod schemas in `src/config/schema.ts` are the **source of truth** for configuration.
- TypeScript types are inferred from Zod: `type InvarailConfig = z.infer<typeof InvarailConfigSchema>` (in `src/config/types.ts`).
- **Never duplicate types** — always derive from Zod schemas using `z.infer<>`.
- Config flow: JSON5 file -> env variable interpolation -> Zod parse/validate -> TypeScript types.

### Tools

- Must implement the `InvarailTool` interface from `src/tools/types.ts`:
  ```typescript
  interface InvarailTool {
    name: string;
    description: string;
    parameterDescription: string;
    parameters?: ToolParameterSchema;  // structured params for native tool calling
    example?: string;
    category: string;
    requiresConfirm?: boolean;         // the one autonomy bit — confirm-gated everywhere unless a channel's autoApproveTools promotes it
    resultLimit?: number;              // per-tool truncation cap; static TOOL_RESULT_LIMITS map wins for built-ins
    execute: (params: Record<string, unknown>, ctx: ToolContext) => Promise<string>;
  }
  ```
- Each tool is created by a factory function: `createXxxTool(deps) -> InvarailTool`.
- Register new tools in `src/tools/register-all.ts` via `registry.register(tool)`.
- Tool descriptions should include: WHEN TO USE, DO NOT, and common chain patterns.
- Tool results are truncated to `MAX_TOOL_RESULT_CHARS` (2000, 8000 for browser) by the tool-loop engine.
- Tool params are validated and type-coerced at runtime (`validateToolParams()` in engine.ts).
- `[FILE:path]` tokens in tool output are stripped before the model sees them and re-appended after the final answer for media delivery.

### MCP bridge (`src/mcp/`)

- External MCP servers (configured in `tools.mcp.servers[]`) are spawned as stdio children and their tools auto-registered as `InvarailTool`s named `<server>_<tool>`, category `mcp:<server>`.
- Protocol client is a **zero-dep** JSON-RPC 2.0 implementation (initialize → tools/list → tools/call only) — deliberately not the official SDK; swap path stays behind `McpManager`.
- **Security default:** tools without `annotations.readOnlyHint` get `requiresConfirm: true`; per-server `trust: 'auto'` in config waives it (owner-authored config = code gate). Channel-layer gates work unchanged (name-based).
- **Small-model layer:** descriptions capped at 500 chars on a sentence boundary; per-server `toolAllowlist`, `toolDescriptions` (hand-curated rewrites), `maxResultChars` (raise for gathering tools — the 2000 default cuts bulk material), and **schema param filtering** (`filterToSchema` in manager.ts): params not in the tool's declared inputSchema are dropped before calling — small models pad arguments, strict servers fail closed, accommodation is the bridge's job.
- **Stdio `cwd`:** servers that resolve their own relative paths (config files, downstream children — e.g. FlowMCP's servers.json5) must run from their repo root; set `cwd` in the server config.
- Specialist tool lists may use the token `mcp:<server>` to include a server's entire toolset (expanded in dispatch via `registry.expandToolNames`).
- A failing server never blocks boot; a crashed server is lazily respawned on next call (3 attempts, 5s backoff).
- **Explicit tool mentions (code gate):** `registry.findExplicitToolMentions(message, allowedNames)` — word-boundary, case-insensitive, MCP-prefixed tools also match their bare downstream name. Dispatch injects hits as `_explicitToolMentions`/`_explicitFlowMentions` into pipeline params. Consumers: research `flow_gather` (flow-first gathering) and plan `skill_check` (a matched skill whose steps never mention an explicitly named tool is ignored). Reference downstream server: FlowMCP (github.com/PeterGreenAppliedAI/FlowMCP).

### Dependencies

- No new dependencies without justification. Node 22+ built-ins preferred.
- Current stack: zod, discord.js, better-sqlite3, croner, json5, playwright-core, googleapis, sharp.

---

## File Map

```
src/
  index.ts                  # Entry point (REPL or Orchestrator mode)
  orchestrator.ts           # Main class: lifecycle, heartbeat, briefing, commands
  dispatch.ts               # Router → Specialist/Pipeline + 6-layer security
  errors.ts                 # Error codes + factory functions (single choke point)
  metrics.ts                # Logging/telemetry

  config/                   # Configuration
    schema.ts               #   Zod schemas (source of truth)
    types.ts                #   z.infer<> type exports
    loader.ts               #   JSON5 config loading + env interpolation

  pipeline/                 # Deterministic pipeline engine
    executor.ts             #   Stage runner (extract, tool, llm, code, branch, loop, parallel_tool)
    registry.ts             #   Pipeline registry
    types.ts                #   Stage types, PipelineContext, SubDispatchResult
    extractor.ts            #   LLM-based parameter extraction with JSON repair
    verification.ts         #   Research claim verification (extract → cited-source check → Tier-1 cross-check → patch-set)
    definitions/            #   Pipeline definitions per category
      plan.ts               #     Plan pipeline (foreman handoffs, skill check, reflection)
      research.ts           #     Research pipeline (decompose → per-facet research → verify → PDF)
      heartbeat.ts          #     Deterministic heartbeat (task board + memory, no LLM date reasoning)
      cron.ts, task.ts, memory.ts, web-search.ts, exec.ts, message.ts, website.ts, code-gen.ts

  tool-loop/                # ReAct execution engine
    engine.ts               #   runToolLoop() — core loop + drift detection + error learning
    parser.ts               #   parseReActResponse() — regex parser + JSON5 repair
    prompt-builder.ts       #   buildReActSystemPrompt(), buildScratchpad()
    types.ts                #   ReActStep, ReActResult, ReActConfig

  tools/                    # 34 tool implementations
    types.ts                #   InvarailTool, ToolContext, ToolExecutor interfaces
    registry.ts             #   ToolRegistry class
    register-all.ts         #   registerAllTools() — wires all tools
    ssrf.ts                 #   SSRF protection for URL-fetching tools
    document.ts             #   LibreOffice headless document creation/conversion (markdown in → code-owned styling; models never write HTML/CSS)
    document-templates.ts   #   HTML templates (report/memo/invoice/letter/simple) for document tool
    gmail-read.ts           #   Gmail search + read (OAuth2, read-only)
    calendar-read.ts        #   Google Calendar list + search (OAuth2, read-only)
    memory-forget.ts        #   Remove facts by text match
    *.ts                    #   Individual tool factories (createXxxTool)

  learnings/                # Self-improvement system
    error-store.ts          #   ErrorLearningStore — JSONL store for tool failures (findHints also surfaces tool-tagged lessons)
    pattern-matcher.ts      #   detectErrorPattern() + enrichObservation()
    lesson-store.ts         #   LessonStore — negative procedural memory (boundary lessons, evidence counts, model-at-observation)
    lesson-harvester.ts     #   Code-driven failure-candidate detection from metrics.jsonl/unrouted.jsonl (marker-tracked)
    lesson-synthesis.ts     #   Heartbeat: grammar-constrained lesson synthesis + dedup ladder + firehose guards
    lesson-semantic.ts      #   Lesson embeddings (EmbeddingStore source='lesson'); injection requires evidence ≥ 2

  channels/                 # Channel adapters (all support file attachments)
    types.ts                #   ChannelAdapter, InboundMessage, MessageTarget, MessageContent
    registry.ts             #   ChannelRegistry class
    discord/                #   Discord adapter (discord.js)
    telegram/               #   Telegram adapter (grammy)
    web/                    #   Web API adapter + voice UI
    gmail/                  #   Gmail adapter (googleapis)

  router/                   # Message classification
    classifier.ts           #   classifyMessage() — pre-model overrides → model → keyword fallback
    prompt.ts               #   Router prompt template

  ollama/                   # LLM inference
    client.ts               #   OllamaClient (REST API wrapper, single retry on connection failure)
    openai-client.ts        #   OpenAICompatClient — vLLM /v1/chat/completions, Ollama<->OpenAI translation
    multi-backend.ts        #   MultiBackendClient (extends OllamaClient) — routes by model id; createInferenceClient()
    types.ts                #   OllamaMessage, OllamaTool, OllamaToolCall

  plugins/                  # Plugin system — dynamic tool discovery
    loader.ts               #   Scan plugins/ and ~/.invarail/plugins/, dynamic import, auto-register
    types.ts                #   PluginManifest, PluginExport interfaces

  mcp/                      # MCP client bridge — external tool servers as Invarail tools
    client.ts               #   McpStdioClient — zero-dep JSON-RPC 2.0 over newline-delimited stdio
    http-client.ts          #   McpHttpClient — streamable HTTP transport (JSON + SSE), same interface
    oauth.ts                #   OAuth 2.1 + PKCE + DCR, fully local; browser flow ONLY via scripts/mcp-oauth-setup.ts
    manager.ts              #   McpManager — transport pick + lifecycle (lazy respawn) + tool translation layer
    types.ts                #   McpToolDefinition, McpContent, McpCallResult, JsonRpcResponse

  agents/                   # Agent routing & workspace
    resolve-route.ts        #   Binding-based agent routing
    scope.ts                #   Workspace path resolution
    workspace.ts            #   Workspace bootstrap + context building (LEARNINGS.md in minimal)

  exec/                     # Command execution
    docker-backend.ts       #   DockerBackend (sandboxed exec)
    session-manager.ts      #   SessionManager for code sessions

  context/                  # Context management
    budget.ts               #   computeBudget()
    compactor.ts            #   buildCompactedHistory()
    tokens.ts               #   estimateTokens() — word-aware heuristic

  memory/                   # Memory system
    fact-store.ts           #   FactStore (JSONL index, dedup, TTL, consolidation, removeFact) — fallback
    graph-store.ts          #   GraphMemoryStore (FalkorDB, vector search, entity linking, SUPERSEDES)
    embeddings.ts           #   EmbeddingStore (SQLite + vectors, used for knowledge_import)
    consolidation.ts        #   consolidateFactsWithLLM() — LLM-driven dedup
    search.ts               #   searchMarkdownFiles() — keyword search over workspace .md files

  cron/                     # Scheduling
    service.ts              #   CronService (retry 2x with exponential backoff)
    store.ts                #   CronStore

  sessions/                 # Session persistence
    store.ts                #   SessionStore (JSON transcripts)

  services/                 # Shared services
    attachments.ts          #   saveAttachment(), isImageMime()
    tts.ts, stt.ts          #   Text-to-speech, speech-to-text
    vision.ts               #   VisionService

  console/                  # Management console API
    api.ts                  #   Route handler
    handlers/               #   Per-resource handlers (status, channels, cron, tasks, tools, etc.)

  tasks/                    # Task management
    store.ts                #   TaskStore

  setup/                    # Interactive setup wizard
    index.ts                #   Entry point
    steps/                  #   Individual setup steps

  utils/
    text.ts                   #   stripThinkingTags, splitFinalMessage (extracted from orchestrator)

  commands/
    router.ts                 #   isCommand(), getCommandName() — command detection
    types.ts                  #   CommandContext interface

  services/                   # Extracted services (from orchestrator decomposition)
    heartbeat-service.ts      #   runHeartbeat() — 411 lines of maintenance logic
    briefing-service.ts       #   runBriefing() — calendar/task/memory CoT synthesis
    rate-limiter.ts           #   Sliding window per-user rate limiter
    media-debouncer.ts        #   3-second batching for rapid media messages
    media-extraction.ts       #   extractMediaAttachments() — [IMAGE:]/[FILE:] token parsing

  learnings/
    training-collector.ts     #   extractTrainingPairs() — router training data from sessions

  browser/
    remote-bridge.ts          #   Action queue between backend and Chrome extension

chrome-extension/             # Browser companion (separate npm project)
  entrypoints/
    background.ts             #   Service worker: context menus, message relay, screenshot capture
    content.ts                #   Content script: page context + DOM action executor
    sidepanel/                #   React side panel (chat UI, settings, action polling)
  lib/
    api.ts                    #   Invarail API client (SSE streaming, browser bridge)
    storage.ts                #   chrome.storage.local wrappers
    types.ts                  #   Shared types
```

---

## Patterns to Follow

### Error factory pattern (`src/errors.ts`)
All errors use `InvarailError` with a typed `ErrorCode`. One factory function per error type.
```typescript
export const toolExecutionError = (tool: string, cause: unknown) =>
  new InvarailError('TOOL_EXECUTION_ERROR', `Tool "${tool}" failed`, cause);
```

### Tool registration pattern (`src/tools/register-all.ts`)
Each tool is a factory function that takes dependencies and returns a `InvarailTool`. Tools are conditionally registered based on config/availability.
```typescript
const webSearch = createWebSearchTool(config.tools?.web?.search);
registry.register(webSearch);
```

### Tool description pattern
Tool descriptions include WHEN TO USE, DO NOT, and common chains:
```typescript
description: `Read file contents. WHEN TO USE: Need to read a file from a prior step.
DO NOT use exec[cat] — always use read_file.`
```

### Channel adapter pattern (`src/channels/registry.ts`)
5-method `ChannelAdapter` interface. All adapters must handle `content.attachments` for file delivery. Open/Closed: add new adapter = implement interface + register.

### Config flow
JSON5 -> env interpolation -> Zod validation -> TypeScript types. Never hand-write config types — always `z.infer<typeof XxxSchema>`.

### Security enforcement in dispatch (`src/dispatch.ts`)
6-layer filtering: allowedCategories → ownerOnlyTools (code gate) → restrictedCategories (untrusted) → blockedTools → restrictedTools (untrusted) → confirmTools (preview). Each layer narrows what a message can do.

### Thinking tag preservation pattern (`src/dispatch.ts`)
Thinking blocks are preserved in session transcripts for model continuity across turns. Stripped only at display boundaries:
- `stripThinking()` in dispatch.ts — strips for channel delivery, graph memory, session state, continuation context, handoff summaries
- `stripThinkingTags()` in compactor.ts — strips from archive text before feeding to summarizer LLM
- `stripThinkingTags()` in state-tracker.ts — strips before feeding transcript turns to semantic extraction model
- `stripThinkingTags()` in orchestrator.ts — strips from assistant turns before fact extraction
- Handles both Qwen (`<think>...</think>`) and Gemma 4 (`<|channel>thought\n...<channel|>`) formats

### [FILE:] token pattern
Document/media tools return `[FILE:path]` tokens. These are:
1. **Stripped** from tool observations before the model sees them (engine.ts)
2. **Stripped** from plan pipeline results before summarization LLM (plan.ts)
3. **Re-appended** to the final answer after all LLM processing
4. **Extracted** by `extractMediaAttachments()` in orchestrator.ts for channel delivery

### [PAGE:] token pattern (Chrome Extension)
Chrome extension injects `[PAGE: url | title]`, `[SELECTED: text]`, and `[PAGE_CONTENT]...[/PAGE_CONTENT]` tokens into messages. Detection in `src/console/handlers/chat.ts` forces `overrideCategory: 'chat'` — the model reads injected content, never fetches. Data-file uploads route to `exec` (the analytics pipeline was retired 2026-08-10; code_session covers pandas work on request).

**Important:** The console API (`/console/api/chat`) dispatches directly — NOT through the orchestrator's `handleMessage()`. Routing overrides for Web/Extension must go in `chat.ts`, not `orchestrator.ts`.

### Foreman handoff pattern (`src/pipeline/definitions/plan.ts`)
Plan pipeline sub-dispatches use structured briefings (not raw result dumps):
- Sub-dispatch returns typed `SubDispatchResult` with status, filePaths, urls, category (extracted at dispatch layer)
- Write full step results to `.plan-artifacts/step-N.txt`
- Build handoff message with: task, plan context, completed steps (status + artifact paths), available artifacts
- Specialists use `read_file` to access prior step content on demand

### Pipeline isolation
All pipeline dispatches get fresh context — no parent session history. Prevents prior conversation topics from biasing pipeline execution.

### Context priority layers (`src/agents/workspace.ts`)
Tool-using specialists get `minimal` workspace context (SOUL.md + IDENTITY.md + LEARNINGS.md) to preserve token budget. Chat gets `full` context.

### Tool-loop guardrails (`src/tool-loop/engine.ts`)
- **One calling convention per model** — `toolStyle: 'native' | 'text'` (specialist config, default native). Native passes tools via the API field only; text describes them in the prompt with `Action:` format. Never both — mixing taught small models two contradictory formats. Fallback parsers (DSML/`<invoke>`/`Action:`/JSON5) stay active in both modes.
- **Hallucination detection** — catches models claiming actions without tool calls. Action-claims and data-claims are separate pattern sets: data claims ("the current price is...") are legitimate once a real tool has run. Repair prompt sent once.
- **Drift detection** — catches repeating tool calls, hedging language, growing responses. Re-anchor prompt after 3+ iterations.
- **Repairs don't burn budget** — each one-shot repair (hallucination, refusal, empty-completion retry, drift re-anchor) extends the loop by one iteration instead of consuming maxIterations.
- **Answer hygiene** — ReAct scaffolding (`Thought:`/`Final Answer:`) is stripped from the answer path; empty completions get one retry. Thinking blocks are left intact here (dispatch strips at delivery boundaries).
- **Error learning** — records failures, hints before execution, enriches observations with tool-specific recovery guidance.
- **Observation summarization** — optional LLM-based summarization for old tool observations (>1000 chars) when context budget is tight. Preserves key data vs hard truncation. Config: `session.summarizeToolObservations`.
- **Param validation** — runtime type coercion (string→number, string→boolean) + enum + required field checks before execution.

### Heartbeat vs Briefing
- **Heartbeat** (every 2h): maintenance only — transcript review, fact extraction, learning promotion, media cleanup, memory consolidation. Dispatches report via plan pipeline.
- **Briefing** (8am, 1:15pm, 5pm): gathers calendar + tasks + memory directly via tool executor, runs CoT reasoning, delivers contextual insight. Separate cron, separate method.

---

## Patterns to Avoid

### Silent error swallowing
```typescript
// BAD
).catch(() => {});

// GOOD
).catch(err => console.warn('[Context] Send failed:', err instanceof Error ? err.message : err));
```

### Duplicating types instead of using Zod inference
```typescript
// BAD
interface MyConfig { url: string; timeout: number; }

// GOOD
const MyConfigSchema = z.object({ url: z.string(), timeout: z.number() });
type MyConfig = z.infer<typeof MyConfigSchema>;
```

### Using require() in ESM
```typescript
// BAD
const { writeFileSync } = require('node:fs');

// GOOD
import { writeFileSync } from 'node:fs';
```

### Passing [FILE:] tokens to the model
Never let the model see `[FILE:path]` tokens — it will rewrite them into fake markdown links. Strip before the model sees the observation, re-append after the model produces the final answer.

### Heartbeat/cron matching saved skills
System operations (heartbeat, cron) should never match or save user-facing skills. Check for heartbeat signatures in `skill_check` and `skill_save` stages.

---

## Testing

- **Framework:** Vitest (`npm test` / `vitest run`)
- **Type checking:** `npx tsc --noEmit`
- **CI:** GitHub Actions runs type check + tests + build on every push/PR to main
- **Current:** 451 tests across 33 files
- **Live checks (real models, no config changes):** `scripts/router-live-check.ts`, `scripts/tool-loop-live-check.ts`. NOTE: node spawned from SSH sessions is silently denied LAN access by macOS (EHOSTUNREACH) — run live checks inside the `lab` tmux session (`tmux send-keys -t lab '...' Enter`), see DECISIONS.md
- **What needs tests** (Tier 2+ per code_rubric):
  - Auth/authz logic (owner-only tier, security filtering)
  - Networking (Ollama client, web fetch, SSRF checks)
  - Persistence (session store, memory, cron store, error learning store)
  - Concurrency (tool-loop iteration limits, timeouts)
  - Error handling changes (error factory coverage)
  - Security controls (dispatch filtering, exec sandboxing)
  - New tools (document tool, Gmail/Calendar tools)
- Tier 0-1 (docs, formatting, UI text) — tests optional.
- Tier 3 (security controls, PII, remote execution) — mandatory full coverage.

---

## Review Checklist

Condensed from the Universal Code Review Rubric (9 gates):

1. **Intent** — Does the change match what was asked? No scope creep?
2. **Correctness** — Contracts honored? Zod schemas updated if config changes? Types derived, not duplicated?
3. **Failure semantics** — Uses error factory? No silent catches? Timeouts bounded? Retries idempotent?
4. **Security** — All 6 dispatch layers intact? Owner-only gate checked? SSRF on URLs? Exec sandboxed? No trust escalation?
5. **Data integrity** — State mutations atomic? Session/memory writes consistent? No partial updates on error?
6. **Concurrency** — Tool-loop bounded by maxIterations? Async operations properly awaited? No race conditions?
7. **Observability** — Errors have codes? Key operations logged? Metrics updated?
8. **Tests** — Tier 2+ changes have test evidence? Edge cases covered?
9. **Maintainability** — Single responsibility? Reuses existing patterns? No speculative abstractions? ESM imports (no require)?

**Merge rules:** Any blocker = no merge. Tier 2+: all 9 gates pass. Tier 3: security + failure gates must be strong.
