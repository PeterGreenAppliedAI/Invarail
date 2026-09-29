# End-to-end eval — small tier through the real front door (September 27 2026)

The August and September boards (`../2026-08-local-model-eval`, `../2026-09-small-tier`)
measured the **engine**: `runToolLoop` and `extractParams` on mock tools under a
fifteen-token system prompt. This run measures **Invarail**: every task goes through
`dispatchMessage` with a config the setup wizard generates for the model under test
(router = every specialist = that one model), a bootstrapped workspace, the real tool
registry, the real stores and pipelines, in a scratch install. Only the web is stubbed
(a fixed seven-page corpus behind `web_search`/`web_fetch`). Scored by code oracles over
the workspace, the stores, the routed category and the answer — never a judge — and every
oracle is validated by a scripted perfect performer (`--selftest`) before a model is scored.

Harness: `scripts/e2e-eval.ts` (since the 2026-09-29 cleanup an entry point over
`scripts/e2e/` — `install.ts` the scratch install, `corpus.ts` the stubbed web, `tasks.ts`
the tasks, oracles and reference performers, `report.ts`, `stats.ts`, `redact.ts`). Host: the
A5000 (Ollama). One rep per task.

## The board (run 3 — every fix below in place)

| # | Model | Overall | chat | task | memory | exec | multi | cron | web_search | website | research | prompt tok / battery | wall |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | gemma4:12b | **100%** | 100 | 100 | 100 | 100 | 100 | 100 | 100 | 100 | 100 | 77,673 | 4.2m |
| 2 | qwen3.5:9b (think off) | **94%** | 100 | 50 | 100 | 90 | 100 | 100 | 100 | 100 | 100 | 77,315 | 1.9m |
| 3 | qwen2.5:7b | **92%** | 100 | 100 | 100 | 78 | 60 | 100 | 100 | 100 | 100 | 68,500 | 2.3m |

Per-task detail, routed categories, call counts and the answers: [`report.md`](report.md);
raw: [`results.json`](results.json).

**Research at 100% on all three, a 7B included.** The pipeline scaffolds the model:
discovery sweep → 5 facets → per-facet search/fetch/synthesis → claim extraction →
per-claim entailment against the cached pages (13 claims, 0 corrections on gemma4) →
Tier-1 cross-check → render → PDF. The "27B for research" line in INSTALL was a guess
about synthesis *quality*; capability is not the gate. Prose quality is unscored here —
read the answers in the report and judge for yourself.

