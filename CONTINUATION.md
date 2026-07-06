# CONTINUATION.md — Handoff for the next build session

This document briefs the next AI collaborator (or future session) continuing the
small-model robustness + bounded-autonomy work on LocalClaw. Read `CLAUDE.md`
first — it is authoritative for architecture and code standards. This file adds
the session-specific context, the rails you must stay on, and the remaining
roadmap.

---

## 1. THE RAILS — invariants you may not break

These are load-bearing values, not preferences. If a change you're considering
violates one, redesign the change — do not relax the rail.

1. **Small models are the floor, not the ceiling.** Everything must keep working
   with 7-35B models (phi4:14b router, qwen3.6, gemma). Big models (DeepSeek via
   vLLM) raise output quality; they must NEVER become structurally required. If
   a design only works because the model is smart, redesign so code carries the
   structure.
2. **Code decides, model executes.** Deterministic pipelines own workflows; the
   model fills small, bounded slots (classify into an enum, extract a JSON
   object, rewrite ONE sentence). Never push orchestration or judgment into the
   model when code can carry it.
3. **Autonomy bounds are structural, never model judgment.** The autonomy ladder
   (silent → act_then_notify → propose_confirm) is enforced by code gates:
   `resolveConfirmSet()` in dispatch.ts, `filterCronTools()`, the pending-action
   ledger, tool `autonomy` metadata. Never add a path where the model decides
   whether an action is safe to take. New action types START at propose_confirm
   and are promoted only via config (`autoApproveTools`) backed by the
   `autonomous_action` metrics track record.
4. **No model literals in logic.** Model assignment is config-driven. (Known
   pre-existing exceptions: gemma4 temp exception in engine.ts, a browser-mode
   check in dispatch.ts — do not add more.)
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

## 2. What the previous session changed (2026-07-05/06)

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
npx tsc --noEmit        # must be clean
npx vitest run          # 448 tests at handoff, 33 files
```

New test files: `test/pipeline/extractor.test.ts`,
`test/security/pending-actions.test.ts`, `test/tools/registry-autonomy.test.ts`,
plus additions in `test/tool-loop/parser.test.ts`,
`test/integration/react-loop.test.ts`, `test/pipeline/verification.test.ts`.

## 4. Remaining roadmap (in rough priority order)

1. **Live verification pass** of the five behavior changes above — before any
   new feature work.
2. **Complete autonomy annotations** on the remaining ~29 tools (pattern in
   send-message.ts). Keep annotations honest: read tools are `silent`,
   workspace writes `act_then_notify`, anything visible externally
   `propose_confirm`.
3. **Intake/clarification flow** (owner's near-term autonomy goal): when a
   request is underspecified, ask 1-3 targeted questions OR do-then-brief with
   assumptions flagged. Frame as a dispatch-level pre-step, code-gated.
4. **Promotion tooling**: a `!autonomy` command (or console view) that reads
   `data/metrics.jsonl` `autonomous_action` events and shows per-action-type
   success rates — the evidence base for adding `autoApproveTools` entries.
5. **Per-model context profiles**: for `contextSize ≤ 16k`, auto-switch
   workspace to `progressive` mode and cap stable facts at 3 (workspace.ts
   already supports progressive).
6. **Few-shot for text-mode models**: one worked example with a REAL tool's
   real params in the text-format block (small models copy literally).
7. **Plan pipeline**: split `generate_plan` (enum-constrained specialist pick,
   then per-step messages); skip `reflect` for ≤2-step plans; replace LLM
   `check_progress` done-detection with plan-index arithmetic.
8. **Deterministic citation numbering** in research `parse_final` (code
   assigns/renumbers `[n]`, model stops being trusted for it).
9. **Ledger-confirmed actions** aren't written to the session transcript —
   append a turn pair so the conversation history reflects what ran.
10. **Session-key binding for pending actions**: ledger lookups are
    sender-bound; consider also binding to channel to prevent cross-channel
    confirms if multiple channels share a sender id.

## 5. Anti-goals — do NOT do these

- Do not add a reranker/cross-encoder to memory until the 0.55 floor has been
  observed insufficient in real use (owner's explicit "monitor before adding
  complexity" stance).
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
