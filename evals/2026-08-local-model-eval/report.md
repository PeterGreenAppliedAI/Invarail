# Model Eval — 20-33B Field (+35B anchor)

**Run:** data/model-eval/run-2026-08-12T07-34-43 · **Date:** 2026-08-12T07:34:43.458Z · **Harness:** `scripts/model-eval.ts` @ 6b9b22f · **Reps per task:** 3

**Serving stack:** http://10.0.0.20:8001. All throughput/latency figures reflect THIS serving topology only — TWO distinct paths: (1) Ollama fleet (DGX Spark cluster) behind a FastAPI gateway proxy (per-box Ollama 0.32.9/0.30.8; one legacy 0.12.5 box), Q4_K_M/MXFP4 quantizations; (2) deepseek-v4-flash served DIRECTLY by ds4/DwarfStar (github.com/antirez/ds4, OpenAI-compat, no gateway in path) — cross-comparisons with it span different stacks. None of these figures are intrinsic model properties; they will not transfer to other hardware, quants, or serving engines.

**Scoring:** deterministic code checks only, averaged over 3 repetitions. Failure taxonomy separates model behavior from infrastructure: PROVIDER_OUTAGE reps are retried once, then excluded from means (UNSCORED) — never counted as model failures. TIMEOUT and SERVING_INCOMPATIBLE score 0 but are labeled (operationally real, causally different). Subjective prose quality is intentionally unscored — raw outputs below.

## Scoreboard

