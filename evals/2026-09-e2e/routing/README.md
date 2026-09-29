# Routing levers — 2026-09-29

The three-rep reliability runs (`../reliability/`) showed the small tier losing at the
router, not in execution. In a one-model install the foreground model classifies its own
request, and the category decides the toolset. A wrong pick doesn't stop the specialist.
It improvises with the wrong tools, and the answer looks finished.

This folder measures the levers on the two requests that need tools from two specialists.
Only `multi` holds every tool either one needs:

- **multi-release-notes**: read releases.txt, add a task, write notes/release-summary.md.
- **web-fact-to-file**: find the year Node.js was first released and write it to a file.

Five reps of each, on qwen3.5:9b, gemma4:12b and qwen2.5:7b, on a quiet A5000.

## First, a harness correction

Both tasks used to accept routes that cannot finish them: `task` and `exec` for the release
notes, `web_search` for the Node.js file. A guaranteed half-job scored as routed. Both now
expect `multi` only, and every arm below is scored that way.

## What shipped

1. **Descriptions that say what each specialist cannot do.** These are the wizard defaults
   for `task`, `web_search`, `exec` and `multi`.
2. **A specialist reroute that reads the answer.** It gives one re-dispatch when the answer
   *claims* an action whose tool the specialist doesn't hold, like "I have added a task…"
   from `exec`, or *ends announcing* one, like "Next, I will read releases.txt" from `task`.
   Nothing is added to the prompt.

## Head to head, final design (`h2h-*`)

Correct outcomes, meaning routed or rerouted to `multi` with every check passed:

| Descriptions | qwen3.5:9b | gemma4:12b | qwen2.5:7b | Total |
|---|---|---|---|---|
| Legacy (`--descriptions=legacy`) | 10/10 | 7/10 | 5/10 | **22/30** |
| New | 10/10 | 10/10 | 7/10 | **27/30** |

Under the old wording gemma4 sent the Node.js request to `exec` three times and wrote the
year from memory, without a word the reroute could catch. The 7B's remaining release-notes
misses were one silent omission, where the task was never mentioned, and two claims in forms
the patterns didn't cover yet: "Task added to your task board" and a done-list line "2. Added
a task … to your task board". Both forms are now covered and tested. See the rerun below.

Baseline for reference, before any change (`results-route-baseline.json`): **18/30**.

**Final code, 7B only** (`final-7b`, after the last two claim forms were added): **10/10**.
All five release-notes reps misrouted to `exec`, and all five were rerouted and finished,
three by the claimed signal and two by the announced one. qwen3.5 and gemma4 were 10/10 in
every arm with the new descriptions, so the final total is 30/30.

## Full battery, final code (`full-final`, 12 tasks × 3 reps)

| Model | Today | Yesterday (`../reliability/`) |
|---|---|---|
| qwen3.5:9b | **36/36** | 36/36 |
| gemma4:12b | **36/36** | 35/36 |
| qwen2.5:7b | **30/36** | 31/36 |

Three reroutes fired, all correct, and there were no parser errors. The 7B's misses were
memory-save-recall 0/3, the environmental `cron` flip that yesterday's code reproduces today
(see below), and exec-csv-revenue 2/3, which is noise. Release notes went from 0/3 to 2/3.
Leaving out the memory flip, the 7B improved.

## Built, measured, removed: the `handoff` tool

The first reroute also offered every arena specialist a `handoff` tool to call when it
lacked something. qwen2.5 did call it, twice and correctly. The full battery showed what one
extra tool in every prompt costs a small model:

| Test | With the tool | Without |
|---|---|---|
| qwen3.5:9b task board (`tb-on` / `tb-off`, `h2h-tb-*`) | 2/5, three malformed tool calls | 5/5, 5/5, 5/5 |
| qwen2.5:7b fib script (`attr10-on` / `attr10-off`) | 7/10 | 10/10 |

The malformed calls were Ollama rejecting the model's output: `element <function> closed by
</parameter>`. The tool was removed the same night. The signals now live only in the answer.

## A misroute that wasn't ours

The battery with the tool also sent qwen2.5's "Remember this: my deployment freeze starts on
2026-09-01" to `cron` 3/3, where yesterday's run said `memory` 3/3. The legacy-descriptions
arm said `cron` 10/10 as well. Yesterday's exact commit, run today from a worktree, said
`cron` 10/10 (`yesterdays-code-memory-routing.log`). The flip is environmental: the 7B sits on
a knife edge for that sentence. A likely contributor: the router prompt's fixed rule says
"memory … can only READ", while the memory specialist holds `memory_save`.

## Noise

qwen2.5's exec-csv-revenue scored 1, 2, 5 and 5 out of 10 across arms with nothing relevant
changed. No arm is judged on it.

## Reproduce

```
npx tsx scripts/e2e-eval.ts qwen3.5:9b gemma4:12b qwen2.5:7b --reps=5 \
  --task=multi-release-notes,web-fact-to-file --descriptions=legacy --label=h2h-two-legacy
```

`--task` takes a comma list. `--label` keeps arms from overwriting each other.
`--reroute=off` disables the reroute. `--descriptions=legacy` restores the old wording of
the four categories.

The earlier arms (`route-*`) include the removed tool and are kept for the record.
