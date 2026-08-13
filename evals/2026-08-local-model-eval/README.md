# The Local Model Eval That Kept Finding Our Bugs Instead

**39 scorecard rows · 23 base models (20–124B) · thinking on/off/low A/B · 14 tasks × 3 repetitions · deterministic code checks only**

An engine-in-the-loop evaluation of every local model on our cluster, run through the
*production* harness of [Invarail/LocalClaw](../../) — the real ReAct engine, the real
grammar-constrained extraction pipeline, the real instruction rules, and a Docker
sandbox that executes the code the models write. Not a model-in-isolation benchmark:
a measurement of what these models do inside a working agent system.

It began as "is Meta's new 28B any good?" It ended with five of our own theories
disproven, six bugs fixed across two codebases, and a podium of three perfect
scorecards achieved with three *different* thinking configurations — none of them
the default. The #1 row belongs to a model its owner had written off as unusable:
it needed permission to think *less*, and until this week no layer of the stack
could even deliver that request.

> **TL;DR:** The second-most important spec of a local model is its default
> configuration. Thinking models rarely fail at tasks — they fail at *budgets*
> (timeouts, token caps, format contracts), and production is made of budgets.

---

![Leaderboard — top 20](./leaderboard.png)

![The Thinking A/B](./think_ab.png)

![Cost vs Quality](./cost_vs_score.png)

## Final Board

