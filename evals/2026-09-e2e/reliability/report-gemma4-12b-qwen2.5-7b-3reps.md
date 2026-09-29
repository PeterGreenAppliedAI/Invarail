# End-to-end eval — 2026-09-28 · profile=wizard · workspace=fresh

Every task through `dispatchMessage` with a wizard-generated config for the model under test (router = specialists = the model), a bootstrapped workspace, the real registry, stores and pipelines; web stubbed over a fixed corpus. Prompt profile: **wizard** (`wizard` = what the wizard writes for the model's tier). Workspace: **fresh**. Reps: 3.

| # | Model | Overall | chat-plain | chat-exact-word | task-board | memory-save-recall | exec-csv-revenue | exec-fib-script | multi-release-notes | cron-schedule | web-fact-to-file | website-summarize | confirm-ledger | research-report | prompt tok/battery | wall |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | gemma4:12b | **99%** | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 87% | 100% | 100% | 100% | 72,670 | 11.4m |
| 2 | qwen2.5:7b | **95%** | 100% | 100% | 100% | 100% | 83% | 100% | 60% | 100% | 100% | 100% | 100% | 100% | 69,415 | 6.8m |

## By category

| Model | chat | task | memory | exec | multi | cron | web_search | website | research |
|---|---|---|---|---|---|---|---|---|---|
| gemma4:12b | 100% | 100% | 100% | 100% | 100% | 100% | 87% | 100% | 100% |
| qwen2.5:7b | 100% | 100% | 100% | 92% | 60% | 100% | 100% | 100% | 100% |

## gemma4:12b

| Task | Score | Routed | Checks | Calls | Prompt tok | Wall |
|---|---|---|---|---|---|---|
| chat-plain | 100% | chat | all pass | 1 | 363 | 4s |
| chat-exact-word | 100% | chat | all pass | 1 | 358 | 2s |
| task-board | 100% | task | all pass | 4 | 5,017 | 6s |
| memory-save-recall | 100% | memory | all pass | 4 | 3,883 | 6s |
| exec-csv-revenue | 100% | exec | all pass | 2 | 3,881 | 5s |
| exec-fib-script | 100% | exec | all pass | 4 | 6,204 | 12s |
| multi-release-notes | 100% | multi | all pass | 6 | 11,251 | 15s |
| cron-schedule | 100% | cron | all pass | 2 | 2,131 | 4s |
| web-fact-to-file | 100% | multi | all pass | 4 | 8,523 | 10s |
| website-summarize | 100% | website | all pass | 2 | 1,436 | 5s |
| confirm-ledger | 100% | task | all pass | 2 | 2,406 | 4s |
| research-report | 100% | research | all pass | 14 | 15,718 | 110s |

<details><summary>Answers (rep 1)</summary>

**chat-plain** — web: none

```
A list is a mutable sequence, meaning you can change, add, or remove elements after it has been created. A tuple is immutable, meaning its contents are fixed once defined, making it safer for constant data and slightly more memory-efficient.
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
The total revenue has been calculated and saved to `revenue.txt`.
```

**exec-fib-script** — web: none

```
The script `fib.py` was created, executed, and its output (6765) was saved to `fib.txt`.
```

**multi-release-notes** — web: none

```
I've processed the release notes for you:

1.  **Task Created**: Added "Evaluate version v0.6.2" to your task board.
2.  **Summary Written**: Created `notes/release-summary.md` with the following details:
    *   Rust frontend rework (moving network ingress out of Python)
    *   MTP speculative decoding enabled by default
    *   KV cache compression for long-context batches
    *   Fix for deadlock in continuous batching during abort storms.
```

**cron-schedule** — web: none

```
I've scheduled a reminder for you. You'll receive a notification to check the build dashboard every weekday at 8:00 AM.
```

**web-fact-to-file** — web: web_search(year Node.js was first released)

```
Node.js was first released in 2009. I've saved that year to `node-year.txt`.
```

**website-summarize** — web: web_fetch(https://example-docs.test/guide)

```
Here is a summary of the Widget Service Operator Guide:

*   **Connectivity & Config:** The service operates on port 8443 with TLS; configuration is managed in `/etc/widget/config.toml` and can be reloaded via SIGHUP.
*   **Backup Protocol:** Automated backups occur daily at 02:00 UTC to the "widget-backups" bucket with a 30-day retention period.
*   **Health Monitoring:** The `/healthz` endpoint is used for status checks, though it will return a 503 status during active backup windows.
```

**confirm-ledger** — web: none

```
I've prepared the task "Rotate the API keys" with high priority. Please reply with **confirm e5660997** to add it to your board.
```

**research-report** — web: web_search(state local LLM inference consumer news), web_search(state local LLM inference consumer announcements September 2026), web_search(model size vs VRAM capacity 2026), web_search(GGUF Q4_K_M vs Q8_0 quantization trade-offs), web_search(Apple Silicon vs Strix Halo unified memory), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://unified-memory.example/apple-strix-halo), web_fetch(https://unified-memory.example/apple-strix-halo), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://small-models.example/9b-vs-27b-tool-use), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_search(llama.cpp vs vLLM vs Ollama performance), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://small-models.example/9b-vs-27b-tool-use), web_search(9B vs 27B models for tool-use agents), web_fetch(https://small-models.example/9b-vs-27b-tool-use), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_search(inference speed comparison llama.cpp vs vLLM), web_search(KV cache memory overhead for long context), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://unified-memory.example/apple-strix-halo), web_fetch(https://unified-memory.example/apple-strix-halo), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://quant-notes.example/gguf-quantization-guide)

```
The feasibility of running large language models on consumer hardware is primarily determined by the balance between model size and quantization depth, with 4-bit quantization serving as the standard for maintaining high quality while managing memory constraints. While high-end discrete GPUs offer superior inference speeds, unified memory systems allow for the deployment of much larger models at the cost of slower processing. Choosing the correct serving stack is critical for performance, as tools like llama.cpp excel in single-user environments while vLLM provides better throughput for shared applications. Additionally, larger models significantly outperform smaller ones in complex tasks like tool-calling and agentic loops due to better logical consistency. [FILE:data/media/documents/loca
```

</details>

## qwen2.5:7b

| Task | Score | Routed | Checks | Calls | Prompt tok | Wall |
|---|---|---|---|---|---|---|
| chat-plain | 100% | chat | all pass | 1 | 345 | 3s |
| chat-exact-word | 100% | chat | all pass | 1 | 340 | 1s |
| task-board | 100% | task | all pass | 2 | 2,393 | 4s |
| memory-save-recall | 100% | memory | all pass | 4 | 3,958 | 4s |
| exec-csv-revenue | 75% | exec | ✗ revenue.txt = 94 ("123456") | 4 | 4,381 | 4s |
| exec-fib-script | 100% | exec | all pass | 3 | 3,906 | 3s |
| multi-release-notes | 60% | task | ✗ task with version (Evaluate version X.Y.Z | Evaluate version X.Y.Z); ✗ summary covers ≥2 changes (0/4 phrases, 0 chars) | 6 | 7,633 | 7s |
| cron-schedule | 100% | cron | all pass | 2 | 2,036 | 2s |
| web-fact-to-file | 100% | web_search | all pass | 6 | 4,089 | 4s |
| website-summarize | 100% | website | all pass | 2 | 1,505 | 2s |
| confirm-ledger | 100% | task | all pass | 2 | 2,260 | 2s |
| research-report | 100% | research | all pass | 32 | 31,880 | 102s |

<details><summary>Answers (rep 1)</summary>

**chat-plain** — web: none

```
A Python list is mutable, meaning you can change, add, or remove items after the list has been created, while a tuple is immutable, so its contents cannot be changed once it's defined. Additionally, tuples are generally faster than lists due to their immutability.
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

Would you like to modify or mark any of these tasks as done?
```

**memory-save-recall** — web: none

```
Your deployment freeze starts on 2026-09-01. This information was saved in your context memory for future reference.
```

**exec-csv-revenue** — web: none

```
The total revenue calculated from the `sales.csv` file is 123456. This value has been written to `revenue.txt`.
```

**exec-fib-script** — web: none

```
The 20th Fibonacci number is 6765. This value has been saved in the file `fib.txt`.
```

**multi-release-notes** — web: none

```
I have created a task titled "Evaluate version X.Y.Z" with the ID `bca872ac`. The task is set to medium priority and is currently in the 'todo' status.

Next, I will read the `releases.txt` file to gather the necessary information about the new version and summarize the actual changes in `notes/release-summary.md`.

Let's proceed by reading the `releases.txt` file to determine the version number and any notes for the new release.
```plaintext
cat data/workspaces/main/releases.txt
```
Based on the content of `releases.txt`, I will summarize the actual changes and create the `notes/release-summary.md` file. Please provide the content of `releases.txt` so I can proceed with the summary.
```

**cron-schedule** — web: none

```
I've scheduled a reminder for you to check the build dashboard every weekday at 8am. You can rely on this to keep your builds on track!
```

**web-fact-to-file** — web: web_search(Node.js release year), web_fetch(data/workspaces/main/node-year.txt), web_search(Node.js first release year)

```
Node.js was first released in 2009. I will now write the year 2009 to node-year.txt in your workspace.

Here is the content that was found:
- Node.js was first released in 2009 by Ryan Dahl, built on Google's V8 engine. npm arrived in 2010. The io.js fork in 2014 merged back in 2015 under the Node.js project.

Let's proceed with writing the year 2009 to node-year.txt.
```

**website-summarize** — web: web_fetch(https://example-docs.test/guide)

```
- The Widget Service listens on port 8443 with TLS required.
- Configuration is reloaded with SIGHUP and backups are retained for 30 days.
- Health checks return 503 during backup operations.
```

**confirm-ledger** — web: none

```
I've added the task "Rotate the API keys" with high priority to your task board. To confirm this action, please reply with "confirm cf074c0c".
```

**research-report** — web: web_search(state local LLM inference consumer news), web_search(state local LLM inference consumer announcements September 2026), web_search(LLM inference limits on 12GB consumer GPUs), web_search(LLM models supported by 24GB consumer GPUs), web_search(Unified memory impact on LLM inference), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://unified-memory.example/apple-strix-halo), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://unified-memory.example/apple-strix-halo), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://small-models.example/9b-vs-27b-tool-use), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://unified-memory.example/apple-strix-halo), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_search(GGUF quantization tradeoffs), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://small-models.example/9b-vs-27b-tool-use), web_search(Serving stack options for individual users), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://small-models.example/9b-vs-27b-tool-use), web_search(Tool-using agent model efficiency), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://small-models.example/9b-vs-27b-tool-use), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://unified-memory.example/apple-strix-halo)

```
In 2026, consumer GPUs like the RTX 3060 and 4090 have enabled local LLM inference for models ranging from 7B to 35B parameters, with throughput varying from 25 to 45 tokens per second. Unified memory, seen in Apple silicon and Strix Halo, allows handling larger models but at the cost of reduced bandwidth. Quantization techniques, particularly Q4_K_M, maintain model quality while optimizing VRAM usage, though tool calling can introduce errors for some models. [FILE:data/media/documents/llm-inference-consumer-gpus-2026.pdf]
```

</details>

---
Provenance: {"date":"2026-09-28T04:32:45.578Z","gitCommit":"89ccb6f","ollamaUrl":"http://<host>:11434","reps":3,"profile":"wizard","workspace":"fresh","tasks":["chat-plain","chat-exact-word","task-board","memory-save-recall","exec-csv-revenue","exec-fib-script","multi-release-notes","cron-schedule","web-fact-to-file","website-summarize","confirm-ledger","research-report"]}
