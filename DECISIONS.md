# Architectural Decisions & Lessons Learned

A log of significant decisions, failed experiments, and why things are the way they are. Prevents re-trying things that already failed and documents the reasoning behind current architecture.

---

## Enum Routes Need an Exit Ramp (August 14 2026)

**The failure:** "Can we trigger a cron to run early?" → routed to the cron pipeline, whose `llm_branch` route offers ONLY action buckets (add/list/remove/edit). An enum-constrained choice with no escape forced the model to pick the least-wrong action (edit); the dispatch context rewrite had already converted the question into a command ("Can we schedule a cron job to execute earlier…?" → imperative); extraction produced the empty-required-id "unknown" signal; and — because pipelines have no reaction step, unlike the ReAct loop — the raw tool error ("Error: id parameter is required") went straight to the user's DM. Four small design gaps stacking into one rude non-answer.

**The doctrine (same as the engine repair-prompt fix, one layer up):** every constrained model choice needs a no-action exit. Applied (75cd5b6): all three `llm_branch` pipelines (cron/memory/task) gain a `question` branch that answers from an honest hardcoded capability list — cron's states plainly that run-now does not exist and offers the real workarounds; the rewrite prompt now preserves interrogative mood; cron edit/remove `when`-guard their tools on id and ask "which job?" with the list when the extractor signals unknown. Rule for future pipelines: an enum route ships with a question exit, and any required-param extraction seam decides what the USER sees when the param comes back empty — a raw tool error is never that answer.

**Deferred with trigger:** an actual `cron_run` (trigger-now) tool, owner-gated — build when the honest "there is no run-now" answer annoys the owner twice.

---

## Recency Research: the Model Cannot Know What It Doesn't Know (August 14 2026)

