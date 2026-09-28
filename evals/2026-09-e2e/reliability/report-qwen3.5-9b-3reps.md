# End-to-end eval — 2026-09-27 · profile=wizard · workspace=fresh

Every task through `dispatchMessage` with a wizard-generated config for the model under test (router = specialists = the model), a bootstrapped workspace, the real registry, stores and pipelines; web stubbed over a fixed corpus. Prompt profile: **wizard** (`wizard` = what the wizard writes for the model's tier). Workspace: **fresh**. Reps: 3.

| # | Model | Overall | chat-plain | chat-exact-word | task-board | memory-save-recall | exec-csv-revenue | exec-fib-script | multi-release-notes | cron-schedule | web-fact-to-file | website-summarize | research-report | prompt tok/battery | wall |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | qwen3.5:9b | **94%** | 100% | 100% | 50% | 100% | 100% | 100% | 100% | 100% | 87% | 100% | 100% | 69,819 | 7.2m |

## By category

| Model | chat | task | memory | exec | multi | cron | web_search | website | research |
|---|---|---|---|---|---|---|---|---|---|
| qwen3.5:9b | 100% | 50% | 100% | 100% | 100% | 100% | 87% | 100% | 100% |

## qwen3.5:9b

| Task | Score | Routed | Checks | Calls | Prompt tok | Wall |
|---|---|---|---|---|---|---|
| chat-plain | 100% | chat | all pass | 1 | 354 | 3s |
| chat-exact-word | 100% | chat | all pass | 1 | 349 | 2s |
| task-board | 50% | task | ✗ three tasks exist (0 tasks: ); ✗ priorities correct (undefined/undefined); ✗ due date correct | 2 | 0 | 3s |
| memory-save-recall | 100% | memory | all pass | 3 | 2,783 | 5s |
| exec-csv-revenue | 100% | exec | all pass | 5 | 9,220 | 8s |
| exec-fib-script | 100% | exec | all pass | 6 | 9,730 | 9s |
| multi-release-notes | 100% | multi | all pass | 6 | 12,762 | 12s |
| cron-schedule | 100% | cron | all pass | 2 | 2,601 | 4s |
| web-fact-to-file | 100% | multi | all pass | 4 | 9,451 | 6s |
| website-summarize | 100% | website | all pass | 2 | 1,868 | 3s |
| research-report | 100% | research | all pass | 12 | 13,584 | 51s |

<details><summary>Answers (rep 1)</summary>

**chat-plain** — web: none

```
A Python list is mutable, meaning you can change, add, or remove its elements after creation. A tuple is immutable, so once it's created, its contents cannot be modified.
```

**chat-exact-word** — web: none

```
READY
```

**task-board** — web: none

```
I'll add these three tasks to your task board now.
```

**memory-save-recall** — web: none

```
Your deployment freeze starts on September 1st, 2026.
```

**exec-csv-revenue** — web: none

```
Total revenue: 94.0
```

**exec-fib-script** — web: none

```
Done! I've created `fib.py` which calculates the 20th Fibonacci number (6765), ran it with Python, and saved the output to `fib.txt`.
```

**multi-release-notes** — web: none

```
Done! I've:
1. ✅ Created task "Evaluate new version v0.6.2" (ID: c33ba119) with high priority
2. ✅ Written `notes/release-summary.md` summarizing the release changes

The summary covers all four changes from the release notes, organized by category (performance/architecture, features, bug fixes), and includes an impact assessment section.
```

**cron-schedule** — web: none

```
Done! I've scheduled a reminder to check the build dashboard every weekday at 8am. The job will send you a message in your Discord channel (e2e).
```

**web-fact-to-file** — web: web_search(Node.js first release year)

```
Node.js was first released in 2009. The year has been written to node-year.txt.
```

**website-summarize** — web: web_fetch(https://example-docs.test/guide)

```
- The service listens on port 8443 with TLS, using `/etc/widget/config.toml` for configuration which reloads on SIGHUP.
- Nightly backups occur at 02:00 UTC to the "widget-backups" bucket and are retained for 30 days.
- The health endpoint is `/healthz`, returning 503 during active backups.
```

**research-report** — web: web_search(state local LLM inference consumer news), web_search(state local LLM inference consumer announcements September 2026), web_search(VRAM constraints for consumer GPUs in 2026), web_search(Unified memory vs discrete GPU performance tradeoffs), web_search(GGUF quantization quality benchmarks Q4_K_M vs Q8_0), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://unified-memory.example/apple-strix-halo), web_fetch(https://unified-memory.example/apple-strix-halo), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://small-models.example/9b-vs-27b-tool-use), web_search(llama.cpp versus vLLM serving stack comparison), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://small-models.example/9b-vs-27b-tool-use), web_search(Minimum model size for effective tool-using agents), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://small-models.example/9b-vs-27b-tool-use), web_fetch(https://gpu-inference.example/consumer-gpus-2026)

```
By 2026, local LLM inference is strictly limited by VRAM capacity rather than raw compute power, creating a clear divide between entry-level cards that handle smaller models and high-end workstations required for larger ones. The industry has settled on Q4_K_M quantization as a critical quality floor, where dropping below this threshold causes severe degradation in tool calling and agent reliability. While unified memory solutions like Apple Silicon offer massive model loading capabilities, they cannot match the real-time interaction speeds of discrete GPUs due to bandwidth limitations. Consequently, consumers must choose between accepting speed limits on smaller hardware or investing in 24GB+ cards to unlock larger models and wider context windows without sacrificing utility. [FILE:data/m
```

</details>

---
Provenance: {"date":"2026-09-27T20:53:18.602Z","gitCommit":"f3d07ba","ollamaUrl":"http://<lan-ollama>:11434","reps":3,"profile":"wizard","workspace":"fresh","tasks":["chat-plain","chat-exact-word","task-board","memory-save-recall","exec-csv-revenue","exec-fib-script","multi-release-notes","cron-schedule","web-fact-to-file","website-summarize","research-report"]}