Sorted by overall score, then cost. `flips` = checks that changed pass/fail between
repetitions (stability). `ctok` = mean completion tokens to finish the full battery —
a **hardware-independent cost metric**. `tok/s` is serving-stack-specific (see
[Provenance](#provenance)) and does not transfer.

| # | Row | Overall | Tool | Extract | Chat | Code | Flips | ctok | tok/s* |
|---|---|---|---|---|---|---|---|---|---|
| 1 | gpt-oss:120b@think=low | **100%** | 100% | 100% | 100% | 100% | 0 | 2,299 | 41.6 |
| 2 | qwen3.6:27b@think=off | **100%** | 100% | 100% | 100% | 100% | 0 | 2,307 | 12 |
| 3 | gemma4:31b@think=on | **100%** | 100% | 100% | 100% | 100% | 0 | 5,436 | 10.4 |
| 4 | gpt-oss:120b@think=on | **99%** | 97% | 100% | 100% | 100% | 1 | 4,605 | 41.1 |
| 5 | muse-glimmer:latest@think=on | **99%** | 97% | 100% | 100% | 100% | 3 | 8,995 | 12.1 |
| 6 | deepseek-v4-flash@think=on | **99%** | 100% | 100% | 96% | 100% | 1 | 6,774 | 20.2 |
| 7 | muse-glimmer:latest@think=off | **99%** | 96% | 100% | 100% | 100% | 4 | 3,839 | 12 |
| 8 | nemotron-3-nano:30b@think=on | **98%** | 100% | 100% | 93% | 100% | 1 | 8,009 | 74 |
| 9 | gemma4:31b@think=off | **97%** | 100% | 100% | 100% | 89% | 3 | 1,503 | 10.1 |
| 10 | gemma4:26b@think=off | **97%** | 100% | 100% | 89% | 100% | 0 | 1,648 | 59.3 |
| 11 | nemotron-3.5-lightning:latest@think=off | **97%** | 100% | 100% | 89% | 100% | 0 | 2,187 | 55.8 |
| 12 | gpt-oss:20b@think=on | **97%** | 100% | 100% | 100% | 89% | 3 | 4,212 | 109.8 |
| 13 | deepseek-v4-flash@think=off | **96%** | 100% | 100% | 85% | 100% | 1 | 2,079 | 21.5 |
| 14 | qwen3:32b@think=off | **95%** | 100% | 100% | 81% | 100% | 1 | 1,431 | 10 |
| 15 | qwen3-coder:30b (no think) | **95%** | 100% | 92% | 89% | 100% | 0 | 1,910 | 85.1 |
| 16 | gpt-oss:20b@think=off | **94%** | 100% | 100% | 100% | 78% | 6 | 4,952 | 32.1 |
| 17 | nemotron3:33b@think=on | **94%** | 96% | 100% | 93% | 89% | 6 | 9,303 | 70.8 |
| 18 | nemotron-cascade-2:30b@think=on | **94%** | 97% | 97% | 93% | 89% | 9 | 8,603 | 73.2 |
| 19 | nemotron-3.5-lightning:latest@think=on | **94%** | 100% | 100% | 96% | 78% | 4 | 9,564 | 65.2 |
| 20 | nemotron-3-super:latest@think=on | **93%** | 100% | 97% | 96% | 78% | 8 | 8,435 | 21.2 |
| 21 | qwen3.6:35b@think=on | **93%** | 100% | 100% | 93% | 78% | 5 | 13,707 | 69.9 |
| 22 | nemotron3:33b@think=off | **93%** | 89% | 100% | 93% | 89% | 6 | 1,349 | 69.8 |
| 23 | gemma4:26b@think=on | **92%** | 92% | 100% | 89% | 89% | 11 | 9,987 | 62.3 |
| 24 | nemotron-cascade-2:30b@think=off | **92%** | 100% | 100% | 89% | 78% | 3 | 2,157 | 71.7 |
| 25 | qwen3.6:35b@think=off | **92%** | 100% | 100% | 100% | 67% | 0 | 2,400 | 68.3 |
| 26 | qwen3-coder-next:latest (no think) | **89%** | 100% | 100% | 89% | 67% | 0 | 1,841 | 58.5 |
| 27 | qwen3.5:27b@think=off | **89%** | 100% | 100% | 89% | 67% | 0 | 2,525 | 12 |
| 28 | llama4:scout (no think) | **89%** | 86% | 92% | 100% | 78% | 8 | 2,662 | 18.3 |
| 29 | nemotron-3-super:latest@think=off | **88%** | 93% | 100% | 70% | 89% | 9 | 3,861 | 21.1 |
| 30 | nemotron-3-nano:30b@think=off | **88%** | 95% | 100% | 89% | 67% | 0 | 1,689 | 72.8 |
| 31 | devstral:24b (no think) | **86%** | 99% | 100% | 100% | 44% | 4 | 1,469 | 13.8 |
| 32 | qwen2.5-coder:32b (no think) | **85%** | 50% | 100% | 100% | 89% | 3 | 950 | 3.2 |
| 33 | qwen2.5:72b (no think) | **83%** | 100% | 100% | 100% | 33% | 0 | 1,551 | 4.4 |
| 34 | qwen3.5:27b@think=on | **83%** | 100% | 67% | 100% | 67% | 0 | 13,102 | 12.1 |
| 35 | qwen3.6:27b@think=on | **82%** | 100% | 67% | 85% | 78% | 5 | 12,437 | 12.1 |
| 36 | qwen3:32b@think=on | **81%** | 100% | 100% | 93% | 33% | 1 | 6,537 | 10 |
| 37 | glm-4.7-flash:latest@think=off | **61%** | 87% | 89% | 67% | 0% | 8 | 8,766 | 61.7 |
| 38 | deepseek-coder:33b (no think) | **59%** | 0% | 97% | 74% | 67% | 8 | 980 | 4.3 |
| 39 | glm-4.7-flash:latest@think=on | **43%** | 83% | 39% | 48% | 0% | 18 | 23,085 | 62.5 |

## The Thinking A/B — the headline result

Every thinking-capable model ran the identical battery twice: thinking enabled and
suppressed. **Thinking value is a per-model property.** Three archetypes emerged, and
no rule predicts membership — not family, not size, not "reasoning-tuned" branding:

| Archetype | Models | Evidence |
|---|---|---|
| **Thinking is harmful** | qwen3.6:27b, qwen3:32b, qwen3.5, gemma4:26b, Lightning, glm | qwen3.6:27b: 82% → **100%, zero flips** with thinking off, at 1/5 the tokens. gemma4:26b: 11 flips → 0. Lightning's only code failure was thinking-induced. |
| **Thinking is load-bearing** | gemma4:31b, nemotron-3-nano | gemma4:31b: 100% → 97% without it. nano: 98% → 88%. |
| **Thinking wants a dial, not a switch** | gpt-oss (both sizes) | No off-mode by design (effort levels; the obedience audit showed BOTH sizes ignore `think:false` — 20b leaked thinking on 40% of "suppressed" rows, 120b on 27%). Their `@think=off` rows measured *leaky* reduced thinking, asterisked accordingly. The valid measurement: 120b at **`low`: 100%, zero flips, half the tokens** — the board's #1 row. The failure mode was never capability; it was effort spent where none was needed. |
| **Thinking is a pure tax** | muse-glimmer, deepseek-v4-flash*, qwen3.6:35b, cascade-2, nemotron3 | qwen3.6:35b: *identical scorecard* at 5.7× the cost. muse: same 99, same flaw, 2.3× the bill. (*deepseek's thinking buys chat manners only.) |

Within one family (gemma4 26B vs 31B; the nemotrons), siblings land in opposite camps.
**Measure, don't reason about reasoning.**

### Why thinking "fails"

Traced mechanisms, all reproducible:
- **Token starvation** — thinking counts against `num_predict`; small budgets are
  exhausted before the answer starts (extraction budgets, code-task caps).
- **Timeouts** — qwen3.5 ruminated past a 120s ceiling on the same task, every rep.
- **Contract leaks** — reasoning prose escaping untagged into content, breaking
  format checks (both qwen3.6 distillations, ~5–10% of turns, weights-level).
- **Variance injection** — gemma4:26b's instability lived entirely in its thinking.

## Other Findings

1. **Unconfigured heavyweights are dead weight; configured, one redeemed itself.**
   Of eight rows from 67–124B models, six placed mid-pack or worse — llama4:scout
   (67GB) scored 89% with 8 flips, beaten by a 17GB model running with reasoning
   disabled. The exception proves the config thesis: gpt-oss:120b at *floor effort*
   took the board's #1 row. On this workload class, VRAM alone buys nothing; VRAM
   plus the right configuration bought first place exactly once.
2. **Coder-tuned models are metronomes** — qwen3-coder, qwen2.5-coder,
   qwen3-coder-next all posted **zero flipped checks**: reliably imperfect, precisely
   gateable. Thinking-mode chat models are coin-flips (up to 13 flips).
3. **Cost decouples from quality entirely**: 950 → 23,085 ctok across the board
   (24×), with the most expensive row scoring 43%.
4. **Real-world coding beats puzzle coding as a discriminator.** Our three tasks
   (messy-CSV cleanup, an off-by-one booking bug, a log summarizer) produced
   *plausible* failures: silently dropped quoted amounts (wrong totals that look
   right), a spec-violating output format shipped consistently. A model that fails
   the contract fails — regardless of how sound its internals were.
5. **Vendor speed claims flattened locally.** A "30% faster than qwen3.6-35B" claim
   measured dead even on our quants/serving. tok/s is a property of the serving
   stack; ctok transfers.

## What the eval fixed (the real yield)

Every one of these was initially misdiagnosed as a model failure:

| Finding | Layer | Fix |
|---|---|---|
| 256-token extraction budget starving thinking models into "broken" output | Invarail | default 2048 ([31d4701](../../commit/31d4701)) |
| Coercive repair prompt sending 13/16 models into fabricated tool-call spirals | Invarail engine | fair-exit wording |
| Gemma-4 thinking format unparsed → wasted repair round-trips | Invarail extractor | `stripThinkingTags` |
| `think` parameter silently dropped; `thinking` field discarded (non-streaming) | Gateway | forwarded + returned + audited |
| glm 503s = Ollama's GLM parser crashing on the model's own malformed tool-call XML | Ollama (upstream) | reported; reclassified as model-attributable |
| gpt-oss:120b + format + think:false → output generated then silently discarded | Ollama (upstream) | reported; see [reclassifications](#reclassifications--pending-verification) |
| Long generations killed by a 120s node timeout, surfacing as anonymous 503s | Gateway config | timeout raised; 503s now carry their cause |

## Exhibition entry: a frontier model on the same battery

Out of competition — different harness, so not a board row. A Claude (Opus 4.7)
subagent ran the identical 14 tasks: same canned tool observations (served via a
mock-tool CLI, calls logged for grading), same prompts verbatim, same deterministic
checks, same Docker sandbox for the code.

**Result: 100% — 56/56 checks, single rep.** Zero tool calls on the restraint task,
the 9-hop hunt in exactly 9 calls with zero wrong codes, exact cron expression,
perfect stop-rule discipline ("You're welcome, Peter." — 22 characters), all three
code submissions passing every basic and edge assertion.

Read this with its caveats: one repetition (no stability column); its own agentic
loop rather than our ReAct engine (it never faced the premature-refusal challenge
the local models did); a frontier cloud model against local Q4 quants.

**The token footprint is its own finding.** The exhibition's 100% cost ~413k total
tokens — but ~28.9k of every agent's ~29.5k was a near-constant baseline: the
general-purpose agent apparatus (system prompt, tool schemas) shipped to each task.
Marginal task work above baseline: **~8.5k tokens across all 14 tasks** — the same
band as the local batteries (2.3k–9k ctok). 98% of the frontier run's traffic was
harness, not work. (Footprint comparison, not strict: total tokens vs
completion-only ctok.) A purpose-built specialist harness running a well-configured
local model did identical work for 2,307 completion tokens — the generality tax is
real, and it dwarfs the model-capability gap on this workload class. What it
honestly establishes is the battery's ceiling: **these tasks are fully solvable, and
the top locally-served rows — 120b@low, qwen3.6@off, gemma31@on — matched a frontier
model's score on this workload.** Which is both a compliment to well-configured
local models and a confession about the battery: it measures production harness-fit,
not capability frontiers. The planned reasoning-loaded addendum exists precisely
because a battery three local models and a frontier model all ace cannot rank what
none of them was forced to struggle with.

## Methodology

- **Dimensions**: tool-loop (single call, dependent chain, restraint-under-challenge,
  404 honesty, 9-hop state-carrying hunt), extraction (grammar-constrained JSON:
  cron, enums, nested arrays), chat discipline (stop rule, exact format, bare JSON),
  coding (execution-verified in a network-less Docker sandbox against basic + edge
  assertion batteries, pre-validated with reference solutions).
- **Scoring**: deterministic code checks only; means over 3 reps; per-check pass
  rates; flipped checks reported as stability. Prose quality deliberately unscored —
  raw outputs are published for human review (see `report.md`).
- **Failure taxonomy**: MODEL_FAILURE / TIMEOUT (scored 0, labeled) /
  SERVING_INCOMPATIBLE (labeled loudly) / PROVIDER_OUTAGE (retried once, then
  UNSCORED — excluded from means, never counted against the model).
- **Think A/B**: runtime capability probing (a model must *accept* think control to
  get A/B rows; see pending obedience audit below). Effort-level models (gpt-oss)
  have no off-mode by design.
- **Accommodations** (transport normalized, content never): thinking-tag stripping
  (two formats), markdown fence dedenting, longest-fence code extraction, JSON5
  tolerance, tool-call fallback parsers. Every accommodation is part of the score
  and listed here deliberately.
- **Engine-in-the-loop**: tasks run inside the production ReAct engine including its
  guardrails. T3 measures restraint against a repair prompt that offers an explicit
  no-tool exit; the pre-fix (coercive-prompt) baseline is preserved in run
  `2026-08-11T21-10-06`.

## Provenance

- **Harness**: [`scripts/model-eval.ts`](../../blob/main/scripts/model-eval.ts) at
  commit `6b9b22f` (clean tree), 3 reps, run `2026-08-12T07-34-43`.
- **Serving topology — two distinct paths**: (1) Ollama fleet on a DGX Spark cluster
  behind a FastAPI gateway proxy (per-box Ollama 0.32.9/0.30.8, one legacy box);
  (2) deepseek-v4-flash served **directly** by
  [ds4/DwarfStar](https://github.com/antirez/ds4) (OpenAI-compat, no gateway,
  default thinking / high effort). Cross-comparisons with deepseek span different
  stacks.
- **Quantization**: Q4_K_M / MXFP4 throughout. Results may differ at higher precision.
- Model digests per row in `results.json`.

## Reclassifications & verification status

This board merges the base run with a post-deploy addendum (both provenance blocks
in `results.json`). Resolved:

- **qwen3.6:35b pair rerun** ✅ — its T5 exclusions were a 120s node timeout killing
  healthy long generations (the model-side transcript was verified clean in the
  gateway audit). With the timeout raised, its pair was rerun with T5 fully measured.
- **glm-4.7-flash pair rerun** ✅ — its tool-task "outages" were Ollama's GLM parser
  crashing on the model's own malformed tool-call XML (a model failure surfacing as
  an infra symptom, pre-fix invisible in the audit log). Rerun post-deploy with
  cause-carrying errors: the failures now score as the model failures they are
  (43%/61%, the board's floor).
- **gpt-oss:120b@think=off retired as invalid** ✅ — the model ignores boolean
  suppression at the weights level (effort levels are its native control; *accepts ≠
  obeys*). Two defects at two layers: no off-mode (model design, permanent) and
  silent output-discard under format+ignored-suppression (Ollama bug, reported
  upstream). Replaced by the legitimate measurement: **`@think=low`, which took the
  board's #1 row.** The retired row is preserved in `results.json` under `retired`.
- **Obedience audit complete** ✅ — every `@think=off` row cross-checked against the
  gateway audit trail (~2,600 A/B rows: did the model return thinking despite
  suppression?). **15 of 17 models clean** — zero disobedient rows for every qwen,
  gemma4, glm, nemotron, muse, and the coder one-offs: their think-off columns are
  honest measurements. **Both gpt-oss sizes disobey** (20b: 40% of suppressed rows
  returned thinking; 120b: 27%) — the 20b had merely looked honest because it never
  trips the format-collision discard. Both gpt-oss `@think=off` rows are therefore
  asterisked: they measured *leaky reduced thinking*, not off; the family's valid
  control is effort levels.
- **A third silent-discard shape** surfaced in the audit: muse-glimmer (5 rows) and
  nemotron3:33b (3 rows) returned token-generating, all-empty responses under
  `think:false` with *no format schema* — the grammar-collision explanation doesn't
  cover these. Retroactive detection against our token meter shows exactly one
  scored casualty: muse-glimmer@think=off's single T2 failure (554 tokens generated,
  empty answer) — the one blemish keeping that row from 100% is *possibly this
  runtime bug*, unresolvable retroactively, annotated not rescored. Reported
  upstream alongside the format-collision variant; the gateway's silent-discard
  detector now logs all shapes.

**The board is final.**

## Limitations

Three reps captures gross instability, not tail behavior (a check went 0/3 → 3/3
between same-day batteries once). Mock tool observations are canned. The battery has
no task where deliberation is plausibly *required* — a reasoning-loaded addendum
(constraint scheduling, computed reconciliation, interaction bugs) is designed to
test whether thinking wins where it should. One gateway, one quant level, one
serving snapshot. The tasks mirror one production workload — ours.

## Reproduce

```bash
# full field, think A/B auto-probed
npx tsx scripts/model-eval.ts

# specific rows
npx tsx scripts/model-eval.ts qwen3.6:27b@think=off gpt-oss:120b@think=low
```

Needs an Ollama-compatible endpoint in `invarail.config.json5` and Docker for the
sandbox. Every run emits `results.json` + `report.md` with full provenance.

## Artifacts

- [`results.json`](./results.json) — all 39 rows: per-rep task results, checks,
  errors, buckets, token costs, digests.
- [`report.md`](./report.md) — the generated full report: per-task pass rates,
  infrastructure events, and **raw model outputs side-by-side** for human review.
- The decision log for the whole saga: [`DECISIONS.md`](../../blob/main/DECISIONS.md)
  ("The Model Eval That Kept Finding Our Bugs Instead").
