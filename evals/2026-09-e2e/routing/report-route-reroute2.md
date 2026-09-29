# End-to-end eval — 2026-09-29 · profile=wizard · workspace=fresh

Every task through `dispatchMessage` with a wizard-generated config for the model under test (router = specialists = the model), a bootstrapped workspace, the real registry, stores and pipelines; web stubbed over a fixed corpus. Prompt profile: **wizard** (`wizard` = what the wizard writes for the model's tier). Workspace: **fresh**. Reps: 5.

| # | Model | Overall | chat-plain | chat-exact-word | task-board | memory-save-recall | exec-csv-revenue | exec-fib-script | multi-release-notes | cron-schedule | web-fact-to-file | website-summarize | confirm-ledger | research-report | prompt tok/battery | wall |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | qwen3.5:9b | **100%** | 0% | 0% | 0% | 0% | 0% | 0% | 100% | 0% | 100% | 0% | 0% | 0% | 26,909 | 1.3m |
| 2 | gemma4:12b | **100%** | 0% | 0% | 0% | 0% | 0% | 0% | 100% | 0% | 100% | 0% | 0% | 0% | 21,080 | 2.1m |
| 3 | qwen2.5:7b | **96%** | 0% | 0% | 0% | 0% | 0% | 0% | 92% | 0% | 100% | 0% | 0% | 0% | 20,420 | 0.8m |

## By category

| Model | multi |
|---|---|
| qwen3.5:9b | 100% |
| gemma4:12b | 100% |
| qwen2.5:7b | 96% |

## qwen3.5:9b

| Task | Score | Routed | Checks | Calls | Prompt tok | Wall |
|---|---|---|---|---|---|---|
| multi-release-notes | 100% | multi | all pass | 6 | 13,528 | 10s |
| web-fact-to-file | 100% | multi | all pass | 4 | 10,062 | 5s |

<details><summary>Answers (rep 1)</summary>

**multi-release-notes** — web: none

```
Done! I've:
1. Read the releases.txt file
2. Created task #12564f1f to evaluate version v0.6.2 (medium priority)
3. Written notes/release-summary.md with a summary of the four changes: Rust frontend rework, MTP speculative decoding enabled by default, KV cache compression for long-context batches, and the deadlock fix in continuous batching
```

**web-fact-to-file** — web: web_search(Node.js first release year)

```
Node.js was first released in 2009. The year has been written to `node-year.txt` in your workspace.
```

</details>

## gemma4:12b

| Task | Score | Routed | Checks | Calls | Prompt tok | Wall |
|---|---|---|---|---|---|---|
| multi-release-notes | 100% | multi | all pass | 6 | 11,945 | 14s |
| web-fact-to-file | 100% | multi | all pass | 4 | 9,096 | 9s |

<details><summary>Answers (rep 1)</summary>

**multi-release-notes** — web: none

```
I've completed the following steps:
1.  Read the `releases.txt` file (version v0.6.2).
2.  Added a high-priority task to your board: **"Evaluate version v0.6.2"**.
3.  Created a summary of the changes in `notes/release-summary.md`.
```

**web-fact-to-file** — web: web_search(year Node.js was first released)

```
Node.js was first released in 2009. I've saved that year to `node-year.txt`.
```

</details>

## qwen2.5:7b

| Task | Score | Routed | Checks | Calls | Prompt tok | Wall |
|---|---|---|---|---|---|---|
| multi-release-notes | 100% | multi | all pass | 7 | 10,546 | 6s |
| web-fact-to-file | 100% | multi | all pass | 4 | 7,923 | 1s |

<details><summary>Answers (rep 1)</summary>

**multi-release-notes** — web: none

```
I've created a task titled "Evaluate new version: v0.6.2" with a medium priority level, and it's marked as "todo" and assigned to you. Additionally, I've summarized the changes in the new version and saved the summary in `notes/release-summary.md`.

Here's a brief summary of the changes:
- Rust frontend rework: network ingress to tokenized handoff moved out of Python
- MTP speculative decoding enabled by default (3 steps)
- KV cache compression for long-context batches

You can review the full details in `notes/release-summary.md`.
```

**web-fact-to-file** — web: web_search(Node.js release year)

```
The year Node.js was first released, 2009, has been written to node-year.txt in your workspace.
```

</details>

---
Provenance: {"date":"2026-09-29T05:13:52.337Z","gitCommit":"018e019","ollamaUrl":"http://<lan-ollama>:11434","reps":5,"profile":"wizard","workspace":"fresh","tasks":["chat-plain","chat-exact-word","task-board","memory-save-recall","exec-csv-revenue","exec-fib-script","multi-release-notes","cron-schedule","web-fact-to-file","website-summarize","confirm-ledger","research-report"]}
