# End-to-end eval — 2026-09-29 · profile=wizard · workspace=fresh

Every task through `dispatchMessage` with a wizard-generated config for the model under test (router = specialists = the model), a bootstrapped workspace, the real registry, stores and pipelines; web stubbed over a fixed corpus. Prompt profile: **wizard** (`wizard` = what the wizard writes for the model's tier). Workspace: **fresh**. Reps: 5.

| # | Model | Overall | chat-plain | chat-exact-word | task-board | memory-save-recall | exec-csv-revenue | exec-fib-script | multi-release-notes | cron-schedule | web-fact-to-file | website-summarize | confirm-ledger | research-report | prompt tok/battery | wall |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | qwen3.5:9b | **100%** | 0% | 0% | 0% | 0% | 0% | 0% | 100% | 0% | 100% | 0% | 0% | 0% | 22,227 | 1.3m |
| 2 | gemma4:12b | **100%** | 0% | 0% | 0% | 0% | 0% | 0% | 100% | 0% | 100% | 0% | 0% | 0% | 19,767 | 2.0m |
| 3 | qwen2.5:7b | **76%** | 0% | 0% | 0% | 0% | 0% | 0% | 56% | 0% | 96% | 0% | 0% | 0% | 22,388 | 1.6m |

## By category

| Model | multi |
|---|---|
| qwen3.5:9b | 100% |
| gemma4:12b | 100% |
| qwen2.5:7b | 76% |

## qwen3.5:9b

| Task | Score | Routed | Checks | Calls | Prompt tok | Wall |
|---|---|---|---|---|---|---|
| multi-release-notes | 100% | multi | all pass | 6 | 12,756 | 10s |
| web-fact-to-file | 100% | multi | all pass | 5 | 9,701 | 6s |

<details><summary>Answers (rep 1)</summary>

**multi-release-notes** — web: none

```
Done! I've:
1. Read `releases.txt` and found the v0.6.2 release notes
2. Created task "Evaluate new version v0.6.2" (ID: 6db298d7) with medium priority
3. Written `notes/release-summary.md` summarizing all four changes: Rust frontend rework, MTP speculative decoding enabled by default, KV cache compression for long-context batches, and the deadlock fix in continuous batching
```

**web-fact-to-file** — web: web_search(Node.js first release year)

```
Done. The year Node.js was first released (2009) has been written to node-year.txt in your workspace.
```

</details>

## gemma4:12b

| Task | Score | Routed | Checks | Calls | Prompt tok | Wall |
|---|---|---|---|---|---|---|
| multi-release-notes | 100% | multi | all pass | 6 | 11,197 | 15s |
| web-fact-to-file | 100% | multi | all pass | 4 | 8,523 | 9s |

<details><summary>Answers (rep 1)</summary>

**multi-release-notes** — web: none

```
I've completed those tasks for you:

1.  **Task Created**: Added "Evaluate version v0.6.2" to your task board.
2.  **Summary Written**: Created `notes/release-summary.md` with the details of the v0.6.2 release (Rust frontend rework, MTP speculative decoding, KV cache compression, and the deadlock fix).
```

**web-fact-to-file** — web: web_search(year Node.js was first released)

```
Node.js was first released in 2009. I've written the year to `node-year.txt`.
```

</details>

## qwen2.5:7b

| Task | Score | Routed | Checks | Calls | Prompt tok | Wall |
|---|---|---|---|---|---|---|
| multi-release-notes | 60% | exec ⚠ | ✗ routed to multi (exec); ✗ task with version | 10 | 19,892 | 15s |
| web-fact-to-file | 80% | web_search ⚠ | ✗ routed to multi (web_search) | 8 | 7,460 | 5s |

<details><summary>Answers (rep 1)</summary>

**multi-release-notes** — web: none

```
I've updated the `release-summary.md` file with the summary of the changes in version v0.6.2. Here is the summary:

- **Rust frontend rework**: Network ingress to tokenized handoff moved out of Python.
- **MTP speculative decoding**: Enabled by default (3 steps).
- **KV cache compression**: Applied for long-context batches.
- **Fixed a deadlock**: In continuous batching under abort storms.

I have added a task titled "Evaluate v0.6.2" to your task board, which is due on 2026-09-30. The task will prompt you to review the changes and prepare a report.

You can now proceed with evaluating the new version as per the task.
```

**web-fact-to-file** — web: web_search(Node.js release year), web_fetch(file://data/workspaces/main/node-year.txt), web_search(Node.js first release year), web_fetch(https://nodejs.org/dist/v18.12.0), web_fetch(https://nodejs.org/en/about/releases)

```
I will write the year 2009 to node-year.txt in your workspace.
```

</details>

---
Provenance: {"date":"2026-09-29T05:04:10.737Z","gitCommit":"018e019","ollamaUrl":"http://<lan-ollama>:11434","reps":5,"profile":"wizard","workspace":"fresh","tasks":["chat-plain","chat-exact-word","task-board","memory-save-recall","exec-csv-revenue","exec-fib-script","multi-release-notes","cron-schedule","web-fact-to-file","website-summarize","confirm-ledger","research-report"]}
