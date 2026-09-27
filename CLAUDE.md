# CLAUDE.md — Invarail AI Code Generation Guidelines

## Architecture

Invarail uses a **Router + Specialist** pattern with an **arena tool-loop (ReAct) engine** as the default execution mode, plus **deterministic pipelines** where the task carries its own verification oracle.

```
Channel (Discord/Telegram/Web/Gmail/Chrome Extension)
  -> Router (`router.model` — phi4:latest on the 3060 — classifies intent into one category; a System-One shadow router may be asked the same question and logged, never decides)
    -> ARENA (open ReAct loop, natural stop — the default for conversational categories)
    -> OR Pipeline (deterministic stages — research + system heartbeat only)
      -> Tool Executor (sandboxed via Docker or allowlist)
        -> Response back to channel
```

**Arena fleet-wide (DECISIONS 2026-08-21):** categories `cron`, `task`, `memory`, `message`, `website`, `web_search`, `exec`, `code_gen`, `multi` run `dispatchMode: "arena"` — open loop with session history, same six security layers and confirm ledger. Deterministic pipelines survive ONLY where stages are an oracle, not choreography: **research** (claim verification) and the system **heartbeat**. Doctrine: *constrain the arena, not every move* — and (harness duel + dsh source audit, DECISIONS 2026-08-22/23) *the loop is a commodity; the walls are the product*.

