# End-to-end eval — 2026-09-27

Every task through `dispatchMessage` with a wizard-generated config for the model under test (router = specialists = the model), a bootstrapped workspace, the real registry, stores and pipelines; web stubbed over a fixed corpus. Profile: **full**. Reps: 1.

| # | Model | Overall | chat-plain | chat-exact-word | task-board | memory-save-recall | exec-csv-revenue | exec-fib-script | multi-release-notes | cron-schedule | web-fact-to-file | website-summarize | research-report | prompt tok/battery | wall |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | gemma4:12b | **100%** | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 77,673 | 4.2m |
| 2 | qwen3.5:9b | **94%** | 100% | 100% | 50% | 100% | 100% | 80% | 100% | 100% | 100% | 100% | 100% | 77,315 | 1.9m |
| 3 | qwen2.5:7b | **92%** | 100% | 100% | 100% | 100% | 75% | 80% | 60% | 100% | 100% | 100% | 100% | 68,500 | 2.3m |

## By category

| Model | chat | task | memory | exec | multi | cron | web_search | website | research |
|---|---|---|---|---|---|---|---|---|---|
| gemma4:12b | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% |
| qwen3.5:9b | 100% | 50% | 100% | 90% | 100% | 100% | 100% | 100% | 100% |
| qwen2.5:7b | 100% | 100% | 100% | 78% | 60% | 100% | 100% | 100% | 100% |

## gemma4:12b

| Task | Score | Routed | Checks | Calls | Prompt tok | Wall |
|---|---|---|---|---|---|---|
| chat-plain | 100% | chat | all pass | 1 | 999 | 9s |
| chat-exact-word | 100% | chat | all pass | 1 | 994 | 2s |
| task-board | 100% | task | all pass | 4 | 5,013 | 6s |
| memory-save-recall | 100% | memory | all pass | 4 | 4,054 | 7s |
| exec-csv-revenue | 100% | exec | all pass | 4 | 6,055 | 11s |
| exec-fib-script | 100% | exec | all pass | 6 | 8,577 | 14s |
| multi-release-notes | 100% | multi | all pass | 6 | 11,214 | 15s |
| cron-schedule | 100% | cron | all pass | 2 | 2,132 | 3s |
| web-fact-to-file | 100% | multi | all pass | 4 | 8,523 | 10s |
| website-summarize | 100% | website | all pass | 2 | 1,436 | 4s |
| research-report | 100% | research | all pass | 29 | 28,676 | 162s |

<details><summary>Answers (rep 1)</summary>

**chat-plain** — web: none

```
A list is a mutable collection, meaning you can add, remove, or change its elements after it's created. A tuple is immutable, meaning its contents are fixed once defined, making it safer for data that shouldn't change.
```

**chat-exact-word** — web: none

```
READY
```

**task-board** — web: none

```
I've added those three tasks to your board:

1. **Renew SSL certificate** (ID: ebb540d2) - High priority
2. **Water the plants** (ID: 7533aca5) - Low priority
3. **Submit quarterly report** (ID: 0329268f) - Due 2026-08-28
```

**memory-save-recall** — web: none

```
Your deployment freeze starts on September 1, 2026.
```

**exec-csv-revenue** — web: none

```
The total revenue has been calculated and saved to `revenue.txt`.
```

**exec-fib-script** — web: none

```
The 20th Fibonacci number is 6765. I've created `fib.py`, executed it, and saved the result to `fib.txt`.
```

**multi-release-notes** — web: none

```
I've processed the release notes for you:

1.  **Task Created**: Added "Evaluate version v0.6.2" to your task board (ID: 67816383).
2.  **Summary Written**: Created `notes/release-summary.md` with a structured summary of the changes (Rust frontend rework, MTP speculative decoding, KV cache compression, and the deadlock fix).
```

**cron-schedule** — web: none

```
I've scheduled that for you. You'll receive a reminder to check the build dashboard every weekday at 8:00 AM.
```

**web-fact-to-file** — web: web_search(year Node.js was first released)

```
Node.js was first released in 2009. I've written that year to `node-year.txt`.
```

