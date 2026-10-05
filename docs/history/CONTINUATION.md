> **Status, revised 2026-09-29.** §0 (current state), §1 (rails), §3 (verification commands), the status lines in §4a/§4 and §5 (anti-goals) are kept current. §2 is the **frozen 2026-07-07 session record** — what that session changed, kept as history; file and type names in it are as they were then (e.g. `LocalClawTool`, now `InvarailTool`). Architecture has moved substantially since (see DECISIONS.md and §0).

# CONTINUATION.md — Handoff for the next build session

This document briefs the next AI collaborator (or future session) continuing the
small-model robustness + bounded-autonomy work on Invarail (called LocalClaw
until the rename; old names survive in history, data paths and the pre-rename
graph `localclaw_memory`). Read `CLAUDE.md` first — it is authoritative for
architecture and code standards (the code wins where the two disagree). This
file adds the session-specific context, the rails you must stay on, and the
remaining roadmap.

---

## 0. Current state (2026-09-29)

What a new collaborator should assume today — each line is in CLAUDE.md and
DECISIONS.md with receipts:

- **Arena everywhere except where stages are an oracle.** `cron`, `task`,
  `memory`, `message`, `website`, `web_search`, `exec`, `code_gen`, `multi` run
  `dispatchMode: "arena"` (open ReAct loop with session history, same six
  security layers and confirm ledger — DECISIONS 2026-08-21). Deterministic
  pipelines survive only for **research** (claim verification) and the system
  **heartbeat**. The plan pipeline is retired for dispatch (code retained); the
  skills system is retired (2026-08-10), succeeded by experience memory and
  lessons, which are advisory prompt text and never authority.
