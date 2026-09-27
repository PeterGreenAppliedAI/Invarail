# End-to-end eval — 2026-09-27 · profile=full · workspace=lived

Every task through `dispatchMessage` with a wizard-generated config for the model under test (router = specialists = the model), a bootstrapped workspace, the real registry, stores and pipelines; web stubbed over a fixed corpus. Prompt profile: **full** (`wizard` = what the wizard writes for the model's tier). Workspace: **lived**. Reps: 1.

| # | Model | Overall | chat-plain | chat-exact-word | task-board | memory-save-recall | exec-csv-revenue | exec-fib-script | multi-release-notes | cron-schedule | web-fact-to-file | website-summarize | research-report | prompt tok/battery | wall |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | qwen3.5:9b | **100%** | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 79,725 | 2.3m |
| 2 | gemma4:12b | **91%** | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 0% | 100% | 100% | 100% | 76,433 | 3.6m |

## By category

| Model | chat | task | memory | exec | multi | cron | web_search | website | research |
|---|---|---|---|---|---|---|---|---|---|
| qwen3.5:9b | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% |
| gemma4:12b | 100% | 100% | 100% | 100% | 100% | 0% | 100% | 100% | 100% |

## qwen3.5:9b

| Task | Score | Routed | Checks | Calls | Prompt tok | Wall |
|---|---|---|---|---|---|---|
| chat-plain | 100% | chat | all pass | 1 | 2,631 | 4s |
| chat-exact-word | 100% | chat | all pass | 1 | 2,626 | 1s |
| task-board | 100% | task | all pass | 4 | 6,600 | 4s |
| memory-save-recall | 100% | memory | all pass | 3 | 5,494 | 3s |
| exec-csv-revenue | 100% | exec | all pass | 5 | 9,706 | 7s |
| exec-fib-script | 100% | exec | all pass | 5 | 9,750 | 7s |
| multi-release-notes | 100% | multi | all pass | 6 | 13,011 | 9s |
| cron-schedule | 100% | cron | all pass | 2 | 2,817 | 3s |
| web-fact-to-file | 100% | multi | all pass | 4 | 9,794 | 5s |
| website-summarize | 100% | website | all pass | 2 | 2,108 | 2s |
| research-report | 100% | research | all pass | 14 | 15,188 | 87s |

<details><summary>Answers (rep 1)</summary>

**chat-plain** — web: none

```
A Python list is mutable, meaning you can change its contents after creation, while a tuple is immutable and cannot be altered once defined. Lists use square brackets `[]` and are generally more flexible for dynamic data, whereas tuples use parentheses `()` and offer performance benefits and hashability for use as dictionary keys.
```

**chat-exact-word** — web: none

```
READY
```

**task-board** — web: none

```
Done. Created three tasks:
1. **Renew SSL certificate** (ID: e3e69dab) — high priority
2. **Water the plants** (ID: 79f2c21a) — low priority  
3. **Submit quarterly report** (ID: aba5af4a) — due 2026-08-28, medium priority
```

**memory-save-recall** — web: none

```
Your deployment freeze starts on 2026-09-01.
```

**exec-csv-revenue** — web: none

```
Done. Total revenue: 94.0 written to revenue.txt.
```

**exec-fib-script** — web: none

```
Done. The 20th Fibonacci number is 6765, saved to fib.txt.
```

**multi-release-notes** — web: none

```
Done. Created task "Evaluate new version v0.6.2" and wrote `notes/release-summary.md` with the release changes.
```

**cron-schedule** — web: none

```
Done. You'll get a reminder every weekday at 8am to check the build dashboard.
```

**web-fact-to-file** — web: web_search(Node.js first release year)

```
2009
```

**website-summarize** — web: web_fetch(https://example-docs.test/guide)

```
- Listens on port 8443 with TLS; config at `/etc/widget/config.toml` reloads via SIGHUP.  
- Nightly backups at 02:00 UTC to `widget-backups` bucket, retained for 30 days.  
- Health endpoint `/healthz` returns 503 during backup operations.
```

**research-report** — web: web_search(state local LLM inference consumer news), web_search(state local LLM inference consumer announcements September 2026), web_search(VRAM constraints vs compute limits for consumer GPUs 2026), web_search(Apple Silicon unified memory capacity tradeoffs), web_search(Strix Halo local inference performance benchmarks), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://unified-memory.example/apple-strix-halo), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://unified-memory.example/apple-strix-halo), web_fetch(https://unified-memory.example/apple-strix-halo), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_search(GGUF quantization quality loss Q4_K_M vs Q8_0), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://small-models.example/9b-vs-27b-tool-use), web_search(llama.cpp versus vLLM serving stack efficiency), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://small-models.example/9b-vs-27b-tool-use), web_search(9B versus 27B model capability gaps in agent tasks), web_fetch(https://small-models.example/9b-vs-27b-tool-use), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://unified-memory.example/apple-strix-halo)

```
In 2026, local LLM inference is strictly limited by VRAM capacity rather than raw compute power, creating a hard divide where 12GB cards are confined to smaller models while 24GB cards can handle larger ones with room for long contexts. To fit these models onto consumer hardware, aggressive quantization is required, but dropping below Q4 levels severely degrades the reliability of tool-calling tasks and malformed JSON arguments. Unified memory architectures like Apple Silicon offer a solution for loading massive 70B parameter models, yet they suffer from significant latency penalties during agent loops compared to high-bandwidth discrete GPUs. Ultimately, users must balance model size against weight integrity, as raw parameter counts matter far less than the quality of quantization and ava
```

</details>

## gemma4:12b

| Task | Score | Routed | Checks | Calls | Prompt tok | Wall |
|---|---|---|---|---|---|---|
| chat-plain | 100% | chat | all pass | 1 | 2,717 | 9s |
| chat-exact-word | 100% | chat | all pass | 1 | 2,712 | 2s |
| task-board | 100% | task | all pass | 4 | 5,512 | 6s |
| memory-save-recall | 100% | memory | all pass | 4 | 4,569 | 7s |
| exec-csv-revenue | 100% | exec | all pass | 3 | 6,184 | 7s |
| exec-fib-script | 100% | exec | all pass | 6 | 9,070 | 15s |
| multi-release-notes | 100% | multi | all pass | 6 | 11,690 | 15s |
| cron-schedule | 0% | — ⚠ | ✗ completed without error (Ollama inference error: 500 Internal Server Error: {"error":"prediction aborted, token repeat limit reached"}) | 1 | 0 | 3s |
| web-fact-to-file | 100% | multi | all pass | 4 | 8,872 | 9s |
| website-summarize | 100% | website | all pass | 2 | 1,684 | 3s |
| research-report | 100% | research | all pass | 23 | 23,423 | 132s |

<details><summary>Answers (rep 1)</summary>

**chat-plain** — web: none

```
A list is mutable, meaning you can change, add, or remove elements after it is created. A tuple is immutable, meaning its contents are fixed once defined, making it faster and safer for constant data.
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
The total revenue has been calculated and the result has been saved to `revenue.txt`.
```

**exec-fib-script** — web: none

```
The 20th Fibonacci number is 6765. I've created `fib.py`, executed it, and saved the result to `fib.txt`.
```

**multi-release-notes** — web: none

```
I've processed the release notes:

1.  **Task Created**: "Evaluate version v0.6.2" (ID: `fb3c2b75`) added to your board.
2.  **Summary Written**: Created `notes/release-summary.md` with the details of the Rust frontend rework, MTP speculative decoding, KV cache compression, and the deadlock fix.
```

**cron-schedule** — web: none

```

```

**web-fact-to-file** — web: web_search(year Node.js was first released)

```
2009
```

**website-summarize** — web: web_fetch(https://example-docs.test/guide)

```
*   **Connectivity:** The service operates on port 8443 with mandatory TLS.
*   **Configuration:** Settings are managed in `/etc/widget/config.toml` and can be reloaded via SIGHUP without a restart.
*   **Maintenance:** Nightly backups occur at 02:00 UTC (30-day retention), during which the `/healthz` endpoint returns a 503 status.
```

**research-report** — web: web_search(state local LLM inference consumer news), web_search(state local LLM inference consumer announcements September 2026), web_search(model size vs VRAM capacity 2026), web_search(Apple Silicon vs Strix Halo unified memory), web_search(GGUF Q4_K_M vs Q8_0 quantization tradeoffs), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://unified-memory.example/apple-strix-halo), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://unified-memory.example/apple-strix-halo), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://small-models.example/9b-vs-27b-tool-use), web_search(llama.cpp vs vLLM vs Ollama performance), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://small-models.example/9b-vs-27b-tool-use), web_search(9B vs 27B models for tool-use agents), web_fetch(https://small-models.example/9b-vs-27b-tool-use), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_search(inference speed comparison of 4-bit vs 8-bit quantization), web_search(vLLM PagedAttention vs llama.cpp KV cache efficiency), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://unified-memory.example/apple-strix-halo), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://small-models.example/9b-vs-27b-tool-use), web_search(rtx 4090 specific fraction performance lost unified), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://unified-memory.example/apple-strix-halo)

```
By 2026, the local LLM landscape is defined by a clear distinction between high-speed, dedicated GPU setups and high-capacity unified memory systems. While unified memory allows for the execution of massive models, dedicated GPUs remain superior for high-speed inference, with 24GB cards serving as the standard for mid-sized models. Quantization is essential for fitting models onto consumer hardware, but dropping below the 4-bit threshold significantly degrades the reliability of tool-calling and logic in complex agentic workflows. [FILE:data/media/documents/local-llm-inference-consumer-gpus-2026.pdf]
```

</details>

---
Provenance: {"date":"2026-09-27T19:51:37.138Z","gitCommit":"65fe730","ollamaUrl":"http://10.9.8.19:11434","reps":1,"profile":"full","workspace":"lived","tasks":["chat-plain","chat-exact-word","task-board","memory-save-recall","exec-csv-revenue","exec-fib-script","multi-release-notes","cron-schedule","web-fact-to-file","website-summarize","research-report"]}
