# Part 2 source material — "the numbers, as promised"

Raw material for the follow-up post. Charts in this directory are screenshot-ready
(leaderboard.png is the hero image; think_ab.png is the argument; cost_vs_score.png
is the economics).

---

## What the eval was

I benchmarked every local model on my cluster — 23 of them, 20B to 124B — inside the
actual production harness of my local agent system. Not prompts-in-a-vacuum: the real
tool-calling engine with its guardrails, the real JSON-extraction pipeline with its
grammar constraints, real instruction rules, and a Docker sandbox that RUNS the code
the models write and grades it with assertions.

14 tasks, everything scored by deterministic code checks — no LLM judges. Each task
three times, because single runs lie (one model scored 84% and 100% on the same day).
And the twist that turned out to be the whole story: every thinking-capable model ran
the entire battery TWICE — reasoning enabled, reasoning suppressed.

39 scorecard rows. ~1,600 scored task executions. Two days.

## The result nobody's leaderboard shows

The #1 model on my board is a mid-tier 17GB model that scored 82% in its default
configuration — and 100%, perfectly stable, at one-fifth the token cost, with ONE
config flag flipped (thinking off).

Same weights. Same tasks. The difference between "written off" and "flawless" was a
default nobody questions.

And there's no universal rule. Three archetypes, measured:
- Thinking HARMFUL: the qwen family, gemma4-26B, Lightning (+3 to +18 points from
  turning it off, 4-6× cheaper, instability vanishes)
- Thinking LOAD-BEARING: gpt-oss, gemma4-31B, nemotron-nano (turn it off and quality
  drops — for one model, cost went UP too)
- Thinking PURE TAX: muse-glimmer, deepseek, the 35B — identical scorecards, up to
  5.7× the price

Siblings from the same family land in opposite camps. You cannot predict membership
from the model card. You can only measure it.

## The hurdles (each one was almost a wrong conclusion)

1. **"This model is terrible at extraction"** → our pipeline gave models 256 output
   tokens; thinking models spend that budget reasoning before the JSON starts. The
   model was fine. The budget was starving it. (33% → 100% after the fix.)
2. **"This model can't code"** → our evaluator passed markdown-nested code fences to
   Python with the indentation intact. The code was correct. Our parser wasn't.
3. **"The gateway isn't enforcing JSON schemas"** → wire-level interception proved it
   was. We'd accused the wrong layer; the theory died to one packet capture.
4. **"Three models failed the long-horizon task"** → those were 503s from a node
   timeout killing healthy generations mid-task. Models fine; infra config.
5. **"The A/B experiment is easy"** → the serving layer was silently DROPPING the
   thinking parameter. Every experiment before the fix was a placebo. And one model
   ACCEPTS the suppression flag and silently ignores it — trust nothing you haven't
   verified at the wire.
6. **One model's "infrastructure failures"** → actually the model emitting malformed
   tool-call XML that crashed the runtime's parser. Infra symptom, model fault — the
   opposite direction of #4. You need a failure taxonomy or you'll mislabel both.

Score of the week: eval found ~zero model bugs it went looking for, and six bugs in
the two systems doing the measuring.

## Quotable lines

- Thinking models rarely fail at tasks — they fail at budgets. Timeouts, token caps,
  format contracts. Production is made of budgets.
- The second-most important spec of a local model is its default configuration.
- A 67GB model, beaten by a 17GB model running with its reasoning turned OFF.
- Accommodate the transport, never the answer.
- tok/s is a fact about your hardware. Tokens-per-finished-task is a fact about the
  model. Only one of them transfers.
- Every model in my fleet got better this week. None of the weights changed.

## Numbers for the post

- 39 rows · 23 models · 14 tasks · 3 reps · ~50 deterministic checks per row
- Biggest single turnaround: +18 points from one config flag
- Token cost spread: 950 to 19,225 per identical battery (20×) — the most expensive
  row scored 50%
- Heavyweights (67-124GB): 7 rows, 1 podium finish
- 2 perfect scorecards, achieved with OPPOSITE thinking configurations
- 6 infrastructure/harness bugs found and fixed across 2 codebases + 2 reported
  upstream to Ollama