### The failure (live, first boot after the eval week)
The weekly AI-news cron produced a report that led with Qwen's flagship release (correctly — by luck) while missing NVIDIA entirely (Lightning, the nemotrons, NeMo Switchyard — the week's second-biggest story, benchmarked in this very repo on release day) and Meta's muse-glimmer. Root mechanism: `decompose` asks a static-knowledge model to decide what current news to search for. The model facets from its frozen training prior — it literally generated Gemma/Llama queries because those are the archetypal open models it remembers — and phrases facets as long natural-language questions that SearXNG returns nothing for (5 of 8 searches came back empty; same failure class as the removed Brave `site:` buckets). **The report's most instructive sentence**: its own gap analysis explained Llama's absence as "may reflect a quiet week for Meta" — the frozen prior didn't just miss the news, it wrote a plausible wrong explanation for its own blind spot. Second-order gap also observed: a "weekly" report built partly on April-dated evergreen sources (freshness filtered the searches, not the sources' publication dates).

### The fix (08353be): discovery-first, strictly no hardcoded targets
1. **`discovery_sweep` stage** — recency-shaped topics (`isRecencyShaped`: shape patterns, no entities) get 2 generic keyword sweeps derived from the topic itself (`condenseToKeywords` + "news"/"announcements <clock month year>"); results go to the decompose prompt with the instruction: *your knowledge of "recent" is stale by definition — facet around the names in these results, not the ones you remember.* The model's job shifts from guessing what's new (impossible) to organizing what search found (its strength). Sweep failure degrades to the old path.
2. **Decompose emits short keyword facets** (3-8 words), not research questions — kills the unsearchable-query problem at birth.
3. **Dry-facet retry** — empty search → one keyword-condensed retry before the facet dies. Degrade-never-abort, same as extraction repair.
Doctrine note: no vendor, model name, or domain appears anywhere in the fix — entities are always runtime data. Hardcoding "search NVIDIA" would fix one week and rot forever (see search-buckets teardown; "why are we hardcoding for this?"). Better procedure, not better answers.

### Verification plan
This week's old-code report is the banked baseline; next week's run is the A/B. Deferred with trigger: source publication-date extraction feeding synthesis (the evergreen-sources gap) — build when a second report leans on stale sources.

### Status
Live on next boot (shipped alongside the eval-week stack + FalkorDB 4.2.3). 698 tests.

---

## The Model Eval That Kept Finding Our Bugs Instead (August 11-12 2026)

### What it was
A "which 20-30B model is best" question (muse-glimmer release day) became a publishable eval harness (`scripts/model-eval.ts`) and a two-day, two-codebase forensic. Final form: 23 base models × 3 reps × 14 tasks (tool-loop incl. 9-hop long-horizon chain, grammar-constrained extraction, chat discipline, execution-verified real-world coding in a Docker sandbox), deterministic code checks only, failure taxonomy (MODEL_FAILURE / TIMEOUT / SERVING_INCOMPATIBLE / PROVIDER_OUTAGE with retry→UNSCORED), think on/off A/B rows via runtime capability probing, per-task completion-token metering (`ctok` — hardware-independent cost), full provenance (digests, harness commit, dual serving topology). Raw outputs published for human read; prose quality deliberately unscored ([[feedback_regressions]]: trust the human side-by-side).

### Disproven theories — record them, they cost the most
1. **"The gateway silently doesn't enforce JSON schemas."** Wrong. Wire-level fetch interception + curl bisect of the exact request body proved `format` was attached AND enforcement works. Real cause: `chatMaybeStructured`'s 256-token default — thinking models burn the whole budget on reasoning (thinking counts against num_predict) and the constrained JSON never gets emitted. Same bug class as the vLLM reasoning-headroom fix in openai-client.ts; the Ollama path never got it. muse-glimmer extract: 33% → 100% with 2048 budget.
2. **"qwen3.6:27B leaks untagged thinking; 35B doesn't."** Wrong premise from a 9-sample eval batch. The gateway team's 200-sample audit grep: BOTH distillations leak untagged reasoning prose (27B ~10%, 35B ~5%) — weights-side gradient, not template (identical serving setup, verified).
3. **"ds4's /v1/chat/completions has no per-request thinking knob."** Wrong — I read one README section instead of testing. Direct curl: ds4 honors `think:false` AND `thinking:{type:disabled}` (1 completion token vs 18 default on trivial math). Never declare an endpoint's capabilities from docs when the endpoint is one curl away.
4. **Three "model failures" were infrastructure**: gateway 503s (`all_providers_unavailable`) zeroing T5 for three models, and deepseek-coder's HTTP 400s (serving path rejects tools entirely). An external report caught both — error strings were sitting untriaged in our own results.json. Hence the failure taxonomy.
5. **Single-run scores lie in both directions**: qwen3.6:35b measured 84% and 100% the same day. 3-rep pass rates + a flipped-checks stability column are the minimum honest unit. (And even 3-rep batteries have variance-of-variance: cascade-2's C1 went 0/3 → 3/3 between batteries.)

### What it changed in Invarail (all committed 31d4701, live on next boot)
- **`think` plumbed end-to-end** (OllamaChatParams → specialist config → engine → dispatch). OpenAI-compat path forwards only for backends declaring `supportsThink` (ds4 verified) — an unverified backend gets warn-once+omit, because a silently ignored request field is the exact failure shape that cost both teams a day. Policy: config-driven, static per specialist, set AFTER the A/B data; think:false measured ~14x cheaper at equal quality on qwen3.6 chat.
- **Premature-refusal repair prompt softened** (engine.ts): the old unconditional "you MUST use your tools" sent 13/16 models spiraling through fabricated web fetches on a unit conversion — models obey authority over sense. New wording keeps anti-refusal teeth but offers the no-tool exit. Old-prompt baseline preserved in run-2026-08-11T21-10-06 for before/after.
- **Extractor**: `tryParseJson` now uses `stripThinkingTags` (was inline `<think>`-only — every Gemma-4 extraction burned a repair); default budget 256→2048.
- **VllmBackendConfig** derived from Zod (hand-written duplicate had already drifted — the CLAUDE.md rule proven again).
- Flagged, unchanged: three more `num_predict: 256` caps (web-search branch, consolidation, graph NER) — fine for today's non-thinking models, same rot class as [[stale rationing caps]]; audit before any thinking model takes those roles.

### What it changed outside Invarail
Gateway (their commits): request-shape audit logging (format/options/think per row), `think` passthrough + `thinking` field on non-streaming responses, bare-tag model matching. Plus a dead-replica hypothesis for the glm 503 parity pattern, and an Ollama-upstream nit (budget-truncated thinking under `format` returns prose in `content` instead of erroring — the silent shape that misled everyone).

### Standing eval lessons
- **Eval the system, not the model.** Four "model failures" in a row were harness/infra bugs. Triage error strings before attributing anything to weights.
- **Accommodate transport, never content** (Peter's contract rule): dedent the markdown-nested code fence, strip the thinking tags, parse the Action: fallback — but a wrong output value or format is a failure regardless of how sound the internals were. "It failed the contract" ends the discussion.
- **tok/s is a serving-stack fact, not a model property** — NVIDIA's "30% faster than qwen3.6-35B" measured dead even on our quants/serving. Report ctok (tokens-to-finish-battery) for transferable cost; asterisk all throughput.
- **Training-dialect accommodation is the harness's job** and every accommodation choice is part of the score — list them in the methodology (we do).
- Serving topology matters for comparisons: 22 models via Ollama-behind-gateway, deepseek DIRECT to ds4/DwarfStar (github.com/antirez/ds4 — not vLLM, config comment corrected) running default thinking/high effort.

### Status
Publication run in flight (run-2026-08-12T07-34-43, clean commit 6b9b22f). Pre-fix boards: run-2026-08-11T21-10-06 (3-dim, 16 models, old repair prompt) + addenda. Model-caps updates pending run data. Repo/README scaffolding pending final board.

---

## Graph Experience Memory — Approaches Judged by the User's Actual Reactions (August 10 2026)

### The build
First build of the Invarail era, replacing what skills tried to be. `:Experience` nodes in FalkorDB (same graph as facts): task shape → approach → outcome → **user satisfaction**, silently injected like facts ("## Approach notes from similar past work — advisory"). Peter's requirement verbatim: "it should also remember if the user was happy with it or not, so it knows not to do it again and try something else."
- **Signals are code-detected** (doctrine: code detects, model explains — model self-assessment never creates an experience): Discord 👍/👎 reactions (new listener — explicit ground truth), confirm denials, mid-turn steering (now persisted — interrupting a run is never praise), post-task review notes (now persisted), re-ask/praise patterns in transcripts. Explicit signals are born at evidence 2 (inject immediately); inferred ones at 1 (must recur).
- **Contradiction is pure code** — an improvement on the fact system's LLM judge: structured outcome/satisfaction fields flipped within the KNN similarity band → SUPERSEDES. No model in the loop.
- Synthesis at heartbeat with the lesson guards verbatim (max 3/cycle, batch-distrust); `!experiences` lists/drops; `memory.experiences.enabled` gates everything; injection floor 0.60 PROVISIONAL (measure at ~10 real experiences, like the lesson/memory floors).

### The authority boundary is now a TESTED invariant
"Experience informs execution; experience never expands authority" is pinned structurally in `test/learnings/experience-system.test.ts`: experience modules import nothing from `security/`; the store may be consumed ONLY by the four advisory surfaces (dispatch priming, heartbeat synthesis, the synthesis writer, the !experiences command); no security module references the experience layer. Rebuilding skills under another name remains the named failure mode — if a future change wants experience to touch permissions, routing, confirmation, or tool exposure, this entry is the tripwire: the answer is no.
- Lessons COEXIST for now (Peter's ruling) — merge when experiences ≥ 20 and lessons stop gaining evidence.

## LocalClaw Explored the Design Space — Invarail Is What Survived (August 10 2026)

### The rename
LocalClaw → **Invarail** (invariant + rail: authority that cannot move, structure that exists so things move fast). Chosen after the week's synthesis (usage data: 28,345 metric events; three-plane architecture: authority plane immutable, experience plane adaptive, execution via FlowMCP; invariant of invariants: **experience may inform execution, never expand authority**). Name coined by Peter; verified unclaimed (npm, GitHub, web). All history in this file keeps "LocalClaw" as written — records don't get renamed.

### The trim: what survived contact with daily usage
28,345 metric events (Feb–Aug) drew the lines; every removal has a usage receipt. **Removed:** WhatsApp adapter (principle, not usage: an agent that answers messages AS the owner is impersonation — communication identity is not delegable); slack/imessage/msgraph adapters (zero sessions ever); the skills system (three hijacked runs in one week; its self-reinforcement made wrong matches stronger — successor is graph experience memory under the invariant *experience informs execution, never expands authority*; rebuilding skills under another name is the named failure mode); the reason tool + step-back/forced-reasoning engine paths (0 uses in 30d; the forced pass fired after artifacts were already written); analytics/document/config/personal categories (≈0 usage; `send_message` + `document` tools remain as documented EXECUTION PRIMITIVES, not router destinations). **Kept deliberately:** tasks (Peter: "dead because it was inconsistent, not because I didn't want to use it" — stabilize on the slim core later), code_gen/Pi, Telegram, gmail adapter, blender, the entire governance layer, memory, research. **Held:** message category — the Sept 15 token-reminder cron uses it; flagged, not silently migrated. Discoveries the prune surfaced: vision.ts had a phantom dep on sharp (transitive via baileys); the shared embedding helpers lessons depend on lived inside skills/semantic.ts (now `src/memory/semantic-helpers.ts`). Deletion is cheap now — git holds the exact code, DECISIONS holds the understanding, and regeneration costs an afternoon; what was expensive was learning which pieces are load-bearing.

### Migration shims are TEMPORARY DEBT — removal condition set NOW
Three compatibility shims exist so Peter's live deployment survives the rename. **All three are deleted at v0.2.0 or 60 days from this entry (2026-10-09), whichever comes first, once Peter's local migration is confirmed.** Compatibility shims otherwise have a habit of becoming permanent architecture — this entry is the tripwire.
1. **Config discovery** (`src/config/loader.ts`): tries `invarail.config.json5`, falls back to the legacy filename **ONLY on absence (ENOENT semantics)** — a malformed new config FAILS loudly rather than silently loading the old one.
2. **Env var**: `INVARAIL_UNSAFE_TLS` primary; the legacy name is honored with a deprecation warning (`src/index.ts`).
3. **Plugin path**: `~/.invarail/plugins` primary; the legacy dir still scanned with a warning, and a **precedence rule**: a plugin name present in both dirs loads ONCE from the Invarail dir — the legacy copy is skipped, never double-registered.
All three shim literals are written as split strings ('local'+'claw') so mechanical rename sweeps can't rewrite them; their behavior pins live in `test/config/rename-shims.test.ts`, which deletes with the shims.

## Five Live Runs, Five Layers: Wiring a Compiled Flow Into Production (August 1 2026)

### The integration was sound at every layer we'd tested — and broken at every layer we hadn't
Getting `flows_weekly_gather` from "registered at boot" to "actually runs when asked" took five live attempts, each exposing a bug only reachable after the previous fix:
1. **Reachability** — the tool sat on the multi specialist, whose list feeds the plan pipeline's executor, not any ReAct loop. Sub-dispatches run on OTHER specialists' toolsets. Moved to exec (the ReAct workhorse).
2. **Selection surface** — upstream description was compiler provenance ("compiled candidate from gather.v0.json"), telling a small model nothing. The model looked for "weekly_gather", saw `flows_weekly_gather`, declared it unavailable, improvised 7 minutes of web fetching. Fixed with a `toolDescriptions` config override (WHEN TO USE + the bare name). The bridge's description-override layer earned its keep on day two.
3. **Skill hijack + false credit** — a March skill matched at 0.847, derailed the plan, got the fallback's success credited AND our test request appended as a trigger → matched at 0.930 next run. Self-reinforcing capture. Fixed: fallback runs credit nothing; poisoned skill archived. A SECOND legit skill then hijacked the same way (0.786) — proving the class, not the instance, was the bug.
4. **Param padding vs fail-closed** — DeepSeek invented `{"input":""}` for a zero-param flow; FlowMCP correctly rejected it, twice; the model abandoned the tool, scavenged a stale April payload from `.learnings/errors.jsonl`, and presented it as this week's news with fabricated URLs. Fixed in the bridge: params filtered to the declared schema before calling. Accommodation is the translation layer's job; strictness is the server's.
5. **Downstream cwd** — FlowMCP resolves its downstream-server paths relative to process CWD; spawned from LocalClaw's directory, the searxng child died MODULE_NOT_FOUND. Lab tests had masked it (run from ~/FlowMCP). Fixed: `cwd` option on MCP stdio servers. Reported upstream (paths should anchor to the servers.json5 location).
Also: gathering tools need `maxResultChars` — the default 2000-char cap cut 12K of gathered material to one facet of four, and the model narrated the missing sections as "a rate-limit error."
**Meta:** every fix was small and correct, but by layer five Peter set the standing rule — ~3 failed live attempts on one feature means stop patching and go to plan mode for a full end-to-end trace. Live-fix loops find one bug per run; a paper trace of the whole path finds them all at once.

### Flow-first gathering in the research pipeline — strict naming, no semantic matching (built from the plan)
The plan→exec path structurally cannot produce the analytical Weekly report: no synthesis stages, no verification, model-improvised deliverable formats. The article factory is the research pipeline; its slowest stage is gathering. Built: when a request EXPLICITLY names an available flow tool, a `flow_gather` stage calls it once — its `##` sections become the facets, its links the source pool — then fetch/synthesis/verification/PDF run unchanged (`_sourceText` fills identically, so verification works on flow-gathered pages). Flow failure degrades to the normal decompose+search path.
**The gate is strict by decision (Peter's call, asked directly): explicit naming only.** The same night's three skill hijacks demonstrated what "close enough" semantic selection does — silently routing around user intent. Cron messages are authored once and can name the flow forever; ambiguous phrasing keeps the normal path; the ReAct layer already provides semantic selection bounded by honest descriptions. A floor-gated semantic PROPOSAL ("I have a compiled gather for this — use it?") is the next rung, earned later with evidence. The shared primitive `findExplicitToolMentions` (word-boundary, bare-name aliasing for MCP prefixes) also guards plan `skill_check`: a matched skill whose steps never mention an explicitly named tool is ignored — explicit instruction outranks learned habit.
Also fixed the same evening: `document` tool takes markdown and renders through `markdownToHtml` + the fixed stylesheet (model-authored HTML drifted per run); CSV misdetection scoped to spreadsheet targets; narration collapsed to one line per tool streak.

### The A/B verdict: flow-gathered research works, and its first report caught a fabrication
First live run of the flow-first research path ("Research this week's AI developments… use the weekly_gather tool"): router → research → `flow_gather` returned **4 facets / 32 urls in 3.7s** → decompose/parse skipped → full editorial machine on flow-selected sources. `gap_check` fired on exactly the flow's thin lenses (model releases, policy) and patched them with fresh searches — the built-in corrective for the ossification bargain (frozen questions, live results; persistent gap-patching = the recompile signal). Verification extracted 14 claims, cross-checked 4, and **CONTRADICTED a fabricated "Claude Opus 5" release — corrected to Opus 4.8 from an independent source**. Total ~30 min, nearly all spent on synthesis + verification instead of improvised gathering. Editorially at least the equal of the search-gathered baseline. Skill hijack guard fired on the same run ("skill generate-report-from-web ignored") — first non-hijacked multi-shaped request of the night. Cron 44b13056 switch = Peter's call, pending.
**Two publishing defects found by the run, both fixed with regression fixtures:**
- **Decimal points are sentence boundaries too** — "Gemini 3.5" split at "3." exactly like URLs used to, splicing a correction mid-version-number ("Gemini 3.According to anthropic.com, 5 Flash Lite") and duplicating a ".5%" tail. Decimals now masked (digit.digit, same-length filler) alongside URLs before segmentation. The general lesson after two rounds of this: ANY dot that isn't a sentence terminator must be masked before segmentation — URLs, decimals, and whatever's next.
- **Charts rendered but never reached the PDF** — 2/2 PNGs on disk, blank in the report: LibreOffice resolves relative `img src` against the temp HTML's directory, not the repo root. Chart swap now emits absolute paths.

## The Agent Authored Flows — and Exposed Two of Our Bugs Doing It (August 1 2026)

### LocalClaw read the FlowMCP repo and drafted a HubSpot integration; the run was a fuzzer
**What happened:** asked about FlowMCP over Discord, the plan pipeline researched the public repo (step 1) and authored a complete HubSpot integration draft (step 2): `servers.json5` + five flows + README, now at `data/workspaces/main/flowmcp-hubspot/`. **The drafts are schema-valid against FlowMCP v0.4** — including the `env:` least-privilege field that shipped hours earlier (the agent's repo knowledge was fresher than its maintainer's). Doctrine absorbed from READING alone: WHEN-TO-USE-first descriptions with example phrasings, read-only downstream allowlist with the write tool deliberately excluded (the write FLOW exists but is inert until allowlisted — staged trust, unprompted), least-privilege env, a REST fallback flow for when the MCP server is down. Remaining gaps before "implementation-ready": HubSpot tool names unverified against the live server's tools/list; templates render raw JSON (needs transform steps); and it claimed "two-phase confirmation, no opt-out" — an overclaim against v0.4 that FlowMCP's v0.5 elicitation feature made true HOURS later.
**The run exposed two real LocalClaw bugs (both fixed):**
1. **Workspace path double-nesting** — the model echoed the workspace-prefixed path it saw in context; `write_file` joined it onto the workspace root again → `data/workspaces/main/data/workspaces/main/…`. read/write_file now strip a redundant workspace prefix deterministically before resolving (path-traversal validation unchanged, re-tested). Lesson: any tool that joins model-provided paths must assume the model echoes absolute-looking context paths.
2. **Narration violated the channel-coarseness rule** — seven consecutive write_file calls narrated "Using write_file…" seven times to Discord. The per-tool-call narration (added July 31) lacked the milestone-level guard the channel design deliberately enforces. Now one narration per tool STREAK: consecutive same-tool calls collapse; a tool change narrates. Lesson: a new observability channel must inherit the coarseness contract of the surface it emits to — "we did that deliberately" applies to features added later, too.
**Meta-observation worth keeping:** doctrine propagated agent-to-agent through nothing but a well-written public repo — the selection-surface and staged-trust rules arrived in a third agent that was never prompted with them. A repo's README/FORMAT is a training signal for every agent that reads it; write them as such.

### FlowMCP production pin: track upstream deliberately, verify per pull
The other Claude Code instance ships to FlowMCP main autonomously (v0.4→v0.5 in one day: elicitation, attestation drift-hash, hostile-ERP matrix). LocalClaw's exposure is bounded structurally: the bridge points at a dedicated clone (`~/FlowMCP`), updated by explicit pull + live `weekly_gather` verification per version (v0.4 ✓, v0.5 ✓ — compatible both times). Velocity upstream, promotion at our discretion — the same rung-by-rung trust model as everything else, applied to a collaborator that happens to be a model. Gotcha for the update drill: local `npm i` rewrites package-lock.json and blocks the pull — `git checkout -- package-lock.json` first (upstream's lockfile is truth).

## FlowMCP Integration: The Ossification Rung Above Skills (July 31 2026)

### Compiled workflows join the toolset — recurrence-proven paths stop paying inference prices
**What:** FlowMCP (Peter's standalone workflow-first MCP server, github.com/PeterGreenAppliedAI/FlowMCP) is wired in as a bridge server: production clone at `~/FlowMCP`, config entry `tools.mcp.servers[name=flows]` pointing at the compiled-flows dir, `mcp:flows` token on the multi specialist. First flow: `weekly_gather` — the AI-news cron's gathering phase (4 SearXNG searches + render), COMPILED from a captured agentic trace by FlowMCP's compiler v0. Declares `readOnlyHint`, so the bridge runs it silently. Verified live from the tmux lab: real gathered material in ~4 seconds. (Direct-shell test failed with `fetch failed` — the macOS TCC node-LAN block again; FlowMCP's child processes inherit the same constraint. Lab or production launch context required, as ever.)
**Why (the architecture, not just the plumbing):** skills and flows are two rungs of one hardening ladder. A skill is a SOFT recipe — "this sequence worked" — with the model still deciding each step: right for tasks with variation. A flow is a HARD program — zero model during execution, deterministic, ~free — and brittle to variation. The lifecycle: **explore agentically → recurrence makes it a skill → stability makes it a compilable flow → breakage demotes it back to exploration.** FlowMCP's own benchmark is the quantitative case: workflow-façade 79% vs 10% on a 40-tool primitive surface across local models; qwen2.5:7b went 6/6 @878 tokens on the façade vs 0/6 @6,768 on primitives — *selection is a different task than planning*. LocalClaw supplies discovery, trace evidence (skill successCount = the compilation signal), and the runtime; FlowMCP supplies ossification; the `.flow.json5` format is the portable membrane (deliberately agent-agnostic — no LocalClaw coupling in the flow format).
**The honest boundary:** gathering compiles; judgment doesn't. The 28.8-minute research run's flaky 6-facet sweep is flow material; synthesis and claim verification remain model-work. The compiled flow's digest quality vs the full pipeline is UNPROVEN — the deal is an A/B: run the flow-fed variant beside the real cron, compare digest quality + stage timings (pipeline_run metrics), and only then switch the production job. Until that comparison exists, `weekly_gather` is an available tool, not a replacement.
**Status:** wired + config-validated + live-verified at the tool level; restart pending; A/B pending. If the A/B shows snippets aren't enough, the finding is "the flow needs a fetch stage" — compiler work on FlowMCP's side, driven by observed pain.

## The 46-Fact Removal: Guards That Stop Floods Can Create Leaks (July 30 2026)

### Bare "!heartbeat no" removed 46 facts when the report showed 2
**Incident:** heartbeat proposed 2 stale facts; Peter replied `!heartbeat no`; the bot removed **46** — including most of his professional-identity layer (Sparks, Val partnership, Clearpath, workshops funnel) and health tracking. Root cause chain: the July 10 firehose guards capped stale proposals at 3 *per cycle* but the pending file MERGED across cycles — two-plus weeks unanswered quietly accumulated 46 candidates while each report displayed only the newest few (the "!heartbeat no 45" index was the visible tell nobody read). Bare `no` = remove-ALL by design, so consent was given against 2 visible items and executed against 46 invisible ones — the July 7 lesson ("the human is not a reliable validator of what they can't see") violated by our own accumulation.
**What saved it:** the removal ledger (`removed.jsonl`) held every text, and the handler's flat/graph divergence BUG (removal never touched FalkorDB) accidentally preserved the highest-value facts with full metadata. Diff analysis showed 41/46 were still-valid; restored 44 through BOTH stores (write-through like `!save`, re-tagged via the extraction model — which promptly invented the category "business relationship", re-proving that a model must never be trusted with a schema boundary; coerce to the closed set). 2 genuinely stale facts stayed removed. Flat 40/44 + graph 40/44 (dedup rejects = survivors, correct).
**Fixes (all structural):**
1. **The pending set is capped at ONE report's worth (5)** — Peter's rule verbatim: "there is never a reason for it to surface that many facts for removal at the same time." Commands can now only act on what the user is looking at, by construction.
2. Unanswered proposals **expire back to normal memory after 7 days** (cooldown ledger prevents instant re-proposal) — review is an offer, not a debt that compounds.
3. Bare `no` on a legacy oversized set (>5) removes NOTHING — lists everything and requires `!heartbeat no all`. Bare `!heartbeat` now lists the full pending set.
4. Reports state the TOTAL pending count when it exceeds what's shown.
5. Review denial now **removes from the graph too** — the divergence that saved us was still a bug (removed facts stayed injectable via graph KNN).
**Lessons:** (1) A per-cycle cap without a total cap converts a flood into a leak — guards must bound the ACCUMULATOR, not just the increment. (2) Any command's blast radius must equal the user's viewport, structurally. (3) Dual-store operations that only touch one store fail in both directions — this time divergence rescued data; next time it resurrects deleted data. (4) The removal ledger earned permanence: deletion without an undo trail would have made this unrecoverable.

## img2img: Correct Wiring, Broken Upstream (July 29 2026)

### "Make this picture anime" now routes right — and the backend ignores the picture
**Incident:** Discord user attached a photo + "make this picture animated in an anime style" → "I don't have image tools." Four stacked causes: (1) the unconditional image-attachment→chat override meant transform intent never reached the router while `image_generate` sat unreachable; (2) "But you can generate a picture of sonic" stuck to chat via sticky; (3) vision leaked gemma4's literal chain-of-thought as the image description (the qwen3 answer-in-thinking fallback backfiring); (4) the image box's IP had changed. All four fixed (transform-caption regex gates an `image` override with the saved path passed as reference_image_path; generation-ask keyword breaks sticky; CoT lead-in stripped from thinking fallback; Peter fixed the IP).
**Then Peter challenged the design** ("you setup a pipeline for a vision model to describe a photo to generate an exact replica?") — and the empirical test proved him right for a reason we didn't expect: a geometric reference image (red circle/blue square) vs a text-only control produced **near-identical generic outputs**. The tool sends the documented base64 `images` payload correctly; **Ollama's Flux2-Klein serving discards the source image** — open upstream bug ollama/ollama#14306, broken since ~0.15.6, reproduced by users through 0.30.8; our server runs 0.21.2.
**Response:** keep the (correct) wiring — img2img starts working the day upstream fixes it — and add an honesty caveat to the tool result whenever a reference was supplied, so the model tells the user the original was NOT preserved instead of claiming an edit it never performed (phantom-PDF over-claim class).
**Lessons:** (1) "The tool has an img2img param" is a claim about the REQUEST, not the backend — verify the far side of every contract with a distinguishable probe (the geometric reference made ignoring it unmissable). (2) When a capability silently degrades, the first casualty is honesty — over-claim guards belong in the TOOL RESULT, where the model can't miss them. (3) Peter's design challenge caught what tests didn't: adversarial owner review, again.
**Real img2img options (deferred, dial list):** wait for #14306; or ComfyUI/Forge on the image box with a proper init-image + denoise API (new tool client — the robust path if photo-editing becomes a real use case).

## Lessons: The Agent Gets Its Own DECISIONS.md (July 29 2026)

### Negative procedural memory — "approach X failed for task-shape Y; the boundary is Z"
**Origin:** a conversation about why the BUILD agent stays coherent across sessions — DECISIONS.md is its causal memory of failures and boundaries. Peter's realization: LocalClaw's runtime agent had no equivalent ("huh, shit you're right"). errors.jsonl records raw tool failures and LEARNINGS.md gets tool-level one-liners, but nothing captured approach-level boundaries. This applies the project's best pattern one level down: the system now has THREE memory systems — FalkorDB (who the user is), skills (what worked), lessons (what didn't and where the line is).
**The three hard questions and their answers:**
1. *How does the agent know a failure happened?* It doesn't — CODE does. Candidates are harvested (`lesson-harvester.ts`, pure code, marker-tracked) from evidence already on disk: max-iteration dispatches (logDispatch now carries a `messagePreview` so failures have a request SHAPE), repeated tool failures at the existing ≥3 threshold, narration-repair clusters, rejected/failed autonomous actions, dead letters. The model's only job is filling a grammar-constrained lesson slot in the heartbeat — it never self-assesses in the hot path, and a 9B-honest limitation is accepted: these are observations-with-wounds, not root-cause diagnoses; the deep entries still come from build sessions.
2. *Storage?* Markdown files (`workspace/lessons/*.md`), skill-store shape: boundary one-liner in frontmatter (the ONLY text ever injected), `model` at time of observation (a phi4-era lesson may be false under DeepSeek — lessons are point-in-time, same doctrine as facts), evidence_count, triggers. Embeddings are the fourth EmbeddingStore tenant (`source='lesson'`; skill semantic helpers generalized to serve both).
3. *When sourced, on a small-model budget?* Never the corpus. Floor-gated KNN one-liners (max 2) in user priming — zero hits = zero tokens — plus tool-tagged boundaries through the existing `findHints` pre-execution seam (lessons outrank raw error strings there: they carry the synthesized boundary).
**The intake decision (Peter's call):** auto-save at evidence:1, but **injection requires evidence ≥ 2** — a one-off failure is noise until it recurs, and recurrence is a code gate, not model judgment. This threads between the two bad options: propose-confirm-everything (review fatigue → the July-10 firehose / reflex-confirm problem) and inject-immediately (one hallucinated boundary silently steers every matching dispatch). Reversibility justifies the auto-save: heartbeat report lists new lessons, `!lessons drop <slug>` kills one. Firehose guards ported from stale-facts: max 3 new per cycle, batch-distrust when the synthesis model marks everything worth keeping.
**Floor:** starts at the measured skill floor 0.65 (same embedding model, same text shape); `scripts/lesson-floor-check.ts` re-measures once ~5 real lessons exist — floors are measured, never guessed.
**Deferred with triggers:** transcript-level user-correction harvesting (fuzzy — needs its own precision work once code-signal lessons prove out); `lesson_find` pull tool (if one-liners prove insufficient).

## The Skill System Was Dead for Three Months — Resurrection by Autopsy (July 25 2026)

### Peter: "I dont see that actually working. It just keeps either skipping it or making a fresh skill"
**Autopsy (all three causes compounding, evidenced on disk — every skill dated Mar 29–Apr 19, nothing since):**
1. **Wrong scope.** `skill_check`/`skill_save` existed ONLY in the plan pipeline (`multi` category). As dedicated pipelines (research/document/analytics/cron) took over traffic, the skill system's only entry point stopped being visited. A feature attached to a category is only as alive as the category.
2. **The generalizer and the matcher fought each other.** Save-time LLM generalization deliberately strips specifics ("weather Long Island PDF" → "retrieve data from an external source based on specific criteria") while the keyword matcher needs overlap with the user's SPECIFIC goal — and its stop-word list banned `report`/`search`/`create`/`make`, the only content words generalized descriptions contain. Two components, individually sensible, jointly guaranteed silence.
3. **No save-time dedup.** The only duplicate check was exact slug collision; a different generalized NAME for the same pattern minted a sibling file. Three copies of web→report existed (`generate-report-from-web`/`fetch-and-format-report`/`generate-and-convert-content`). Bonus: the heartbeat guard was a string-match on the message text — `execute-heartbeat-tasks` had success_count 22.

**Rebuild (all shipped, 593 tests green):**
- **Embedding-based matching** as primary (skill text = name + description + `triggers`; stored in the existing EmbeddingStore under `source:'skill'`, stable `skill:<slug>` ids), keyword scorer as fallback with the load-bearing stop-words removed. New `triggers:` frontmatter preserves up to 5 CONCRETE past requests — the generalizer can keep generalizing because triggers carry the specifics. Floor MEASURED at 0.65 against real qwen3-embedding (noise ≤0.604, signal ≥0.700) — the 0.60 guess would have false-positived on "what did we talk about yesterday" at 0.604; same lesson as the memory floor: qwen3-embedding's baseline similarity runs high, floors must be measured, never guessed.
- **Save-time dedup ladder:** exact slug → hybrid match on the original request → grammar-constrained judge against the catalog (`{decision: new|update|skip, slug}`) → genuinely new. `update` revises the EXISTING file (trigger append, success bump, variant-sequence note) — slug-addressed revision, never a sibling.
- **Structural guard:** `cronMode` threaded into PipelineContext; heartbeat/cron can no longer match or save skills regardless of message wording.
- **Progressive disclosure beyond `multi`:** new `skill_find` tool (read-only) lets ReAct specialists pull proven step sequences on demand — the catalog stays out of the prompt (OpenWorker's pattern, adapted). Deliberately no recordSuccess on lookup: finding ≠ completing.
- **Observability:** skill_matched/saved/updated/skipped all flow through `logAutonomousAction` — the live log now shows the system breathing, which is how the next silent death gets caught in days not months.
- One-time cleanup script merges the dupes, archives the heartbeat-born skills, backfills embeddings (`scripts/skills-cleanup.ts`, run from the lab).
**Lessons:** (1) A learning loop needs a liveness signal — this one had zero log lines on the skip path, so three dead months looked like quiet health. (2) When one model call WRITES what another model call must later MATCH, design them as a pair; generalization without preserved specifics is lossy compression of the matching key. (3) Save-time dedup must compare against the CATALOG, not just the key you're about to write.

### Cron runs, remote MCP, and the cheap-wins sweep — OpenWorker harvest complete (July 25 2026)
**Cron runs are auditable now:** every run persists its own session (`cron:<job>:<run>` — fresh context via unique key, continuable transcript), deliverables are captured by CODE (workspace mtime-window scan; gotcha for the record: **macOS mtimeMs carries sub-ms precision and measured 0.66ms AHEAD of Date.now()** — an unpadded until-bound silently dropped a just-written artifact in tests), runs land in capped `data/cron-runs.jsonl`, failures in a `data/unrouted.jsonl` dead-letter store surfaced by `!autonomy`. Scheduler gained skip-on-overlap and boot catch-up-once (a reboot at 8:59 no longer eats a 9:00 one-shot reminder).
**Remote MCP, fully local:** `McpHttpClient` (streamable HTTP: JSON + SSE responses, Mcp-Session-Id echo) behind the same interface as stdio — the swap seam built July 20 paid off in one file. Auth is OAuth 2.1 + PKCE + **Dynamic Client Registration** — DCR is what makes "no cloud broker" possible (no pre-registered client secret to hide). Tokens in the new `SecretStore` (0600, atomic, `status()` never leaks values). **The `interactive` boundary is structural:** the browser-opening flow exists ONLY in `scripts/mcp-oauth-setup.ts`; every runtime path does stored-token + silent-refresh and throws a clean re-auth error — OpenWorker shipped the authorize-page-at-launch bug; we made it unrepresentable.
**Cheap wins:** `logAutonomousAction` approval/resource columns (promotion evidence is queryable); MODEL_CAPS declared capability matrix (extractor consults it before trying `format`; runtime fallback kept as net); absolute-date + verify-still-exists memory guidance; **steering queue** (messages typed mid-dispatch inject into the running ReAct loop between iterations; undrained leftovers replay as normal messages, finally-guarded so a crash can't wedge a session busy); deterministic per-tool narration lines (zero model cost).

### Confirm buttons, deny, and continuation — closing the confirm-gap UX (July 25 2026)
**Buttons as typed-reply sugar:** Discord components / Telegram inline keyboards render ✅ Confirm / 🔓 Always / 🚫 Deny under previews, and a press SYNTHESIZES the equivalent typed message through the normal inbound path into the one `handleConfirmation` choke point. Design rule worth keeping: **an interactive affordance must never become a second security surface** — buttons inherit sender-binding, single-use, expiry, and principal resolution for free because they ARE typed replies. Buttons strip themselves on press; a stale second press just gets "doesn't match".
**Deny is now explicit** (`deny|cancel|reject <id>` → consume without executing, logged `rejected`) — before, denial was only expiry, so a refused preview stayed confirmable for its whole TTL. Subtlety that matters: deny verbs are NOT near-miss-guarded ("cancel the daily search" is a cron request and must reach the router; cron ids are also 8-hex, so `cancel 15e8b662` with no matching pending entry FALLS THROUGH to routing instead of erroring — safe for deny because denial has no execution risk, unlike confirm near-misses).
**Continuation-after-confirm:** a confirmed action's result dispatches ONE follow-up turn into the originating session with the ORIGINAL category's toolset (category now stored on ledger entries) — multi-step work no longer dies at the preview. Gated by `session.continueAfterConfirm` (default on); confirm-gated calls inside the continuation are gated again, so there's no approval loophole.
**Dropped consciously:** OpenWorker's interrupted-tool-call hygiene — LocalClaw has no mid-turn abort machinery to clean up after; building abort just to need hygiene is YAGNI. Revisit only if a user-stop feature lands.

### Target-bound standing grants — the missing rung of the autonomy ladder (July 25 2026)
**Harvested from the OpenWorker deep-dive and adapted.** Between propose_confirm (ask every time) and `autoApproveTools` (never ask, tool-wide) there was nothing — so promotion was all-or-nothing. Now: tools may declare `targetArgs` (the params naming their external target; `send_message` → `['channel','channelId']` → grant key `discord:123`). Replying **`always <id>`** to a confirm preview executes it AND mints a standing grant for that exact tool→target pair; future identical-target calls run silently (`act_then_notify`, logged with the grant source). **Structural properties:** tools without targetArgs (exec) are grant-INELIGIBLE by construction; grants mint only from an explicit id'd confirmation, only on successful execution; exact-string match, principal-bound, file-backed, revocable via `!grants revoke <id>`; "always" with a bad id is a near-miss error, never chat fall-through. Plus an **implicit reply-origin approval**: sending to the exact conversation the request came from doesn't ask — permission ceremony to reply to the person who just asked was pure friction. Preview text now offers both: `confirm <id>` / `always <id>`.
**Why this shape:** the July 7 incident proved the reflex-confirm is real — every unnecessary ask trains it. Target-bound grants cut asks precisely where trust is earned (one destination) without widening the blast radius to the whole tool. It's also what `logAutonomousAction`'s track record was FOR: the metrics justify each grant, and the grant is the promotion.

## MCP Client Bridge: The Ecosystem for the Price of One Protocol (July 20 2026)

### Any MCP server's tools become LocalClaw tools — security stack inherited for free
**Origin:** an NVIDIA demo (Agent Toolkit + Blender MCP on a DGX Station) that Peter wanted to reproduce locally. Decision: don't hand-wrap Blender as a one-off tool — build a generic bridge (`src/mcp/`) so `blender-mcp` is merely the first consumer and every other MCP server (filesystem, GitHub, hundreds more) comes along.
**Three interrogated decisions:**
1. **Zero-dep protocol client, not the official SDK.** We use ~10% of MCP (initialize / tools/list / tools/call over newline-delimited stdio JSON-RPC) — the oldest, most stable slice of the spec. ~200 owned lines mean our error factory, our timeouts, one file to debug at 10pm from the live log. Honest counter-case recorded: the SDK absorbs spec drift and server handshake quirks for free — if resources/prompts/sampling/remote servers become wanted, swap it in behind `McpManager` (the interface doesn't change).
2. **readOnlyHint-aware autonomy default.** MCP tools are external processes doing real things. Tools the server annotates read-only run silently; everything else lands `requiresConfirm: true`. Per-server `trust: 'auto'` waives it — owner-authored config as the code gate, same doctrine as cron's category waiver. All-confirm was rejected because 15 confirms per Blender scene trains the reflex-confirm the July 7 incident proved is real; all-silent was rejected by the ladder ("new externally-visible tools start at propose_confirm").
3. **stdio only in v1.** HTTP transport's trigger is a server on another machine (likely: Blender on the Windows GPU box while LocalClaw stays on the Mini).
**Small-model layer (the part that makes it work on 7-30B):** MCP servers write descriptions for frontier models. Translation caps them at 500 chars on a sentence boundary; per-server `toolAllowlist` (don't drown a 14B model in 40 tools), `toolDescriptions` hand-rewrites, `maxResultChars` via a new per-tool `resultLimit`. Tool names are `<server>_<tool>`; specialists opt in with one token — `"mcp:blender"` in a tools list expands to the server's whole set at dispatch (`registry.expandToolNames`), so config doesn't chase runtime tool names.
**Integration wins that cost nothing:** name-based channel security (blockedTools/ownerOnlyTools/autoApproveTools) applies unchanged; MCP write tools flow into the metadata confirm set automatically; image content (Blender screenshots) becomes `[FILE:]` tokens riding the existing media pipeline; `isError` results become model-visible `Error:` strings the error-learning store already knows how to record.
**Resilience:** failing server skipped at boot (plugin-loader doctrine), crashed server lazily respawned on next call (FalkorDB doctrine), children killed on orchestrator stop AND REPL exit.
**Testing:** the fixture is a REAL ~80-line MCP server (`test/mcp/fixtures/fake-server.mjs`) spawned as a real child process — handshake, timeout, crash, noise-on-stdout, image content, RPC errors all integration-tested, not mocked. 33 new tests, suite at 564.
**Post-ship fix (July 25):** tool names are sanitized to `[A-Za-z0-9_-]{1,64}` (prefix-preserving truncation, collision suffixes) — MCP servers may use dots/slashes in tool names, and the vLLM/OpenAI path REJECTS those; the bridge shipped passing them through raw (caught by comparing against OpenWorker's client, which sanitizes). The server still receives the original name; only the model-facing registry name is cleaned.
**Deferred with triggers:** HTTP transport (remote server), tools/list pagination + listChanged (logged if ever seen), LLM description summarization (if hand-curation gets old), SDK swap (if protocol ambitions grow).

## The Three Reminders: Every Seam in the Cron Path at Once (July 20 2026)

### Incident — "set up three reminders" hit four independent defects in nine minutes
**Timeline (production, 10:45–10:50 AM, Discord):** The owner asked for three September reminders in one message. (1) The cron pipeline's extraction enum offered category `task`, but `cron_add` kept its OWN hand-copied category list that predated `task`/`research`/`personal` — the tool rejected what the extractor was told to produce, and the raw error string was delivered as the reply. (2) On retry the pipeline created only ONE of the three jobs — the add branch extracted a single job and silently dropped the rest — and created it as a RECURRING yearly job because the pipeline never extracted the `once` flag built for exactly this. (3) "We did all three or just the one?" routed to `memory` (cron wasn't sticky) and the memory pipeline "answered" from a fact saved at `!reset` minutes earlier — confident confabulation instead of a `cron_list` call. (4) The re-paste of the two missing reminders broke sticky on a false keyword hit — `\bsetting\b` in the config pattern matched "**setting** up a business structure" — then model-routed to `personal`, whose specialist hallucinated `cron_job_create`, was correctly blocked by the registry (the one layer that held), and declared no scheduler exists.
**Fixes (all deterministic):**
1. `CRON_JOB_CATEGORIES` in `src/cron/types.ts` is the single source — cron_add, cron_edit, AND both pipeline extraction enums import it; a test asserts all four are identical. Same bug class as Zod-vs-hand-written types: two hand-maintained copies of one list WILL drift.
2. The extractor now supports array-of-object fields (recursive `items` schema, per-element validation with indexed errors, grammar-constrained) + per-stage `maxTokens` (the 256 default cannot fit three reminder texts). The add branch extracts `jobs[]`, fans out via the existing `parallel_tool` stage (store writes are synchronous → race-free), and the confirm stage DISCLOSES partials: "Only 1 of 3 created" — the silent partial was the most corrosive failure of the four.
3. `once` extracted per job (with a dated-reminder example), passed through, and editable (`cron_edit` + edit branch + `CronJobUpdate.once`). Confirmations now state "one-shot … next run Sep 15, 2026 (runs once, then auto-disables)" vs "recurring" — the yearly-instead-of-once mistake is only catchable if the firing semantics are in the reply.
4. Routing: `cron` added to STICKY_CATEGORIES (post-scheduling follow-ups belong to the cron pipeline, whose list branch answers from `cron_list`, not memory); config keyword tightened to `settings?(?! up)`; router prompt says dated reminders are cron even when the content is personal/business, and `personal` explicitly CANNOT schedule.
**Lessons:** (1) When a pipeline hands a model an enum, the enum and the tool's validation must be the same object — an extraction schema is a PROMISE the tool has to honor. (2) Partial completion without disclosure is worse than failure: the owner had to ask "did we do all three?" and got a confabulated answer — every fan-out stage must compare requested vs created and say so. (3) A question about what the system just did must reach the subsystem that did it — sticky-category is the cheap mechanism for that. (4) Keyword overrides that break sticky need the same precision bar as pre-model overrides ("setting up a business" is not a settings request).
**Also caught in the same sweep:** four prep-context tests had silently rotted on main — the store's retention pruning used wall-clock `Date.now()` while tests inject `now`, so July 8 fixtures aged out of the 7-day window ~July 15. `load()` now takes injected time. Time-frozen fixtures + wall-clock pruning = tests that pass until the calendar breaks them.
**Watch item (not fixed):** the personal specialist's final answer was delivered twice — the model wrote its answer twice in one completion. If it recurs, look at the answer path in engine.ts, not delivery.

## FalkorDB: The Volume That Wasn't (July 14 2026)

### Two months of graph memory lived in a disposable container layer
**Found during a routine image update:** the May container mounted its volume at `/data`, but FalkorDB persists to `/var/lib/falkordb/data` (its `FALKORDB_DATA_PATH`) — the volume was EMPTY and the real `dump.rdb` sat in the container's writable layer. A plain `docker rm` at any point since May would have destroyed all graph memory (1,301 turns, all facts/entities). The update procedure caught it only because step one was "verify where the data actually is before removing anything."
**Fix:** host-side RDB backup first (`data/backups/falkordb-dump-2026-07-14.rdb` — keep forever), old container preserved until verification, new container mounts the volume at the CORRECT path and got `--restart unless-stopped` (was `no` — memory also silently died on every Mac reboot until manually restarted). Counts verified identical post-upgrade; HNSW vector search verified live (version upgrades are where vector indexes silently break).
**2026-08-14 update (4.2.0 → 4.2.3):** same procedure, clean run — backup `falkordb-dump-2026-08-14.rdb`, old container preserved as `falkordb-old-20260814`, counts identical (2,462/1,075), HNSW verified with a live KNN query (index *existing* ≠ index *serving*). Mount path and restart policy from the July fix held.
**Lessons:** (1) A mounted volume proves nothing — verify the process's actual persistence path writes INTO it (`redis-cli CONFIG GET dir` + ls both paths). (2) Infra updates start with "where is the data, really," not with the update. (3) macOS keychain blocks docker pulls over SSH — pull via the tmux lab session (GUI keychain) — same family as the EHOSTUNREACH entry.

## Document Vault: Folders Are the Taxonomy (July 9 2026)

### A domain-organized document store as source of truth — designed by interrogation
**Origin:** Peter asked whether Obsidian would help for documents-as-source-of-truth. Resolution: don't adopt Obsidian, adopt THE VAULT — a plain folder of markdown/PDF that Obsidian happens to edit well. Editor and data decoupled; zero dependency. He then rejected a fancy frontmatter/`applies_to` doctrine-routing design in favor of "folders are the taxonomy: business/, coding/, ..." — and stress-tested every hand-wave until the spec was real (chunking strategy? unstructured docs? no numbered sections? retrieval mechanics?). The design improved at every challenge; adversarial owner review before build is as valuable as the fresh-eyes audit after.
**Shape:** `vault/<domain>/*` → normalization ladder (markdown heading-path chunks → heuristic heading promotion → semantic-valley segmentation via embedding dips — deterministic math, no generative model ever touches document text → paragraph fallback; tier logged per file) → hybrid retrieval (dense ∪ FTS5 lexical fused by reciprocal rank — doctrine is term-anchored, "Gate 4" must hit exactly; floor 0.45 pending corpus measurement; per-file cap; adjacent stitch with combined provenance; budget pack) → `docs_search`/`docs_store` tools; heartbeat reindexes by mtime+hash. Every search logged for tuning.
**Test-caught bugs worth remembering:** (1) contentless FTS5 (`content=''`) does not store UNINDEXED columns — joins silently return nothing; use contentful tables. (2) Query-term regex `{2,}` dropped single digits — "Gate 7" searched as "Gate". (3) Runt-section merging at 120 chars swallowed adjacent rubric gates into one chunk labeled with the WRONG heading — provenance-correct thresholds beat tidy-looking chunks (now 40). Each found by a test asserting on real retrieval shape, not by review.
**Deferred with triggers:** LLM-assisted structuring for hopeless walls of text (when tier-3 list shows retrieval pain), reranker (evidence first), ANN/HNSW migration (>50k chunks — FalkorDB already serves HNSW), auto-injection of doctrine into pipelines (tool-initiated retrieval first; watch usage).
**Status:** Built, 522 tests. Seeded with the code-review rubric. vault/ is gitignored — personal content never enters the open-source repo (the person-literals rule extended to person-documents).

## The First Real Save: Misroute Chain vs the Confirm Gate (July 7 2026)

### Incident — the gate contained what routing broke, including a reflex confirm
**Timeline (production, 4:05-4:14 PM):** The owner answered a briefing prep question in Discord ("David is going on the podcast, I just need to get him a Riverside link"). The router classified the ANSWER as a `message` command; extraction fabricated a WhatsApp target (a Discord-shaped snowflake) with his own words as the text; the confirm gate previewed it. The owner **reflex-confirmed without reading**. The stored action executed — and the WhatsApp adapter refused the invalid target: **nothing was ever delivered**. He then asked "did you actually send a message?" — which ALSO routed to `message`, and the pipeline's anaphoric rewrite rebuilt fresh send params from conversation history (the earlier preview JSON), proposing a SECOND send. He didn't confirm that one. Net harm: zero, minus some trust.
**What worked:** every layer of the July autonomy build held — the gate previewed both times, stored-params execution ran exactly what was shown, the ledger/metrics recorded every step (which is how the incident was reconstructed to the minute), and the invalid fabricated target was unsendable. Without this stack, the 4:05 message sends immediately.
**What broke (all fixed, all deterministic):**
1. Briefing replies now presume answerhood — sticky to chat ('briefing' in STICKY_CATEGORIES with target chat); only imperatives or keyword hits break out. The fuzzy new-topic patterns ("get…a…") are tuned for chat drift and misfire on answers.
2. Meta-questions about the agent's own actions ("did you / have you…") are a pre-model chat override — a question about an action must never BECOME an action. Past/perfective second-person only; polite commands ("can you send…") untouched.
3. The anaphoric history rewrite never runs for the message pipeline — a send must come from the user's explicit words; history had become a parts-bin for fabricating sends.
4. `validate_target` stage: extraction-produced targets must be format-plausible for their channel (jid/chat-id/snowflake/slack patterns) or match the conversation's own channel — otherwise the pipeline ASKS instead of proposing.
5. Preview + confirm honesty: gate previews render as "⏸️ Not sent yet … to `<target>`" (was "Failed to send message: <JSON>"); confirmed actions whose tool returns an error string now reply ❌ and log outcome `failure` (was "✅ Ran send_message: Error…" — a success mark on a failure).
**Lessons:** (1) The reflex confirm is REAL — the owner confirmed without reading within 2 minutes of the feature's first misfire. Previews must put the scary part (who receives it) in plain words, and structural validity checks must run BEFORE anything reaches the human, because the human is not a reliable validator. (2) An agent's conversation history is attacker-shaped input to parameter extraction — never let a rewrite stage synthesize action params from it. (3) Meta-conversation about the system is a routing category of its own; treat it as chat by rule. (4) The metrics ledger paid for itself on day one — the incident was reconstructed entirely from `autonomous_action` events.

## Self-Identity in Prompts: Config, Never Code (July 7 2026)

### Models must recognize the user in content metadata — from config only
**Problem:** the briefing asked "What is the context for the meeting with David regarding Peter Green?" — the model saw "booked by pgreen@devmesh.tech" in calendar metadata and treated the user as a third party. The principal layer taught the SYSTEM who the user is; the MODEL had never been told.
**Constraint (Peter's, and now a standing rule):** this is an open-source app — no person may ever be hardcoded in a prompt. Kin to "no model literals in logic": no PERSON literals in prompts.
**Fix:** `PrincipalSchema` gained `displayName` + `emails`; `selfIdentityLine()` (identity/principal.ts) assembles the prompt line entirely from config ("The user you are assisting is X. These are THEIR OWN addresses…"), returns null when unconfigured. Injected into the briefing prompt and prep prompt. Verified live: the question became "What is the agenda for your meeting with David?"
**Status:** Active. Candidate follow-up: inject the same line into specialist prompts that read email/calendar (personal category).

## The Morning After: Migration Starved the Briefing's Memory (July 7 2026)

### First production 8am briefing — conflict caught, but prep silently absent
**What the owner received at 8:00:** correct schedule, the Val/David overlap flagged with exact interval language (the new deterministic detector), a memory-driven insight (Val↔Domo — unified-memory payoff), and a working `!heartbeat no` round-trip that removed facts from the PRINCIPAL bucket. But NO prep section — no questions, no confirmable proposals.
**Debug path (empiricism, no theorizing):** calendar parser probe on real text → OK. Full harness re-run → reproduced: no `[Prep]` failure warning, so the model call succeeded and returned nothing actionable. Raw-output probe → DeepSeek was answering "none" for almost everything, validly.
**Root cause:** the briefing log's own `memory=18 chars`. The briefing/heartbeat tool contexts still passed the RAW delivery target as senderId — post-migration that bucket is empty; the person's memory lives under `peter`. With zero user context, "prefer none over inventing busywork" produced exactly what it says. Fixed: principal-resolved senderId in both services' toolCtx + the briefing's stale-facts read. Verified: memory 18→236 chars, prep section back (two intake questions; TKD reminder correctly deduped against last night's still-open proposal).
**Lessons:** (1) An identity migration isn't done until EVERY read path is audited — grep for the alias, not just the write sites; the two missed spots were toolCtx constructions, not memory calls. (2) "Model returned none" and "model was starved of context" are indistinguishable from the outside — when a judgment stage goes quiet, check what it was SHOWN before blaming its judgment. (3) The `memory=<n> chars` context log line is what cracked this — keep sizing logs on every model-facing context assembly.
**Recurring cosmetic:** DeepSeek name-slips in prep questions (wrote "Val" in David's question twice across runs). Harmless, watch for pattern.

## First Real Proactive Briefing + the Determinism Rubric (July 7 2026)

### The proof run — real calendar, real conflict, real confirmable proposal
**What happened:** `scripts/briefing-live-check.ts` runs the PRODUCTION briefing path (real Google Calendar OAuth, real unified memory under the principal, real DeepSeek, real pending-action ledger, real session-transcript append) with only the channel send stubbed to stdout. First run against live data: correct schedule, the genuine Val/David 11:00-vs-11:15 overlap flagged, a confirmable one-shot TKD reminder proposed into the live ledger, and intake questions asked for both under-specified meetings — the owner's original vision sentence, on his actual life.
**Blemishes recorded:** DeepSeek name-slipped in one question (wrote "Val" for David's meeting — cosmetic); and the conflict catch came from the MODEL, because the code detector only matched identical start times (fixed below).

### "Does this need to be deterministic if the model catches it?" — the rubric
Peter challenged whether conflict detection needs code at all, since DeepSeek caught the overlap. Resolution — determinism is required when ALL of:
1. **Silent-miss harm** — a missed catch = real-world damage discovered too late (double-booked at 11:15), with nothing signaling the miss;
2. **Objectively computable** — the check is enumerable (interval intersection), not judgment;
3. **Floor-sensitive** — model-layer detection makes the feature's reliability silently track whichever model is in the swappable slot.
Model judgment remains the right layer for everything fuzzy: soft conflicts (back-to-back across town, travel time), topical connections, "you always run over with Val." Code guarantees the floor; the model provides the ceiling.
**The kicker that decided this case:** the system had ALREADY voted for deterministic — a code detector existed and the prompt declared it AUTHORITATIVE — but it compared start times for equality, so it missed the real overlap and DeepSeek freelanced around its own instructions to save the user. Worst possible configuration: prompt declares a wrong layer authoritative. Fixed: `findScheduleConflicts` (temporal/urgency.ts) does interval intersection, tested incl. the live case, back-to-back non-conflicts, and AM/PM handling.
**Status:** Live-proven. Remaining known gap: multi-day events / midnight-spanning intervals not handled (calendar output format doesn't produce them today).

## Prep Proposals: Never Ask a Model to Construct a Timestamp (July 7 2026)

### The whenISO failure — a rail violation caught by live testing
**Symptom:** the prep-proposal live check on real qwen3.5:9b returned an empty section. Raw output showed the model burned its ENTIRE 1024-token budget on prose reasoning about timezones ("If this is UTC, it's very late night in Europe...") and never emitted the JSON array. Unit tests (mocked model) were all green — the failure only exists with a real small model.
**Root cause:** the prompt asked the model to construct `whenISO` (an ISO-8601 timestamp with offset) from calendar text like "Wed, Jul 8 2:00 PM". That's date math + timezone reasoning pushed into the model — a direct violation of "code decides, model executes," written by the same session that documented the rail hours earlier. The builder blind spot is real.
**Fix (the on-principle shape):** CODE parses calendar lines into structured events (`parseCalendarEvents` — the regex already existed in briefing conflict detection) and does ALL time math in the configured timezone (`zonedDate`/`cronForDate`, two-pass Intl offset, DST-tested). The model now returns only `{event: <number>, action, reminder?: {minutesBefore: <integer>, message}}` — an index and an integer. Also fixed en passant: the original `isoToOneShotCron` built cron fields with server-local getters, but croner interprets expressions in the CONFIGURED timezone — worked only because the Mac's zone matches config.
**Result:** live PASS on deepseek-v4-flash first try — asked the intake question for a context-less meeting, proposed a memory-informed prep task, skipped the dentist, and the proposal was confirmed from a different channel alias (principal binding) with stored-params execution.
**Lessons:** (1) A model's output schema should never contain anything code can compute — every such field is a place for a small model to drown. (2) Mocked-model unit tests cannot catch "the model can't actually produce this" — every model-facing prompt needs one live-model run before it ships. (3) num_predict ceilings turn model rumination into silent empty outputs; prefer output shapes too small to ruminate over.

## Confusion Audit of the Autonomy System (July 6 2026)

### Fresh-eyes audit found 4 real bugs the builder couldn't see
**Context:** Peter: "I don't think we've created the best autonomous workflow, it feels confusing — even to me." A 4-agent audit (owner-UX / config-surface / mental-model lenses + synthesis) reviewed the just-built autonomy system with no stake in defending it. Verdict: the safety was sound, the SURFACE had three vocabularies for one concept and several interaction bugs.
**Bugs found and fixed same night:**
1. **"Reply with details" was structurally broken** — briefings were channel-sent but never appended to any session transcript, so a reply to a prep question dispatched into a session that never saw the question. Fixed: the delivered briefing is appended to the owner's session on the delivery channel (`category: 'briefing'` turn).
2. **Stale-proposal misfire** — loose confirm synonyms ("go ahead") matched the LATEST pending action, and briefing proposals live 12h; a casual "go ahead" hours later fired a morning proposal as a non-sequitur. Fixed: bare confirms only match entries `< BARE_CONFIRM_MAX_AGE_MS` (10 min) old on the same channel; long-TTL proposals require `confirm <id>`.
3. **"confirm 2" fell through to chat** — the id regex wants 6-12 hex chars, so a natural short reply matched nothing and routed to the model, which could hallucinate "Done!". Fixed: `CONFIRMATION_NEAR_MISS` catches confirm-verb + short token and replies with an error + the open-proposal list. ("confirm my flight booking" still routes to chat.)
4. **`!heartbeat no 2` renumbering drift** — partial removal rewrote the pending file (positions shift) while the owner's phone showed the old numbers; the next `no N` could delete the wrong fact. Fixed: the reply now prints the renumbered remaining list.
**Simplifications applied:** `ToolAutonomy {tier, reversible, blastRadius}` collapsed to ONE bit — `requiresConfirm?: boolean` — after the audit verified `reversible`/`blastRadius` were never read by enforcement and silent vs act_then_notify were behaviorally identical (tier labels live on in metric events, where they mean something). The dead `DispatchParams.confirmed` bypass flag (zero setters, shaped exactly like the hole the ledger closed) deleted. Config footguns now warn at load: restrictedTools/Categories with no trustedUsers (= applies to EVERYONE), tool in both confirmTools and autoApproveTools (autoApprove ignored).
**Deliberately NOT done (owner's call):** the full one-inbox unification (`ok N` / `no N` replacing hex ids + `!heartbeat yes/no` + free-text) — blueprint preserved in CONTINUATION.md for a future session.
**Lesson:** the builder of a multi-surface UX cannot audit its coherence — every concept feels earned to the person who added it. Fresh-eyes agents found in one pass what two nights of building never noticed, including one structurally-broken headline feature. Audit user-facing surfaces with reviewers who didn't build them, BEFORE shipping to the owner.

## Calendar Prep Proposals — First Proactive Autonomy Rung (July 6 2026)

### The briefing now proposes executable actions, not just insight text
**Decision:** A structured prep stage after the briefing CoT (`src/services/prep-proposals.ts`, config: `briefing.prepProposals`, default on): per upcoming event (48h window) the model chooses from a CLOSED action set — `question` (ask the user for context: "your 2pm with John — what's it about? I can prep notes or a reminder"), `reminder` (one-shot cron), `task` (task_add), or `none`. Code validates against the registry, does ALL date math (ISO→one-shot cron in `isoToOneShotCron` — the model only names a moment), builds the exact tool params, and records proposals in the pending-action ledger with a 12h TTL. The briefing lists them with `confirm <id>` handles. NOTHING executes unconfirmed.
**Why this shape:** Peter's stated flow — "the agent can be like: hey, there isn't enough information, is there anything you want to tell me that I can help preparing?" The question action IS the intake/clarification flow, applied to calendar first. Model fills bounded slots; code owns the envelope — same inversion of control as everything else.
**Supporting changes:** ledger got id-targeted confirmation (`confirm 3fa2c1b9` — briefings propose several), channel binding on bare confirms (generic sender ids like "console-user" could collide across channels), per-entry TTL (10min interactive / 12h briefing), and confirmed actions now write to the session transcript. `!autonomy` command renders the per-action track record + promotion candidates (≥20 decided outcomes at ≥95%) + open proposals.
**Gotcha — one-shot cron didn't exist:** a 5-field expression like `30 8 7 7 *` fires EVERY YEAR. Any "remind me tomorrow" reminder would have haunted the owner annually — a pre-existing bug in every reminder flow, exposed by this feature. Added `once: true` to CronJob: the service disables the job after its first successful run. cron_add accepts it; prep reminders always set it.
**Gotcha — briefing prompt says "NEVER ask questions":** deliberate for the one-way insight; the prep section is a separate structured call so questions live there without softening the main update's rules.
**Deferred to next rungs:** gmail in the briefing context (needs a slice decision), research/agenda-doc prep offers, promotion application from the command (kept manual by design — the bot should not edit its own security config), reply-context threading (v1: the user's answer is a normal message; the briefing text above it carries the context).
**Status:** Built + unit-tested (472 tests). Needs a live briefing run to validate end-to-end.

### Memory floor tuned on real data + a fragmentation finding
**Decision:** Injection floor 0.55 → 0.52. Measured on the real corpus (`scripts/memory-floor-check.ts`): noise clusters ≤0.49, genuine signal starts ~0.546 on qwen3-embedding — 0.55 was clipping the best fact in a relevant query (sim 0.546, imp 4).
**Finding (evidence for the cross-channel sessions roadmap item):** facts are fragmented across channel sender ids — 55 of 64 live under the Telegram id, 5 under Discord, rest scattered. On Discord, memory search sees 8% of the owner's knowledge. Identity mapping is now measurably the biggest memory-quality lever, bigger than any scoring change.
**Status:** Floor active. Fragmentation unaddressed (roadmap: cross-channel sessions).

## Small-Model Hardening + Bounded-Autonomy Gates (July 5-6 2026)

A full-codebase assessment (four parallel research passes: tool-loop, router/pipelines, memory/context, autonomy surface) concluded the architecture was sound and the gaps were implementation-level: tolerant layers with bugs, gates that existed but weren't applied uniformly, budgets computed against the wrong numbers. One session, 9 commits (b54742f..be5fe4a), each independently revertable. 451 tests after (was 389).

### One tool-calling convention per model (`toolStyle`)
**Decision:** Specialists get `toolStyle: 'native' | 'text'` (schema.ts, default native). Native passes tools via the API field ONLY — no tool text block, no `Action:` format rules in the prompt. Text is the inverse: prompt-described tools, nothing passed natively. Never both.
**Why:** The prompt previously taught the text `Action: tool[{json}]` convention *while* native tools were also active — two contradictory formats, and small models mixed them mid-loop. It also doubled tool overhead (~5K tokens of tool text on a full set, duplicated by the native template). Measured live: text mode costs ~950 more prompt tokens than native *with one tool*.
**Kept:** ALL fallback parser dialects (DSML, `<invoke>`, `Action:`, JSON5 ladder) stay active in both modes — they're the safety net that keeps arbitrary models usable, not part of the convention choice.
**Status:** Active, default native. Verified live on qwen3.6:35b in both modes (tools called, params well-formed). Watch item: native-mode qwen3.6 sometimes writes its deliberation into the final answer instead of the requested format.

### Grammar-constrained decoding (`format`) with automatic fallback
**Decision:** Structured tasks pass a JSON schema via Ollama `format` / vLLM `guided_json`: param extraction, `llm_branch`, router classification (enum of valid categories), research claim extraction (`CLAIMS_JSON_SCHEMA`). Every call site falls back to prompt-only on backend rejection; the extractor caches the rejection in a module flag so only the first call pays the failed round-trip.
**Why:** Kills the malformed-JSON failure class at the token level instead of repairing after the fact — the single biggest "raise the floor for 7-14B models" lever available.
**Gotcha — the gateway silently swallows it:** the custom FastAPI gateway types `format: str`, so schema objects 422 and even `format: "json"` is accepted-then-discarded (proof: phi4 returned markdown-fenced output, impossible under real JSON mode). Root cause per the gateway team's own review: their internal normalization layer drops any field it doesn't model — same bug family also hardcodes `num_ctx: 32768` (silently clamping our 131K → system prompt truncates first) and discards `keep_alive` (models go cold between calls; observed 0.2s-8s latency swings on phi4 in one sequential run). Fix is theirs: "normalize what you police, pass through what you don't." See GATEWAY-REQUIREMENTS.md for the contract + acceptance tests. Until it lands, constrained decoding is dormant and the fallbacks carry.
**Status:** Active in code, blocked on gateway for effect. Re-run GATEWAY-REQUIREMENTS acceptance tests 1a/1b when their passthrough refactor lands.

### Extraction: degrade-not-abort
**Decision:** `extractParams` parses with JSON5 before burning a repair call (trailing commas/single quotes are free now); validates required/enum/coercion post-parse and feeds specific errors into the repair prompt; prefers best-effort params over throwing; `ExtractStage` gained an optional deterministic `fallback(ctx)` (web_search falls back to the raw message as the query). Cron expressions are validated with croner in `cron_add`/`cron_edit` BEFORE persisting.
**Why:** Extraction failure previously aborted the entire pipeline (`executor.ts` converted any stage error into a full abort). Invalid cron expressions were stored and silently never ran.
**Status:** Active.

### Research correction: code-driven sentence splice (whole-report rewrite removed)
**Decision:** `locateClaimSentence` (token-overlap fuzzy locate; skips Sources/headings/chart placeholders; ≥0.5 threshold — skip rather than splice the wrong sentence) finds each flagged claim's sentence; the model rewrites ONE sentence; code splices it back with sanity bounds. The whole-report `correctionPrompt`, its 0.7-length guard, and the strikethrough-stripping band-aid on the output path are gone.
**Why:** "Edit these sentences, preserve 3000 other words verbatim" was the hardest task in the system for a small model — the strikethrough hack and length guard existed *because* it kept misbehaving. Now the report body is never handed to a model for wholesale rewriting.
**Status:** Active. Needs a live research run for end-to-end confirmation.

### Pending-action ledger — confirmations execute stored params
**Decision:** `src/security/pending-actions.ts`: confirmTools previews record `{id, tool, params, sender, channel, agentId, sessionKey, expiresAt}` to a file-backed ledger. "Confirm" executes the STORED call — sender-bound, single-use, 10-minute expiry. Wired into both dispatch paths' previews, the orchestrator confirm handler, and console `chat.ts`. The old `confirmed: true` re-dispatch arming is removed.
**Why (three real holes):** (1) confirmation previously set a flag for the *entire* re-dispatch and the model *regenerated* params — nothing guaranteed the executed call matched the preview; "go ahead" in any context armed whatever the model decided next. (2) Pipelines built their executor with NO confirm wrapper — the `message` pipeline could send with the gate configured. (3) The console path had no confirm detection at all: on Web the gate was a dead-end that could never release.
**Status:** Active, Tier-3 test coverage (sender binding, single-use, expiry, exact-params). Live channel walkthrough still pending. Known gap: ledger-confirmed actions aren't written to the session transcript.

### Tool autonomy metadata + `autoApproveTools` promotion lever
**Decision:** `LocalClawTool.autonomy?: {tier: silent|act_then_notify|propose_confirm, reversible, blastRadius: self|owner|external}`. Effective confirm set = channel `confirmTools` ∪ metadata `propose_confirm` tools − channel `autoApproveTools` (explicit confirmTools always wins over a promotion). `send_message` starts at propose_confirm/external — the ladder's rule that anything visible to others starts gated. Cron pre-authorization: an owner-scheduled exec/message job waives the metadata gate for its category tool only (the schedule IS the approval; nobody is present to confirm at run time).
**Why:** Tier assignment was per-channel name lists — a new tool defaulted to *ungated*. Now the ladder is structural and per-channel promotion (`autoApproveTools`) is the earned-leash mechanism, backed by `logAutonomousAction` metrics (every heartbeat auto-action, cron run, stale-fact proposal, and ledger confirmation logs action/tier/source/reversible/outcome — the track record promotions cite).
**Also:** cron dispatches only get `exec`/`send_message` when the job's category is exec/message — a web_search cron job whose fetched page contains an injected "run this / message X" has no tool to reach for. Heartbeat stale-fact deletion (model-judged, 40-char prefix match, un-itemized) demoted to propose-and-confirm via the existing `!heartbeat yes/no` review file.
**Status:** Active. ~29 tools still need annotations (pattern in send-message.ts). Promotion tooling (metrics reader) not built yet.

### Memory injection: relevance floor
**Decision:** Vector KNN injection requires raw cosine similarity ≥ 0.55; contextual facts capped at 3; multi-hop traversal only fires when ≥1 result passed the floor but results are sparse.
**Why:** Multi-signal scoring (`sim*0.5 + recency*0.2 + imp*0.3`) only ORDERS results — a fresh imp-5 fact scored 0.5 with zero query relevance, so identity facts injected on every turn regardless of topic (small-model topic-drift trap). Multi-hop previously fired exactly when KNN found *nothing* relevant — adding tangential facts when they'd be most distracting.
**Rejected for now:** reranker/cross-encoder — monitor the floor first (per the standing "no complexity before evidence" stance).
**Status:** Active. Floor value untested against real recall feel — tune in `buildUserPriming` before adding anything smarter.

### Context budget: charge the real prompt
**Decision:** `computeBudget` accepts `extraSections` (serialized tool defs, statePreamble, userPriming); dispatch re-budgets AFTER classification with the actual specialist prompt and trims oldest history turns to fit (`trimHistoryToFit`). `estimateTokens` uses ~3 chars/token for punctuation-dense segments (JSON/URLs).
**Why:** The pre-classification budget used an empty system prompt and ignored tool definitions entirely — historyBudget was overestimated by 3-6K tokens for exactly the tool-using calls that matter, starving 8-16K models. The old 4-chars/token estimate *under*-counted JSON-heavy tool observations, risking silent prompt-head truncation.
**Status:** Active.

### Router: enforced timeout + fallback fixes
**Decision:** `config.router.timeout` is now actually enforced (Promise race → keyword fallback; the abandoned request's result is discarded). Config raised 2000→8000ms. Keyword fixes: bare `workspace` removed from the config pattern (it captured "run ls in the workspace"), ls/pwd/chmod added to exec hints, live-value lookups ("current price of X") fall back to web_search. Blanket URL→website override narrowed to bare-URL-only (short remainder, no other intent verbs) — "research X, start from <url>" no longer hijacked to a page summary.
**Why the config bump:** the 2000ms was FICTION — never enforced, so nobody knew phi4 actually takes 0.2-8s through the gateway (variance from the keep_alive drop above). Enforcing 2s for real would have starved the model path entirely. Lesson: enforcing a previously-advisory limit requires re-measuring reality first.
**Status:** Active. Live: 15/16 on real phi4 (`scripts/router-live-check.ts`; the miss is "turn this analysis into a PDF report" → multi instead of document — judgment call, logged not chased).

### The EHOSTUNREACH saga — two wrong theories, then macOS TCC
**Symptom:** Live checks "flapped": node got connection failures against the gateway mid-run, repeatedly, while curl probes succeeded moments later.
**False starts (both disproven):** (1) "gateway drops connections under sequential load" — reported to the gateway team, later retracted. (2) "big-model cold load crashes the gateway" — disproven when a small warm model failed identically. The kill shot: **simultaneous** curl → 200 and node → `EHOSTUNREACH`, same literal IP, same box; then the matrix (node LAN ✗ / node internet ✓ / python LAN ✓ / curl LAN ✓).
**Actual root cause:** macOS Local Network privacy silently denies LAN access to third-party binaries (homebrew node) spawned from SSH sessions (incl. VS Code Remote) — there's no GUI app to attribute a prompt to, so it's deny-with-no-error, presenting as a routing failure. Apple-signed binaries and already-permitted apps pass, which is why every counter-probe "worked."
**Fix:** tmux server started once from local Terminal.app (which has the permission); everything spawned inside inherits it. `tmux send-keys -t lab '…' Enter` + `capture-pane` gives sessions like this one full live-test access. Recreate after reboot.
**Lessons:** (1) When probes contradict each other, run them *simultaneously from the same context* before theorizing — the same lesson as the BLS 403 entry below, relearned at the network layer. (2) An intermittent failure that only hits one binary is a permissions/attribution problem, not a load problem. (3) Don't ship a bug report to another team until the failing client and a working client have been diffed.

---

## Coding Agent Swap: OpenCode → Pi/picoder (June 26 2026)

### Replaced OpenCode with the Pi coding agent for `code_gen`
**Decision:** The `code_gen` pipeline now drives **Pi** (`@earendil-works/pi-coding-agent`, "picoder") via its headless CLI instead of OpenCode. New `pi_build` tool (`src/tools/pi-build.ts`); `opencode-build.ts`, `@opencode-ai/sdk`, and the `openCode` config block are removed.
**Why:** Pi fits the local-first/model-agnostic thesis better and kills OpenCode's operational pain. OpenCode required a **manually-started server** (`opencode serve`), kept a **global session DB** that carried stale context across restarts, and had a **snapshot/move hack** (old project dirs got swallowed). Pi runs **cwd-scoped** (every write lands in `builds/<slug>/`, which also structurally prevents the package.json-overwrite class of bug — no prompt-based directory constraint needed) and is invoked headless per-build (SDK / `-p` / RPC), so there's **no daemon and no global state**. Model is `provider/id` from `~/.pi/agent/models.json` (currently `vllm/deepseek-v4-flash`).
**Gotcha 1 — stdin hang:** Pi's `-p` print mode reads stdin to merge piped input. Spawned with an inherited/open stdin pipe it blocks forever waiting for EOF. Fix: `spawn(..., { stdio: ['ignore', ...] })` so it gets immediate EOF. (An interactive-shell run worked because stdin was a TTY — the bug only showed when spawned.)
**Gotcha 2 — scoped-executor authorization:** the `code_gen` *specialist's* allowed-tools list still named `opencode_build`, so the scoped executor blocked `pi_build` as unauthorized — invisible to tsc/unit tests, only caught by a live dispatch run. Lesson: a tool swap must update the specialist `tools` allowlist in config, not just the pipeline + registration.
**Gotcha 3 — test-gate false-negative:** `runTests` hard-failed on a non-zero `pip install` exit (the `.venv/bin/pip` script flaked while the venv was actually healthy), so a correct build (102 passing tests) got labeled "tests failing." Fix: use `python -m pip` (not the pip script), and **run the tests even if install exits non-zero — judge the gate on the actual test result, not the install exit code.** The test outcome is the source of truth; a real missing-dep surfaces as a test/import failure anyway.
**Loop shape:** enrich → `pi_build` (cwd-scoped) → verify (tests = the gate) → [fix: re-run Pi in the dir with errors] → re-verify → **commit** (local git autonomous; remote GitHub push opt-in, off by default — the autonomy-ladder split: reversible/internal acts silently, visible/irreversible is gated) → report.
**Status:** Active. Verified end-to-end through live dispatch (built a Roman-numeral package, self-repaired, committed). The "OpenCode integration" entries below are retained as history (superseded).

## Verification False Negative from a Stale Truncation Cap (June 17 2026)

### A research report's real, correctly-cited BLS numbers were stamped UNSUPPORTED (fixed)
**Symptom:** A labor-market report (DeepSeek) presented `172K payrolls / 4.3% / leisure +70K` citing `[2]` BLS, while its own Verification appendix marked the sector figures **UNSUPPORTED**.
**False starts (both disproven by actually reproducing the fetch):** First guess was an over-aggressive entailment judge; a worse second guess (logged here yesterday, now deleted) was that `bls.gov` **403-blocks** the fetcher so the model misattributed secondary numbers to BLS. BOTH WRONG. The 403 came from *Claude's own WebFetch tool* — a different client. Running the pipeline's actual `web_fetch` (User-Agent `LocalClaw/1.0`) returns BLS **200, 6K-char extract**, and it **contains every figure**. The numbers are real, genuinely in BLS, and **correctly cited** — no block, no misattribution, no hallucination.
**Actual root cause (proven from the run's `verification.json` + char offsets):** `entailmentPrompt`/`tier1JudgePrompt` sliced each source to `text.slice(0, 3500)`. The BLS sector table sits at offset ~3976–4327 in the 6K extract. So **every figure before char 3500 verified; every figure after 3500 came back UNSUPPORTED** ("None of the provided sources state…") — the judge literally never saw them. A second small-context artifact compounded it: the research pipeline forced `web_fetch maxChars: '6000'`, overriding the tool's 30K default, so the cache only held 6K of each page.
**Fix (general, no site-specific anything):** Both caps are small-context-era relics — DeepSeek serves 256K, a fetched page is ~1.5K tokens. (1) Pass the FULL cached source to the judge (removed the `slice(0, 3500)` in both prompt builders). (2) Drop the forced `maxChars: '6000'` so research uses the tool's config default (30K) — full pages get cached. No relevance-window cleverness, no block-detection markers — both were rejected as solving a non-problem / hardcoding for one case.
**Lesson (reinforced, hard):** Reproduce the program's *exact* behavior before theorizing — a tool's 403 ≠ the pipeline's fetch. Two wrong theories died the moment the real `web_fetch` was run. Also: when a model gets *bigger context*, audit for old rationing caps (`slice`, `maxChars`, `MAX_*`) that silently throw away data the model could now hold.
**Known separate issue (flagged, not fixed):** the BLS *PDF* `[1]` fetches as raw `%PDF` binary (PDFs aren't parsed) and passes the weak `valid` filter (`!startsWith('Error') && len>120`) → a junk source. Didn't cause this failure, but raising `maxChars` caches more of the garbage. Candidate: a general "is this text" guard (binary/empty), NOT a block-marker list.
**Status:** Fixed (truncation caps removed). Live re-run on restart should flip the sector claims to VERIFIED.

## Foreground Model Swap: MiniMax-M2.7 → DeepSeek-V4-Flash (June 2026)

### Swapped the foreground reasoning tier to DeepSeek-V4-Flash (June 2026)
**Decision:** Foreground reasoning (chat + all foreground specialists + `reason` tool + briefing/heartbeat synthesis) now runs on **DeepSeek-V4-Flash** (vLLM on the Spark, served id `deepseek-v4-flash`, 256K context), replacing MiniMax-M2.7. Vision stays on qwen3.6:27b — DeepSeek is text-only, same as MiniMax.
**Why:** Markedly better output than the prior local-model era. The swap was config + two small code changes — the pipelines, memory graph, and channels were untouched. This is the second foreground swap (qwen → MiniMax → DeepSeek) done purely through the `MultiBackendClient`, and it's the working proof that the foreground model is a *slot*, not a dependency: each model's per-call job stays small enough that a big model raises the ceiling without becoming the floor.
**Gotcha 1 — DSML tool-call dialect:** DeepSeek narrates tool calls as text in its own `<｜DSML｜invoke name="…"><｜DSML｜parameter …>` dialect when no native `tools` are passed. The parser (`src/tool-loop/parser.ts`) strips the `｜DSML｜` (U+FF5C) markers so it normalizes to the existing `<invoke>`/`<parameter>` handling, and tolerates extra param attributes (`string="true"`).
**Gotcha 2 — empty completions on small `max_tokens`:** reasoning tokens count against `max_tokens` on the vLLM path. Verification stages pass `num_predict` 400-700 as the *answer* budget, which DeepSeek's reasoning consumed entirely → truncated before any answer → empty `content`, silently gutting the stage. Fixed by reserving reasoning headroom (`+4096`) on `max_tokens` in `OpenAICompatClient`, plus a warn when a completion returns empty with `finish_reason: length`.
**Status:** Active. The MiniMax entries below are retained as history (superseded by this swap).

## Multi-Backend Inference & MiniMax Swap (June 2026) — superseded by DeepSeek-V4-Flash swap above

### vLLM backend, additive (June 2026)
**Decision:** Add OpenAI-compatible inference (vLLM serving MiniMax-M2.7) alongside Ollama, not replace it.
**How:** `MultiBackendClient extends OllamaClient` routes `chat`/`chatStream` to `OpenAICompatClient` when the model id matches `inference.backends[].models`, else falls through to Ollama. `embed`/`generate`/`listModels` always use Ollama. Drop-in — every `client: OllamaClient` call site is unchanged.
**Translation handled in OpenAICompatClient:** `options.{temperature,top_p,num_predict}`→top-level; tool-call `arguments` string→object (vLLM returns a JSON string, Ollama an object); `tool_call_id` stitched onto tool-result messages (OpenAI requires it, the ReAct engine doesn't emit it); SSE streaming; `usage`→`eval_count`/`prompt_eval_count`.
**Status:** Active.

### Model split: foreground on Spark, utility on A5000 (June 2026)
**Decision:** MiniMax-M2.7 (vLLM, Spark) for all foreground specialists + chat + multi + the `reason` tool. qwen3.6:27b (A5000 gateway) for vision + briefing + heartbeat (background). phi4/phi4-mini/qwen3-embedding stay on the gateway (router/NER/extraction/embedding). qwen2.5:7b stays for the voice fast-path; whisper/flux unchanged.
**Why:** MiniMax reasons far better than qwen3-coder:30b/gemma4:26b; the hardware split keeps the Spark free for foreground while the A5000 handles small/modality models. Vision can't move to MiniMax (text-only) — qwen3.6:27b is multimodal and covers it.
**Gotcha:** the `reason` tool's model lives in its own `reasoning` config block and was missed in the first swap pass — it pointed at a non-existent `nemotron-3-nano:30b` and hung every forced-reasoning pass on a timeout loop. Fixed to MiniMax. Lesson: model strings live in several config blocks (specialists, reasoning, vision, voice, briefing, heartbeat, opencode) — swap them all.
**Deferred:** OpenCode `defaultModel` stays `ollama/qwen3-coder:30b` — its `provider/model` slash-split collides with MiniMax's slashed id (`cyankiwi/MiniMax-...`); needs its own provider wiring.
**Status:** Active.

### Context window raised to 128K (June 2026)
**Decision:** `session.contextSize` 32K→131072; added optional per-specialist `contextSize` override.
**Why:** 32K forced compaction every message. MiniMax serves 192K. The global value drives the compaction budget (safe to raise — router/vision/embedding set their own `num_ctx`; MiniMax ignores `num_ctx` since vLLM fixes context at launch). Per-specialist override is the lever to *lower* context for any future small-context Ollama specialist.
**Status:** Active.

## Memory Integrity (June 2026)

### FactStore importance-aware char bound (June 2026)
**Problem:** Root-caused a real data loss — the user's wife's name (and other imp-4/5 family facts) lived in USER.md + historical raw extractions but were absent from facts.json and the graph. `enforceCharBound` capped facts.json at 3000 chars (~12 facts) and evicted the *lowest-confidence* facts, ignoring importance — so a critical identity fact with moderate confidence got dropped before an ephemeral high-confidence one. Logs showed "trimmed 92 low-confidence facts."
**Fix:** Eviction orders by importance first, confidence as tiebreak; imp≥4 never evicted; `MAX_FACTS_CHARS` 3000→20000.
**Status:** Active. Backfill of historical facts into the graph deliberately NOT automated — the raw set contains time-sensitive/sensitive personal facts (a pregnancy, a hospitalization, a pet's death) and contradictions; re-asserting them as current is a user decision.

### Graph provenance edges wired (June 2026)
**Problem:** `EXTRACTED_FROM` and `SUPERSEDES` were defined in the schema but never created (live graph showed 0 of each). `addFact`'s `sourceSession` was optional and no caller passed it; the contradiction check set `superseded=true` but created no edge.
**Fix:** Session key threaded through all `addFact` callers (heartbeat, !save, memory_save); SUPERSEDES edge created (new→old) after the new Fact node exists.
**Status:** Active.

## Model Evaluations

### Gemma4:26b for chat (May 2026)
**Context:** Chat was on qwen3.5:9b (thinking model). Analysis of conversation transcripts revealed the model self-prompting — asking follow-up questions then answering them in the same turn via `<think>` blocks. The orphaned `</think>` tags were also leaking into continuation context previews.
**Decision:** Switched chat to gemma4:26b (MoE, 3.8B active / 25.2B total). Kept qwen3-coder:30b for tool-calling specialists.
**Why gemma4 for chat:** MoE architecture means only 3.8B active params → faster tok/s than the dense 9B qwen, while being a smarter model overall. DGX Spark hardware gives better throughput. No self-prompting artifacts. Cleaner conversational output.
**Sampling:** Per Gemma 4 best practices: temperature=1.0, top_p=0.95, top_k=64.
**Note:** Gemma 4 docs explicitly say "No Thinking Content in History" for multi-turn conversations. The thinking preservation in transcripts still benefits qwen3 specialists (tool-loop reasoning chains), but gemma4 chat sessions should have thinking stripped from history.
**Status:** Active for chat. qwen3-coder:30b remains for all tool-calling specialists.

### Gemma4:26b as specialist replacement (April 2026)
**Tried:** Swapped qwen3-coder:30b for gemma4:26b as the specialist model. Benchmarks showed 85% on agentic tasks vs qwen3-coder's 65%.
**Result:** Tool calling worked, but tool **sequencing** was worse. Model answered before using tools, wandered to irrelevant sites, didn't complete multi-step chains. Reverted after testing.
**Lesson:** Benchmarks don't tell you about tool sequencing discipline. A model can call tools correctly in isolation but fail at knowing when to stop talking and start calling.
**Status:** Under re-evaluation now that Ollama has updated. gemma4:26b stays available for future testing pipeline-by-pipeline.

### qwen3.6:35b for briefing (May 2026)
**Tried:** Swapped qwen3-coder:30b for qwen3.6:35b on the briefing reasoning pass.
**Result:** Immediate quality improvement. No fabricated events, respects pre-labeled data, cleaner synthesis, less filler.
**Gotcha:** qwen3.6 defaults to thinking mode, which consumed the entire `num_predict` budget leaving content empty — same root cause that killed nemotron earlier (see "Low num_predict starving thinking models"). Fix: bumped `num_predict` from 1024 to 8192.
**Status:** Active. Briefings now run on qwen3.6:35b.

### Nemotron for briefing (April 2026)
**Tried:** Used nemotron-3-nano:30b for briefing CoT reasoning.
**Result:** All output went into `<think>` tags with nothing outside. Empty briefings delivered.
**Root cause (discovered later):** Likely the same `num_predict: 1024` starvation issue — see "Low num_predict starving thinking models" below. Nemotron is a thinking model that uses internal reasoning tokens. At 1024, it spent all tokens thinking and produced no visible output. The model may have worked fine with adequate headroom.
**Status:** Switched to qwen3-coder, then to qwen3.6. Worth re-evaluating with `num_predict: 8192`.

### phi4-mini as smart router (April 2026)
**Tried:** Used phi4-mini for short messages mid-conversation to save latency.
**Result:** Produced "As an AI developed by Microsoft" responses. Also broke mid-conversation routing by classifying follow-up messages as new intents.
**Lesson:** Smart routing based on message length is fragile. Short messages mid-conversation need context, not a cheaper model.
**Status:** Removed entirely. All routing goes through phi4:14b.

### Low num_predict starving thinking models (May 2026)
**Problem:** Multiple models (nemotron, qwen3.6) produced empty or truncated output. We blamed the models and swapped them out.
**Root cause:** `num_predict: 1024` was too low for thinking models. These models use internal reasoning tokens (think tags) before producing visible output. At 1024 tokens, the model spent its entire budget thinking and had nothing left for the actual response.
**Impact:** Nemotron was wrongly dismissed for briefings. qwen3.6 initially appeared broken. Any thinking model evaluated under these constraints was handicapped.
**Fix:** Bumped briefing `num_predict` to 8192. Gateway updated to surface thinking content as fallback when content is empty.
**Lesson:** Before blaming a model's capability, check if you're giving it enough room to work. Thinking models need headroom for internal reasoning on top of the output tokens. Audit `num_predict` values when onboarding any new model.

---

## Architecture Decisions

### Thinking preservation in transcripts (May 2026)
**Problem:** Models that emit `<think>` blocks had their reasoning stripped before storing in session transcripts. On subsequent turns, the model only saw its own terse answers — not the reasoning chain that produced them. Quality degraded over multi-turn conversations as the model lost context about _why_ it said what it said. Session state (known facts, open questions) was a poor substitute for the model's actual internal reasoning.
**Decision:** Store raw model output (with thinking blocks) in the transcript. Strip thinking only at display boundaries: channel delivery, graph memory turns, session state updates, continuation context previews, handoff summarization, and when feeding transcript content to other LLMs (compactor summarizer, semantic extractor, fact extraction).
**Why not strip everywhere:** The model benefits from seeing its own reasoning on subsequent turns — it maintains coherence and builds on prior analysis. But other LLMs that consume transcript content (summarizers, extractors) shouldn't see nested thinking blocks.
**Also fixed:** Orphaned `</think>` regex was unlimited (`[\s\S]*?`) — tightened to `{0,500}` to prevent eating half the response if a stray `</think>` appears deep in the text. Added Gemma 4 thinking format (`<|channel>thought\n...<channel|>`) to all strip functions.
**Also added:** `num_ctx` passthrough from `config.session.contextSize` to Ollama via `buildOllamaOptions()` and bare chat options — ensures Ollama allocates enough context for the larger history.
**Status:** Active.

### Exec pipeline vs ReAct loop (April 2026)
**Tried:** Removed the exec pipeline to let the model reason freely about 6 exec tools in a ReAct loop.
**Result:** Model used 8 steps for `ls data` -- called exec correctly but then tried `find`, `chmod`, `which` before stopping. Massive over-exploration.
**Lesson:** Local models can't self-regulate in open-ended tool loops for simple tasks. Pipeline for simple commands, ReAct for complex multi-tool tasks.
**Status:** Exec pipeline restored.

### Sticky routing evolution (April-May 2026)
**Original problem:** Sticky routing kept follow-up messages on the same specialist across all categories. Fixed: restricted to chat/memory only.
**Second problem (May 2026):** Broad keyword hints ("what is", "who is") broke sticky for casual questions. "What are the privacy implications of NotebookLM?" triggered web_search keyword hint → broke sticky → model classified as research/multi → full report instead of chat.
**Third problem:** Even when sticky held, the model classifier could override it. Conversational messages with technical keywords got classified as research/multi/web_search.
**Fix (keyword hints):** Removed "what is" and "who is" from web_search keyword hint. These are questions, not search actions.
**Fix (dispatch guard):** Added dispatch-level conversational guard: if classified as non-chat but session has prior turns (turnCount > 0) AND message has no explicit task intent (create, search for, generate, etc.), downgrade to chat. Catches ALL pipeline misroutes from conversational context — research, multi, web_search, everything.
**What breaks through:** Explicit task intent always wins — "search for X", "create a report", "generate an image". Pre-model overrides (calendar, email, PDF) still fire. First messages (no session) unaffected. Cron jobs unaffected.
**Status:** Active. Three layers: keyword tightening + task intent check for long messages + dispatch-level guard.

### Session isolation for pipelines (April 2026)
**Decision:** All pipeline dispatches (plan, research, exec) run with fresh context -- no parent session history.
**Why:** Research results were being biased by prior conversation topics. A research task about "AI news" would incorporate topics from a prior chat about healthcare because the session history was shared.
**Status:** Active. Context isolation is enforced for all pipeline dispatches.

### Code-driven temporal intelligence (May 2026)
**Decision:** Task urgency and calendar day labels computed in TypeScript, not by the model.
**Why:** qwen3-coder said "264 days remaining, requiring attention soon." It showed events on wrong days. It couldn't distinguish events from deliverables. Three separate prompt rewrites failed to fix it.
**Lesson:** If a model fails at something deterministic after 3+ prompt attempts, move it to code. The model's job is synthesis, not arithmetic.
**Status:** Active. `src/temporal/urgency.ts` handles all temporal reasoning. Model receives pre-labeled data with authoritative tags.

### Heartbeat: code curates, model reasons (April-May 2026)
**Decision:** Heartbeat uses snapshot-based fact diffing (code) then sends structured diff to LLM for reasoning. Task board uses urgency tiers (code) then sends pre-labeled board to LLM for summary.
**Why:** Original approach let the model search memory randomly -- each run surfaced different facts with different formatting. Plan pipeline heartbeat matched wrong skills (137 inflated success count on one skill). Model-driven task board said everything was urgent.
**Lesson:** Code handles the "what" (which facts changed, which tasks matter). Model handles the "so what" (what does it mean, what's connected).
**Status:** Active. Pattern applied to both memory and task board.

### Hallucination detector: verb-aware (May 2026)
**Decision:** Hallucination detection now checks claimed action verbs against actual tool calls made.
**Why:** Image generation tool took ~60 seconds. After the tool completed, the model summarized "I've generated the image." Detector flagged this as hallucination (model claiming action without tool call), triggered a repair prompt, model generated the image a second time.
**Lesson:** "Claims action without tool call" needs context -- if the model DID call the tool, its summary is legitimate.
**Status:** Active. `TOOL_ACTION_VERBS` map in `src/tool-loop/engine.ts`.

### [FILE:] token flow (March 2026)
**Decision:** File tokens stripped from model observations before model sees them, collected, re-appended after final answer.
**Why:** Model rewrites `[FILE:path]` into fake markdown links like `[Download report](path)`. Once the model touches the token, the path format breaks and media extraction fails.
**Status:** Active. Two strip points: tool-loop engine (observations) and plan pipeline (before summarization LLM).

---

## Failed Approaches

### Phone call integration (April 2026)
**Explored:** macOS Continuity for intercepting phone calls, BlackHole audio routing for system audio capture.
**Why abandoned:** No public API for macOS Continuity calls. BlackHole routing is fragile and requires manual audio config. Twilio Media Streams is the clean path but adds cost.
**Conclusion:** Shelved. Better use case is business appointment scheduling, not personal call handling.

### Skill matching catching everything (April 2026)
**Problem:** The skill "generate-report-from-web" matched 73 consecutive heartbeat dispatches, inflating to 137 success count.
**Root cause:** Skill matcher thresholds too low, no exclusion for system operations.
**Fix:** Threshold raised to 8, 30% keyword ratio required, success bonus capped at +2, heartbeat dispatches skip skill check/save entirely.

### Briefing on heartbeat cron (April 2026)
**Problem:** Briefing was triggered inside the heartbeat cron (even hours). The briefing wanted to run at 8am, 1:15pm, 5pm -- which never aligned with even-hour heartbeat runs.
**Fix:** Separated briefing into its own cron schedules. Heartbeat and briefing are independent systems.

### Memory facts surfacing irrelevant context (April 2026)
**Problem:** User priming injected LLC/career facts during a health conversation. Briefing memory search pulled colonoscopy info into every daily briefing.
**Fix (priming):** Changed header to "Background context (do NOT reference unless directly relevant)."
**Fix (briefing):** Added explicit rule: "Calendar is the ONLY source of truth for events. NEVER invent or recall events from memory."
**Lesson:** Broad memory search queries like "recent activity decisions context" pull everything. The model can't filter relevance -- it tries to use everything it sees.

### Memory system overhaul: flat store to graph database (May 2026)

**Problem:** The JSONL-based FactStore accumulated 14 near-duplicate facts about the same topic. Layered dedup defenses (hash, substring, embedding similarity) were individually weak. Memory facts only surfaced in briefings, never in conversations. No relationship modeling between facts.

**Evolution (Phases 1-4 on flat store):**
1. Embedding dedup on write (cosine > 0.85 rejected via qwen3-embedding)
2. Importance tiers (1-5) driving TTL and retrieval priority
3. Auto-injection: embedding search on every message, contextually relevant facts silently injected into specialist context
4. Extraction awareness: existing facts shown to extraction LLM to prevent re-extraction

**Decision: FalkorDB graph database (Phase 5)**

Replaced the flat JSONL fact store with FalkorDB — a Redis-compatible graph database with native HNSW vector search.

**Why FalkorDB over alternatives:**
- vs Neo4j: Free (MIT-adjacent), ~85MB vs 2.6GB memory, sub-ms lookups, native vector search. Neo4j Community can't cluster.
- vs SQLite (existing EmbeddingStore): No graph traversal, no relationship modeling, brute-force vector search.
- vs Memgraph: Lacked native vector search at time of evaluation (has since added it).

**What the graph enables that flat storage can't:**
- SUPERSEDES edges: fact evolution with history ("ML engineer" → "Senior ML engineer")
- Temporal queries: "what did I know last month?" via createdAt filters + SUPERSEDES chain
- Multi-hop reasoning: traverse shared entities to find connected facts (DevMesh → AI → career fair)
- Community detection: clusters of related facts by entity co-occurrence (work cluster, health cluster, hobby cluster)
- Native vector KNN: O(log n) via HNSW index, not O(n) brute-force

**Infrastructure:** FalkorDB runs in Docker on the Mac Mini alongside LocalClaw. ~85MB for the graph at current scale (~1,067 nodes).

**Status:** Fully integrated. Auto-injection, memory tools, and migration complete.

**Early results (May 10, 2026):**
- Cookie preference test: bot knew "soft chocolate chip cookies with precise measurements" without being asked
- FalkorDB discussion: bot held multi-turn technical conversation, correctly pulled user's ML engineer role and DGX Spark setup from graph memory for context
- Migration dedup: caught 2 paraphrased duplicates during 23-fact migration that flat store had missed
- Narrated tool call detection: added to capability gap detector after chat faked a `[brave_search()]` call
- Personalized conversation: "What would you like to talk about?" → bot built a menu from graph memory (open-source models, DGX Spark, edge AI, Long Island events, System Prompt podcast). Zero prompting from user.
- Unity AI discussion: bot autonomously connected Unity research to user's LocalClaw setup and edge computing interests via auto-injected graph facts
- FalkorDB discussion: multi-turn technical conversation where bot correctly pulled user's ML engineer role and infrastructure context
- `!forget register agent` working with flexible word matching after exact CONTAINS failed on "registered agent" vs "register agent change"

### OpenCode integration — workspace isolation (May 2026) — SUPERSEDED by the Pi swap (June 26 2026, top of file)
**Problem:** OpenCode's headless server treats its startup directory as the project root. When started from the LocalClaw directory, it overwrote `package.json` (replaced all dependencies with Express) and `README.md` (replaced with Express API docs). Prompt instructions to "only write to builds/" were ignored by the model.
**Root cause:** OpenCode is a model-driven agent with full filesystem access within its project directory. Prompt-based directory constraints are not enforceable — the model writes wherever it decides.
**Fix:** Start `opencode serve` from a separate `data/workspaces/main/builds/` directory. OpenCode can only see and modify files within that directory. LocalClaw connects to the existing server via SDK — it doesn't manage the server lifecycle.
**Lesson:** Never give a model-driven coding agent write access to your production codebase. Isolate its workspace at the process level, not the prompt level.
**Status:** Active. User starts `opencode serve` from builds directory manually. LocalClaw tool detects and connects to the running server.

### OpenCode pipeline evolution (May 2026)
**Phase 1 (ReAct):** Specialist called opencode_build in a ReAct loop. Model retried 2-3x despite "call once" instructions.
**Phase 2 (Pipeline):** Deterministic extract → build → report. Extract stage mangled user intent. Replaced with LLM enrichment stage.
**Phase 3 (Verify/Fix):** Added verify (run tests), fix (send errors to same session), re-verify stages. Uses `when` guards for conditional execution. Session reuse via `sessionId` parameter.
**Phase 4 (Iterative builds):** Session persistence (`.opencode-session.json` per project). `list_projects` code stage scans existing projects. Enrich LLM outputs `[MODIFY] <slug>` for modifications vs new project name. `resolveParams` loads saved session data for reuse.
**Key pattern:** Each stage does ONE thing. Code controls the flow. Model executes within constraints. No model decisions about retry/flow.
**Status:** Active. Full pipeline: list_projects → enrich → build → verify → [fix] → [re-verify] → report.

### OpenCode specialist retry behavior (May 2026)
**Problem:** Despite system prompt saying "Call opencode_build ONCE", the specialist calls it 2-3 times:
- First call: build succeeds, returns file listing
- Specialist reviews output, decides tests aren't good enough, starts second build
- Or: first call times out (fetch failed), specialist retries with new session
**Attempted fixes:**
- System prompt: "Do NOT call opencode_build multiple times" — model ignores it
- maxIterations: 3 → still retries. Need to drop to 2 (one build + one answer)
- Content previews truncated at 2000 chars → specialist thought build was incomplete → retried. Fixed: bumped to 8000 char limit
**Lesson:** Local models don't reliably follow "call this tool exactly once" instructions. Constrain via maxIterations, not prompts.
**Status:** maxIterations set to 2 to force single build + answer.

### Tool-specific error recovery (May 2026)
**Problem:** Tool errors returned generic "Try a different approach or tool" regardless of which tool failed or why. The 8 error patterns in `enrichObservation()` had generic suggestions (e.g., "Check file permissions") that didn't help the model recover.
**Fix:** Added `TOOL_RECOVERY_MAP` — a lookup table mapping (toolName, errorType) → actionable recovery instruction. When `web_fetch` gets a 404, model is told "Use web_search to find the correct URL." When `exec` gets EACCES, model is told to try Docker backend.
**Why this matters:** Goose's architecture treats errors as prompts — recovery instructions tailored to the specific failure. LocalClaw already had `enrichObservation()` but it was generic. Now it's tool-aware.
**Status:** Active. `src/learnings/pattern-matcher.ts`.

### Structured sub-dispatch results (May 2026)
**Problem:** Plan pipeline sub-dispatches returned raw text strings. File paths and URLs were regex-extracted post-hoc from the answer, which was fragile and could miss paths in unexpected formats.
**Fix:** Added `SubDispatchResult` typed interface. Dispatch layer now extracts paths/URLs at source (where it has the full answer) and returns structured metadata. Plan pipeline uses typed fields instead of regex.
**Why this matters:** Separates data extraction from orchestration. Foreman handoffs are now based on structured data, not text parsing.
**Status:** Active. `src/pipeline/types.ts`, `src/dispatch.ts`, `src/pipeline/definitions/plan.ts`.

### LLM-based observation summarization (May 2026)
**Decision:** Added optional LLM summarization for old tool observations in the tool-loop context trimmer.
**How it works:** When context budget is tight (>85%), observations >1000 chars are summarized by a fast model (router model by default) before truncation. Observations 300-1000 chars hard-truncate as before. Controlled by `session.summarizeToolObservations` config flag.
**Why:** Hard truncation to 300 chars loses key data (errors, file paths, status codes) buried in middle of output. Smart summarization preserves what matters. Goose uses LLM-based summarization too but for full session compaction — this is more targeted (per-observation).
**Fallback:** If LLM call fails, falls back to hard truncation. Zero risk of breaking existing behavior.
**Status:** Active. Enabled in config.

### Graph memory quality: importance, entity typing, entity dedup (May 2026)
**Problem:** Three data quality issues in the knowledge graph:
1. All facts had importance=2 — extraction LLM (phi4:14b) never returned the `imp` field, fallback defaulted to 2. The 30% importance weight in auto-injection scoring was dead weight.
2. All entities had type="unknown" — NER prompt only asked for names as flat strings, MERGE hardcoded `type = 'unknown'`.
3. Duplicate entities from string variations — "open-source model" vs "open-source models", "Poly Markets" vs "Polymarket" created separate nodes, fragmenting the graph.

**Fix (importance):** Added few-shot examples to extraction prompt showing concrete importance levels (wife+health=5, job=4, preference=3, context=2, ephemeral=1). Added warning log when `imp` is missing.
**Fix (entity typing):** Changed NER prompt from flat `["string"]` to typed `[{name, type}]` with closed taxonomy (person, organization, technology, hardware, software, place, event, concept). MERGE uses extracted type, ON MATCH upgrades `unknown` → real type.
**Fix (bootstrapped NER):** NER prompt now queries existing typed entities from the graph and injects them as reference context: "Known entities: DGX Spark → hardware, DevMesh → organization...". Creates a self-improving loop — correctly typed entities teach the model to classify new ones consistently. Without this, phi4-mini classified blind (DGX Spark → software, Solutions Architect → person). Rollback: remove the `knownEntitiesBlock` query in `graph-store.ts addFact()` and revert to static examples.
**Fix (entity dedup):** Added `normalizeEntityName()` for canonical form computation (lowercase, collapse whitespace, simple plural stripping). MERGE matches on canonical property. Display name preserved separately. Startup migration backfills canonical on existing entities. NER prompt instructs model to use singular/canonical forms.
**Status:** Active.

### Graph memory maintenance: entity quality gate + orphan cleanup (June 2026)
**Problem:** First graph audit (1 month in, 1,067 nodes) revealed three categories of junk: (1) garbage entities — "user", "user's", "230s" created as entity nodes, (2) duplicate entities — same canonical name but different types (DevMesh as both `organization` and `unknown`) creating separate nodes, (3) orphaned entities — fact deletions left entity nodes with no ABOUT edges pointing to them. Also found 30+ entities still typed `unknown` from before bootstrapped NER was added, and misclassifications (SOUL.md → hardware, ERA blocks → software).
**Fix (quality gate):** Added `isGarbageEntity()` filter before graph insertion — rejects generic pronouns ("user", "user's", "they"), pure numbers ("230s"), and single-char strings. Runs after NER extraction, before MERGE.
**Fix (orphan cleanup):** After `removeFact()`, automatically sweeps entities with no remaining ABOUT or MENTIONS edges. Best-effort, non-blocking.
**Not fixed with TTL:** Fact expiry stays human-in-the-loop via heartbeat review candidates — the user knows if "interested in Polymarket" is still relevant, the model doesn't.
**Lesson:** Graph databases need periodic maintenance just like any other data store. Plan for a monthly audit cycle — the bootstrapped NER and quality gates reduce future junk, but won't eliminate it entirely.
**Status:** Active. First cleanup: 73→50 facts, 97→75 entities, 0 unknown types remaining.

### Chrome extension: console API bypasses orchestrator (June 2026)
**Problem:** Chrome extension sends messages to `/console/api/chat`, which calls `dispatchMessage()` directly — not through the orchestrator's `handleMessage()`. Page context override (`[PAGE:]` → force chat category) added to the orchestrator had no effect. Messages with injected page content were routed to `website` or `web_search`, which used `web_fetch`/`browser` to re-fetch pages the user was already looking at.
**Root cause:** Two dispatch paths exist: orchestrator (channels) and console API (web/extension). The override was only in the orchestrator.
**Fix:** Added `[PAGE:]` detection in `src/console/handlers/chat.ts` with `overrideCategory: 'chat'`. When the extension injects page context, the model reads the injected content directly — no tools, no fetching.
**Also fixed:** Extension manifest had `host_permissions: ['http://localhost:*/*']` only — content script injection silently failed on HTTPS pages (all of them). Added `https://*/*`. Changed from programmatic `executeScript` injection to declarative content script with active message listener for reliability.
**Lesson:** When adding routing overrides, check ALL dispatch paths — not just the main orchestrator flow. The console API is a separate entry point.
**Revision (June 2026):** Removed the forced `overrideCategory: 'chat'` for extension messages. Let the router classify naturally — it correctly sends "summarize this page" to chat and "click the search bar" to website. Keyword-based intent detection was tried and abandoned (too fragile, false positives on "search for").
**Status:** Active. Router classifies, no overrides.

### Browser control via Chrome extension — evolution (June 2026)
**Problem:** The extension reads page content but can't interact with it. User wants browser control (click, type, navigate) through the extension on their Windows PC, controlled by LocalClaw on the Mac Mini.

**Approach 1 (rejected): CDP over network.** Playwright on Mac Mini connects to Chrome on Windows via `--remote-debugging-port`. Works but exposes Chrome's debug port across the network — real security concern. Built and removed.

**Approach 2 (rejected): Extension parses LLM action tokens.** LocalClaw responds with `[ACTION: click | ref=3]` tokens, extension parses and executes. Same antipattern as letting models decide tool ordering — fragile, retry-prone.

**Approach 3 (active): Remote browser bridge.** Model calls the browser tool normally. If extension is connected (`remoteBridge.isConnected()` + `channel === 'console'`), the tool forwards the structured command to the extension via a poll/POST queue instead of Playwright. Extension content script executes DOM actions. The extension is a dumb executor — same pattern as Docker for exec.

**Architecture:** `model → browser tool → remote bridge queue → extension polls GET /browser/action → background relays to content script → content script executes → POST result → tool promise resolves → model sees result`

**Bugs hit during implementation:**
1. **Content script dies on navigate.** `window.location.href` kills the content script. Fix: navigate delegated to background via `chrome.tabs.update()`.
2. **Content script not loaded on tab.** After navigation or tab switch, content script doesn't exist. Fix: background pings content script, injects on-demand via `chrome.scripting.executeScript()` if missing.
3. **Navigate timing.** Navigate returns instantly but new page hasn't loaded. Next action (snapshot) fails. Fix: 3-second delay after navigate actions.
4. **"Illegal invocation" on type.** Native setter used wrong prototype for `<textarea>` vs `<input>`. Fix: check element tag, try/catch fallback.
5. **Conversational guard blocking website.** Guard downgraded `website` → `chat` on follow-up messages (no task intent detected for "go to reddit.com"). Fix: skip guard for console channel.
6. **qwen3-coder repeated snapshots.** Model called snapshot 8x in a row without acting on results. Can't self-regulate multi-step browser interactions.
7. **gemma4:26b froze on browser control.** Switched from qwen3-coder hoping better reasoning would help. Instead: (a) thinking tags parsed as final answer — parser didn't strip `<|channel>thought` blocks, ending loop at step 4, (b) temperature clamp to 0.3 killed MoE performance (needs 1.0), (c) even with both fixes, model froze generating massive thinking blocks with 16K token headroom instead of acting. gemma4 reasons too much and acts too slowly for rapid browser interaction.
8. **qwen3.6:35b works.** Better reasoning than qwen3-coder, faster than gemma4. Uses direct URLs (google.com/search?q=...) instead of multi-step UI interaction. Searches across multiple vendors (Google, eBay, Amazon). Only issue: retried 404 URLs instead of skipping them.
9. **web_fetch competing with browser tool.** Model had web_fetch, browser, and web_search available. Defaulted to web_fetch (simpler) instead of using the browser to navigate pages the user can see. Fix: strip web_fetch from tool list in browser control mode — forces the model to use browser for navigation.
10. **Page content bloated compaction.** 10K chars of page content repeated in session history broke compaction. Fix: strip `[PAGE_CONTENT]` from archive after fact extraction but before summary generation.
11. **Drift detector fighting completion.** Model has enough data and tries to synthesize final answer, but drift detector flags "growing text" and re-anchors, forcing more unnecessary actions. Browser control needs different drift thresholds.

**Model evaluation for browser control:**
- qwen3-coder:30b — fast tool calls but can't reason about multi-step sequences. Loops on snapshots.
- gemma4:26b — good reasoning but freezes generating thinking blocks. Too slow for interactive browser actions.
- qwen3.6:35b — best balance. Plans well (direct URLs), acts quickly, recovers from errors. Active choice.

**Lesson:** Browser control is fundamentally different from browser fetching. The website specialist ("fetch and summarize") can't do multi-step automation. Needed: a dedicated prompt (plan before acting, never repeat actions, prefer direct URLs, recovery strategies), a reasoning model (qwen3.6 over qwen3-coder/gemma4), more iterations (25), higher output tokens (16K), and web_fetch stripped from tool list to force browser usage.

### Deterministic pipeline for browser control — FAILED (June 2026)
**Tried:** Replaced the working ReAct browser control with a deterministic pipeline (plan → reflect → execute → synthesize → quality review → revision). Same pattern as analytics/heartbeat/web-search. 280 lines became 601 lines.

**What broke:**
1. **Synthesize stripping cascade** — LLM told to output "synthesize" as final step, `parse_plan` stripped it, `reflect_on_plan` stripped it again from revised plans → plans shrank from 5 steps to 1-2
2. **Plan reflection made plans worse** — saw a 4-step plan, "revised" it to 2 steps. Same model doing action + critique produces rubber stamp effect (confirmed by research)
3. **Per-step reflection JSON parsing failed** — summary field contained page content with unescaped quotes/newlines that broke JSON parsing, even with JSON5. When reflection failed, no summary was captured → synthesis had no data
4. **Reflection injected hallucinated actions** — `sort_results`, `validate_urls`, `check_pagination` despite action validation filter (plan reflection's revised plan bypassed validation initially)
5. **Quality review suggested infrastructure changes** — "use Playwright with waitForSelector" — revision LLM took this literally and wrote a Python tutorial instead of product data
6. **Revision hallucinated data** — with no real data from failed collection, revision invented URLs, prices, and vendor names

**Research findings that explain the failure:**
- Skyvern (45% → 85.8% on WebVoyager) achieved this by adding a **Validator LLM**, not a planner. Upfront planning is a known failure mode.
- Browser-Use uses pure ReAct with code-driven loop detection (action hashing). No separate planner.
- Same model for action + critique produces rubber stamp effect. External signals (DOM mutations, screenshot diffs) are needed for honest validation.
- WebVoyager keeps only 3 most recent observations. Keeping all step results bloats context.

**What worked instead:** Guided ReAct with code guardrails:
- Action dedup via hash comparison (Browser-Use pattern) — blocks identical consecutive tool calls
- Content-aware auto-vision — regex checks for price/product patterns in snapshot, auto-escalates to screenshot+vision when missing
- Skip growing-text drift detection — let model produce long final answers
- 20 iterations max, qwen3.6:35b, web_fetch stripped

**Lesson:** Not everything benefits from a deterministic pipeline. Browser control is inherently reactive — the model needs to see page content before deciding what to do next. Upfront planning commits to a strategy before seeing the data. The pipeline pattern works for categories with predictable workflows (analytics: always load → compute → chart → interpret). Browser control has unpredictable workflows — different sites, different layouts, different failure modes. ReAct with code guardrails (dedup, vision fallback, iteration caps) is the right pattern.

**Status:** Active. Guided ReAct with action dedup, content-aware auto-vision, qwen3.6:35b. 10 steps for multi-vendor comparison with real prices and URLs.

### !save writing to both FactStore and GraphMemory (May 2026)
**Problem:** The `!save` command (user-approved fact storage after `!reset`) only wrote to the flat JSONL FactStore, never to FalkorDB. Facts only reached the graph via heartbeat transcript review — a separate extraction pass that could produce different results.
**Fix:** `!save` now writes each fact to both stores. GraphMemory `addFact()` runs entity extraction, NER with typing, canonical normalization, and vector embedding.
**Status:** Active.

### URL routing: website specialist with fetch→browser fallback (May 2026)
**Problem:** Pasting a URL into chat caused the router to classify it as `web_search`, which searched for related content instead of fetching the actual URL. The `website` category existed but used a broken `website_query` tool (required `tools.website.baseUrl` config that was never set).
**Fix:** Added pre-model override in `classifier.ts`: any message containing a URL routes to `website`. Rebuilt the `website` specialist to use `web_fetch` → `browser` fallback (ReAct loop, no pipeline). Reddit and other JS-heavy sites that block `web_fetch` get rendered by the headless browser automatically.
**Status:** Active.

### Setup wizard overhaul (May 2026)
**Problem:** The setup wizard generated a ~60 line config that silently disabled most features. No graph memory, no heartbeat, no security, no research/image/personal specialists, no pipeline fields. Preflight said "All checks passed!" with a severely incomplete config.
**Fix:** Complete rewrite of `generate.ts` to produce a production-ready config (~200 lines). Added prompts for: ownerId, trusted users, FalkorDB (with auto-install), OpenCode (with auto-install), heartbeat, reasoning model, image generation. Added prerequisites check (Docker) at wizard start. Preflight now warns about missing ownerId, no trusted users, disabled heartbeat, unavailable graph memory.
**Status:** Active.

### Analytics pipeline: code computes, model interprets (May 2026)
**Problem:** When users upload data files (CSV/Excel), the model hallucinated numbers. Tried multiple approaches: letting the model compute from pandas output (invented $1.2M totals), providing "authoritative data" labels (model ignored them), stricter prompts (still fabricated breakdowns). The model cannot reliably copy numbers from structured data.
**Decision:** Complete separation — Python computes ALL numbers (totals, breakdowns, top items, distributions) as a formatted markdown report. The LLM ONLY interprets the pre-built report, adding executive analysis, risk assessment, and recommendations. Same pattern as heartbeat: code handles "what", model handles "so what".
**Pipeline:** extract_file → report (Python/pandas) → generate_charts (matplotlib) → interpret (LLM) → attach_charts. Smart column selection: prefers "Total" over "Unit Cost", groups by "Category" not "Date", labels by "Item Description" not "Vendor". Python runs via /tmp scripts to avoid exec tool cwd path issues.
**Key bugs found:** JS template literals eating Python f-string `{}` braces, exec tool doubling workspace paths, matplotlib crashing on NaN in categorical data, column keyword matching order (column-first vs keyword-first).
**Status:** Active. File type routing in orchestrator: .csv/.xlsx/.json auto-route to analytics, text files prompt user for knowledge base vs read-as-text.

---

## Known Issues

### Double message delivery on Discord (intermittent)
**Problem:** Occasionally the bot sends the same response twice in Discord — the stream preview message AND a separate final message, resulting in duplicate content.
**Frequency:** Rare, observed twice in extended testing sessions.
**Suspected cause:** Race condition between stream message edit and the channelRegistry.send fallback path. May also relate to silent re-route or capability gap detection triggering a second dispatch.
**Impact:** Cosmetic — the response content is correct, just duplicated.
**Status:** Logged for investigation. Not blocking daily use.

### Gateway 429 rate limit under request bursts (June 2026)
**Problem:** The Ollama gateway (10.0.0.20:8001) caps at 100 requests/minute. Everything except MiniMax (router classify, embedding, NER, vision, pipeline quality_review, post-task review, semantic state extraction) hits the gateway. A single web_search message fires several gateway calls; rapid messages + 5 parallel fetches burst past 100/min → `429 rate_limit_exceeded`.
**Observed:** "OLLAMA_INFERENCE_ERROR: Classification failed — 429" + "Post-task review failed — 429".
**Impact:** Degrades gracefully (router falls back to keyword classification, reviews skip) — nothing crashes — but lossy: a 429'd router classification means keyword routing instead of the model, which is exactly when misroutes creep in.
**Potential fixes (NOT yet done):**
1. **Infra:** raise the gateway req/min cap (100 → 300-500) — it's tight for a multi-call pipeline on shared small models.
2. **Client:** add 429 backoff/retry to `OllamaClient.post()` — it currently retries once on *connection* failure but throws immediately on 429. A short exponential backoff (the rate window resets in <60s) would smooth transient limits instead of dropping the call. This is the right resilience fix regardless of the gateway cap.
3. **Reduce burst:** post-task review + quality review add gateway calls per message; consider gating them or batching.
**Status:** Documented, deferred. Fix #2 (client backoff) is the cleanest LocalClaw-side improvement.

### Research / deck pipeline fragile (June 2026)
**Problem:** The research pipeline's deck/PDF rendering path (reveal.js deck + styled PDF branch) is unreliable — "the whole deck thing is kinda broken."
**History:** This path has been fragile since the deck/report branch was added; an earlier deterministic browser-control pipeline in the same family was reverted for similar reasons (see Failed Approaches).
**Impact:** Report/deck generation (`research` category, "make me a report/deck") produces broken or incomplete output. Web_search synthesis (the lighter path) works well.
**Potential fix (NOT yet done):** A focused rebuild of the research pipeline render stages — review the chart-gen → write_file → render_deck flow, the HTML template, and the PDF branch. Worth its own session, not a 1am patch.
**Status:** Documented, deferred to a dedicated session.

### Chat over-promises tool actions (band-aid in place) (June 2026)
**Problem:** The toolless chat specialist sometimes promises actions it can't perform ("Let me search for X", "On it, let me pull together…") and then can't follow through — no tools, no ReAct loop, so hallucination detection (which lives in the tool-loop engine) never runs.
**Current mitigation (band-aid):** The silent re-route (dispatch.ts) now catches future-action promises (search/research verbs) and re-dispatches to a specialist that can actually do it.
**Cleaner fix (NOT yet done):** Strengthen the chat system prompt so it doesn't promise tool actions in the first place — if it needs to search, it should signal a re-route, not narrate intent. Pairs naturally with the research-pipeline work.
**Status:** Band-aid active (catches it post-hoc and does the search); prompt-level fix deferred.

### SearXNG self-hosted search provider (June 2026)
**Problem:** Brave's free tier (~1 req/sec, 2000/month) forced a serialized throttle + 429 backoff and capped the research/verification search budget (bounded Tier-1 cross-checks, sequential facet searches). The rate limit was the recurring bottleneck across the whole research/verification build-out.
**Fix:** Added a `searxng` provider to `src/tools/web-search.ts` (+ `provider` enum and a `baseUrl` field in `WebSearchConfigSchema`). SearXNG is a self-hosted metasearch engine — no API key, no rate limit. Calls `GET {baseUrl}/search?format=json`, maps our `freshness` (day/week/month/year) → SearXNG `time_range` (same vocabulary), slices to `count`. Requires the instance's `settings.yml` to enable the JSON format (`search.formats: [html, json]`) — returns a clear 403 error otherwise. Purely additive; Brave/Tavily/etc. paths unchanged. Runtime config points at the LAN instance (gitignored).
**Status:** Live. With no rate limit, the Brave throttle is effectively bypassed and the Tier-1/facet search budgets can be widened if desired.

### web_search recall depth + freshness effectiveness (June 2026)
**Problem:** Broad multi-vendor survey queries via web_search (single query, now top-5 fetches) can still miss product-specific pages (e.g. missed the DGX Spark article in an Apple/NVIDIA/AMD survey — it ranked below the comparison pieces).
**Mitigations done:** fetch 3→5 pages; freshness forcing on recency-signalling queries.
**Open questions (NOT verified):**
1. Does the search provider (Brave) actually honor the `freshness=month` param? A "recent" query once returned 2019-2023 content even with freshness forced. Needs isolated verification.
2. Broad surveys are really a `research` request (multi-query, 8 fetches, supplementary round), not a `search` one — but "search the web for X" routes to the shallow pipeline. Consider routing multi-entity surveys to research.
**Status:** Documented. Freshness-param verification is the next concrete check.

### Routing latency on the gateway (June 2026)
**Problem:** Router classification (phi4 on the gateway) occasionally takes 4-5s (observed `Routing: 4957ms`). Memory runs in parallel, so it's the classifier itself — almost certainly gateway contention (many models resident on the A5000 node, or phi4 cold-reloading).
**Potential fix (NOT yet done):** `OLLAMA_MAX_LOADED_MODELS` bump or trimming what's resident on the gateway so phi4 stays warm. Infra-side, not code.
**Status:** Documented, watch. Related to the 429 issue — both point at gateway-node pressure.

---

## Future Ideas (Stashed)

### MFLUX + Pillow programmatic diagram generation
**Idea:** Use MFLUX (Apple MLX port of FLUX) to generate cyberpunk/stylized backgrounds locally, then composite text blocks, neon borders, and connection lines with Pillow. Produces architecture diagrams, system maps, status dashboards — all locally, no API.
**Why it fits:** Already have Flux on the infrastructure for image_generate. This extends it from "generate a picture" to "generate a technical visual." Could become a LocalClaw tool or pipeline stage.
**Inspiration:** Seen in another local AI setup that generated cyberpunk architecture diagrams this way.
**Status:** Stashed. Circle back when image pipeline is more mature.

### DevMesh integration into LocalClaw
**Idea:** LocalClaw becomes the control plane for DevMesh outreach platform. Phase 1: status/control tools (manage from Discord). Phase 2: pipeline convergence (shared search, LLM routing, cron, CRM tools).
**Why it fits:** Both systems share Ollama, cron, web search. LocalClaw's memory + calendar awareness can drive smarter outreach decisions.
**Status:** Stashed. Plan light integration first. See `memory/project_devmesh.md`.

---

## Conference-Inspired Improvements (June 2026, AI Dev Summit)

### Memory decay (June 2026)
**Source:** Talk 2 (Lamatic AI) — "memory eviction and decay let the agent forget gracefully."
**Problem:** Facts persist forever in the graph store. Low-importance ephemeral facts accumulate, degrading search quality. Flat store has TTL but graph store had none.
**Fix:** `applyDecay()` in GraphMemoryStore. Confidence decays automatically based on importance tier: imp 1 at 0.05/day, imp 2 at 0.02/day, imp 3 at 0.005/day. Identity facts (4-5) never decay. Facts below 0.3 confidence auto-removed. Facts 0.3-0.5 surfaced as review candidates.
**Status:** Active.

### Contradiction eviction (June 2026)
**Source:** Talk 2 (Lamatic AI) — "deleting 'favorite color is red' when user says they hate red."
**Problem:** "I use Ubuntu" and "I switched to Arch" coexisted in the graph until manual heartbeat review.
**Fix:** On `addFact()`, vector search for similar existing facts (cosine distance 0.15-0.4). For each match, phi4-mini judges YES/NO on contradiction. If YES, old fact marked `superseded: true`.
**Status:** Active.

### Token economics monitoring (June 2026)
**Source:** Talk 1 (stealth founder) — "Uber burning annual token budget in four months."
**Problem:** Ollama returns `eval_count` and `prompt_eval_count` in every response but they were completely discarded. No visibility into token consumption per category.
**Fix:** Token counts captured from Ollama responses (both streaming and non-streaming), accumulated per tool loop iteration, logged per dispatch. `[Dispatch] Tokens: 3200 prompt + 800 completion = 4000 total (web_search)`
**Status:** Active.

### LLM-as-judge quality scoring (June 2026)
**Source:** Talk 3 (Ramana) — "LLM-as-judge graded on accuracy, relevance, citation, tone."
**Problem:** Quality review existed only in web_search and research pipelines. No systematic scoring across categories.
**Fix:** Post-dispatch quality check for pipeline categories (web_search, research, analytics, multi, exec, code_gen). Router model scores 1-5 on accuracy, relevance, completeness. Logged to `data/quality/quality-scores.jsonl` for weekly review. Skipped for chat/cron/task/memory (subjective or deterministic).
**Status:** Active.

### Metadata-filtered memory search (June 2026)
**Source:** Talk 3 (Ramana) — "metadata as the filter layer applied before semantic search."
**Problem:** Vector KNN searched ALL facts for a sender. No pre-filtering by importance, category, or age.
**Fix:** `search()` now accepts optional filters: `minImportance`, `categories`, `maxAgeDays`. Cypher WHERE clauses applied before vector KNN. Dispatch can pass context-aware filters per category.
**Status:** Active (filters available, context-aware dispatch filtering ready to wire).

### Specialist use case specs (June 2026)
**Source:** Talk 3 (Ramana) — "12-point spec per use case."
**Fix:** `SPECIALISTS.md` with 12-point specs for top 5 specialists (chat, web_search, research, multi, exec). Includes in/out scope, acceptance criteria, edge cases, known failures, test cases.
**Status:** Active.

### Session-scoped permissions (June 2026)
**Source:** Talk 5 (Architex) — "block by default, approve once scoped to the conversation."
**Fix:** Added `toolGrants` to SessionState. Foundation for per-session tool access with TTL.
**Status:** Schema added, enforcement logic ready to wire in dispatch.

### Progressive tool disclosure (June 2026)
**Source:** Talk 6 (Juwan Lightfoot) — "MCP servers inject ~7000 tokens of tool definitions."
**Fix:** Added `relevanceHints` field to LocalClawTool interface. Foundation for filtering tool injection based on user message context.
**Status:** Interface extended, filtering logic ready to wire in prompt-builder.

### Media burst handling (June 2026)
**Source:** WhatsApp media burst incident.
**Fix:** Vision queue (one call at a time), media debounce (3-second batching), video path (acknowledge and save), rate limiter adjustment.
**Status:** Active.

---

## Security Hardening (June 2026, External Review)

### Web API authentication warning (June 2026)
**Finding (P0):** Web adapter bound to 0.0.0.0 with no token = anyone on the network can exec commands.
**Fix:** Startup warning when no token + 0.0.0.0. Host stays configurable (user accesses from network). README updated with security configuration section and explicit guidance to set a token.
**Status:** Active. Warning on startup, docs updated.

### Session route path traversal (June 2026)
**Finding (P1):** Console API accepts `agentId` from URL path and passes to `join(baseDir, agentId, ...)` unsanitized. `../` in agentId = file access outside sessions directory.
**Fix:** `sanitizePath()` strips `..` and path separators. SessionStore now sanitizes agentId in all path methods (not just sessionKey).
**Status:** Active.

### File containment prefix matching (June 2026)
**Finding (P1):** `startsWith(resolve(workspace))` allows sibling-prefix escapes (`main2` when workspace is `main`).
**Fix (round 1):** Changed to `startsWith(resolve(workspace) + '/')`.
**Fix (round 2):** Replaced with `path.relative()` + `isAbsolute()` check — cross-platform safe (POSIX + Windows). Applied to read_file, write_file, console file serving, and static console serving.
**Status:** Active.

### Telegram allowFrom (June 2026)
**Finding (P2):** Discord and Slack enforce `allowFrom`, Telegram didn't.
**Fix (round 1):** Added `allowFrom` set to TelegramAdapter.
**Fix (round 2):** Fixed to read `allowFrom.users` (schema-compatible `{users?: string[]}`) instead of treating `allowFrom` as a flat array (which never matched the Zod schema).
**Status:** Active.

### Scoped tool executor (June 2026)
**Finding (P1):** ToolRegistry.createExecutor() directly executed any tool. Pipeline stages bypassed dispatch-time filtering.
**Fix:** Added `createScopedExecutor(allowedTools: Set<string>)` — rejects tools not in the allowlist. Wired in both ReAct and pipeline dispatch paths as the final enforcement gate. Cron tool stripping now enforced even in pipelines.
**Status:** Active.

---

## Latency Optimization (June 2026)

### Parallel memory + router (June 2026)
**Problem:** Graph memory queries (embed → KNN → multi-hop → user model) ran sequentially BEFORE router classification. ~800-1500ms of blocking before routing even started.
**Fix:** Router classification and memory injection run as `Promise.all()`. Router starts immediately, memory runs alongside. Memory results injected when they arrive — if memory finishes during routing, wait time is 0ms.
**Also:** Lazy multi-hop — only runs if KNN returns <3 results (inspired by Hermes Agent pattern).
**Measured:** Routing 0-4ms (sticky) with memory priming 235-2900ms in parallel. Previously sequential (additive).
**Status:** Active.

### Async compaction cache → turn-count gated + prewarm (June 2026)
**Problem:** History compaction ran synchronously every message once history exceeded budget (300-1000ms blocking).
**v1:** Cache compaction per session (5-min TTL), serve cached + refresh async.
**v2 (review fix):** TTL-only cache could serve history MISSING the previous exchange. Gated cache validity on SessionStore `turnCount` — reuse only if no new turns since it was built.
**v3 (review fix):** Turn-count gate made the cache miss after every exchange (each response appends 2 turns). Added a **prewarm**: after appending turns, build+cache compaction in the background keyed to the new turn count, so the next message hits a warm, correct cache.
**v4 (review fix):** Removed the cache-hit async refresh entirely — with turn-count gating a cache entry is exact for its turn count (can't drift) and turn count only increases, so the refresh cached an obsolete count and raced the prewarm for the `pendingCompactions` lock. Deleting it fixed the race by removing the path.
**Reset:** `clearSession` resets metadata `turnCount` to 0; `clearCompactionCache()` clears the entry on `!reset`/`!new` so a fresh session can't reuse old compacted history.
**Status:** Active. (Note: with the 128K context raise, compaction's expensive LLM summary rarely fires at all now.)

### Tool-loop streaming (June 2026)
**Problem:** Tool-loop specialists used non-streaming `client.chat()`. User saw "thinking..." for 2-5 seconds with no feedback.
**Fix:** Three streaming points: (1) plain-text tool status events ("Searching...", "Running command...") before each tool execution, (2) max-iterations synthesis via `chatStream()` with `tools: undefined` (safe — no tool-call risk), (3) normal final answer post-hoc streamed after tool calls complete.
**Rule:** Tool-loop model calls stay non-streaming (prevents leaking JSON/function calls). Only stream user-facing natural language.
**Status:** Active.

### Web-fetch page caching + URL key case (June 2026)
**Problem:** Same pages fetched repeatedly across conversations. No caching.
**Fix:** In-memory cache with 1-hour TTL. SSRF validation runs BEFORE cache check, and returns a tool-style `Error:` (not throw). Cache key includes URL + extractMode + maxChars. Non-HTML responses cached too.
**Review fix:** `normalizeCacheKey` lowercased all keys — fine for search queries, wrong for URLs (`/Foo` vs `/foo` collide). Split into `normalizeCacheKey` (queries, lowercase) vs `normalizeUrlKey` (URLs, trim only); `readCache`/`writeCache` now use keys verbatim and callers normalize.
**Status:** Active.

### Search source buckets — removed (June 2026)
**History:** `src/pipeline/search-buckets.ts` mapped query topics to curated-domain buckets and appended `site:` filters (with an anchor convention guaranteeing high-value domains, a `real_estate` bucket, civic open-data spread, etc.).
**Why removed:** In practice the buckets didn't deliver — `site:` filters over-constrained Brave on longer/question-shaped queries (often returning nothing), and the curated domain lists added maintenance and misroute risk (e.g. "AMD/NVIDIA hardware for local inference" landed in ai_tech, not hardware) without improving result quality. Per the user: "the bucket angle just hasn't produced what I thought it would."
**Fix:** Deleted `search-buckets.ts` + its test. `web_search` and `research` now run plain queries with **recency/freshness filtering only** — `freshness=month` is forced when the query signals recency (research applies the same `wantsFreshness` check per angle and on the topic). URLs are taken in result order (no bucket re-prioritization).
**Status:** Buckets gone; recency filter retained.

### Per-domain source-diversity cap — tried and reverted (June 2026)
**What was tried:** Research capped fetches at ≤2 per domain run-wide (+ distinct domains within a facet, exact-URL dedup), to stop runs leaning on one source. It raised the source count (12→16) and the automated quality score (rel 4→5, comp 3→4).
**Why reverted:** Side-by-side, the *capped* report was visibly **worse** — less well-rounded. Root cause: a single genuinely comprehensive survey source (an "enterprise guide" page) had been the backbone of the good run, legitimately informing many facets (ASIC ecosystem, vendors, market size, DGX Spark). The cap throttled exactly that source, forcing reliance on thinner specialized pages — trading breadth for scattered depth. The original "all from one source" complaint was really **cosmetic log noise** (the same URL re-found across facets, already harmless via the `seen`-style dedup), not a quality problem. The automated judge rewarded source count; the human judged substance and preferred the uncapped run.
**Lesson:** Don't cap how much a comprehensive source can contribute. Diversity-by-fetch-cap is the wrong mechanism; a great survey should be allowed to anchor a report. Recency bias + Brave freshness-code mapping (from the same commit) were kept — only the cap was rolled back.
**Status:** Reverted to plain top-3 URLs per facet in result order.

### Evidence verification layer for research (June 2026)
**Problem:** MiniMax synthesizes a confident report from mostly secondary blogs with no check that each statement is supported by its cited source. Live output stated materially false claims as fact — NVIDIA's Dec-2025 Groq arrangement called an "acquisition" (it was a non-exclusive license + hires), Cerebras IPO dated Feb 2026 (actual debut May 14 2026).
**Approach (MVP):** A cited-source-only verification pass between `parse_final` and `generate_visuals` (`src/pipeline/verification.ts` + stages in research.ts). Principle: **no claim should outrun its evidence.** Extract atomic claims (fast model) → check each against the *cached* page it was built from (research now persists `_sourceText`, so zero new searches) → entailment judge returns a controlled verdict (VERIFIED/PARTIALLY_VERIFIED/UNSUPPORTED/VENDOR_CLAIM/AMBIGUOUS) → MiniMax correction pass edits ONLY failed sentences (attribute "according to X" / qualify / remove) → re-extract + diff to catch claims added during revision → publish with a `## Verification` appendix + auditable `verification.json`. Config-gated (`verification` block, on by default); correction stage `when`-skips if all VERIFIED. Never hard-blocks publication.
**Known limit (by design):** cited-source-only catches *overstatement* and enforces *attribution* — it cannot disprove a source that is itself wrong/stale (the Groq/Cerebras blogs get honestly attributed, not corrected to the truth). Independently disproving those needs a **Tier-1 cross-check** (one targeted official-source fetch for high-impact + weak-sourced claims) — designed, deferred to Phase 2 along with benchmark-schema validation, an adversarial synthesis critic, and hard publication gates.
**Live result — DISABLED by default (June 2026):** First live run degraded the report (quality acc 5→3) and deleted true claims (M3 Ultra 512GB, NVIDIA ~92% share, $255B-by-2030, the Groq deal). Three bugs: (1) `verdictToAction` mapped UNSUPPORTED→**remove** instead of attribute/qualify — deletion is the opposite of the "according to X" goal; (2) **citation→source mismatch** — the synthesis model's `[n]` numbering is unreliable and reports synthesize across sources, so checking a claim against its single (mis-)cited URL yields false UNSUPPORTEDs (claims cited to the right page verified fine; misattributed-but-true claims got removed); (3) the revision **claim-diff appendix is noise** — reworded/merged sentences show as "newly added." Flipped `verification.enabled` default to **false** (code retained, fully gated). Fix plan: never auto-remove (UNSUPPORTED→qualify/attribute); check each claim against the **broader cached corpus** (`_sourceText` for all sources, top-K by token overlap) not one cited URL; drop the diff. Re-enable only after a live run shows it *improves* (not degrades) accuracy.
**Precision fixes — RE-ENABLED (June 2026):** Fixed all three on a branch and merged: (1) **never auto-remove** — UNSUPPORTED/AMBIGUOUS → `qualify` (hedge the certainty), VENDOR_CLAIM → `attribute`; any judge-returned `remove` is coerced to a hedge; (2) **broader-corpus check** — `pickRelevantSources()` ranks all cached pages by token/number overlap and the judge sees the top-K that actually mention the claim (plus the cited URL), reporting which source supports it — kills the false-UNSUPPORTEDs; (3) **dropped the revision diff** + concise-hedging instruction (one qualifier per sentence). Second live run: **0 removes** (was 8), 5/12 claims hedged/attributed, all true claims survived (92% share → "According to Intuition Labs…", M3 Ultra 512GB kept + hedged). The automated quality judge still scored it low (acc 3, comp 2) but a human read confirmed the report is comprehensive and well-rounded — **the judge is not a trustworthy signal here** (it also over-rewarded the disliked diversity-cap run). Re-enabled by default.
**Phase 2 — Tier-1 independent cross-check (June 2026):** Added to catch faithfully-cited wrong facts (the Groq-date class). After cited-source verification, a `tier1_crosscheck` stage escalates a bounded set of **high-impact, falsifiable** claims (`corporate_event`/`financial`/`market_share` with named entities, capped at `maxCrossChecks`=4) to ONE independent `web_search` + fetch each. The query is built from entities + key terms **minus the contested value** (so it finds the authoritative source, not echoes of a wrong number). A judge returns CONFIRMED / CONTRADICTED / SILENT: CONTRADICTED → new `CONTRADICTED` verdict + `correct` action (the correction pass replaces the wrong detail using the independent evidence); CONFIRMED → un-hedges a previously qualified claim; SILENT → leaves the cited-source verdict. Bounded search budget (~≤4 searches, absorbed by the Brave throttle). Config: `verification.crossCheck` (default true), `maxCrossChecks` (4).
**Targeting fix (June 2026):** First Tier-1 live run executed correctly (4 cross-checks, bounded, throttle fine) but caught nothing useful — it escalated volatile **product-price** claims (the extractor tags "priced at $X" as `financial`), whose searches returned junk (a Robinhood NVDA stock page → SILENT), and the draft happened to contain no corporate-event claim at all. Narrowed `ESCALATE_TYPES` to **`corporate_event` + `market_share`** only (acquisitions/IPOs/launches/share — the actual Groq/Cerebras/92% class); dropped `financial`. Under this, that run escalates 0 and spends 0 searches — correct.
**Extraction-coverage fix (June 2026):** A later run still slipped a wrong "NVIDIA acquired Groq" past Tier-1 — because `extract_claims` pulled 9 GPU-price claims and never extracted the corporate event, so it never reached the cross-check. Fixed by instructing the extractor to ALWAYS include corporate events (with date, amount, and exact verb "acquired" vs "licensed") and market-share figures BEFORE routine prices/specs.
**Validated (June 2026):** With both fixes, a live run finally produced the end-to-end catch: Tier-1 independently found NVIDIA's own statement ("We haven't acquired Groq. We've taken a non-exclusive license…") → CONTRADICTED → the correction pass rewrote the report from "acquired" to "licensed," and corrected ~92%→94% market share from Jon Peddie Research. Confirmed in `verification.json` and the rendered PDF.
**Render fix (June 2026):** The correction model marked edits Word-style — wrapping old text in GFM strikethrough (`~~…~~`) and adding the replacement beside it; with `gfm` rendering, the PDF showed lines through the (still-present) wrong text. `stripStrikethrough()` removes struck spans/`<del>`/stray markers at the render chokepoint, plus a prompt instruction to replace cleanly.
**Status:** Live and enabled (cited-source + Tier-1), end-to-end catch validated. 389 tests. Caveat (real-world ambiguity, not a bug): the Groq deal is genuinely reported both ways — groq.com says "non-exclusive license," CNBC frames it as a "$20B acquisition" — which is the strongest argument for the verifier *attributing* disputed claims rather than silently rewriting; a future refinement. Trust the human side-by-side read over the judge score ([[feedback_regressions]]).

### web_search over-trigger (June 2026)
**Problem:** Conversational text containing bare "search"/"latest"/"news" (e.g. "uses brave for search") classified as web_search and ran the full pipeline.
**Fix:** Tightened the keyword hint to require intent ("search for/the web/online", "web search", google, look up, find out about); dropped bare search/latest/news. Router-prompt nudge for the model layer (not unit-testable — model layer has 0 corpus cases; needs live verification). Also: web_search forces `freshness=month` when the query signals recency, and the quality judge gained a recency check (was scoring a 2019-2023 retrospective 5/5/5 on a "recent" query).
**Status:** Active.

### Expanded pre-model overrides (June 2026)
**Problem:** Router LLM inference (phi4:14b) takes 400-800ms even for obvious classifications.
**Fix:** Added pre-model overrides: "add/create task" → task, "show/list tasks" → task, "generate/create image" → image. Conservative start-of-message patterns only. Also added speculative language override: "I wonder", "what if", "do you think" → chat (prevents "I wonder if you could create" → multi).
**Status:** Active.

### Conversational guard simplified (June 2026)
**Problem:** Keyword-based task intent matching caused both false positives (blocked "do some web search") and false negatives (let "I wonder if you could create" through). Every keyword fix broke another case.
**Fix:** Replaced 11-line keyword regex with 8-line length check: short messages (<30 chars) mid-conversation downgrade to chat. Long or explicit messages trust the router. No keyword matching.
**Status:** Active.

### Quality judge calibration (June 2026)
**Problem:** LLM-as-judge scored every response against research-report standards. Web search returning structured data with sources scored 2/5 (POOR).
**Fix:** Calibrated prompt per category with scoring guide: "a structured answer with sources is at least a 4." Category name included in prompt so judge knows the expected output format.
**Status:** Active.

---

## Ollama Version Issues

### Image generation API broken on 0.23.1 (May 2026)
**Problem:** Flux model on second Mac Mini returned empty progress lines (4/4 steps in milliseconds) with no image data via API. Worked fine via `ollama run` locally.
**Fix:** Downgraded to Ollama 0.21.2. Image generation works correctly over API on this version.
**Status:** Pinned at 0.21.2 on image gen Mac Mini. Monitor future Ollama releases for fix.
