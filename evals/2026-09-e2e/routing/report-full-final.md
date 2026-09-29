# End-to-end eval — 2026-09-29 · profile=wizard · workspace=fresh

Every task through `dispatchMessage` with a wizard-generated config for the model under test (router = specialists = the model), a bootstrapped workspace, the real registry, stores and pipelines; web stubbed over a fixed corpus. Prompt profile: **wizard** (`wizard` = what the wizard writes for the model's tier). Workspace: **fresh**. Reps: 3.

| # | Model | Overall | chat-plain | chat-exact-word | task-board | memory-save-recall | exec-csv-revenue | exec-fib-script | multi-release-notes | cron-schedule | web-fact-to-file | website-summarize | confirm-ledger | research-report | prompt tok/battery | wall |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | qwen3.5:9b | **100%** | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 87,578 | 8.6m |
| 2 | gemma4:12b | **100%** | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 77,013 | 11.0m |
| 3 | qwen2.5:7b | **94%** | 100% | 100% | 100% | 53% | 83% | 100% | 87% | 100% | 100% | 100% | 100% | 100% | 94,145 | 6.5m |

## By category

| Model | chat | task | memory | exec | multi | cron | website | research |
|---|---|---|---|---|---|---|---|---|
| qwen3.5:9b | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% |
| gemma4:12b | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% |
| qwen2.5:7b | 100% | 100% | 53% | 92% | 93% | 100% | 100% | 100% |

## qwen3.5:9b

| Task | Score | Routed | Checks | Calls | Prompt tok | Wall |
|---|---|---|---|---|---|---|
| chat-plain | 100% | chat | all pass | 1 | 354 | 1s |
| chat-exact-word | 100% | chat | all pass | 1 | 349 | 1s |
| task-board | 100% | task | all pass | 4 | 6,172 | 4s |
| memory-save-recall | 100% | memory | all pass | 4 | 3,002 | 5s |
| exec-csv-revenue | 100% | exec | all pass | 5 | 9,229 | 7s |
| exec-fib-script | 100% | exec | all pass | 6 | 9,572 | 8s |
| multi-release-notes | 100% | multi | all pass | 6 | 12,837 | 11s |
| cron-schedule | 100% | cron | all pass | 2 | 2,602 | 3s |
| web-fact-to-file | 100% | multi | all pass | 5 | 12,946 | 6s |
| website-summarize | 100% | website | all pass | 2 | 1,868 | 2s |
| confirm-ledger | 100% | task | all pass | 2 | 2,907 | 2s |
| research-report | 100% | research | all pass | 36 | 34,026 | 132s |

<details><summary>Answers (rep 1)</summary>

**chat-plain** — web: none

```
A Python list is mutable, meaning you can change its elements after creation, whereas a tuple is immutable. Lists use square brackets `[]` for syntax while tuples use parentheses `()`.
```

**chat-exact-word** — web: none

```
READY
```

**task-board** — web: none

```
All three tasks have been successfully added to your task board:

1. **Renew SSL certificate** (ID: d1c771bc) - High priority, Status: Todo
2. **Water the plants** (ID: 0e742ba0) - Low priority, Status: Todo  
3. **Submit quarterly report** (ID: 263647b9) - Medium priority, Due: 2026-08-28, Status: Todo

Note: The "Submit quarterly report" is due on 2026-08-28, which is in the past (today is 2026-09-29). You may want to update the due date if needed.
```

**memory-save-recall** — web: none

```
Your deployment freeze starts on **September 1st, 2026**. Anything I need to keep in mind for that date? 🛑
```

**exec-csv-revenue** — web: none

```
The total revenue is 94.0, which has been written to revenue.txt.
```

**exec-fib-script** — web: none

```
Done! I've created `fib.py` which calculates the 20th Fibonacci number (using fib(1)=1, fib(2)=1), ran it with python3, and saved the output `6765` to `fib.txt`.
```

**multi-release-notes** — web: none

```
Done! I've:
1. Read releases.txt and found version v0.6.2 from 2026-08-18 with 4 changes
2. Created task #4d0c8b5d to evaluate version v0.6.2 (medium priority)
3. Written notes/release-summary.md summarizing all the changes

The summary covers the Rust frontend rework, MTP speculative decoding, KV cache compression, and the deadlock fix in continuous batching.
```

**cron-schedule** — web: none

```
Done! I've scheduled a reminder for you to check the build dashboard every weekday at 8am. The job will be delivered via Discord to your channel (e2e).
```

**web-fact-to-file** — web: web_search(Node.js first release year), web_fetch(https://nodejs-history.example/timeline)

```
The year Node.js was first released is 2009. I've written that to node-year.txt in your workspace.
```

**website-summarize** — web: web_fetch(https://example-docs.test/guide)

```
- The Widget Service listens on port 8443 with TLS, using config from `/etc/widget/config.toml` that reloads via SIGHUP without restart.
- Nightly backups occur at 02:00 UTC to the `widget-backups` bucket, retained for 30 days.
- The health endpoint `/healthz` returns 503 during backup operations.
```

**confirm-ledger** — web: none

```
I'm about to add a high-priority task titled "Rotate the API keys" to your task board. Please reply with `confirm b40fbbea` to proceed, or `always b40fbbea` if you want me to stop asking for confirmation on this exact target (expires in 10 minutes).
```

**research-report** — web: web_search(state local LLM inference consumer news), web_search(state local LLM inference consumer announcements September 2026), web_search(VRAM constraints for 2026 consumer GPUs), web_search(Unified memory vs discrete GPU tradeoffs), web_search(GGUF quantization quality vs memory usage), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://unified-memory.example/apple-strix-halo), web_fetch(https://unified-memory.example/apple-strix-halo), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://unified-memory.example/apple-strix-halo), web_search(llama.cpp versus vLLM serving stack comparison), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://small-models.example/9b-vs-27b-tool-use), web_search(Minimum model size for reliable tool use), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://small-models.example/9b-vs-27b-tool-use), web_search(phi4 gemma3 models like small return http), web_search(strix halo confirm strix halo load models.), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://small-models.example/9b-vs-27b-tool-use), web_fetch(https://unified-memory.example/apple-strix-halo), web_search(consumer local inference consumer local inference strictly limited), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://unified-memory.example/apple-strix-halo), web_search(apple silicon strix halo workloads exceeding vram requirements market), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://unified-memory.example/apple-strix-halo)

```
In 2026, local LLM inference is strictly limited by video memory capacity rather than raw compute power, forcing users to balance model scale against quantization fidelity. High-quality tool calling requires the Q4_K_M quantization standard as a mandatory baseline, since lower bit depths cause significant failures in generating valid arguments for external tools. While powerful discrete GPUs like the RTX 4090 offer high throughput for single-user tasks, unified memory systems provide the only viable path for loading massive models despite introducing higher latency during agent loops. Consequently, the ecosystem has bifurcated into a choice between accepting smaller models on entry-level hardware or utilizing multi-card and unified memory setups to handle complex, multi-hop reasoning workl
```

</details>

## gemma4:12b

| Task | Score | Routed | Checks | Calls | Prompt tok | Wall |
|---|---|---|---|---|---|---|
| chat-plain | 100% | chat | all pass | 1 | 363 | 2s |
| chat-exact-word | 100% | chat | all pass | 1 | 358 | 1s |
| task-board | 100% | task | all pass | 4 | 5,019 | 5s |
| memory-save-recall | 100% | memory | all pass | 4 | 3,876 | 7s |
| exec-csv-revenue | 100% | exec | all pass | 4 | 6,055 | 11s |
| exec-fib-script | 100% | exec | all pass | 6 | 8,671 | 15s |
| multi-release-notes | 100% | multi | all pass | 6 | 11,275 | 16s |
| cron-schedule | 100% | cron | all pass | 2 | 2,132 | 3s |
| web-fact-to-file | 100% | multi | all pass | 4 | 8,523 | 10s |
| website-summarize | 100% | website | all pass | 2 | 1,436 | 3s |
| confirm-ledger | 100% | task | all pass | 2 | 2,404 | 3s |
| research-report | 100% | research | all pass | 26 | 26,253 | 144s |

<details><summary>Answers (rep 1)</summary>

**chat-plain** — web: none

```
A list is a mutable sequence, meaning you can change, add, or remove elements after it is created. A tuple is immutable, meaning its contents are fixed once defined, which makes it faster and safer for constant data.
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
Your deployment freeze starts on September 1, 2026.
```

**exec-csv-revenue** — web: none

```
The total revenue has been calculated and written to `revenue.txt`.
```

**exec-fib-script** — web: none

```
The script `fib.py` has been created, executed, and the result has been saved.

1.  **Script Created**: `fib.py` calculates the 20th Fibonacci number.
2.  **Execution**: The script was run using `python3`, yielding `6765`.
3.  **File Saved**: The output was saved to `fib.txt`.
```

**multi-release-notes** — web: none

```
I've processed the release information for you:

1.  **Task Created**: Added "Evaluate version v0.6.2" to your task board.
2.  **Summary Written**: Created `notes/release-summary.md` with the following details:
    *   Rust frontend rework (moving network ingress to tokenized handoff out of Python).
    *   MTP speculative decoding enabled by default (3 steps).
    *   KV cache compression for long-context batches.
    *   Fix for a deadlock in continuous batching during abort storms.
```

**cron-schedule** — web: none

```
I've scheduled a reminder for you. You'll get a notification to check the build dashboard every weekday at 8:00 AM.
```

**web-fact-to-file** — web: web_search(year Node.js was first released)

```
Node.js was first released in 2009. I've written the year to `node-year.txt`.
```

**website-summarize** — web: web_fetch(https://example-docs.test/guide)

```
Here is a summary of the Widget Service Operator Guide:

*   **Connectivity & Configuration:** The service operates on port 8443 using TLS, with configurations managed in `/etc/widget/config.toml` (reloaded via SIGHUP).
*   **Backup Protocol:** Automated nightly backups occur at 02:00 UTC to the "widget-backups" bucket with a 30-day retention period.
*   **Health Monitoring:** The `/healthz` endpoint monitors system status, specifically returning a 503 status during active backup windows.
```

**confirm-ledger** — web: none

```
I've prepared the task "Rotate the API keys" with high priority. Please confirm by replying "confirm 49dea4a5" to add it to your board.
```

**research-report** — web: web_search(state local LLM inference consumer news), web_search(state local LLM inference consumer announcements September 2026), web_search(model size vs VRAM capacity 2026), web_search(Apple Silicon vs Strix Halo unified memory), web_search(GGUF Q4_K_M vs Q8_0 quantization trade-offs), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://unified-memory.example/apple-strix-halo), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://unified-memory.example/apple-strix-halo), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://small-models.example/9b-vs-27b-tool-use), web_search(llama.cpp vs vLLM vs Ollama for single-user), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://small-models.example/9b-vs-27b-tool-use), web_search(9B vs 27B models for tool-using agents), web_fetch(https://small-models.example/9b-vs-27b-tool-use), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_search(KV cache memory overhead for long context windows), web_search(inference speed comparison of GGUF vs EXL2), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://unified-memory.example/apple-strix-halo), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://unified-memory.example/apple-strix-halo), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_search(exl2 gguf there total lack data regarding), web_search(rtx 4090 specific fraction performance lost unified), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://unified-memory.example/apple-strix-halo)

```
The current landscape of local LLM inference is defined by a clear trade-off between the high-speed performance of discrete GPUs and the massive capacity of unified memory systems. While 4-bit quantization has become the standard for maintaining model quality, smaller models often struggle with the complex logic and reliability required for autonomous agentic workflows. Consequently, hardware selection is increasingly driven by specific use cases, where high-bandwidth GPUs are preferred for low-latency interactions and unified memory systems are utilized for running much larger models at the cost of speed. [FILE:data/media/documents/local-llm-inference-consumer-gpus-2026.pdf]
```

</details>

## qwen2.5:7b

| Task | Score | Routed | Checks | Calls | Prompt tok | Wall |
|---|---|---|---|---|---|---|
| chat-plain | 100% | chat | all pass | 1 | 345 | 1s |
| chat-exact-word | 100% | chat | all pass | 1 | 340 | 0s |
| task-board | 100% | task | all pass | 2 | 2,395 | 2s |
| memory-save-recall | 40% | cron ⚠ | ✗ routed to memory (cron); ✗ fact persisted; ✗ recalled in follow-up ("I apologize for the mistake. The hour field in the cron expression should be between 0 and 23. Let's") | 9 | 13,751 | 17s |
| exec-csv-revenue | 75% | exec | ✗ revenue.txt = 94 ("123456") | 5 | 6,619 | 3s |
| exec-fib-script | 100% | exec | all pass | 3 | 3,908 | 2s |
| multi-release-notes | 60% | exec ⚠ | ✗ routed to multi (exec); ✗ task with version | 8 | 12,894 | 6s |
| cron-schedule | 100% | cron | all pass | 4 | 4,466 | 2s |
| web-fact-to-file | 100% | multi | all pass | 4 | 7,390 | 2s |
| website-summarize | 100% | website | all pass | 2 | 1,505 | 1s |
| confirm-ledger | 100% | task | all pass | 2 | 2,262 | 1s |
| research-report | 100% | research | all pass | 34 | 33,606 | 100s |

<details><summary>Answers (rep 1)</summary>

**chat-plain** — web: none

```
A Python list is mutable, allowing elements to be changed, appended, or removed, while a tuple is immutable, meaning its elements cannot be changed once it's defined. Tuples are generally used for their immutability to ensure data integrity in situations where you don't want elements to change accidentally.
```

**chat-exact-word** — web: none

```
READY
```

**task-board** — web: none

```
Here are the tasks you've added to your task board:

1. **Renew SSL certificate** - Priority: High, Status: Todo
2. **Water the plants** - Priority: Low, Status: Todo
3. **Submit quarterly report** - Priority: Medium, Status: Todo, Due: 2026-08-28

Would you like to modify or add any more tasks?
```

**memory-save-recall** — web: none

```
I apologize for the mistake. The hour field in the cron expression should be between 0 and 23. Let's correct the schedule to run the reminder at 11:00 PM on September 30, 2026, using the proper syntax:

```json
{
  "action": "cron_add",
  "name": "deployment_freeze_reminder",
  "schedule": "0 23 30 8 9 *",
  "target": "e2e",
  "category": "message",
  "channel": "e2e",
  "message": "Deployment freeze starts tomorrow at 12:00 AM."
}
```

This command will add a cron job that sends a message to the `e2e` channel at 11:00 PM on September 30, 2026, reminding you that the deployment freeze starts the next day.

Let's proceed with this command:

```json
{
  "action": "cron_add",
  "name": "deployment_freeze_reminder",
  "schedule": "0 23 30 8 9 *",
  "target": "e2e",
  "category": "message",
  "
```

**exec-csv-revenue** — web: none

```
The total revenue, calculated as the sum of units multiplied by unit price from the `sales.csv` file, is `123456`. This value has been written to `revenue.txt`.
```

**exec-fib-script** — web: none

```
The 20th Fibonacci number is 6765. This has been saved in the file `fib.txt`.
```

**multi-release-notes** — web: none

```
The changes from version v0.6.2 have been summarized in `notes/release-summary.md`:

- **Rust frontend rework**: network ingress to tokenized handoff moved out of Python
- **MTP speculative decoding**: enabled by default (3 steps)
- **KV cache compression**: for long-context batches
- **Fixed a deadlock**: in continuous batching under abort storms

You can review the summary in `notes/release-summary.md`.
```

**cron-schedule** — web: none

```
I've set up a reminder for you. Every weekday at 8am, you'll receive a message in channel "e2e" to check the build dashboard.
```

**web-fact-to-file** — web: web_search(Node.js first release year)

```
The year 2009 has been written to `node-year.txt` in your workspace.
```

**website-summarize** — web: web_fetch(https://example-docs.test/guide)

```
- The Widget Service operates on port 8443 with TLS required.
- Configuration is located in `/etc/widget/config.toml` and reloads with SIGHUP.
- Nightly backups to the "widget-backups" bucket are retained for 30 days.
```

**confirm-ledger** — web: none

```
I've added a task titled "Rotate the API keys" with high priority to your task board. To confirm this action, please reply with "confirm d6a5b642".
```

**research-report** — web: web_search(state local LLM inference consumer news), web_search(state local LLM inference consumer announcements September 2026), web_search(LLM inference VRAM limits 2026), web_search(Unified memory impact on LLM inference), web_search(GGUF quantization Q4_K_M), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://unified-memory.example/apple-strix-halo), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://unified-memory.example/apple-strix-halo), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://small-models.example/9b-vs-27b-tool-use), web_search(Serving stack options llama.cpp, vLLM, Ollama), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://small-models.example/9b-vs-27b-tool-use), web_search(Tool-using agent model size comparison), web_fetch(https://small-models.example/9b-vs-27b-tool-use), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://unified-memory.example/apple-strix-halo), web_search(9b model 27b model agent loops models knowledge discipline), web_search(27b model 9b model thinking modes help models hurt), web_fetch(https://small-models.example/9b-vs-27b-tool-use), web_fetch(https://small-models.example/9b-vs-27b-tool-use), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_search(vram local inference bounded compute.), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://unified-memory.example/apple-strix-halo), web_search(9b model 27b model agent loops knowledge discipline small), web_fetch(https://small-models.example/9b-vs-27b-tool-use), web_fetch(https://unified-memory.example/apple-strix-halo)

```
By 2026, consumer GPUs have evolved in their ability to run local Large Language Models (LLMs). A 12GB GPU like the RTX 3060 or 4070 can handle models with up to 12 billion parameters in 4-bit quantization, while a 24GB GPU such as the RTX 3090 or 4090 can manage larger 35 billion parameter models. Unified memory setups, seen in Mac Studios and Strix Halo, allow for the loading of even larger models, such as 70 billion parameters, by trading bandwidth for capacity. GGUF quantization Q4_K_M is the default, maintaining 95–98% of a model's quality with 4.5 bits per weight. [FILE:data/media/documents/llm-inference-consumer-gpus-2026.pdf]
```

</details>

---
Provenance: {"date":"2026-09-29T06:16:04.474Z","gitCommit":"018e019","ollamaUrl":"http://<host>:11434","reps":3,"profile":"wizard","workspace":"fresh","tasks":["chat-plain","chat-exact-word","task-board","memory-save-recall","exec-csv-revenue","exec-fib-script","multi-release-notes","cron-schedule","web-fact-to-file","website-summarize","confirm-ledger","research-report"]}
