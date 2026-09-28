# End-to-end eval — 2026-09-28 · profile=wizard · workspace=fresh

Every task through `dispatchMessage` with a wizard-generated config for the model under test (router = specialists = the model), a bootstrapped workspace, the real registry, stores and pipelines; web stubbed over a fixed corpus. Prompt profile: **wizard** (`wizard` = what the wizard writes for the model's tier). Workspace: **fresh**. Reps: 3.

| # | Model | Overall | chat-plain | chat-exact-word | task-board | memory-save-recall | exec-csv-revenue | exec-fib-script | multi-release-notes | cron-schedule | web-fact-to-file | website-summarize | confirm-ledger | research-report | prompt tok/battery | wall |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | qwen3.5:9b | **100%** | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 79,637 | 7.7m |

## By category

| Model | chat | task | memory | exec | multi | cron | web_search | website | research |
|---|---|---|---|---|---|---|---|---|---|
| qwen3.5:9b | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% |

## qwen3.5:9b

| Task | Score | Routed | Checks | Calls | Prompt tok | Wall |
|---|---|---|---|---|---|---|
| chat-plain | 100% | chat | all pass | 1 | 354 | 3s |
| chat-exact-word | 100% | chat | all pass | 1 | 349 | 2s |
| task-board | 100% | task | all pass | 7 | 8,836 | 7s |
| memory-save-recall | 100% | memory | all pass | 3 | 2,782 | 5s |
| exec-csv-revenue | 100% | exec | all pass | 5 | 9,225 | 8s |
| exec-fib-script | 100% | exec | all pass | 6 | 9,657 | 9s |
| multi-release-notes | 100% | multi | all pass | 6 | 12,643 | 11s |
| cron-schedule | 100% | cron | all pass | 2 | 2,580 | 4s |
| web-fact-to-file | 100% | multi | all pass | 5 | 9,676 | 7s |
| website-summarize | 100% | website | all pass | 2 | 1,868 | 3s |
| confirm-ledger | 100% | task | all pass | 2 | 2,909 | 3s |
| research-report | 100% | research | all pass | 12 | 13,902 | 56s |

<details><summary>Answers (rep 1)</summary>

**chat-plain** — web: none

```
A Python list is mutable, meaning you can change its elements after creation, while a tuple is immutable and cannot be modified once defined. This immutability makes tuples ideal for data that should remain constant, whereas lists are better suited for collections requiring frequent updates.
```

**chat-exact-word** — web: none

```
READY
```

**task-board** — web: none

```
All three tasks have been successfully added to your task board:

1. **"Renew SSL certificate"** - high priority ✓
2. **"Water the plants"** - low priority ✓  
3. **"Submit quarterly report"** - due 2026-08-28 ✓

The request is complete.
```

**memory-save-recall** — web: none

```
Your deployment freeze starts on **September 1st, 2026**. Anything before that date is fair game!
```

**exec-csv-revenue** — web: none

```
Total revenue: 94.0, written to revenue.txt
```

**exec-fib-script** — web: none

```
Done! I've created `fib.py` which calculates the 20th Fibonacci number (with fib(1)=1, fib(2)=1). The script ran successfully and produced **6765** as the result. I've saved this output to `fib.txt`.
```

**multi-release-notes** — web: none

```
Done! I've:
1. Read `releases.txt` and identified version v0.6.2 with its changes
2. Created a high-priority task "Evaluate new version v0.6.2" on your task board
3. Written `notes/release-summary.md` summarizing all the actual changes from the release
```

**cron-schedule** — web: none

```
Done! I've scheduled a reminder for you to check the build dashboard every weekday at 8am. The job will trigger on Mondays through Fridays at 8:00 AM and send the message to your Discord channel (e2e).
```

**web-fact-to-file** — web: web_search(Node.js first release year)

```
Done. Node.js was first released in 2009, and I've written that year to node-year.txt in your workspace.
```

**website-summarize** — web: web_fetch(https://example-docs.test/guide)

```
- The Widget Service listens on port 8443 with TLS, using configuration from `/etc/widget/config.toml` that reloads on SIGHUP without restart.  
- Nightly backups occur at 02:00 UTC to the `widget-backups` bucket, retaining data for 30 days.  
- The health endpoint `/healthz` returns a 503 status code while a backup is in progress.
```

**confirm-ledger** — web: none

```
I'm about to create a high-priority task titled "Rotate the API keys" on your task board. Please reply with "confirm ae23b993" to proceed, or "always ae23b993" if you'd like me to stop asking for confirmation for this specific target (expires in 10 minutes).
```

**research-report** — web: web_search(state local LLM inference consumer news), web_search(state local LLM inference consumer announcements September 2026), web_search(VRAM constraints for consumer GPUs in 2026), web_search(Apple Silicon vs Strix Halo unified memory tradeoffs), web_search(GGUF quantization strategies Q4_K_M vs Q8_0), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://unified-memory.example/apple-strix-halo), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://unified-memory.example/apple-strix-halo), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://small-models.example/9b-vs-27b-tool-use), web_search(llama.cpp versus vLLM serving stack comparison), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://small-models.example/9b-vs-27b-tool-use), web_search(9B versus 27B model performance in agent loops), web_fetch(https://small-models.example/9b-vs-27b-tool-use), web_fetch(https://unified-memory.example/apple-strix-halo), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://quant-notes.example/gguf-quantization-guide)

```
In 2026, local LLM inference is strictly limited by VRAM capacity rather than compute power, forcing users to balance model size against available memory. While unified memory systems like Apple Silicon can load massive models, they suffer from bandwidth penalties that degrade latency during critical prefill stages compared to high-bandwidth discrete GPUs. Consequently, the optimal choice depends on whether a user prioritizes the raw capability of larger models or the low-latency performance required for interactive agent workloads. [FILE:data/media/documents/local-llm-inference-consumer-gpus-2026.pdf]
```

</details>

---
Provenance: {"date":"2026-09-28T03:50:25.429Z","gitCommit":"89ccb6f","ollamaUrl":"http://<lan-ollama>:11434","reps":3,"profile":"wizard","workspace":"fresh","tasks":["chat-plain","chat-exact-word","task-board","memory-save-recall","exec-csv-revenue","exec-fib-script","multi-release-notes","cron-schedule","web-fact-to-file","website-summarize","confirm-ledger","research-report"]}
