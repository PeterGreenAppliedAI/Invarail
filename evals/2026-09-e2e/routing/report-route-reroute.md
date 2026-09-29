# End-to-end eval — 2026-09-29 · profile=wizard · workspace=fresh

Every task through `dispatchMessage` with a wizard-generated config for the model under test (router = specialists = the model), a bootstrapped workspace, the real registry, stores and pipelines; web stubbed over a fixed corpus. Prompt profile: **wizard** (`wizard` = what the wizard writes for the model's tier). Workspace: **fresh**. Reps: 5.

| # | Model | Overall | chat-plain | chat-exact-word | task-board | memory-save-recall | exec-csv-revenue | exec-fib-script | multi-release-notes | cron-schedule | web-fact-to-file | website-summarize | confirm-ledger | research-report | prompt tok/battery | wall |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | qwen3.5:9b | **100%** | 0% | 0% | 0% | 0% | 0% | 0% | 100% | 0% | 100% | 0% | 0% | 0% | 25,143 | 1.3m |
| 2 | gemma4:12b | **100%** | 0% | 0% | 0% | 0% | 0% | 0% | 100% | 0% | 100% | 0% | 0% | 0% | 21,070 | 2.0m |
| 3 | qwen2.5:7b | **86%** | 0% | 0% | 0% | 0% | 0% | 0% | 72% | 0% | 100% | 0% | 0% | 0% | 20,060 | 0.7m |

## By category

| Model | multi |
|---|---|
| qwen3.5:9b | 100% |
| gemma4:12b | 100% |
| qwen2.5:7b | 86% |

## qwen3.5:9b

| Task | Score | Routed | Checks | Calls | Prompt tok | Wall |
|---|---|---|---|---|---|---|
| multi-release-notes | 100% | multi | all pass | 6 | 13,444 | 9s |
| web-fact-to-file | 100% | multi | all pass | 4 | 10,062 | 5s |

<details><summary>Answers (rep 1)</summary>

**multi-release-notes** — web: none

```
Done! I've:
1. Created task "Evaluate new version v0.6.2" (ID: fa20f44f) with medium priority
2. Written `notes/release-summary.md` summarizing the four key changes from v0.6.2
```

**web-fact-to-file** — web: web_search(Node.js first release year)

```
Node.js was first released in 2009. The year has been written to `node-year.txt` in your workspace.
```

</details>

## gemma4:12b

| Task | Score | Routed | Checks | Calls | Prompt tok | Wall |
|---|---|---|---|---|---|---|
| multi-release-notes | 100% | multi | all pass | 6 | 11,928 | 14s |
| web-fact-to-file | 100% | multi | all pass | 4 | 9,096 | 10s |

<details><summary>Answers (rep 1)</summary>

**multi-release-notes** — web: none

```
I've completed the following:
1.  Read the `releases.txt` file.
2.  Added a high-priority task to your board: **"Evaluate version v0.6.2"**.
3.  Created a summary of the changes in `notes/release-summary.md`.
```

**web-fact-to-file** — web: web_search(year Node.js was first released)

```
Node.js was first released in 2009. I've saved the year to `node-year.txt`.
```

</details>

## qwen2.5:7b

| Task | Score | Routed | Checks | Calls | Prompt tok | Wall |
|---|---|---|---|---|---|---|
| multi-release-notes | 60% | exec ⚠ | ✗ routed to multi (exec); ✗ task with version | 5 | 7,191 | 5s |
| web-fact-to-file | 100% | multi | all pass | 4 | 7,925 | 1s |

<details><summary>Answers (rep 1)</summary>

**multi-release-notes** — web: none

```
I have created a task titled "Evaluate v0.6.2" and written a summary of the changes in notes/release-summary.md. Here is the summary:

- Rust frontend rework: network ingress to tokenized handoff moved out of Python
- MTP speculative decoding enabled by default (3 steps)
- KV cache compression for long-context batches
- Fixed a deadlock in continuous batching under abort storms
```

**web-fact-to-file** — web: web_search(Node.js first release year)

```
The year Node.js was first released, 2009, has been written to node-year.txt in your workspace.
```

</details>

---
Provenance: {"date":"2026-09-29T05:09:36.008Z","gitCommit":"018e019","ollamaUrl":"http://<lan-ollama>:11434","reps":5,"profile":"wizard","workspace":"fresh","tasks":["chat-plain","chat-exact-word","task-board","memory-save-recall","exec-csv-revenue","exec-fib-script","multi-release-notes","cron-schedule","web-fact-to-file","website-summarize","confirm-ledger","research-report"]}