| # | Model | Overall | Tool-loop | Extract | Chat | Code | Stability | ctok† | tok/s\* | Load |
|---|-------|---------|-----------|---------|------|------|-----------|-------|--------|------|
| 1 | gpt-oss:120b@think=low | **100%** | 100% | 100% | 100% | 100% | stable | 2,299 | 41.6 | 12.1s |
| 2 | qwen3.6:27b@think=off | **100%** | 100% | 100% | 100% | 100% | stable | 2,307 | 12 | 0.9s |
| 3 | qwen3.8:27b@think=on | **100%** | 100% | 100% | 100% | 100% | stable | 4,810 | 19.3 | 0.7s |
| 4 | gemma4:31b@think=on | **100%** | 100% | 100% | 100% | 100% | stable | 5,436 | 10.4 | 0.9s |
| 5 | gpt-oss:120b@think=on | **99%** | 97% | 100% | 100% | 100% | 1 flip | 4,605 | 41.1 | 0.6s |
| 6 | muse-glimmer:latest@think=on | **99%** | 97% | 100% | 100% | 100% | 3 flips | 8,995 | 12.1 | 0.8s |
| 7 | deepseek-v4-flash@think=on | **99%** | 100% | 100% | 96% | 100% | 1 flip | 6,774 | 20.2 | 8.5s |
| 8 | muse-glimmer:latest@think=off | **99%** | 96% | 100% | 100% | 100% | 4 flips | 3,839 | 12 | 0.7s |
| 9 | nemotron-3-nano:30b@think=on | **98%** | 100% | 100% | 93% | 100% | 1 flip | 8,009 | 74 | 0.3s |
| 10 | gemma4:26b@think=off | **97%** | 100% | 100% | 89% | 100% | stable | 1,648 | 59.3 | 0.6s |
| 11 | nemotron-3.5-lightning:latest@think=off | **97%** | 100% | 100% | 89% | 100% | stable | 2,187 | 55.8 | 0.4s |
| 12 | gemma4:31b@think=off | **97%** | 100% | 100% | 100% | 89% | 3 flips | 1,503 | 10.1 | 1.1s |
| 13 | qwen3.8:27b@think=off | **97%** | 100% | 100% | 100% | 89% | 3 flips | 2,048 | 17.6 | 0.8s |
| 14 | gpt-oss:20b@think=on | **97%** | 100% | 100% | 100% | 89% | 3 flips | 4,212 | 109.8 | 9.3s |
| 15 | deepseek-v4-flash@think=off | **96%** | 100% | 100% | 85% | 100% | 1 flip | 2,079 | 21.5 | 1.7s |
| 16 | qwen3:32b@think=off | **95%** | 100% | 100% | 81% | 100% | 1 flip | 1,431 | 10 | 0.7s |
| 17 | qwen3-coder:30b (no think) | **95%** | 100% | 92% | 89% | 100% | stable | 1,910 | 85.1 | 0.2s |
| 18 | gpt-oss:20b@think=off | **94%** | 100% | 100% | 100% | 78% | 6 flips | 4,952 | 32.1 | 0.4s |
| 19 | nemotron3:33b@think=on | **94%** | 96% | 100% | 93% | 89% | 6 flips | 9,303 | 70.8 | 0.3s |
| 20 | nemotron-cascade-2:30b@think=on | **94%** | 97% | 97% | 93% | 89% | 9 flips | 8,603 | 73.2 | 0.3s |
| 21 | nemotron-3.5-lightning:latest@think=on | **94%** | 100% | 100% | 96% | 78% | 4 flips | 9,564 | 65.2 | 0.3s |
| 22 | nemotron-3-super:latest@think=on | **93%** | 100% | 97% | 96% | 78% | 8 flips | 8,435 | 21.2 | 0.6s |
| 23 | qwen3.6:35b@think=on | **93%** | 100% | 100% | 93% | 78% | 5 flips | 13,707 | 69.9 | 0.4s |
| 24 | nemotron3:33b@think=off | **93%** | 89% | 100% | 93% | 89% | 6 flips | 1,349 | 69.8 | 0.4s |
| 25 | gemma4:26b@think=on | **92%** | 92% | 100% | 89% | 89% | 11 flips | 9,987 | 62.3 | 0.5s |
| 26 | qwen3.6:35b@think=off | **92%** | 100% | 100% | 100% | 67% | stable | 2,400 | 68.3 | 0.5s |
| 27 | nemotron-cascade-2:30b@think=off | **92%** | 100% | 100% | 89% | 78% | 3 flips | 2,157 | 71.7 | 0.4s |
| 28 | qwen3-coder-next:latest (no think) | **89%** | 100% | 100% | 89% | 67% | stable | 1,841 | 58.5 | 0.3s |
| 29 | qwen3.5:27b@think=off | **89%** | 100% | 100% | 89% | 67% | stable | 2,525 | 12 | 1.0s |
| 30 | llama4:scout (no think) | **89%** | 86% | 92% | 100% | 78% | 8 flips | 2,662 | 18.3 | 0.6s |
| 31 | nemotron-3-super:latest@think=off | **88%** | 93% | 100% | 70% | 89% | 9 flips | 3,861 | 21.1 | 0.9s |
| 32 | nemotron-3-nano:30b@think=off | **88%** | 95% | 100% | 89% | 67% | stable | 1,689 | 72.8 | 0.4s |
| 33 | devstral:24b (no think) | **86%** | 99% | 100% | 100% | 44% | 4 flips | 1,469 | 13.8 | 0.5s |
| 34 | qwen2.5-coder:32b (no think) | **85%** | 50% | 100% | 100% | 89% | 3 flips | 950 | 3.2 | 1.4s |
| 35 | qwen2.5:72b (no think) | **83%** | 100% | 100% | 100% | 33% | stable | 1,551 | 4.4 | 1.1s |
| 36 | qwen3.5:27b@think=on | **83%** | 100% | 67% | 100% | 67% | stable | 13,102 | 12.1 | 0.7s |
| 37 | qwen3.6:27b@think=on | **82%** | 100% | 67% | 85% | 78% | 5 flips | 12,437 | 12.1 | 0.7s |
| 38 | qwen3:32b@think=on | **81%** | 100% | 100% | 93% | 33% | 1 flip | 6,537 | 10 | 0.6s |
| 39 | glm-4.7-flash:latest@think=off | **61%** | 87% | 89% | 67% | 0% | 8 flips | 8,766 | 61.7 | 0.3s |
| 40 | deepseek-coder:33b (no think) | **59%** | 0% | 97% | 74% | 67% | 8 flips | 980 | 4.3 | 11.5s |
| 41 | glm-4.7-flash:latest@think=on | **43%** | 83% | 39% | 48% | 0% | 18 flips | 23,085 | 62.5 | 0.3s |