**Inference backends (additive multi-backend):** A `MultiBackendClient` (`src/ollama/multi-backend.ts`, extends `OllamaClient`) routes each `chat`/`chatStream`/`embed` call by model id across three backend kinds: `inference.backends[]` (OpenAI-compat — the Spark's vLLM, coding only), `inference.ollamaBackends[]` (extra Ollama-native hosts — the A5000 foreground, the 3060 utility box, the Mini embedder), and the primary Ollama for anything unrouted. **THE foreground model is a single config line** — `defaultModel` (currently `qwen3.8:27B`, Ollama-native on a 24GB A5000; `session.contextSize` 32768) is filled pre-parse into every specialist/briefing/heartbeat/vision slot that doesn't override it (`applyDefaultModel` in loader.ts); a model cutover = that line + the backend entry (+ `pi.model`). Utility tier: `router.model`/`memory.extractionModel` = phi4:latest (the `:14b` tag 404s on the 3060), `memory.nerModel` phi4-mini — on the 3060; voice replies on the foreground model via the lean voice flow (`config.voice`: model/contextSize/maxTokens/historyTurns — small models beside the 27B split to CPU, DECISIONS voice round three); `memory.embeddingModel` qwen3-embedding:8b resident alone on the Mini (router/embedder VRAM contention blew priming's 8s cap and silently skipped memory injection, 2026-09-19). **Prompt order is a KV-prefix-cache contract** (2026-09-19): `[static system][append-only history][volatile state+memory][user]` in BOTH `runToolLoop` and `runAsBareChat` — `buildVolatileContext()`; per-turn content in the cached head re-prefills everything (61s → 0.3s), and `test/tool-loop/prefix-cache.test.ts` guards it. **On a hybrid model the contract holds only for tail-side divergence** (qwen35 = SSM layers + attention every 4th; recurrent state restores from checkpoints, not arbitrary tokens — measured 2026-09-26: append-only 283ms, tail change ~850ms, a window slid by one exchange 4036ms = cold). The voice history window is therefore ANCHORED with hysteresis (`voiceWindowStart`), and bare chat prints a `[Chat] … prompt=Ntok/Xms gen=Ntok/Yms` line — read it before theorizing about latency. Ollama-native `chat()` streams internally too (headers timeout); the stream accumulator collects `tool_calls` across chunks — reading them off the last (stats-only) chunk dropped every native tool call for a day (2026-09-20). The OpenAI-compat client (`src/ollama/openai-client.ts`) translates Ollama↔OpenAI shapes: `options.*`→top-level params (reasoning headroom on `max_tokens`), tool-call `arguments` string→object, `tool_call_id` stitching, `usage`→`eval_count`. **`chat()` always streams under the hood** — a non-streaming request sends no headers until generation completes and undici kills header-less connections at 5 min (live-caught 2026-08-26); SSE headers arrive instantly, so the only clock is `OLLAMA_CHAT_TIMEOUT_MS`. **Separated reasoning** (vLLM `reasoning`/`reasoning_content` fields) maps to inline `<think>` tags so the whole thinking pipeline applies uniformly. **`think` control:** forwarded only for backends declaring `supportsThink` (warn-once-omit otherwise — never a silent drop); **model-caps** (`src/ollama/model-caps.ts`) declare per-model quirks, incl. `noThinkLeaksDeliberation` (glm-5.3 narrates its deliberation INSIDE content when thinking is suppressed — the client coerces `think:false`→`true` on such models, warn-once; per-specialist `think` flags are qwen-era values, coerced at this choke point).

**Key components:**
- **Router** — `router.model` (phi4:latest), single-word classification into the configured categories: `chat`, `web_search`, `memory`, `exec`, `cron`, `message`, `website`, `multi`, `task`, `research`, `image`, `code_gen` (`config`/`personal`/`analytics` retired 2026-08-10 — email/calendar reads route to `multi`, the only holder of the owner-only Gmail/Calendar tools, and the `multi` description must SAY so or the router cannot know: 6/6 misroutes until it did, 2026-09-25). Pre-model overrides for high-confidence patterns (PDF reports; bare URLs → website — a URL inside a larger request does NOT hijack routing). Model output is enum-grammar-constrained via `format` when the backend supports it. `config.router.timeout` is ENFORCED (Promise race → keyword fallback; the client's connection-retry loop no longer stalls messages past the budget). Fallback to `defaultCategory` on timeout/parse failure. Implemented in `src/router/classifier.ts`. **Shadow router** (`router.shadow`, `src/router/shadow.ts` + `systemone-client.ts`, 2026-09-25): a System-One decision model (Laya, `/v1/systemone`) is asked the same question with `router.categories` descriptions as option text and logged beside the live decision in `data/router-shadow.jsonl` — wraps `classifyMessage` so every decision path is compared, fire-and-forget, never decides. The switch (`router.backend`) waits on the real-traffic disagreement rate (DECISIONS "A 421M Encoder Out-Routes phi4").
- **Pipeline engine** — `src/pipeline/executor.ts`. Deterministic stage-based workflows: extract, tool, parallel_tool, llm, code, branch, llm_branch, loop. Since the arena melt (2026-08-21) only research and heartbeat use it — pipelines earn their keep where stages are verification, not choreography. Extraction (`src/pipeline/extractor.ts`) uses grammar-constrained decoding (`format` JSON schema, auto-fallback if the backend rejects it), a 2048-token default budget (thinking counts against `num_predict` — 256 starved thinking models into emitting reasoning prose with no JSON; 2026-08 eval), `stripThinkingTags` before parsing (Qwen `<think>` AND Gemma-4 formats), JSON5-tolerant parsing, post-parse required/enum/coercion validation feeding the repair prompt, and best-effort params over aborting; `ExtractStage.fallback(ctx)` provides deterministic degrade-not-abort per stage. `llm_branch` output is enum-constrained.
- **Plan pipeline (RETIRED for dispatch)** — `src/pipeline/definitions/plan.ts` still exists in code but `multi` runs arena since the duel (7/7 vs 7/7 at 4.7× the cost — DECISIONS "The Arena Duel"). The skills system was retired 2026-08-10 (successor: graph experience memory — experience informs execution, never expands authority; see DECISIONS).
- **Self-modification rail + SIP** — `src/coding/`: Pi (`pi-session.ts`, SDK adapter) implements changes in isolated git worktrees (never the running tree); merge gate (`merge-gate.ts`: three-dot diff, clamped Tier-3 PROTECTED_PATHS, scrubbed-env tsc+vitest) → owner-confirmed `self_merge` on the ledger (12h TTL) → deploy marker + exit(42) → supervisor restarts with health check + rollback; `!improve retry` rebases a kept worktree onto main and re-gates (for when MAIN was at fault, e.g. a time-rotten test). **SIP** (`improvement-proposals.ts` + `tools/self-improve.ts`, both PROTECTED): the heartbeat drafts `!improve` specs from code-detected error recurrence onto the ledger — two owner gates, max 1/cycle, denied = permanent (denial detail leads with the pending id). First closed production loop 2026-08-22 (DECISIONS).
- **Email steward** — `src/services/email-steward.ts`. READ-ONLY FOREVER (no email-send capability exists — the boundary is tool absence). Three lanes: fast (watched alias/VIP senders → immediate ping, 15-min poll — cron not scheduled at all when lists are empty), watch (owner-chosen bulk senders → always digest, bypasses the automated-mail filter), judged (one grammar-constrained needs-Peter judgment). Flagged mail rides the 2h heartbeat digest; every alert logs an autonomous_action row (the promotion track record). Personal sender lists live ONLY in gitignored config.
- **Research pipeline** — `src/pipeline/definitions/research.ts`. [flow_gather] → decompose → per-facet parallel search + fetch + synthesis → analytical markdown report → **evidence verification** → deterministic markdown→HTML→PDF render with charts (absolute img paths — LibreOffice resolves relative src against the temp HTML's dir). **Flow-first gathering:** when the request EXPLICITLY names an available flow tool, `flow_gather` calls it once; `parseFlowGather` turns its `##` sections into facets and links into per-facet source pools; decompose/parse_angles skip (`when` gates); `researchAngle(ctx, angle, presetUrls)` fetches/synthesizes identically so verification works unchanged. Flow failure degrades to normal search. Strict naming only — NO semantic flow-matching (that's the skill-hijack bug class one layer up).
- **Evidence verification** — `src/pipeline/verification.ts` + stages in research.ts. After the draft, extract atomic claims (fast model, grammar-constrained via `CLAIMS_JSON_SCHEMA`), check each against the **cached pages that actually mention it** (`pickRelevantSources` ranks all cached sources by token overlap — no independent search), and **attribute/qualify (never remove)** overstated or single-sourced claims. Corrections are **code-driven sentence splices**: `locateClaimSentence` fuzzy-locates the claim's sentence by token overlap (URLs AND decimal numbers are masked with same-length filler before segmentation — any non-terminator dot splices corrections mid-URL/mid-version-number; skips Sources/headings/charts; skips rather than splicing a wrong match), the model rewrites ONE sentence, code splices it back with sanity bounds — the report body is never handed to a model for wholesale rewriting. A **Tier-1 cross-check** then escalates a bounded set of high-impact, falsifiable claims (corporate events / financials / market-share, capped at `maxCrossChecks`) to ONE independent search each — CONTRADICTED → `correct` the wrong detail (this is what catches the Groq-date class of error); CONFIRMED → un-hedge; SILENT → leave. Publishes with a `## Verification` appendix + auditable `verification.json`. Config-gated via `verification` block (`enabled`, `crossCheck`, both default on).
- **Tool-loop engine** — `runToolLoop()` in `src/tool-loop/engine.ts`. ReAct-style loop with native tool calls + fallback parsers for four narrated dialects (DSML, `<invoke>`, `Action:`, Qwen-template `<tool_call>`/`<function=>`). Guardrails: hallucination/refusal repairs, drift + same-tool streak detection, action dedup, error-learning hints, observation spill (oversized results persist whole to workspace `.spill/` — the model greps instead of re-reading in slices), server-overflow hard-compact retry, crash-durable run journal (every step lands in `data/run-journal/`; surviving journals sweep into transcripts at boot as "interrupted" notes), and `!stop` mid-run cancellation at iteration boundaries.
- **Dispatch pipeline** — `src/dispatch.ts` routes classified messages to specialists/pipelines. Handles 6-layer security enforcement, tool stripping, context isolation.
- **Briefing system** — `src/orchestrator.ts`. Separate from heartbeat. Runs at 8am/1:15pm/5pm. Gathers calendar + tasks + memory, runs CoT reasoning on the foreground model (`defaultModel`), delivers contextual insights.
- **OllamaClient** — `src/ollama/client.ts`, REST API wrapper: 4-attempt retry (connection failures, 429, transient 5xx) with jittered backoff honoring Retry-After; request timeouts + abort propagation. Same policy in OpenAICompatClient.
- **DockerBackend** — `src/exec/docker-backend.ts`, sandboxed command execution.

**Data flow:** Channel message -> session resolution -> Router classification (pre-model overrides → model → keyword fallback) -> Security filtering (6 layers) -> Pipeline or Specialist dispatch -> tool-loop execution -> [FILE:] token extraction -> response to channel (thinking stripped) -> transcript persistence (thinking preserved).

**Chrome Extension:** Browser companion side panel (WXT + React + Manifest V3) in `chrome-extension/`. Content script extracts page context (URL, title, selected text, page content). Connects to existing Web channel API via SSE streaming (`/console/api/chat`). When `[PAGE:]` token detected in message, `src/console/handlers/chat.ts` forces `overrideCategory: 'chat'` — model reads injected content directly, no fetching. Two dispatch paths exist: orchestrator (Discord/Telegram/etc.) and console API (Web/Extension) — routing overrides must be applied in the correct path.

**Thinking tag handling:** Thinking is preserved in the session transcript (model sees its own reasoning on later turns) and stripped only at boundaries: channel delivery, stream previews, graph memory turns, session state, continuation previews, handoff summarization — all via the shared `stripThinkingTags()` (`src/utils/text.ts`), which also scrubs residual narrated tool-call markup as the delivery backstop. Separated-reasoning backends (vLLM `reasoning` fields) are mapped to inline `<think>` by the client so one format feeds the whole pipeline; Gemma-4's `<|channel>thought` format is handled too. **Per-model caps** (`src/ollama/model-caps.ts`) declare think capability (`toggle`/`levels`/`full`/`none`) and quirks — on `noThinkLeaksDeliberation` models (glm-5.3) thinking is always explicitly enabled, because suppression leaks untagged deliberation prose into content that nothing can strip. The `num_ctx` option passes through from `config.session.contextSize` (sized to the serving backend's context).

### Memory System

Memory uses a **dual-backend** architecture: **FalkorDB graph database** (primary) with flat JSONL FactStore (fallback).

**Graph memory (`src/memory/graph-store.ts`):**
- FalkorDB (GraphBLAS-based graph database, Docker beside the Invarail process on its Mac mini, Redis wire protocol)
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

**Behavioral user modeling:** UserModel node updated every heartbeat by the heartbeat model analyzing recent interactions. Injected into specialist context as "User preferences." **Closed schema** (`USER_MODEL_FIELDS` in graph-store.ts: communicationStyle, decisionPattern, topicInterests, frustrationTriggers): the writer drops any other key the model invents and the renderer reads only these — the node had drifted to 41 keys / 9K chars injected on every turn (2026-09-26).

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

**Provenance (2026-09-20):** `FactProvenance = stated | observed | inferred` on `FactEntry`/`FactInput` and the graph `Fact` node (filterable in `search()`). Only `!save` may write `stated`; consolidation merges are `inferred` (merging never launders provenance upward); everything else is `observed`; legacy nodes coalesce DOWN via `readProvenance`. Injection (`renderPrimingFacts` in dispatch.ts) marks the weak classes ONLY when the injected set is mixed — every pre-existing fact reads as `observed`, so unconditional marking would have hedged all of memory on day one. `USER.md` is read-only to the agent (`workspace_write` refuses it, points at `memory_save`) and is fed to extraction as an authoritative do-not-re-extract block. Entity clustering (`getClusters` → `filterDegenerateClusters`) excludes the owner's names (`ownerNames(config)` from principals) and per-corpus stopword entities; a heartbeat synthesis pass is designed in DECISIONS but NOT built (gate: `scripts/memory-cluster-check.ts`).

**Fact extraction paths:**
1. **`!reset` (user-approved)** — On session clear, `extractFacts` runs on ONLY the turns incremental capture has not read (`MemoryCapture.takeSessionTail`), bounded to `memory.extractionContextSize` (oldest turns dropped loudly — an 80-turn transcript at Ollama's 4096 default front-truncated the instructions away and phi4 continued the chat, 2026-09-20), with the "do NOT infer" rule and the USER.md block; the reply lists new candidates AND the session's captures. On `!save`, candidates are written `stated` and captures are PROMOTED `observed → stated` (graph by id via `setProvenance`, flat store by text via `setProvenanceByText` — the stores mint different ids). `!discard` leaves captures as they are.
2. **Incremental capture (autonomous, 2026-09-20)** — `src/services/memory-capture.ts`: every `memory.capture.everyTurns` (8) unprocessed turns, after the reply is delivered (`finally` in `handleMessage`), fire-and-forget on the utility tier with a timeout; code-triggered on purpose (a model judging topic shifts = a model call deciding whether to spend a model call). Marker advances on empty extraction, rewinds on `!reset`; one run per session at a time; state in `<workspace>/memory/capture-state.json` (records `{processed, captured:[{id,text}]}`). Closed the two-hour hole that had left the graph at 24 facts.
3. **Heartbeat (autonomous)** — Every 2 hours, `reviewTranscripts()` scans sessions, extracts facts with existing facts shown to prevent re-extraction. Writes to both flat FactStore and GraphMemory. Owns reconciliation (consolidation, contradictions, review).
4. **`memory_forget`** — Removes from both graph and flat store. Records removal to prevent re-extraction.

**Memory priming query (2026-09-21):** `primingQueryFrom(message)` strips `[PAGE_CONTENT]` and attached-PDF bodies (the PDF prefix is end-delimited for this) and caps at 800 chars before ALL four priming embeds (facts, multi-hop, lessons, experiences) — an attached 9K-char PDF embedded on the Mini blew the 8s cap.

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

**Available error codes:** `ROUTER_TIMEOUT`, `ROUTER_PARSE_FAILURE`, `REACT_MAX_ITERATIONS`, `REACT_PARSE_FAILURE`, `TOOL_EXECUTION_ERROR`, `TOOL_NOT_FOUND`, `OLLAMA_UNREACHABLE`, `OLLAMA_INFERENCE_ERROR`, `CONFIG_INVALID`, `CHANNEL_CONNECT_ERROR`, `CHANNEL_SEND_ERROR`, `SSRF_BLOCKED`, `SESSION_IO_ERROR`, `PIPELINE_STAGE_ERROR`, `PIPELINE_EXTRACT_FAILURE`, `MCP_SERVER_ERROR`, `SELF_MOD_ERROR`, `CONVERSION_ERROR`.

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
  orchestrator.ts           # Main class: lifecycle, heartbeat, briefing; slash commands live in commands/builtin.ts
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
      plan.ts               #     Plan pipeline — RETIRED for dispatch 2026-08-21 (code retained)
      research.ts           #     Research pipeline (decompose → per-facet research → verify → PDF)
      heartbeat.ts          #     Deterministic heartbeat (task board + memory, no LLM date reasoning)
      cron.ts, task.ts, memory.ts, web-search.ts, exec.ts, message.ts, website.ts, code-gen.ts

  tool-loop/                # ReAct execution engine
    engine.ts               #   runToolLoop() — core loop + drift detection + error learning
    parser.ts               #   parseReActResponse() — regex parser + JSON5 repair
    prompt-builder.ts       #   buildReActSystemPrompt(), buildScratchpad()
    types.ts                #   ReActStep, ReActResult, ReActConfig

  tools/                    # ~44 tool implementations
    types.ts                #   InvarailTool, ToolContext, ToolExecutor interfaces
    registry.ts             #   ToolRegistry class
    register-all.ts         #   registerAllTools() — wires all tools
    ssrf.ts                 #   SSRF protection for URL-fetching tools
    document.ts             #   LibreOffice headless document creation/conversion (markdown in → code-owned styling; models never write HTML/CSS)
    document-templates.ts   #   HTML templates (report/memo/invoice/letter/simple) for document tool
    gmail-read.ts           #   Gmail search + read (OAuth2, read-only)
    calendar-read.ts        #   Google Calendar list + search (OAuth2, read-only)
    memory-forget.ts        #   Remove facts by text match
    pi-build.ts             #   pi_build — delegate code-shaped work to Pi (projectDir = existing-dir mode; in multi's toolset)
    self-improve.ts         #   SIP ledger tool — model-invisible, grant-ineligible [PROTECTED]
    *.ts                    #   Individual tool factories (createXxxTool)

  coding/                   # Pi coding substrate + self-modification rail
    pi-session.ts           #   PiCodingAdapter — Pi SDK sessions (thinkingLevel config, metrics, memory_search customTool)
    self-mod.ts             #   SelfModWorktrees — worktree lifecycle, deploy markers, state
    self-mod-service.ts     #   propose/retry/executeMerge — gates, ledger merges, supervised deploy
    merge-gate.ts           #   Three-dot diff, Tier-3 PROTECTED_PATHS (clamped), tsc+vitest checks
    coding-memory.ts        #   Prior-experience briefs + memory_search callback for Pi sessions
    improvement-proposals.ts#   SIP: candidate selection, proposal history (denied=permanent), drafting [PROTECTED]

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
    classifier.ts           #   classifyMessage() — pre-model overrides → model → keyword fallback (wrapped: feeds the shadow)
    prompt.ts               #   Router prompt template
    shadow.ts               #   RouterShadow — System-One candidate observed beside the live decision, never decides
    systemone-client.ts     #   SystemOneClient — /v1/systemone (Jev wire protocol); NOT an OllamaClient

  ollama/                   # LLM inference
    client.ts               #   OllamaClient (REST API wrapper; retry/backoff for connection, 429, transient 5xx w/ Retry-After)
    openai-client.ts        #   OpenAICompatClient — vLLM/OpenAI-compat; chat() always streams; reasoning→<think> mapping; think coercion for leak-flagged models
    multi-backend.ts        #   MultiBackendClient (extends OllamaClient) — routes by model id; createInferenceClient()
    model-caps.ts           #   Declared per-model capabilities (format, vision, think mode, noThinkLeaksDeliberation)
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
    extraction-window.ts    #   fitLinesToTokenBudget — bound the extraction transcript, newest-first, loudly
    fact-store.ts           #   FactStore (JSONL index, dedup, TTL, consolidation, removeFact, setProvenanceByText) — fallback
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
    builtin.ts                #   runBuiltinCommand() — every `!…` command, carved out of the orchestrator 2026-09-27 (CommandHost interface)
    router.ts                 #   isCommand(), getCommandName() — command detection
    types.ts                  #   CommandContext interface

  services/                   # Extracted services (from orchestrator decomposition)
    memory-capture.ts         #   MemoryCapture — incremental fact capture every N turns, after delivery; session review gate for !save
    heartbeat-service.ts      #   runHeartbeat() — maintenance + SIP proposals + email digest
    briefing-service.ts       #   runBriefing() — calendar/task/memory CoT synthesis
    email-steward.ts          #   Read-only email triage: fast/watch/judged lanes, heartbeat digest
    run-journal.ts            #   Crash-durable run journal + boot sweep (interrupted-run transcript notes)
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

### Foreman handoff pattern (`src/pipeline/definitions/plan.ts` — retired pipeline; the typed sub-dispatch result survives)
Plan pipeline sub-dispatches used structured briefings (not raw result dumps):
- Sub-dispatch returns typed `SubDispatchResult` with status, filePaths, urls, category (extracted at dispatch layer)
- Write full step results to `.plan-artifacts/step-N.txt`
- Build handoff message with: task, plan context, completed steps (status + artifact paths), available artifacts
- Specialists use `read_file` to access prior step content on demand

### Pipeline isolation
All pipeline dispatches get fresh context — no parent session history. Prevents prior conversation topics from biasing pipeline execution.

### Context priority layers (`src/agents/workspace.ts`)
Tool-using specialists get `minimal` workspace context (SOUL.md + IDENTITY.md + LEARNINGS.md) to preserve token budget. Chat gets the `chat` set (+ TOOLS.md / USER.md / AGENTS.md); voice turns get `minimal` under their own cache key.

### Tool-loop guardrails (`src/tool-loop/engine.ts`)
- **One calling convention per model** — `toolStyle: 'native' | 'text'` (specialist config, default native). Native passes tools via the API field only; text describes them in the prompt with `Action:` format. Never both — mixing taught small models two contradictory formats. Fallback parsers (DSML/`<invoke>`/`Action:`/JSON5) stay active in both modes.
- **Hallucination detection** — catches models claiming actions without tool calls. Action-claims and data-claims are separate pattern sets: data claims ("the current price is...") are legitimate once a real tool has run. Repair prompt sent once.
- **Premature-refusal repair offers a no-tool exit** — the repair prompt says "call a tool if relevant, otherwise restate your answer directly." Never an unconditional order to use tools: the 2026-08 eval showed 13/16 models obey such an order into fabricated tool-call spirals rather than defy it.
- **Drift detection** — catches repeating tool calls, hedging language, growing responses. Re-anchor prompt after 3+ iterations.
- **Repairs don't burn budget** — each one-shot repair (hallucination, refusal, empty-completion retry, drift re-anchor) extends the loop by one iteration instead of consuming maxIterations.
- **Answer hygiene** — ReAct scaffolding (`Thought:`/`Final Answer:`) is stripped from the answer path; empty completions get one retry. Thinking blocks are left intact here (dispatch strips at delivery boundaries).
- **Error learning** — records failures, hints before execution, enriches observations with tool-specific recovery guidance.
- **Observation spill** — an observation over its per-tool budget persists WHOLE to workspace `.spill/` (24h transient); the truncation notice teaches grep/read instead of slice-reconstruction (the 30-step re-read spiral class, killed 2026-08-22).
- **Server-overflow retry** — pre-call trimming works from a token estimate; when the server reports actual context overflow, hard-compact all but the last two observations and retry ONCE.
- **Same-tool streak guard** — 5 consecutive calls to one tool with varying params = grinding; one reconsider-your-tools re-anchor.
- **Crash-durable journal + `!stop`** — steps land in `data/run-journal/` as they happen (accounted exits delete the file; boot sweeps survivors into transcripts as "interrupted" notes); `!stop` (command layer — the unknown-command catchall would eat it later) cancels the session's run at the next iteration boundary with an honest partial answer.
- **Observation summarization** — optional LLM-based summarization for old tool observations (>1000 chars) when context budget is tight. Preserves key data vs hard truncation. Config: `session.summarizeToolObservations`.
- **Param validation** — runtime type coercion (string→number, string→boolean) + enum + required field checks before execution.

### Heartbeat vs Briefing
- **Heartbeat** (every 2h): maintenance only — transcript review, fact extraction, learning promotion, media cleanup, memory consolidation, SIP proposals, steward digest. Runs as its own deterministic pipeline (`heartbeat.ts`) and reports to the configured delivery channel.
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

### System operations consulting learned artifacts
The skills system is retired (2026-08-10), but the rule it taught stands: heartbeat and cron must never match, replay, or save user-facing learned artifacts. Experiences and lessons are advisory prompt text only — never routing, permissions, or confirm decisions.

---

## Testing

- **Framework:** Vitest (`npm test` / `vitest run`)
- **Type checking:** `npx tsc --noEmit`
- **CI:** GitHub Actions runs type check + tests + build on every push/PR to main
- **Current:** 1053 tests across 114 files
- **Live checks (real models, no config changes):** `scripts/router-live-check.ts`, `scripts/tool-loop-live-check.ts`, `scripts/arena-duel.ts` (arm-vs-arm eval with computed oracles), `scripts/harness-duel.ts` (cross-harness: our arena vs external harnesses on identical model+tasks — the dsh duel). NOTE: node spawned from SSH sessions is silently denied LAN access by macOS (EHOSTUNREACH) — run live checks inside the `lab` tmux session (`tmux send-keys -t lab '...' Enter`), see DECISIONS.md
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
