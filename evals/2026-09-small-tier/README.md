# The Small-Tier Eval — Where Tool Use Begins (September 27 2026)

**13 rows · 10 base models (1.5B–14.7B, Q4_K_M) · 14 tasks × 3 reps · deterministic checks · two runs: an RTX 3060 (12GB) with nothing else loaded, then an A5000 for the two models only it held**

The [August eval](../2026-08-local-model-eval/) covered 20B–124B and found every model
there could drive the tool loop; the spread was in chat discipline and code. It said
nothing about the tier a first-time user actually has: one consumer GPU or a laptop.
This run is the same harness (`scripts/model-eval.ts`, same battery, same checks) on
every small model resident on the utility box. Invarail was stopped for the duration, so
the numbers are the model's, not a contended GPU's.

## Final Board

`tok/s` is per-GPU and does not transfer between the two runs. `min` is wall time for the
whole battery × 3 reps.

| # | Row | Overall | Tool | Extract | Chat | Code | Flips | min | tok/s* | Size | GPU |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | gemma4:12b@think=off | **92%** | 100% | 100% | 89% | 78% | 3 | 3.9 | 38 | 11.9B Q4_K_M | 3060 |
| 2 | qwen3.5:9b@think=off | **92%** | 100% | 100% | 100% | 67% | 0 | 2.1 | 91 | 9.7B Q4_K_M | A5000 |
| 3 | qwen3.5:9b@think=on | **89%** | 100% | 100% | 89% | 67% | 0 | 7.0 | 91 | 9.7B Q4_K_M | A5000 |
| 4 | qwen2.5:7b (no think) | **81%** | 92% | 100% | 100% | 33% | 1 | 2.4 | 66 | 7.6B Q4_K_M | 3060 |
| 5 | gemma4:12b@think=on | **79%** | 83% | 100% | 89% | 44% | 6 | 20.0 | 38 | 11.9B Q4_K_M | 3060 |
| 6 | llama3.1:8b (no think) | **69%** | 74% | 92% | 100% | 11% | 3 | 1.8 | 63 | 8.0B Q4_K_M | 3060 |
| 7 | phi4:latest (no think) | **67%** | 0% | 100% | 78% | 89% | 3 | 1.7 | 35 | 14.7B Q4_K_M | 3060 |
| 8 | phi4-mini:latest (no think) | **61%** | 55% | 92% | 85% | 11% | 7 | 1.5 | 104 | 3.8B Q4_K_M | 3060 |
| 9 | mistral:7b (no think) | **61%** | 58% | 92% | 93% | 0% | 5 | 2.8 | 69 | 7.2B Q4_K_M | 3060 |
| 10 | deepseek-r1:1.5b@think=on | **59%** | 54% | 81% | 89% | 11% | 7 | 3.1 | 303 | 1.8B Q4_K_M | A5000 |
| 11 | deepseek-r1:1.5b@think=off | **57%** | 55% | 83% | 89% | 0% | 3 | 3.1 | 303 | 1.8B Q4_K_M | A5000 |
| 12 | gemma3:4b (no think) | **53%** | 0% | 92% | 89% | 33% | 0 | 1.1 | 92 | 4.3B Q4_K_M | 3060 |
| 13 | gemma3n:e4b (no think) | **42%** | 0% | 100% | 67% | 0% | 0 | 1.2 | 73 | 6.9B Q4_K_M | 3060 |

## What the board says

1. **Extraction is solved at every size.** Grammar-constrained decoding does the work:
   even the 4B models score 92–100% on cron/message/nested schemas. The utility tier
   (router, NER, fact extraction, consolidation) can stay tiny.
2. **Native tool use begins at 9–12B.** Two models drive the whole loop at 100% —
   single call, two-step chain, restraint under a repair prompt, error honesty, the 9-hop
   long-horizon chain: **qwen3.5:9b** (6.6GB, thinking off: 92% overall, perfect chat
   discipline, zero flipped checks, 2.1 min) and **gemma4:12b** (7.6GB, thinking off: 92%,
   stronger on code). Below them qwen2.5:7b (tool 92%) is the only one close; llama3.1:8b
   74%, mistral 58%, phi4-mini 55%, deepseek-r1:1.5b 55%.
