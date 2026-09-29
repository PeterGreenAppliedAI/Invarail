# End-to-end eval — 2026-09-27

Every task through `dispatchMessage` with a wizard-generated config for the model under test (router = specialists = the model), a bootstrapped workspace, the real registry, stores and pipelines; web stubbed over a fixed corpus. Profile: **full**. Reps: 1.

| # | Model | Overall | chat-plain | chat-exact-word | task-board | memory-save-recall | exec-csv-revenue | exec-fib-script | multi-release-notes | cron-schedule | web-fact-to-file | website-summarize | research-report | prompt tok/battery | wall |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | gemma4:12b | **95%** | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 50% | 69,092 | 4.8m |
| 2 | qwen2.5:7b | **90%** | 100% | 100% | 100% | 100% | 75% | 100% | 60% | 100% | 100% | 100% | 50% | 57,360 | 2.0m |
| 3 | qwen3.5:9b | **80%** | 100% | 100% | 100% | 100% | 50% | 40% | 60% | 100% | 100% | 100% | 33% | 29,060 | 0.9m |

## By category

| Model | chat | task | memory | exec | multi | cron | web_search | website | research |
|---|---|---|---|---|---|---|---|---|---|
| gemma4:12b | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 50% |
| qwen2.5:7b | 100% | 100% | 100% | 88% | 60% | 100% | 100% | 100% | 50% |
| qwen3.5:9b | 100% | 100% | 100% | 45% | 60% | 100% | 100% | 100% | 33% |

## gemma4:12b

| Task | Score | Routed | Checks | Calls | Prompt tok | Wall |
|---|---|---|---|---|---|---|
| chat-plain | 100% | chat | all pass | 1 | 999 | 19s |
| chat-exact-word | 100% | chat | all pass | 1 | 994 | 2s |
| task-board | 100% | task | all pass | 4 | 5,021 | 5s |
| memory-save-recall | 100% | memory | all pass | 3 | 3,038 | 6s |
| exec-csv-revenue | 100% | multi | all pass | 3 | 5,275 | 6s |
| exec-fib-script | 100% | multi | all pass | 6 | 7,977 | 15s |
| multi-release-notes | 100% | multi | all pass | 6 | 7,970 | 24s |
| cron-schedule | 100% | cron | all pass | 2 | 2,131 | 13s |
| web-fact-to-file | 100% | multi | all pass | 4 | 6,114 | 10s |
| website-summarize | 100% | website | all pass | 2 | 1,436 | 4s |
| research-report | 50% | research | ✗ pipeline ran to a report (not the evidence-gate abort) (0 chars of report text, 40 web calls); ✗ report uses ≥3 corpus facts (0/8); ✗ cites ≥2 corpus URLs (0 cited) | 28 | 28,137 | 146s |

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
Your deployment freeze starts on September 1, 2026.
```

**exec-csv-revenue** — web: none

```
The total revenue has been calculated and written to `revenue.txt`.
```

**exec-fib-script** — web: none

```
The script `fib.py` has been created, executed, and the result has been saved.

1.  **Created `fib.py`**: Implemented a function to calculate the $n$-th Fibonacci number.
2.  **Executed**: Ran the script, which calculated the 20th Fibonacci number as **6765**.
3.  **Saved Output**: The result was saved to `fib.txt`.
```

**multi-release-notes** — web: none

```
I've processed the release information for you:

1.  **Task Created**: Added "Evaluate version v0.6.2" to your task board.
2.  **Summary Written**: Created `notes/release-summary.md` with the details of the Rust frontend rework, MTP speculative decoding, KV cache compression, and the deadlock fix.
```

**cron-schedule** — web: none

```
I've scheduled a reminder for you. You'll get a notification to check the build dashboard every weekday at 8:00 AM.
```

**web-fact-to-file** — web: web_search(year Node.js was first released)

```
Node.js was first released in 2009. I've written that year to `node-year.txt`.
```

**website-summarize** — web: web_fetch(https://example-docs.test/guide)

```
Here is a summary of the Widget Service Operator Guide:

*   **Connectivity & Config:** The service operates on port 8443 with TLS; configuration is managed via `/etc/widget/config.toml` and can be reloaded using SIGHUP without a restart.
*   **Backup Protocol:** Automated nightly backups occur at 02:00 UTC to the "widget-backups" bucket with a 30-day retention period.
*   **Health Monitoring:** The `/healthz` endpoint provides status updates, specifically returning a 503 error during active backup windows.
```

**research-report** — web: web_search(state local LLM inference consumer news), web_search(state local LLM inference consumer announcements September 2026), web_search(model size vs VRAM capacity 2026), web_search(GGUF Q4_K_M vs Q8_0 quantization tradeoffs), web_search(Apple Silicon vs Strix Halo unified memory), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://unified-memory.example/apple-strix-halo), web_fetch(https://unified-memory.example/apple-strix-halo), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://small-models.example/9b-vs-27b-tool-use), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_search(llama.cpp vs vLLM vs Ollama for single user), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://small-models.example/9b-vs-27b-tool-use), web_search(9B vs 27B models for tool-using agents), web_fetch(https://small-models.example/9b-vs-27b-tool-use), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_search(inference speed benchmarks for GGUF vs EXL2), web_search(vLLM PagedAttention vs llama.cpp memory efficiency), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://unified-memory.example/apple-strix-halo), web_fetch(https://unified-memory.example/apple-strix-halo), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_search(amd apple specific sweet spot model size), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://unified-memory.example/apple-strix-halo)

```
By 2026, local LLM inference is defined by a clear divide between high-speed NVIDIA GPUs, which are ideal for smaller models under 35B parameters, and unified memory systems like Apple Silicon, which allow for much larger models at the cost of lower processing speeds. Quantization has reached a critical threshold where 4-bit weights are the standard for maintaining model integrity, while dropping below this level significantly degrades performance and reliability in complex tasks like tool-calling. For autonomous agents, larger 27B models are preferred over 9B models because they maintain better logical consistency and reliability across long, multi-step workflows.

(Note: the report was generated but the PDF conversion did not produce a file.)
```

</details>

## qwen2.5:7b

| Task | Score | Routed | Checks | Calls | Prompt tok | Wall |
|---|---|---|---|---|---|---|
| chat-plain | 100% | chat | all pass | 1 | 937 | 2s |
| chat-exact-word | 100% | chat | all pass | 1 | 932 | 1s |
| task-board | 100% | task | all pass | 2 | 2,392 | 3s |
| memory-save-recall | 100% | memory | all pass | 6 | 6,786 | 4s |
| exec-csv-revenue | 75% | exec | ✗ revenue.txt = 94 ("") | 3 | 2,783 | 4s |
| exec-fib-script | 100% | exec | all pass | 3 | 2,715 | 3s |
| multi-release-notes | 60% | task | ✗ task with version (Evaluate new version); ✗ summary covers ≥2 changes (0/4 phrases, 0 chars) | 4 | 4,892 | 5s |
| cron-schedule | 100% | cron | all pass | 4 | 4,482 | 3s |
| web-fact-to-file | 100% | web_search | all pass | 6 | 4,089 | 4s |
| website-summarize | 100% | website | all pass | 2 | 1,505 | 2s |
| research-report | 50% | research | ✗ pipeline ran to a report (not the evidence-gate abort) (0 chars of report text, 27 web calls); ✗ report uses ≥3 corpus facts (0/8); ✗ cites ≥2 corpus URLs (0 cited) | 26 | 25,847 | 86s |

<details><summary>Answers (rep 1)</summary>

**chat-plain** — web: none

```
A Python list is mutable, allowing elements to be added, removed, or changed, while a tuple is immutable, meaning its elements cannot be altered once assigned. Lists are denoted by square brackets [] and tuples by parentheses ().
```

**chat-exact-word** — web: none

```
READY
```

**task-board** — web: none

```
Here are the tasks added to your task board:

1. **Renew SSL certificate** - Priority: High, Status: Todo
2. **Water the plants** - Priority: Low, Status: Todo
3. **Submit quarterly report** - Priority: Medium, Status: Todo, Due: 2026-08-28

Would you like to modify or add any more tasks?
```

**memory-save-recall** — web: none

```
I've confirmed that your deployment freeze started on 2026-09-01. Is there anything else you need help with regarding this?
```

**exec-csv-revenue** — web: none

```
It seems there was an issue with running the Python command. Let's try another approach using the `python3` tool directly to ensure we can process the CSV file correctly.

