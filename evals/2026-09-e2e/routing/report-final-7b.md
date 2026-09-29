# End-to-end eval — 2026-09-29 · profile=wizard · workspace=fresh

Every task through `dispatchMessage` with a wizard-generated config for the model under test (router = specialists = the model), a bootstrapped workspace, the real registry, stores and pipelines; web stubbed over a fixed corpus. Prompt profile: **wizard** (`wizard` = what the wizard writes for the model's tier). Workspace: **fresh**. Reps: 5.

| # | Model | Overall | chat-plain | chat-exact-word | task-board | memory-save-recall | exec-csv-revenue | exec-fib-script | multi-release-notes | cron-schedule | web-fact-to-file | website-summarize | confirm-ledger | research-report | prompt tok/battery | wall |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | qwen2.5:7b | **100%** | 0% | 0% | 0% | 0% | 0% | 0% | 100% | 0% | 100% | 0% | 0% | 0% | 22,706 | 1.1m |

## By category

| Model | multi |
|---|---|
| qwen2.5:7b | 100% |

## qwen2.5:7b

| Task | Score | Routed | Checks | Calls | Prompt tok | Wall |
|---|---|---|---|---|---|---|
| multi-release-notes | 100% | multi | all pass | 12 | 22,271 | 14s |
| web-fact-to-file | 100% | multi | all pass | 4 | 7,387 | 1s |

<details><summary>Answers (rep 1)</summary>

**multi-release-notes** — web: none

```
The task to evaluate version v0.6.2 has been created with the following details:
- **Title**: Evaluate v0.6.2
- **Priority**: Medium
- **Due Date**: 2026-09-30

A summary of the actual changes has been written to `notes/release-summary.md`:

- **Rust frontend rework**: Network ingress to tokenized handoff moved out of Python.
- **MTP speculative decoding**: Enabled by default (3 steps).
- **KV cache compression**: Added for long-context bat...

You can review the task and the summary at your convenience. Let me know if you need any further assistance!
```

**web-fact-to-file** — web: web_search(Node.js first release year)

```
The year Node.js was first released, 2009, has been written to `node-year.txt` in your workspace.
```

</details>

---
Provenance: {"date":"2026-09-29T17:54:33.963Z","gitCommit":"018e019","ollamaUrl":"http://<host>:11434","reps":5,"profile":"wizard","workspace":"fresh","tasks":["chat-plain","chat-exact-word","task-board","memory-save-recall","exec-csv-revenue","exec-fib-script","multi-release-notes","cron-schedule","web-fact-to-file","website-summarize","confirm-ledger","research-report"]}
