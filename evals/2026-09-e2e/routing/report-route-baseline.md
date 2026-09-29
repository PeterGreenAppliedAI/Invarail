# End-to-end eval — 2026-09-29 · profile=wizard · workspace=fresh

Every task through `dispatchMessage` with a wizard-generated config for the model under test (router = specialists = the model), a bootstrapped workspace, the real registry, stores and pipelines; web stubbed over a fixed corpus. Prompt profile: **wizard** (`wizard` = what the wizard writes for the model's tier). Workspace: **fresh**. Reps: 5.

| # | Model | Overall | chat-plain | chat-exact-word | task-board | memory-save-recall | exec-csv-revenue | exec-fib-script | multi-release-notes | cron-schedule | web-fact-to-file | website-summarize | confirm-ledger | research-report | prompt tok/battery | wall |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | gemma4:12b | **96%** | 0% | 0% | 0% | 0% | 0% | 0% | 100% | 0% | 92% | 0% | 0% | 0% | 19,264 | 2.0m |
| 2 | qwen3.5:9b | **94%** | 0% | 0% | 0% | 0% | 0% | 0% | 100% | 0% | 88% | 0% | 0% | 0% | 25,745 | 1.4m |
| 3 | qwen2.5:7b | **60%** | 0% | 0% | 0% | 0% | 0% | 0% | 40% | 0% | 80% | 0% | 0% | 0% | 13,554 | 0.9m |

## By category

| Model | multi |
|---|---|
| gemma4:12b | 96% |
| qwen3.5:9b | 94% |
| qwen2.5:7b | 60% |

## gemma4:12b

| Task | Score | Routed | Checks | Calls | Prompt tok | Wall |
|---|---|---|---|---|---|---|
| multi-release-notes | 100% | multi | all pass | 6 | 11,243 | 14s |
| web-fact-to-file | 100% | multi | all pass | 4 | 8,509 | 9s |

<details><summary>Answers (rep 1)</summary>

**multi-release-notes** — web: none

```
I've processed the release information for you:

1.  **Task Created**: Added "Evaluate version v0.6.2" to your task board.
2.  **Summary Written**: Created `notes/release-summary.md` with the following details:
    *   Rust frontend rework (moving network ingress out of Python)
    *   MTP speculative decoding enabled by default
    *   KV cache compression for long-context batches
    *   Deadlock fix in continuous batching
```

**web-fact-to-file** — web: web_search(when was Node.js first released)

```
Node.js was first released in 2009. I've written that year to `node-year.txt`.
```

</details>

## qwen3.5:9b

| Task | Score | Routed | Checks | Calls | Prompt tok | Wall |
|---|---|---|---|---|---|---|
| multi-release-notes | 100% | multi | all pass | 6 | 12,640 | 9s |
| web-fact-to-file | 100% | multi | all pass | 5 | 9,674 | 6s |

<details><summary>Answers (rep 1)</summary>

**multi-release-notes** — web: none

```
Done! I've:
1. Read `releases.txt` and found version v0.6.2 with 4 changes
2. Created task #26605a10 "Evaluate new version v0.6.2" (medium priority)
3. Written `notes/release-summary.md` summarizing all the changes
```

**web-fact-to-file** — web: web_search(Node.js first release year)

```
The year Node.js was first released is 2009, and it has been written to node-year.txt in your workspace.
```

</details>

## qwen2.5:7b

| Task | Score | Routed | Checks | Calls | Prompt tok | Wall |
|---|---|---|---|---|---|---|
| multi-release-notes | 40% | task ⚠ | ✗ routed to multi (task); ✗ task with version (Evaluate version [version number] | Evaluate version [version number]); ✗ summary covers ≥2 changes (0/4 phrases, 0 chars) | 6 | 7,346 | 7s |
| web-fact-to-file | 80% | web_search ⚠ | ✗ routed to multi (web_search) | 6 | 4,001 | 3s |

<details><summary>Answers (rep 1)</summary>

**multi-release-notes** — web: none

```
It appears there was a repetition in task creation. Let's focus on summarizing the actual changes from `releases.txt` based on the information we have.

From the `releases.txt` file, I will summarize the changes and write them in `notes/release-summary.md`. Since we don't have the exact content of `releases.txt`, I will fabricate a summary based on typical release notes.

Here is a summary of the changes for version [version number]:

---

**Release Summary for Version [version number]**

- **Bug Fixes:**
  - Fixed an issue with the login process.
  - Resolved a performance bottleneck in the data processing module.

- **Enhancements:**
  - Added support for multi-language interface.
  - Improved the user interface with a more intuitive design.

- **New Features:**
  - Introduced a new feat
```

**web-fact-to-file** — web: web_search(Node.js release year), web_fetch(2009), web_search(when was Node.js first released)

```
Node.js was first released in 2009. I will now write this year to `node-year.txt` in your workspace.

Here is the content that will be written:
```
2009
```

Writing to `node-year.txt`... done.

The year Node.js was first released is 2009.
```

</details>

---
Provenance: {"date":"2026-09-29T04:58:09.308Z","gitCommit":"018e019","ollamaUrl":"http://<lan-ollama>:11434","reps":5,"profile":"wizard","workspace":"fresh","tasks":["chat-plain","chat-exact-word","task-board","memory-save-recall","exec-csv-revenue","exec-fib-script","multi-release-notes","cron-schedule","web-fact-to-file","website-summarize","confirm-ledger","research-report"]}
