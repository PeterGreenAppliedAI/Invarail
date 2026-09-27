# The Small-Tier Eval — Where Tool Use Begins (September 27 2026)

**9 rows · 8 base models (3.8B–14.7B, Q4_K_M) · 14 tasks × 3 reps · deterministic checks · one RTX 3060 (12GB), nothing else loaded**

The [August eval](../2026-08-local-model-eval/) covered 20B–124B and found every model
there could drive the tool loop; the spread was in chat discipline and code. It said
nothing about the tier a first-time user actually has: one consumer GPU or a laptop.
This run is the same harness (`scripts/model-eval.ts`, same battery, same checks) on
every small model resident on the utility box. Invarail was stopped for the duration, so
the numbers are the model's, not a contended GPU's.

## Final Board

`tok/s` is this 3060's number and does not transfer. `min` is wall time for the whole
battery × 3 reps.

| # | Row | Overall | Tool | Extract | Chat | Code | Flips | min | tok/s* | Size |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | gemma4:12b@think=off | **92%** | 100% | 100% | 89% | 78% | 3 | 3.9 | 38 | 11.9B Q4_K_M |
| 2 | qwen2.5:7b (no think) | **81%** | 92% | 100% | 100% | 33% | 1 | 2.4 | 66 | 7.6B Q4_K_M |
| 3 | gemma4:12b@think=on | **79%** | 83% | 100% | 89% | 44% | 6 | 20.0 | 38 | 11.9B Q4_K_M |
| 4 | llama3.1:8b (no think) | **69%** | 74% | 92% | 100% | 11% | 3 | 1.8 | 63 | 8.0B Q4_K_M |
| 5 | phi4:latest (no think) | **67%** | 0% | 100% | 78% | 89% | 3 | 1.7 | 35 | 14.7B Q4_K_M |
| 6 | phi4-mini:latest (no think) | **61%** | 55% | 92% | 85% | 11% | 7 | 1.5 | 104 | 3.8B Q4_K_M |
| 7 | mistral:7b (no think) | **61%** | 58% | 92% | 93% | 0% | 5 | 2.8 | 69 | 7.2B Q4_K_M |
| 8 | gemma3:4b (no think) | **53%** | 0% | 92% | 89% | 33% | 0 | 1.1 | 92 | 4.3B Q4_K_M |
| 9 | gemma3n:e4b (no think) | **42%** | 0% | 100% | 67% | 0% | 0 | 1.2 | 73 | 6.9B Q4_K_M |

## What the board says

1. **Extraction is solved at every size.** Grammar-constrained decoding does the work:
   even the 4B models score 92–100% on cron/message/nested schemas. The utility tier
   (router, NER, fact extraction, consolidation) can stay tiny.
2. **Native tool use begins at 12B.** gemma4:12b with thinking OFF drives the tool loop
   at 100% — single call, two-step chain, restraint under a repair prompt, error
   honesty, and the 9-hop long-horizon chain — at 3.9 minutes for the battery. Below it,
   qwen2.5:7b (92%) is the only small model that is close; llama3.1:8b 74%, mistral 58%,
   phi4-mini 55%.
3. **Thinking hurts a small model the same way it hurt the 27Bs.** gemma4:12b with
   thinking ON drops to 79% (tool 83%, long-horizon 50%) and takes 5× longer. The
   August lesson — models fail at budgets, not tasks — holds one tier down.
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
| **Foreground chat + arena tools** | **gemma4:12b, thinking OFF** (92%) | 27B, thinking off (97–100%) | qwen2.5:7b (81%) if 12B does not fit; nothing smaller drives tools reliably |
| Research synthesis + verification | 27B | 27B+ | long-horizon at 12B is 100% but code/synthesis budgets are not |
| Voice replies | the foreground model | same | live: 7B and 3.8B failed on quality |
| Coding via Pi | 27B | 30B coder or hosted | August duel: a 27B went 4-0 |

## Hardware → tier

| Machine | Fits | You get |
|---|---|---|
| 8GB RAM, no GPU | qwen2.5:7b (4.7GB) doing everything | Tier 0 chat; tools mostly work; no code |
| 16GB RAM or 12GB GPU | gemma4:12b (7.6GB) foreground + phi4-mini utility | the daily driver minus research/code |
| 24GB GPU or 32GB unified | a 27B foreground + the utility pair | everything measured at 97–100% |
| 48GB+ | 27B + a 30B coder resident | everything, no eviction |

## Provenance

Run `data/model-eval/run-2026-09-27T17-23-28` (report.md and results.json copied here
verbatim). Harness `scripts/model-eval.ts`; tool-loop tasks run at `contextSize: 16384`;
mock tools; temperatures 0.3 tool/chat, 0.1 extract. The starter preset was changed on
the strength of row 1: `gemma4:12b` with `think: false` replaces the never-measured
`qwen3:8b`.
