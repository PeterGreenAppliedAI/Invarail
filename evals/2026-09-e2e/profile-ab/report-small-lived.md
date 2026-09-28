# End-to-end eval — 2026-09-27 · profile=small · workspace=lived

Every task through `dispatchMessage` with a wizard-generated config for the model under test (router = specialists = the model), a bootstrapped workspace, the real registry, stores and pipelines; web stubbed over a fixed corpus. Prompt profile: **small** (`wizard` = what the wizard writes for the model's tier). Workspace: **lived**. Reps: 1.

| # | Model | Overall | chat-plain | chat-exact-word | task-board | memory-save-recall | exec-csv-revenue | exec-fib-script | multi-release-notes | cron-schedule | web-fact-to-file | website-summarize | research-report | prompt tok/battery | wall |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | qwen3.5:9b | **100%** | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 77,441 | 2.4m |
| 2 | gemma4:12b | **100%** | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 82,695 | 4.0m |

## By category

| Model | chat | task | memory | exec | multi | cron | web_search | website | research |
|---|---|---|---|---|---|---|---|---|---|
| qwen3.5:9b | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% |
| gemma4:12b | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% |

## qwen3.5:9b

| Task | Score | Routed | Checks | Calls | Prompt tok | Wall |
|---|---|---|---|---|---|---|
| chat-plain | 100% | chat | all pass | 1 | 474 | 3s |
| chat-exact-word | 100% | chat | all pass | 1 | 469 | 1s |
| task-board | 100% | task | all pass | 2 | 3,297 | 4s |
| memory-save-recall | 100% | memory | all pass | 3 | 3,340 | 3s |
| exec-csv-revenue | 100% | exec | all pass | 5 | 9,609 | 7s |
| exec-fib-script | 100% | exec | all pass | 6 | 12,379 | 7s |
| multi-release-notes | 100% | multi | all pass | 6 | 12,989 | 9s |
| cron-schedule | 100% | cron | all pass | 2 | 2,818 | 3s |
| web-fact-to-file | 100% | multi | all pass | 5 | 13,405 | 6s |
| website-summarize | 100% | website | all pass | 2 | 2,108 | 2s |
| research-report | 100% | research | all pass | 15 | 16,553 | 96s |

<details><summary>Answers (rep 1)</summary>

**chat-plain** — web: none

```
A Python **list** is mutable, meaning you can add, remove, or change elements after creation. A **tuple** is immutable, so its contents cannot be altered once defined.
```

**chat-exact-word** — web: none

```
READY
```

**task-board** — web: none

```
Done. Created three tasks:
- **Renew SSL certificate** (f0452d2e) — high priority
- **Water the plants** (3bf7c08a) — low priority  
- **Submit quarterly report** (d861e672) — due 2026-08-28
```

**memory-save-recall** — web: none

```
It starts on 2026-09-01.
```

**exec-csv-revenue** — web: none

```
Done. Total revenue is 94.0, written to revenue.txt.
```

**exec-fib-script** — web: none

```
Done. The 20th Fibonacci number is 6765, saved to `fib.txt`.
```

**multi-release-notes** — web: none

```
Done. Created task "Evaluate new version v0.6.2" (high priority) and wrote `notes/release-summary.md` with the release details.
```

**cron-schedule** — web: none

```
Done. You'll get a reminder every weekday at 8am to check the build dashboard.
```

**web-fact-to-file** — web: web_search(Node.js first release year), web_fetch(https://nodejs-history.example/timeline)

```
2009
```

**website-summarize** — web: web_fetch(https://example-docs.test/guide)

```
- Listens on port 8443 with TLS; config at `/etc/widget/config.toml` reloads via SIGHUP.  
- Nightly backups at 02:00 UTC to `widget-backups` bucket, retained 30 days.  
- Health endpoint `/healthz` returns 503 during backup operations.
```

**research-report** — web: web_search(state local LLM inference consumer news), web_search(state local LLM inference consumer announcements September 2026), web_search(Consumer GPU VRAM limits for 2026 local inference), web_search(Unified memory vs discrete GPU capacity tradeoffs), web_search(GGUF quantization quality vs memory usage benchmarks), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://unified-memory.example/apple-strix-halo), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://unified-memory.example/apple-strix-halo), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://unified-memory.example/apple-strix-halo), web_search(llama.cpp versus vLLM serving stack comparison), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://small-models.example/9b-vs-27b-tool-use), web_search(Tool-using agent capabilities in 9B vs 27B models), web_fetch(https://small-models.example/9b-vs-27b-tool-use), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_search(Strix Halo unified memory bandwidth latency), web_search(Mac Studio MLX first token generation speed), web_fetch(https://unified-memory.example/apple-strix-halo), web_fetch(https://unified-memory.example/apple-strix-halo), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://small-models.example/9b-vs-27b-tool-use), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://nodejs-history.example/timeline)

```
By late 2026, the primary bottleneck for local inference has shifted decisively from raw compute power to VRAM capacity and memory bandwidth, forcing a hard trade-off between model size and response latency. While unified memory systems like the Mac Studio or Strix Halo can load massive 70B parameter models, they suffer from significantly higher prefill latencies compared to high-bandwidth discrete GPUs like the RTX 4090. Consequently, the optimal strategy for most users involves sticking to Q4_K_M quantization on 24GB cards for a balance of speed and quality, reserving unified memory only when model size exceeds physical VRAM limits. [FILE:data/media/documents/local-llm-inference-consumer-gpus-2026.pdf]
```

</details>

## gemma4:12b

| Task | Score | Routed | Checks | Calls | Prompt tok | Wall |
|---|---|---|---|---|---|---|
| chat-plain | 100% | chat | all pass | 1 | 487 | 14s |
| chat-exact-word | 100% | chat | all pass | 1 | 482 | 2s |
| task-board | 100% | task | all pass | 4 | 5,516 | 5s |
| memory-save-recall | 100% | memory | all pass | 4 | 4,570 | 7s |
| exec-csv-revenue | 100% | exec | all pass | 5 | 8,617 | 11s |
| exec-fib-script | 100% | exec | all pass | 6 | 9,065 | 14s |
| multi-release-notes | 100% | multi | all pass | 6 | 11,679 | 15s |
| cron-schedule | 100% | cron | all pass | 3 | 3,682 | 5s |
| web-fact-to-file | 100% | multi | all pass | 4 | 8,872 | 9s |
| website-summarize | 100% | website | all pass | 2 | 1,684 | 4s |
| research-report | 100% | research | all pass | 29 | 28,041 | 145s |

<details><summary>Answers (rep 1)</summary>

**chat-plain** — web: none

```
A list is mutable, meaning you can modify, add, or remove elements after it is created. A tuple is immutable, making it a fixed sequence that cannot be changed once defined.
```

**chat-exact-word** — web: none

```
READY
```

**task-board** — web: none

```
I've added those three tasks to your board:
1. **Renew SSL certificate** (High priority)
2. **Water the plants** (Low priority)
3. **Submit quarterly report** (Due 2026-08-28)
```

**memory-save-recall** — web: none

```
Your deployment freeze starts on 2026-09-01.
```

**exec-csv-revenue** — web: none

```
The total revenue has been calculated from `sales.csv` and the resulting number has been written to `revenue.txt`.
```

**exec-fib-script** — web: none

```
The script `fib.py` was created, executed, and the result was saved.

The 20th Fibonacci number is **6765**.
```

**multi-release-notes** — web: none

```
I've completed the following:
1.  **Read `releases.txt`**: Identified version v0.6.2.
2.  **Added Task**: Created a new task "Evaluate version v0.6.2" on your board.
3.  **Created Summary**: Wrote the details of the changes to `notes/release-summary.md`.
```

**cron-schedule** — web: none

```
Done. I've scheduled a reminder to check the build dashboard every weekday at 8:00 AM.
```

**web-fact-to-file** — web: web_search(year Node.js was first released)

```
2009
```

**website-summarize** — web: web_fetch(https://example-docs.test/guide)

```
*   **Connectivity:** The service operates on port 8443 using TLS.
*   **Configuration:** Settings are located in `/etc/widget/config.toml` and can be reloaded via SIGHUP without a restart.
*   **Maintenance:** Nightly backups occur at 02:00 UTC (retained for 30 days), during which the `/healthz` endpoint returns a 503 status.
```

**research-report** — web: web_search(state local LLM inference consumer news), web_search(state local LLM inference consumer announcements September 2026), web_search(model size vs VRAM capacity 2026), web_search(GGUF Q4_K_M vs Q8_0 quantization tradeoffs), web_search(Apple Silicon vs Strix Halo unified memory), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://unified-memory.example/apple-strix-halo), web_fetch(https://unified-memory.example/apple-strix-halo), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://small-models.example/9b-vs-27b-tool-use), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_search(llama.cpp vs vLLM vs Ollama performance), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://small-models.example/9b-vs-27b-tool-use), web_search(9B vs 27B models for tool-use agents), web_fetch(https://small-models.example/9b-vs-27b-tool-use), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_search(inference speed impact of PagedAttention and FlashAttention-3), web_search(FP8 and NF4 quantization performance on Blackwell and Hopper architectures), web_fetch(https://unified-memory.example/apple-strix-halo), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://small-models.example/9b-vs-27b-tool-use), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://example-docs.test/guide), web_search(phi4 gemma3 small models return http errors), web_search(blackwell hopper there available data regarding performance), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://small-models.example/9b-vs-27b-tool-use), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_search(pagedattention flashattention-3 data available regarding specific impact), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://quant-notes.example/gguf-quantization-guide)

```
Local LLM inference in 2026 is characterized by a clear distinction between high-speed single-GPU setups and high-capacity unified memory systems. While quantization allows larger models to run on consumer hardware, staying above the 4-bit threshold is essential to maintain reliability for complex tasks like tool-calling and agentic workflows. Larger models, specifically in the 27B range, are preferred for complex logic because they exhibit better discipline and reliability compared to smaller models that may struggle with long prompts or multi-step reasoning. [FILE:data/media/documents/local-llm-inference-consumer-gpus-2026.pdf]
```

</details>

---
Provenance: {"date":"2026-09-27T20:12:26.779Z","gitCommit":"65fe730","ollamaUrl":"http://<lan-ollama>:11434","reps":1,"profile":"small","workspace":"lived","tasks":["chat-plain","chat-exact-word","task-board","memory-save-recall","exec-csv-revenue","exec-fib-script","multi-release-notes","cron-schedule","web-fact-to-file","website-summarize","research-report"]}