- **Specialist reroute.** An arena answer that claims or ends announcing an
  action whose tool the specialist lacks gets ONE re-dispatch through the full
  security path (never for cron, forced categories, or twice; the transcript
  keeps the user's words) — `src/router/reroute.ts`. Category descriptions say
  what each specialist cannot do. A handoff *tool* was built, measured harmful
  on qwen3.5 and removed.
- **Models are config lines.** `defaultModel` (qwen3.8:27B on an A5000 in the
  reference setup) fills every slot that doesn't override it; the router and
  extraction run phi4:latest on a utility box; embeddings on their own box;
  per-model quirks live in `src/ollama/model-caps.ts`. Prompt order is a
  KV-prefix-cache contract (`[static system][append-only history][volatile
  state+memory][user]`), guarded by `test/tool-loop/prefix-cache.test.ts`.
  `promptProfile: "small"` trims workspace context for ≤14B foregrounds.
- **Memory tiers.** `memory.backend` = `markdown` (legacy: graph if FalkorDB
  answers, else flat) | `graph` | `flat` | `vault` (+ `vault.okf` for Open
  Knowledge Format concept notes, `index.md`/`log.md`, `docs_read`);
  `memory.embeddingModel: "none"` turns every embedding call off, lessons and
  experiences included (2026-09-28). `src/memory/policy.ts` is the only reader
  of these fields. Facts carry provenance (`stated | observed | inferred`);
  incremental capture runs every 8 turns after delivery. The heartbeat
  synthesis pass is designed, NOT built — the build decision is the owner's.
  See MEMORY-SYSTEM.md.
- **Security additions since July.** Target-bound standing grants
  (`always <id>`), the web/console identity choke point
  (`src/security/web-identity.ts`), the tool-policy check at confirmation time
  (`src/security/tool-policy.ts`), sandboxed and principal-owned code sessions,
  a read-only-forever email steward (no email-send capability exists).
- **Self-modification rail + SIP.** Pi implements changes in isolated
  worktrees; merge gate → owner-confirmed `self_merge` → supervised deploy with
  rollback; the heartbeat drafts `!improve` proposals from code-detected error
  recurrence. The owner is not yet routing fixes through it by default — offer,
  don't push.
- **Evaluation.** The e2e harness (`scripts/e2e-eval.ts`, split into
  `scripts/e2e/` modules: install, corpus, tasks, report, stats, redact) runs a
  wizard-generated config for the model under test through `dispatchMessage`
  with code oracles; the report gives a full-pass rate with a 95% Wilson
  interval. CI runs type check (app + scripts), tests, the harness
  `--selftest`, build and console build on Linux, plus a Windows job (type
  check, tests with a failure list, selftest).
- **Size.** 1205 tests across 140 files (448 / 33 at the July handoff below).

## 1. THE RAILS — invariants you may not break

These are load-bearing values, not preferences. If a change you're considering
violates one, redesign the change — do not relax the rail.

1. **Small models are the floor, not the ceiling.** Everything must keep working
   with 7-35B models (phi4 router, qwen3.5/3.6, gemma4; the e2e harness measures
   qwen3.5:9b, gemma4:12b and qwen2.5:7b). Bigger models (the 27B foreground,
   vLLM on the Spark for coding) raise output quality; they must NEVER become
   structurally required. If a design only works because the model is smart,
   redesign so code carries the structure.
2. **Code decides, model executes — constrain the arena, not every move.**
   (Revised 2026-08-21; the July wording was "deterministic pipelines own
   workflows.") Conversational work runs in the arena loop: code fixes the
   scope, the tool set, the security layers and the confirm gates, and the model
   chooses the moves inside them. Deterministic stages survive only where they
   are an oracle (research verification, heartbeat), and there the model still
   fills small, bounded slots (classify into an enum, extract a JSON object,
   rewrite ONE sentence). Never push authorization, verification or bookkeeping
   into the model when code can carry it — the loop is a commodity; the walls
   are the product.
3. **Autonomy bounds are structural, never model judgment.** The autonomy ladder
   (silent → act_then_notify → propose_confirm) is enforced by code gates:
   `resolveConfirmSet()` in dispatch.ts, `filterCronTools()`, the pending-action
   ledger, tool `autonomy` metadata. Never add a path where the model decides
   whether an action is safe to take. New action types START at propose_confirm
   and are promoted only via config (`autoApproveTools`) backed by the
   `autonomous_action` metrics track record.
4. **No model literals in logic.** Model assignment is config-driven
   (`defaultModel` + per-slot overrides); per-model quirks are declared in
   `src/ollama/model-caps.ts`, never branched on inline. (Known pre-existing
   exceptions: gemma4 temp exception in engine.ts, a browser-mode check in
   dispatch.ts — do not add more.)
5. **Repo conventions:** ESM only (`.js` extensions on relative imports), error
   factory from `src/errors.ts` (no ad-hoc `throw new Error`), types derived
   from Zod via `z.infer<>` (never hand-written config types), no silent
   `catch {}` for meaningful failures, no speculative features.
6. **Token flows:** `[FILE:path]` tokens are stripped before the model sees any
   observation and re-appended after the final answer. Thinking tags are
   PRESERVED in session transcripts and stripped only at display boundaries
   (`stripThinking` in dispatch.ts). Do not "fix" either of these flows.
7. **Every degradation path must land somewhere useful.** Parse failure →
   repair → best-effort params → deterministic fallback → honest error text.
   Never let a failure abort silently or return an empty answer.
8. **Memory tier and prompt-order contracts.** Memory tier fields are read only
   through `src/memory/policy.ts`; a no-embedder tier must make every dense
   lookup inert, not slow. Per-turn content never goes into the cached prompt
   head — it belongs in the volatile block before the user turn.

## 2. What the previous session changed (2026-07-05/06) — frozen record

All changes are in the working tree / recent commits. `npx tsc --noEmit` clean,
448 tests green at handoff. Grouped by intent:

### Small-model robustness
- **tool-loop/parser.ts** — string-aware brace matching; sanitizer no longer
  corrupts apostrophes inside double-quoted JSON values.
- **tool-loop/engine.ts** — `toolStyle` ('native' default | 'text') selects ONE
  tool-calling convention per model (previously both were taught at once,
  doubling prompt size); ReAct scaffolding (`Thought:`/`Final Answer:`) stripped
  from the answer path; one-shot retry on empty completion; hallucination
  detector split into action-claims vs data-claims (data claims are legitimate
  after a real tool call); repair prompts no longer consume maxIterations
  (`extraIterations`, each one-shot); fixed dedup-branch double-pushing the
  assistant message.
- **tool-loop/prompt-builder.ts** — native style omits the tool text block and
  Action-format rules entirely (native `tools` field carries schemas); text
  style keeps the old format block. `buildScratchpad` (dead) removed.
- **pipeline/extractor.ts** — JSON5 parse layer; `validateExtractedParams`
  (required/enum/coercion) with validation-error-driven repair; best-effort
  params preferred over pipeline abort; grammar-constrained decoding via
  `format` (JSON schema built from the stage schema) with a module-level
  fallback flag if the backend rejects `format`.
- **pipeline/executor.ts** — ExtractStage gained optional `fallback(ctx)`
  (degrade-not-abort); `llm_branch` uses enum-constrained `format`.
- **router/classifier.ts** — blanket URL→website override replaced with
  bare-URL-only logic (short remainder, no other intent verbs); classification
  is enum-grammar-constrained with plain fallback.
- **ollama/types.ts + openai-client.ts** — `format` field on chat/generate;
  translated to `response_format`/`guided_json` for vLLM.
- **context/budget.ts + dispatch.ts** — `computeBudget` accepts `extraSections`
  (tool block, statePreamble, userPriming); dispatch re-budgets with the REAL
  prompt after classification and trims history (`trimHistoryToFit`).
  `estimateTokens` uses ~3 chars/token for punctuation-dense segments.
- **memory/graph-store.ts + dispatch.ts** — similarity floor (0.55) on fact
  injection, contextual facts capped at 3, multi-hop only fires when ≥1 result
  passed the floor (was: fired exactly when the query was least memory-relevant).
- **pipeline/verification.ts + definitions/research.ts** — correction pass is
  now code-driven sentence splice: `locateClaimSentence` (token-overlap fuzzy
  locate, skips Sources/headings/charts, ≥0.5 threshold) + model rewrites ONE
  sentence + code splices. The whole-report rewrite, its 0.7-length guard, and
  `correctionPrompt` are gone. Claim extraction is schema-constrained
  (`CLAIMS_JSON_SCHEMA`).

### Autonomy / security
- **security/pending-actions.ts (NEW)** — file-backed pending-action ledger.
  Preview records `{id, tool, params, sender, channel, agentId, sessionKey,
  expiresAt}`; "confirm" executes the STORED params (never model-regenerated),
  sender-bound, single-use, 10-min expiry. Wired into: dispatch preview sites
  (ReAct + pipeline), orchestrator confirm handler, console `chat.ts` confirm
  handler (was a dead-end on Web). `confirmed: true` re-dispatch arming is
  REMOVED from the orchestrator.
- **dispatch.ts** — pipelines now have the same confirm gate as ReAct (was a
  full bypass for e.g. the message pipeline); `filterCronTools`: cron jobs get
  `exec`/`send_message` only when the job's category is exec/message
  (owner-authored schedule = the code gate); `resolveConfirmSet` merges channel
  `confirmTools` ∪ metadata `propose_confirm` tools, minus `autoApproveTools`
  promotions, with cron pre-authorization for the category tool.
- **tools/types.ts** — `autonomy?: {tier, reversible, blastRadius}` on
  `LocalClawTool`. Annotated so far: send_message (propose_confirm/external),
  exec, memory_forget, write_file, cron_add (act_then_notify).
- **config/schema.ts** — `autoApproveTools` on ChannelSecurity (the promotion
  mechanism); `toolStyle` on SpecialistConfig.
- **metrics.ts** — `logAutonomousAction({action, tier, source, reversible,
  outcome, detail})` — called from heartbeat auto-complete/cancel/dedup, stale
  fact proposals, `!heartbeat` review outcomes, cron run success/failure, and
  ledger confirmations. This is the promotion track record.
- **services/heartbeat-service.ts** — LLM-flagged stale facts are NO LONGER
  deleted; they merge into the pending `!heartbeat yes/no` review file
  (`proposeStaleFactsForReview`) and are itemized in the report.
- **tools/cron-add.ts / cron-edit.ts** — cron expressions validated with croner
  BEFORE persisting (invalid schedules used to be stored and silently never run).
- **pipeline/definitions/web-search.ts** — extraction fallback: raw message as
  query.

### Live verification status (updated 2026-07-06 late session)
1. `toolStyle` — **VERIFIED LIVE** on qwen3.6:35b via `scripts/tool-loop-live-check.ts`:
   both native and text modes complete cleanly (tools called, params well-formed,
   scaffolding strip confirmed working on real output). Native saves ~950 prompt
   tokens vs text with ONE tool. Watch item: native-mode qwen3.6 sometimes writes
   deliberation into the final answer instead of the requested format.
2. `send_message` confirm-gated by metadata default — **not yet exercised live**
   (needs a running channel session). Promotion path if too much friction:
   `security.autoApproveTools: ["send_message"]` per channel.
3. Memory injection floor (0.55) — **not yet exercised live**; FalkorDB +
   embeddings (legacy /api/embeddings) confirmed reachable. If recall feels
   worse, tune the floor in `buildUserPriming` (dispatch.ts) first.
4. Router — **VERIFIED LIVE**: 15/16 on real phi4:14b via
   `scripts/router-live-check.ts` (URL handling correct; the one miss is
   "turn this analysis into a PDF report" → multi instead of document —
   judgment call, acceptable). Router timeout is now ENFORCED in code;
   config `router.timeout` raised 2000→8000 (phi4 measures 0.2-8s through
   the gateway while keep_alive is being dropped).
5. `format` structured outputs — **BLOCKED ON GATEWAY** (see
   GATEWAY-REQUIREMENTS.md): the gateway 422s schema objects and swallows
   "json". LocalClaw's fallbacks verified working. Re-run acceptance tests
   1a/1b after the gateway team lands their passthrough refactor.

### Environment gotcha (cost half a night — do not rediscover)
Node processes spawned from SSH sessions (incl. VS Code Remote) get SILENTLY
denied LAN access by macOS Local Network privacy → `EHOSTUNREACH` from node
while curl/python work. Fix: run node work inside the `lab` tmux session
(server started from local Terminal.app, inherits its permission):
`tmux send-keys -t lab '<cmd>' Enter` + `tmux capture-pane`. Survives until
reboot; recreate from local Terminal.app after reboots.

## 3. Verification commands

```bash
npm run typecheck                         # tsc --noEmit + scripts tsconfig; must be clean
npm test                                  # 1205 tests / 140 files (2026-09-29); 448 / 33 at the July handoff
npx tsx scripts/e2e-eval.ts --selftest    # e2e harness against the real registry + pipelines, no model
```

July-session test files: `test/pipeline/extractor.test.ts`,
`test/security/pending-actions.test.ts`, `test/tools/registry-autonomy.test.ts`,
plus additions in `test/tool-loop/parser.test.ts`,
`test/integration/react-loop.test.ts`, `test/pipeline/verification.test.ts`.

## 4a. THE architectural item: Session Control Plane (owner-named, design below)

Peter's closing insight of the July 6 session: every wart the confusion audit
found is one missing layer, not many bugs. Build a session control plane that
owns four things (evolution over SessionStore/ledger/resolveRoute — the organs
exist, this is the membrane):

1. **Identity**: a Principal ("peter") with channel aliases (Discord id,
   Telegram id, WhatsApp jid, console-user). All memory, ledger binding, and
   trust checks key on the principal. Fixes the measured 55/64 memory
   fragmentation; makes sender-binding mean PERSON not channel-account.
   Config: a `principals` block mapping alias → principal.
2. **Conversation**: one logical session per principal that channels attach
   to (per-channel view, shared transcript). A Telegram reply continues the
   Discord conversation.
3. **Pending interactions**: ONE inbox for everything awaiting the owner —
   tool previews, prep proposals, memory reviews, unanswered agent questions.
   Single grammar (`ok N` / `no N` per the deferred blueprint in item 8
   below). The pending-action ledger and heartbeat review file both fold in.
4. **Proactive injection**: agent-initiated turns (briefing, heartbeat,
   alerts) enter the conversation as first-class turns BY DESIGN.

Seams to dissolve when building it (tonight's manual bridges, all marked in
code): briefing appendTurn patch (briefing-service.ts), ledger sender/channel
binding heuristics (pending-actions.ts), heartbeat review file
(heartbeatPendingPath), the duplicated confirm handling in orchestrator.ts +
console/handlers/chat.ts (the control plane should expose ONE confirm entry
point both paths call).

Constraints: keep the two dispatch paths' ROUTING overrides separate (see
anti-goals) — the control plane unifies session/identity/pending state, not
routing. All safety invariants hold: stored-params execution, code gates,
principal-bound confirmation.

**Slice status (July 7):** Pillar 1 (identity) BUILT — `src/identity/
principal.ts`, `config.principals`, wired at every identity-bearing point,
live stores migrated (`scripts/archive/migrate-to-principal.ts`), cross-channel
memory verified unified. Pillar 3 partially built (ledger is principal-bound;
full one-inbox grammar still item 8 below). Pillar 4 partially built
(briefings append to the owner's session). One confirm entry point built
(`src/security/confirm-handler.ts`).

**Slice 3 design — shared conversation per principal (still NOT built as of
2026-09-29 — no `session.sharedDmSessions` in the schema; dragons identified):**
- Scope: DM/1:1 sessions only. Group/guild sessions must NEVER merge.
  Per-adapter `isDm` detection is required (Telegram: private chat id ==
  sender id; Discord: no guildId; WhatsApp: jid without @g.us — the WhatsApp
  adapter has since been removed; console: its
  own surface — decide whether it joins the DM session or stays separate).
- Key change: `buildSessionKey` uses `dm:<principal>` for DM contexts,
  unchanged otherwise. Gate behind `session.sharedDmSessions` (default off).
- MUST-FIX FIRST: SessionStore.appendTurn has no locking — two channels
  writing one session concurrently (Telegram reply while console streams)
  clobbers turns. Add an in-process write queue per sessionKey (all writers
  are in one Node process).
- Migration: interleave existing per-channel DM transcripts by timestamp
  into the shared key; keep originals as .pre-merge backups.
- Watch: channel-specific artifacts in one transcript (voice formatting,
  [PAGE:] context) may confuse the model — consider tagging turns with
  their source channel in metadata (NOT in content).
- Test live with two real channels before trusting; compaction cache keys
  follow the session key and need no change.

## 4. Remaining roadmap (updated after the July 6 second session)

DONE since first writing: autonomy annotations (all 35 factories), `!autonomy`
promotion report command, few-shot text-mode example, ledger transcript writes
+ channel binding + id-targeted confirms, memory floor tuned on real data
(0.52), **calendar prep proposals** (the first intake/clarification rung —
see DECISIONS.md July 6). Console frontend error-UX pass done (error banner,
typed SSE events, skeletons, modal guard).

1. **Live briefing run** — DONE July 7 via `scripts/briefing-live-check.ts`
   (production path, channel send stubbed to stdout): real calendar, real
   conflict caught deterministically, confirmable reminder + intake questions
   proposed into the live ledger. Remaining sliver: observe a confirmed
   one-shot reminder actually FIRE once through the running app's cron.
2. **Cross-channel identity mapping** — DONE (principals, §4a Pillar 1). Original note: now evidence-backed: 55/64 facts live
   under the Telegram sender id; Discord sees 8% of the owner's memory
   (scripts/memory-floor-check.ts + graph-diag.ts). Biggest memory lever.
3. **Prep proposals next rungs** (partly built: reply-context threading exists
   via `src/services/prep-context.ts`; the rest not verified as of 2026-09-29): gmail slice in briefing context;
   research/agenda-doc offers; reply-context threading (v1 relies on the
   briefing text being adjacent in the conversation).
4. **Per-model context profiles** — SUPERSEDED by `promptProfile: "small"`
   (config-declared, wizard-written, doctor-checked — never inferred from the
   model at runtime). Original note: for `contextSize ≤ 16k`, auto-switch
   workspace to `progressive` mode and cap stable facts (workspace.ts already
   supports progressive).
5. **Plan pipeline** — MOOT: retired for dispatch 2026-08-21 (`multi` runs
   arena after the duel). Original note: split `generate_plan` (enum-constrained specialist pick,
   then per-step messages); skip `reflect` for ≤2-step plans; replace LLM
   `check_progress` done-detection with plan-index arithmetic.
6. **Deterministic citation numbering** in research `parse_final` — DONE: code
   regenerates the `## Sources` list from the URL list the model was given, so
   body `[n]` citations always match and an invented URL cannot publish.
7. **Gmail compose tool** — REJECTED by later design: the email steward is
   read-only forever and no email-send capability exists (the boundary is tool
   absence). Original note: backlog promotion candidate: prep proposals will
   eventually want draft_reply → actual send; it must be requiresConfirm.
8. **One-inbox unification (designed, still deferred as of 2026-09-29 —
   `!heartbeat yes/no` and hex ids are live; per-channel tool lists remain
   separate keys, though `src/security/tool-policy.ts` now answers "may this
   principal run this tool here?" as one question)** — from the July 6
   confusion audit's synthesis. End state: EVERY proposal (tool preview, prep
   reminder/task, stale-fact review) lands in the single pending-action ledger
   as a numbered item; reply grammar is `ok N` / `no N` (with `no` a real
   reject that consumes + logs `rejected`); numbers are per-batch-stable, never
   renumbered live; `!heartbeat yes/no` and hex ids retire. Second piece:
   collapse the five per-channel tool lists into one `{who: everyone|trusted|
   owner, gate: allow|confirm|deny}` entry per tool, old keys as a deprecated
   Zod transform. Both preserve every safety invariant (stored-params
   execution, code gates). The three-sentence mental model to build toward:
   "The agent either acts silently or proposes; every proposal is a numbered
   item in one inbox, and ok N runs exactly what's shown. Each tool carries
   one bit — asks-first or not — overridable per channel with one line. Nothing
   external executes without a stored-params confirmation or an explicit
   config grant."

## 5. Anti-goals — do NOT do these

- Do not add a reranker/cross-encoder to memory until the relevance floor
  (0.52 since tuning; shipped at 0.55) has been observed insufficient in real
  use (owner's explicit "monitor before adding complexity" stance).
- Do not bring back deterministic pipelines for conversational categories, or
  let learned artifacts (experiences, lessons) touch routing, permissions or
  confirm decisions — the skills system is the cautionary tale.
- Do not build the heartbeat synthesis pass, or any other open design item
  flagged as the owner's call, without the owner's go-ahead.
- Do not add an email-send (or any "act as the owner") capability — the line
  is: an agent you talk to is an assistant; an agent that talks as you is
  impersonation.
- Do not "clean up" the fallback parser dialects (DSML, `<invoke>`, Action:)
  — they are the safety net that keeps arbitrary local models usable.
- Do not make the heartbeat/briefing smarter by giving the model more
  authority; deterministic sections are AUTHORITATIVE by design.
- Do not consolidate the two dispatch paths (orchestrator vs console API)
  as a refactor — routing overrides live in BOTH places on purpose; changes
  must be applied to each (see CLAUDE.md Chrome Extension note).
- Do not add dependencies. Node 22 built-ins + the existing stack.
- Do not batch unrelated improvements into one change; keep each independently
  revertable (the owner reverts to known-good on regressions rather than
  tuning forward).