**website-summarize** — web: web_fetch(https://example-docs.test/guide)

```
Here is a summary of the Widget Service Operator Guide:

*   **Connectivity & Config:** The service operates on port 8443 using TLS, with configuration managed in `/etc/widget/config.toml` (reloadable via SIGHUP).
*   **Backup Protocol:** Automated nightly backups occur at 02:00 UTC to the "widget-backups" bucket with a 30-day retention period.
*   **Health Monitoring:** The `/healthz` endpoint monitors system status, specifically returning a 503 status during active backup windows.
```

**research-report** — web: web_search(state local LLM inference consumer news), web_search(state local LLM inference consumer announcements September 2026), web_search(model size vs VRAM capacity 2026), web_search(GGUF Q4_K_M vs Q8_0 quantization trade-offs), web_search(Apple Silicon vs Strix Halo unified memory), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://unified-memory.example/apple-strix-halo), web_fetch(https://unified-memory.example/apple-strix-halo), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://small-models.example/9b-vs-27b-tool-use), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_search(llama.cpp vs vLLM vs Ollama performance), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://small-models.example/9b-vs-27b-tool-use), web_search(9B vs 27B models for tool-use agents), web_fetch(https://small-models.example/9b-vs-27b-tool-use), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_search(inference speed comparison llama.cpp vs vLLM), web_search(KV cache memory overhead for long context), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://unified-memory.example/apple-strix-halo), web_fetch(https://unified-memory.example/apple-strix-halo), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_search(phi4 gemma3 small specific models small still trigger), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://small-models.example/9b-vs-27b-tool-use)

```
The current landscape of local LLM inference is defined by a clear trade-off between high-speed performance on dedicated GPUs and high-capacity execution on unified memory systems. While 4-bit quantization has become the standard for balancing model fidelity with memory limits, dropping below this threshold significantly degrades the reliability of complex tasks like tool-calling. Hardware selection now depends on specific needs, where high-end GPUs offer superior speed for smaller models while unified memory systems allow for the operation of much larger models at the cost of lower generation speeds. [FILE:data/media/documents/local-llm-inference-consumer-gpus-2026.pdf]
```

</details>

## qwen3.5:9b

| Task | Score | Routed | Checks | Calls | Prompt tok | Wall |
|---|---|---|---|---|---|---|
| chat-plain | 100% | chat | all pass | 1 | 960 | 3s |
| chat-exact-word | 100% | chat | all pass | 1 | 955 | 1s |
| task-board | 50% | task | ✗ three tasks exist (0 tasks: ); ✗ priorities correct (undefined/undefined); ✗ due date correct | 2 | 0 | 3s |
| memory-save-recall | 100% | memory | all pass | 3 | 3,629 | 4s |
| exec-csv-revenue | 100% | exec | all pass | 4 | 6,871 | 7s |
| exec-fib-script | 80% | exec | ✗ fib.txt = 6765 ("") | 11 | 22,940 | 17s |
| multi-release-notes | 100% | multi | all pass | 6 | 12,819 | 11s |
| cron-schedule | 100% | cron | all pass | 3 | 4,043 | 4s |
| web-fact-to-file | 100% | multi | all pass | 4 | 9,443 | 6s |
| website-summarize | 100% | website | all pass | 2 | 1,868 | 3s |
| research-report | 100% | research | all pass | 12 | 13,787 | 53s |

<details><summary>Answers (rep 1)</summary>

**chat-plain** — web: none

```
A Python list is mutable, meaning you can add, remove, or change its elements after creation, while a tuple is immutable and cannot be modified once defined. This immutability makes tuples faster for read-only data and allows them to be used as dictionary keys, whereas lists are generally preferred when you need to store a collection of items that might change.
```

**chat-exact-word** — web: none

```
READY
```

**task-board** — web: none

```
You're right - I need to actually call the tools to add these tasks. Let me create each one:
```

**memory-save-recall** — web: none

```
Your deployment freeze starts on **2026-09-01**.
```

**exec-csv-revenue** — web: none

```
Done! I've computed the total revenue (94.00) and written it to revenue.txt.
```

**exec-fib-script** — web: none

```
I've created the `fib.py` script in your workspace directory. The script calculates the 20th Fibonacci number (where fib(1)=1, fib(2)=1).

The calculation shows that **fib(20) = 6765**.

However, I wasn't able to successfully save the output to `fib.txt` - the file doesn't appear to have been created. The shell command execution had issues (ENOENT errors), and the code session approach also encountered syntax problems with the file writing operations.

The script itself is correct and would work properly when run in an environment where Python can execute it directly. If you need the output saved to `fib.txt`, you may want to try running:

```bash
python3 fib.py > fib.txt
```

in a terminal where the shell commands are functional.
```

**multi-release-notes** — web: none

```
Done! I've:
1. Read `releases.txt` and found version v0.6.2 with 4 changes
2. Created task "Evaluate new version v0.6.2" (ID: adb048be) with medium priority
3. Written `notes/release-summary.md` summarizing the Rust frontend rework, MTP speculative decoding, KV cache compression, and the deadlock fix
```

**cron-schedule** — web: none

```
I apologize for the confusion in my previous response. I did actually call the `cron_add` tool successfully, as shown in the function result:

```
Scheduled recurring job "weekday-build-dashboard-reminder" (c31a5234) with schedule "0 8 * * 1-5", category="message"
```

The cron job has been created and is now active. The reminder will trigger every weekday at 8am to check the build dashboard.
```

**web-fact-to-file** — web: web_search(year Node.js was first released)

```
Node.js was first released in 2009.
```

**website-summarize** — web: web_fetch(https://example-docs.test/guide)

```
- The Widget Service listens on port 8443 with TLS enabled, using configuration from `/etc/widget/config.toml` that reloads on SIGHUP without requiring a restart.  
- Backups occur nightly at 02:00 UTC to the `widget-backups` bucket and are retained for 30 days.  
- The health endpoint `/healthz` returns a 503 status code while a backup is in progress.
```

**research-report** — web: web_search(state local LLM inference consumer news), web_search(state local LLM inference consumer announcements September 2026), web_search(VRAM constraints vs compute limits for 2026 consumer GPUs), web_search(Apple Silicon unified memory capacity tradeoffs), web_search(GGUF quantization quality benchmarks Q4_K_M vs Q8_0), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://unified-memory.example/apple-strix-halo), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://unified-memory.example/apple-strix-halo), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://small-models.example/9b-vs-27b-tool-use), web_search(llama.cpp versus vLLM serving stack efficiency comparison), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://small-models.example/9b-vs-27b-tool-use), web_search(Tool-using agent capabilities in 9B versus 27B models), web_fetch(https://small-models.example/9b-vs-27b-tool-use), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama)

```
In 2026, local LLM inference on consumer hardware has become strictly limited by VRAM capacity rather than raw compute power, forcing users to balance model scale against quantization fidelity. While unified memory systems like Apple Silicon can load massive models exceeding 70B parameters, they suffer from significant latency penalties during interactive agent loops compared to discrete GPUs. The most critical factor for success is architectural discipline; a moderately sized model with structured reasoning capabilities consistently outperforms larger, less optimized models in complex tool-use scenarios regardless of quantization level. [FILE:data/media/documents/local-llm-inference-consumer-gpus-2026.pdf]
```

</details>

## qwen2.5:7b

| Task | Score | Routed | Checks | Calls | Prompt tok | Wall |
|---|---|---|---|---|---|---|
| chat-plain | 100% | chat | all pass | 1 | 937 | 1s |
| chat-exact-word | 100% | chat | all pass | 1 | 932 | 1s |
| task-board | 100% | task | all pass | 2 | 2,394 | 3s |
| memory-save-recall | 100% | memory | all pass | 6 | 6,792 | 4s |
| exec-csv-revenue | 75% | exec | ✗ revenue.txt = 94 ("123456") | 4 | 4,382 | 3s |
| exec-fib-script | 80% | exec | ✗ fib.txt = 6765 ("1655801837266826841") | 4 | 4,245 | 4s |
| multi-release-notes | 60% | task | ✗ task with version (Evaluate new version); ✗ summary covers ≥2 changes (0/4 phrases, 0 chars) | 6 | 8,149 | 6s |
| cron-schedule | 100% | cron | all pass | 4 | 4,470 | 3s |
| web-fact-to-file | 100% | web_search | all pass | 6 | 3,996 | 4s |
| website-summarize | 100% | website | all pass | 2 | 1,505 | 2s |
| research-report | 100% | research | all pass | 32 | 30,698 | 100s |

<details><summary>Answers (rep 1)</summary>

**chat-plain** — web: none

```
A Python list is mutable, allowing elements to be changed, added, or removed, while a tuple is immutable, meaning its elements cannot be altered once defined.
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
I've confirmed using the memory_search tool that your deployment freeze started on 2026-09-01. Is there anything else you need assistance with regarding this?
```

**exec-csv-revenue** — web: none

```
The total revenue calculated from the `sales.csv` file is 123456. This value has been written to the file `revenue.txt`.
```

**exec-fib-script** — web: none

```
The Python script `fib.py` has been created and executed successfully. The 20th Fibonacci number, which is 1655801837266826841, has been saved in the file `fib.txt`.
```

**multi-release-notes** — web: none

```
Understood. Let's move forward with the information we have.

Based on the task ID `0a8f4b11`, the task to evaluate the new version is already created and marked as todo. Now, I will read the `releases.txt` file to gather the necessary information for summarizing the changes.

Let's proceed with reading the `releases.txt` file.
```

**cron-schedule** — web: none

```
I've set up a reminder for you. Every weekday at 8am, you'll receive a message in channel "e2e" to check the build dashboard.
```

**web-fact-to-file** — web: web_search(Node.js release year), web_fetch(2009), web_search(Node.js first release year)

```
Node.js was first released in 2009. I will now write this year to `node-year.txt` in your workspace.

Here is the content that will be written to `node-year.txt`:

2009

Let's proceed with writing this to the file.
node-year.txt:
2009
```

**website-summarize** — web: web_fetch(https://example-docs.test/guide)

```
- The Widget Service operates on port 8443 with TLS required.
- Configuration is located in `/etc/widget/config.toml` and reloads with SIGHUP.
- Backups occur nightly at 02:00 UTC, retained for 30 days in the "widget-backups" bucket.
- The health endpoint is `/healthz`, returning 503 during backup progress.
```

**research-report** — web: web_search(state local LLM inference consumer news), web_search(state local LLM inference consumer announcements September 2026), web_search(Local LLM inference VRAM limits 2026), web_search(Unified memory impact on LLM inference), web_search(GGUF quantization tradeoffs 2026), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://unified-memory.example/apple-strix-halo), web_fetch(https://unified-memory.example/apple-strix-halo), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://small-models.example/9b-vs-27b-tool-use), web_search(Serving stacks for individual users), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://small-models.example/9b-vs-27b-tool-use), web_search(Tool-using agent model size comparison), web_fetch(https://small-models.example/9b-vs-27b-tool-use), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://unified-memory.example/apple-strix-halo)

```
By 2026, consumer GPUs like the RTX 3060 and 4090 support local LLM inference with models ranging from 7 to 35 billion parameters, using quantization techniques like Q4_K_M to optimize memory usage and performance. Throughput varies, with a 4090 handling about 35–45 tokens per second for a 27B model and a 3060 managing around 25 tokens per second for a 12B model. Unified memory solutions, such as those found in Apple silicon and Strix Halo, allow for larger model sizes but at the cost of reduced throughput. [FILE:data/media/documents/llm-inference-consumer-gpus-2026.pdf]
```

</details>

---
Provenance: {"date":"2026-09-27T19:19:29.915Z","gitCommit":"198058d","ollamaUrl":"http://<host>:11434","reps":1,"profile":"full","tasks":["chat-plain","chat-exact-word","task-board","memory-save-recall","exec-csv-revenue","exec-fib-script","multi-release-notes","cron-schedule","web-fact-to-file","website-summarize","research-report"]}