**The misses are model discipline, not plumbing.** qwen3.5:9b answered the task-board
request in prose twice ("I'll add these now…") without calling a tool — the premature-answer
repair fired once and the model repeated itself; the same task passed 100% in run 2 (a flip).
qwen2.5:7b wrote a one-line Python with `with` after semicolons (a syntax error), then
**fabricated** `123456` into revenue.txt — the honest-failure class the engine's guards do not
catch when the model chooses to lie into a file. Its multi task routed to `task` (keyword
"add a task" beat the model's decision — the task specialist has no `read_file`).

After the exec fix (below) both `exec-fib-script` misses re-ran at 100% (run 4):
qwen3.5:9b read the operator refusal and retried without the redirect.

## What the harness found before it could score anything

Run 1 (the wizard's output as of the morning) and run 2 are kept as evidence:
[`run1-baseline-partial.log`](run1-baseline-partial.log),
[`report-run2-before-router-fix.md`](report-run2-before-router-fix.md).

1. **One model, three context sizes = a reload on every hop.** The wizard wrote the router
   at 8K (schema default), extraction at 8K and the session at 32K. On a one-model install
   Ollama reloads on a `num_ctx` change, so router → specialist → capture reloaded the 9B
   each turn (`load=8788ms`), the 2-second router budget blew on **every** message, and
   everything went to keyword fallback. Run 1: 7/7 router timeouts. Fix: one `contextSize`
   for all three when the router is the foreground model; the Starter preset too.
2. **A thinking model routes nothing.** With the reload gone the router answered in 350ms
   — and still never decided. On qwen3.5 the grammar-constrained one-word answer lands in
   the `thinking` field and `response` comes back **empty**; the classifier read that as
   garbage and fell through *silently*. Run 2: qwen3.5:9b routed 0/11 by model; the two
   exec tasks and the research request went to bare chat (80% overall, research 33%).
   Fix: `think: false` on the router's generate call, and the no-category path now logs.
   gemma4:12b never hit this — its answers land in `response` — which is why its run-2
   score was already 95%.
3. **The wizard still shipped the retired architecture.** Its templates emitted
   `pipeline: "plan"` for multi and no `dispatchMode` anywhere — a Custom-wizard user got
   the pre-arena scripted pipelines the fleet abandoned on 2026-08-21. Fix: templates carry
   `dispatchMode: "arena"` like the live config; plan is gone.
4. **No wizard user ever got the research PDF.** `convert_pdf` calls the `document` tool
   through the *scoped* executor, and the wizard's research template did not list it:
   `[ToolRegistry] Blocked unauthorized tool call: document` on every install, with a
   summary delivered as if the report existed. Fix: research/exec/multi templates carry
   `document`; the pipeline now persists `report.md` beside `verification.json`.
5. **exec swallowed the whole command line.** Models put `python3 fib.py > fib.txt` in
   `command`; the allowlist check passed on `python3`, then `execFile` looked for a binary
   literally named that and returned a spawn `ENOENT` the model could not read — qwen3.5
   burned three retries and a `code_session` detour. Fix: a command line splits into
   binary + args (quote-aware) and shell operators are **refused with the reason**.

None of these is visible to the engine eval. All five are visible to the first message a
new user sends.

## The prompt profile A/B (`profile-ab/`)

Same eleven tasks, same two models, on a **lived-in workspace** (USER/TOOLS/AGENTS/LEARNINGS
filled to ~3K tokens, the size of the reference box's), under the `full` profile and the
`small` profile the wizard now writes for a ≤14B foreground (minimal workspace set for
chat, 4K-char file cap, one 16K context everywhere).

| Model | Profile | Overall | Bare-chat prompt | Battery prompt tokens | Wall |
|---|---|---|---|---|---|
| qwen3.5:9b | full | 100% | 2,631 | 79,725 | 133s |
| qwen3.5:9b | **small** | **100%** | **474** | 77,441 | 141s |
| gemma4:12b | full | 91%* | 2,717 | 76,433 | 207s |
| gemma4:12b | **small** | **100%** | **487** | 82,695 | 231s |

\* one Ollama 500 ("prediction aborted") mid-call, scored as a miss before the harness
learned to bucket serving-stack errors as outages; every other task passed.

**What it says.** The small profile cuts a chat turn's prompt **5.5×** with no task lost.
The battery total barely moves because tool specialists already ran on the minimal set;
the profile's lever is the chat and voice turns, which are most of real traffic — and on a
3060 a 2.6K-token prefill is the difference between a reply that starts now and one that
starts in two seconds. The three-run detour to get here found two more one-model-install
bugs: the small profile's 16K context was ping-ponging against the server's 32K default
for every call that named no `num_ctx` (the quality judge, summaries) — six router
timeouts and 5-second reloads per battery — until the generated config also wrote
`ollama.defaultContextSize`; and the harness itself had to build its client from the
generated config to see it.

## Reliability: three reps of qwen3.5:9b (`reliability/`)

The board is one rep per task. A reviewer (rightly) asked what that hides. Three full
batteries of qwen3.5:9b under the wizard's own config (small profile, fresh workspace,
33 task-reps):

| Task | Passes | What happened |
|---|---|---|
| 9 of the 11 tasks, research included | **3/3** each | identical or near-identical traces every rep |
| web-fact-to-file | 2/3 | one rep the router chose `exec` over `multi`; the task still ran but without a web search |
| task-board | **0/3** | the same stall every time: "I'll add these three tasks now…", the repair prompt, then "You're right — I need to actually call the tools. Let me create them." and a stop |

So the flip in the board's 94% row was not a flip. It is a **deterministic stall** on this
model for this request shape: the premature-answer repair makes the model *concede*, and
conceding is where it stops. That is a code-detectable pattern — an answer that announces
an action in its own voice ("let me…", "I'll…", "I need to call…") with no tool call —
so the engine now sends one more nudge, once, bounded like every repair: *"Announcing is
not doing: call the tool now. If you are not going to act, say so plainly."* Rerun of the
task under the nudge: **3/3** (`task-board-after-intent-nudge.log`) — two reps needed it,
one went straight to the tools.

Reliability, then, for a 9B through the real front door: 29/33 task-reps before the nudge,
with three of the four misses being one behaviour that is now guarded, plus one routing flip in
three on a request that is defensibly either category. *(Corrected 2026-09-29 from "30/33":
`reliability/results-qwen3.5-9b-3reps.json` has 29 full passes — task-board 0/3 plus one
web-fact-to-file rep.)*

### Three reps, all three small-tier models, corrected harness (2026-09-28)

The confirm-ledger task's `confirmTools: ['task_add']` had leaked into every task's install
(see DECISIONS "A Harness Mistake That Looked Like Model Decline"), which made two tasks
"fail" for every model. With the gate scoped to its own flow, three reps of the full
12-task battery on a quiet A5000 (`report-*-3reps*.md`, `results-*.json`):

| Model | Task-reps | Overall | Where the misses are |
|---|---|---|---|
| qwen3.5:9b (`…-corrected-harness`) | **36/36** | 100% | none — the intent nudge holds; task-board 3/3 |
| gemma4:12b | 35/36 | 99% | one rep of web-fact-to-file routed `exec` instead of `multi` and never searched |
| qwen2.5:7b | 31/36 | 95% | multi-release-notes 3/3 routed `task`: adds the task, then *announces* the summary and stops; exec-csv-revenue 2/3 wrote the wrong total (one rep 123456 — a fabrication, the caveat from the board) |

Read together: **execution is not where the small tier loses.** Every exec, memory, cron,
website, confirm-ledger and research rep passed on all three models — 45/45 research reps
across the tier, PDF included. The misses are the router (the model classifying its own
request in a one-model install: `exec` for "look up X and write it", `task` for "add a task
and summarize the changes") and, on the 7B, one announced-intent stall AFTER a successful
tool call — a shape the nudge does not cover, since it fires only after the premature-answer
repair. Both are engine/config levers, measurable per model with `--task`, not model swaps.

*(Correction, 2026-09-29, against `reliability/results-gemma4-12b-qwen2.5-7b-3reps.json`:
"every exec rep passed" is not quite right — qwen2.5:7b's two exec-csv-revenue misses in the
table above are exec reps, the model computing or fabricating the wrong total (`123456` once,
an empty file once), not a plumbing failure. And research was 9/9 reps across the three
models, all seven checks each (63/63 checks), PDF included; the "45/45" figure does not
correspond to any count in the result files.)*

## Routing levers (2026-09-29, `routing/`)

The reliability runs located the small tier's losses at the router, so the next night
measured routing levers on the two requests that need two specialists' tools. Shipped: default
category descriptions that say what each specialist cannot do, and a specialist reroute (one
re-dispatch when an arena answer claims or ends announcing an action whose tool it lacks).
Two-specialist requests went from **18/30** to **30/30** across the three models; the full
12-task battery × 3 reps on the final code scored qwen3.5:9b **36/36**, gemma4:12b **36/36**,
qwen2.5:7b **30/36** (its misses: a memory request the 7B now routes to `cron`, reproduced on
the previous day's code, plus exec-csv-revenue noise). A `handoff` tool was built, measured
harmful to small models, and removed. Details, arms and caveats:
[`routing/README.md`](routing/README.md).

## Reading the numbers

- **Prompt tokens per battery are ~77K for 11 tasks** on the 9B/12B — the system prompt is
  ~950 tokens on a fresh install (1.6K workspace + engine scaffolding), plus tool schemas
  (multi carries 13). That is the cost the *small profile* is meant to cut; this run is the
  `full` profile baseline it will be measured against. *(Since measured: see the prompt
  profile A/B above — the chat turn shrinks 5.5×, the battery total barely moves.)*
- **gemma4:12b at 100% is the small-tier foreground pick** when it fits; qwen3.5:9b at
  94% is the floor with one disciplined miss; qwen2.5:7b at 92% is a real fallback for an
  8GB machine, with the caveat that when it fails it may fabricate. *(Superseded 2026-09-28
  by three reps on the corrected harness — qwen3.5:9b 36/36, gemma4:12b 35/36, qwen2.5:7b
  31/36 — and on 2026-09-29 by the routing levers: 36/36, 36/36, 30/36. The single-rep
  ranking between the 9B and the 12B did not hold up.)*
- One rep. Flips exist (task-board on qwen3.5). Treat single-task differences under ~10
  points as noise; the category pattern is the signal.

## Since the board: the confirm ledger, and the selftest in CI

A twelfth task, `confirm-ledger`, exercises the security path the board never touched: the
web channel gates `task_add` behind a confirm, the request must produce a preview and
**no** task, a stranger holding the pending id must be refused (sender-bound), the owner's
confirm must execute the STORED call, and a second confirm of the same id must do nothing
(single-use). It is the one thing the harness adds to the wizard's config, and it is the
only task that talks to `handleConfirmation` the way the console path does.

The `--selftest` now runs in CI on every push and pull request to main, on Linux and on
Windows: it boots the real registry, stores and pipelines in a scratch install and pushes a
scripted perfect performer through every oracle — no model, no Ollama. Since 2026-09-29 the
harness itself is also type-checked in CI (`npm run typecheck` includes
`tsc -p tsconfig.scripts.json`). On a box without LibreOffice (CI) the research PDF check is
skipped with that reason rather than failed; the pipeline cannot render one there either.

## Reproduce

```bash
npx tsx scripts/e2e-eval.ts --selftest                      # oracles vs the reference performer
OLLAMA_URL=http://<host>:11434 npx tsx scripts/e2e-eval.ts qwen3.5:9b gemma4:12b qwen2.5:7b

# the reliability runs: three reps of the full battery
OLLAMA_URL=http://<host>:11434 npx tsx scripts/e2e-eval.ts qwen3.5:9b --reps=3

# the prompt profile A/B arms
OLLAMA_URL=http://<host>:11434 npx tsx scripts/e2e-eval.ts qwen3.5:9b gemma4:12b --profile=full --workspace=lived
OLLAMA_URL=http://<host>:11434 npx tsx scripts/e2e-eval.ts qwen3.5:9b gemma4:12b --profile=small --workspace=lived
```

Flags: `--reps=N` (default 1) · `--task=a,b` (comma list of task ids; also honoured by
`--selftest`) · `--profile=wizard|full|small` (default `wizard`: whatever the wizard writes
for the model) · `--workspace=fresh|lived` · `--label=name` (suffix on the output directory,
so A/B arms don't overwrite each other) · `--reroute=off` · `--descriptions=legacy` (the
routing A/B levers, see `routing/`). `OLLAMA_URL` picks the host (default
`http://localhost:11434`).

Output lands in `data/model-eval/e2e-<date>-<profile>-<workspace>[-<label>]/` (`report.md`
+ `results.json`). Since the 2026-09-29 cleanup the report adds, beside the mean check score,
the full-pass rate (task-reps with every check passed) with a 95% Wilson interval, and the
provenance block redacts a non-loopback model host to `<host>` and records every A/B flag
(`profile`, `workspace`, `label`, `reroute`, `descriptions`). Result files published here
before that date were redacted by hand and do not carry the flag fields.