Let's use the `python3` tool to compute the total revenue from the `sales.csv` file and write the result to `revenue.txt`.
```

**exec-fib-script** — web: none

```
The 20th Fibonacci number is 6765. This value has been saved in the file `fib.txt`.
```

**multi-release-notes** — web: none

```
It seems like the task has already been created and is marked as `todo`. Let's proceed with reading the `releases.txt` file to gather the necessary information for evaluating the new version.

I will now call the `read_releases_file` function to extract the version number and any relevant changes.
```

**cron-schedule** — web: none

```
I've scheduled a reminder for you to check the build dashboard every weekday at 8am. You can manage this task using the commands provided. If you need any further assistance, feel free to ask!
```

**web-fact-to-file** — web: web_search(Node.js release year), web_fetch(data/workspaces/main/node-year.txt), web_search(Node.js first release year)

```
Node.js was first released in 2009. I will now write the year 2009 to node-year.txt in your workspace.

Here is the content that was found:
- Node.js was first released in 2009 by Ryan Dahl, built on Google's V8 engine. npm arrived in 2010. The io.js fork in 2014 merged back in 2015 under the Node.js project.

Let me proceed with writing the year 2009 to node-year.txt.
```

**website-summarize** — web: web_fetch(https://example-docs.test/guide)

```
- The Widget Service operates on port 8443 with TLS required.
- Configurations are managed in `/etc/widget/config.toml` and reloaded with a SIGHUP signal.
- Nightly backups occur at 02:00 UTC, retained for 30 days in the "widget-backups" bucket.
```

**research-report** — web: web_search(state local LLM inference consumer news), web_search(state local LLM inference consumer announcements September 2026), web_search(LLM inference VRAM limits 2026), web_search(Unified memory impact on LLM inference), web_search(GGUF quantization methods comparison), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://unified-memory.example/apple-strix-halo), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://unified-memory.example/apple-strix-halo), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://small-models.example/9b-vs-27b-tool-use), web_search(Serving stacks for individual users), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://gpu-inference.example/consumer-gpus-2026), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://small-models.example/9b-vs-27b-tool-use), web_search(Tool-using agent model size efficiency), web_fetch(https://serving-stacks.example/llamacpp-vs-vllm-vs-ollama), web_fetch(https://small-models.example/9b-vs-27b-tool-use), web_fetch(https://quant-notes.example/gguf-quantization-guide), web_fetch(https://unified-memory.example/apple-strix-halo)

```
By 2026, local LLM inference on consumer GPUs has seen significant advancements, with specific models and quantization techniques optimizing performance and efficiency. A 12GB GPU like the RTX 3060 can handle 7-12B parameter models in 4-bit GGUF, while a 24GB GPU like the RTX 3090 can manage 27-35B parameter models. Throughput varies, with a 27B model on a 4090 running at about 35-45 tokens per second, and a 12B model on a 3060 at around 25 tokens per second. Unified memory solutions, such as those in Apple silicon and Strix Halo, can handle larger models but introduce latency due to lower bandwidth.

(Note: the report was generated but the PDF conversion did not produce a file.)
```

</details>

## qwen3.5:9b

| Task | Score | Routed | Checks | Calls | Prompt tok | Wall |
|---|---|---|---|---|---|---|
| chat-plain | 100% | chat | all pass | 1 | 960 | 3s |
| chat-exact-word | 100% | chat | all pass | 1 | 955 | 1s |
| task-board | 100% | task | all pass | 4 | 6,192 | 5s |
| memory-save-recall | 100% | memory | all pass | 3 | 3,608 | 4s |
| exec-csv-revenue | 50% | chat ⚠ | ✗ routed to exec|multi (chat); ✗ revenue.txt = 94 ("") | 1 | 981 | 2s |
| exec-fib-script | 40% | chat ⚠ | ✗ routed to exec|multi (chat); ✗ fib.py exists; ✗ fib.txt = 6765 ("") | 1 | 989 | 2s |
| multi-release-notes | 60% | task | ✗ task with version (Evaluate new version 1.2.3); ✗ summary covers ≥2 changes (0/4 phrases, 0 chars) | 2 | 2,963 | 4s |
| cron-schedule | 100% | cron | all pass | 2 | 2,601 | 3s |
| web-fact-to-file | 100% | multi | all pass | 4 | 6,961 | 6s |
| website-summarize | 100% | website | all pass | 2 | 1,868 | 2s |
| research-report | 33% | chat ⚠ | ✗ routed to research (chat); ✗ pipeline ran to a report (not the evidence-gate abort) (0 chars of report text, 0 web calls); ✗ report uses ≥3 corpus facts (0/8); ✗ cites ≥2 corpus URLs (0 cited) | 1 | 982 | 21s |

<details><summary>Answers (rep 1)</summary>

**chat-plain** — web: none

```
A Python list is mutable, meaning you can change its elements after creation, whereas a tuple is immutable and cannot be altered once defined. Lists are generally used for collections of items that may change, while tuples are preferred for fixed data like coordinates or database records.
```

**chat-exact-word** — web: none

```
READY
```

**task-board** — web: none

```
All three tasks have been added to your task board:

1. **Renew SSL certificate** (ID: 001eb1c6) — high priority
2. **Water the plants** (ID: dd5e0b58) — low priority  
3. **Submit quarterly report** (ID: 3aa1b42f) — medium priority, due 2026-08-28

Note: I set "Submit quarterly report" to medium priority since you didn't specify one. Is that okay, or would you like me to adjust it?
```

**memory-save-recall** — web: none

```
Your deployment freeze starts on **2026-09-01**.
```

**exec-csv-revenue** — web: none

```
I'll compute the total revenue from `sales.csv` and save it to `revenue.txt`. Let me start by reading the CSV file.

<invoke_tool>read_file</invoke_tool>
<path>sales.csv</path>
```

**exec-fib-script** — web: none

```
Here's your `fib.py` script:

```python
# fib.py - Computes the nth Fibonacci number (fib(1)=1, fib(2)=1)
def fib(n):
    a, b = 1, 1
    for _ in range(2, n + 1):
        a, b = b, a + b
    return a

print(fib(20))
```

Run it with:
```bash
python3 fib.py > fib.txt
```

Let me know if you'd like me to execute it now or refine anything!
```

**multi-release-notes** — web: none

```
Now I need to read the releases.txt file to see what changes are listed. However, I don't have a direct tool to read files from the workspace. Let me check if there's a way to access this information or if you can provide the contents of releases.txt.

Actually, looking at my available tools, I don't have a file reading capability. Could you please share the contents of releases.txt so I can:
1. Create the release-summary.md file with the actual changes
2. Ensure the task details are accurate

Alternatively, if you'd like me to proceed with creating the summary based on what you tell me about the changes, please provide that information.
```

**cron-schedule** — web: none

```
Done! I've scheduled a reminder to check the build dashboard every weekday at 8am. The job will send you a message in your Discord channel (e2e).
```

**web-fact-to-file** — web: web_search(Node.js first release year)

```
Done. The file contains: 2009
```

**website-summarize** — web: web_fetch(https://example-docs.test/guide)

```
- **Service Configuration**: Listens on port 8443 with TLS; config stored in `/etc/widget/config.toml` and reloaded via `SIGHUP`.  
- **Backup Schedule**: Nightly at 02:00 UTC to the "widget-backups" bucket, retained for 30 days.  
- **Health Endpoint**: `/healthz` returns `503` during backup operations.
```

**research-report** — web: none

```
Here is a research report on the state of local LLM inference on consumer GPUs as it stands in 2026.

***

# Local LLM Inference on Consumer GPUs: State Report (2026)

## Executive Summary
By 2026, the landscape has shifted from "can I run a model?" to "which efficiency and speed tradeoffs do I want?" The proliferation of open weights models (Llama-4 series, Mistral-Nemo successors) has made consumer GPUs viable for serious work. The primary bottleneck is no longer raw FLOPS but memory bandwidth and VRAM capacity. Quantization (INT8/INT4) is the standard default; FP16 is reserved for high-priority tasks like image generation or training fine-tuning.

## 1. Hardware Landscape: What Fits on Which Cards

The market has matured around three distinct tiers based on VRAM size and memory bandwidt
```

</details>

---
Provenance: {"date":"2026-09-27T19:09:52.353Z","gitCommit":"198058d","ollamaUrl":"http://<host>:11434","reps":1,"profile":"full","tasks":["chat-plain","chat-exact-word","task-board","memory-save-recall","exec-csv-revenue","exec-fib-script","multi-release-notes","cron-schedule","web-fact-to-file","website-summarize","research-report"]}