3. **Thinking hurts a small model the same way it hurt the 27Bs.** gemma4:12b with
   thinking ON drops to 79% (tool 83%, long-horizon 50%) and takes 5× longer; qwen3.5:9b
   loses 3 points and takes 3.3× longer. The August lesson — models fail at budgets, not
   tasks — holds one tier down. deepseek-r1:1.5b is the floor of the floor: thinking
   changes nothing, extraction drops to 81–83% (the first sub-90 in either run), 7
   flipped checks.
4. **Three models cannot native-tool-call on Ollama at all.** phi4 (14B), gemma3:4b and
   gemma3n:e4b returned HTTP 400 on every tool task (`SERVING_INCOMPATIBLE`): their
   Ollama chat templates have no tool support. That is a serving fact, not a competence
   score — phi4 scores 100% extraction and 89% code with no tools in the prompt. For
   Invarail it means: these are router / extraction models, or text-style tool callers
   (`toolStyle: "text"`), never native arena specialists.
5. **Code is a 27B-class job.** gemma4:12b@off reaches 78% on the build task; nothing
   else under 15B passes it reliably. The doctrine stands: coding goes to a 27B+ or a
   hosted model, gated by real tests.

## Model minimums, by role (this run + the August run + live observation)

| Role | Floor (measured) | Comfortable | Notes |
|---|---|---|---|
| Router (one-word classify) | phi4-mini 3.8B | phi4 14B | extraction-class task; live: phi4-mini misroutes more than phi4 |
| NER · fact extraction · consolidation | phi4-mini 3.8B | phi4 14B | 92–100% extraction at every size |
| Embeddings | qwen3-embedding 4B | 8B | `embeddingDims` must match |
| **Foreground chat + arena tools** | **qwen3.5:9b, thinking OFF** (92%, 6.6GB) or gemma4:12b (92%, 7.6GB, better code) | 27B, thinking off (97–100%) | qwen2.5:7b (81%) on an 8GB machine; nothing smaller drives tools reliably |
| Research synthesis + verification | 27B | 27B+ | long-horizon at 12B is 100% but code/synthesis budgets are not |
| Voice replies | the foreground model | same | live: 7B and 3.8B failed on quality |
| Coding via Pi | 27B | 30B coder or hosted | August duel: a 27B went 4-0 |

## Hardware → tier

| Machine | Fits | You get |
|---|---|---|
| 8GB RAM, no GPU | qwen2.5:7b (4.7GB) doing everything | Tier 0 chat; tools mostly work; no code |
| 16GB RAM or 12GB GPU | qwen3.5:9b (6.6GB) or gemma4:12b (7.6GB) foreground + phi4-mini utility | the daily driver minus research/code |
| 24GB GPU or 32GB unified | a 27B foreground + the utility pair | everything measured at 97–100% |
| 48GB+ | 27B + a 30B coder resident | everything, no eviction |

## Provenance

Runs `data/model-eval/run-2026-09-27T17-23-28` (3060; report.md / results.json) and
`run-2026-09-27T18-08-39` (A5000, deepseek-r1:1.5b + qwen3.5:9b; report-a5000.md /
results-a5000.json), copied here verbatim — harness commits `4251383` and `16b147e`
respectively, clean trees. (The generated reports' title and "Serving stack" paragraph are
the August template's boilerplate — "20-33B Field", Spark gateway, deepseek via ds4 — and
do not describe these runs; the serving host for both was a single Ollama, redacted `<host>`.) Invarail was stopped for both. Harness `scripts/model-eval.ts`; tool-loop tasks run at `contextSize: 16384`;
mock tools; temperatures 0.3 tool/chat, 0.1 extract. The starter preset was changed on
the strength of the top rows: `qwen3.5:9b` with `think: false` (gemma4:12b as the named
alternate) replaces the never-measured `qwen3:8b`.

> **Later result (2026-09-28/29):** the same three candidates run end to end through the
> real front door (router → dispatch → arena, wizard-generated config) in
> [2026-09-e2e](../2026-09-e2e/README.md#three-reps-all-three-small-tier-models-corrected-harness-2026-09-28):
> qwen3.5:9b 36/36, gemma4:12b 35/36, qwen2.5:7b 31/36 — the 7B's losses are at the router,
> not in execution. This board's engine-only numbers stand as measured.
