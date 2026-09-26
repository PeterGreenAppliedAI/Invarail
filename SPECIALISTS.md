# Specialist Use Case Specs

12-point specification for each of the 12 configured specialists (six added 2026-09-26: memory, cron, task, message, website, code_gen). A developer should be able to read a spec and implement or debug the specialist with zero follow-up questions.

**Tool list notes (apply to every specialist):** a `tools:` entry may use the token `mcp:<server>` to include an MCP server's entire registered toolset (expanded at dispatch via `registry.expandToolNames`). The skills system and its `skill_find` tool were retired 2026-08-10 (DECISIONS "the Invarail trim"); nothing is registered globally on their behalf.

---

## chat

1. **User story:** User wants a conversational interaction — questions, opinions, discussion, greetings.
2. **In scope:** General conversation, opinion questions, follow-ups, greetings, questions answerable from memory/context, discussing topics the user is interested in.
3. **Out of scope:** Web search, file execution, scheduling, research reports, image generation, email/calendar queries. If the model can't answer, the silent re-route catches it.
4. **Data requirements:** Session history, user priming (graph memory auto-injection), workspace context (SOUL.md, IDENTITY.md).
5. **Tools:** None (bare chat) or minimal set depending on config. Chat is typically tool-free.
6. **Acceptance criteria:** Conversational, contextually aware, references memory when relevant, doesn't narrate tool calls. Responds in the user's communication style (from UserModel).
7. **Edge cases:** User asks a question that requires web search mid-conversation. Conversational guard should keep it on chat unless explicit task intent detected. Silent re-route catches capability gaps.
8. **Confidence threshold:** N/A — conversational responses are subjective.
9. **Human escalation:** When the model says "I don't have access to..." — triggers silent re-route.
10. **Known failures:** qwen3.5:9b self-prompted (replaced with gemma4:26b). Thinking tags leaking into display (fixed with stripThinking). Gemma4 docs say "no thinking in history."
11. **Pipeline:** None — bare chat (direct LLM, no tool loop).
12. **Test cases:** "hey how are you" → chat (fallback), "what do you think about local models" → chat (fallback), "what about the pricing?" with previousCategory=chat → chat (sticky).

---

## web_search

1. **User story:** User asks a question requiring current internet information — news, prices, facts, events.
2. **In scope:** Factual questions about the external world, current events, "search for X", "what's the latest on Y", price lookups, weather.
3. **Out of scope:** Questions about the user (→ memory), calendar/email (→ multi, which holds the owner-only Gmail/Calendar tools), code execution (→ exec), research reports (→ research), browsing specific URLs (→ website).
4. **Data requirements:** Web search provider (SearXNG self-hosted in the reference build; Brave/Perplexity/Grok/Tavily selectable), the personal web index (`local_search`) tried first, web_fetch for page content, browser for JS-heavy sites.
5. **Tools:** local_search, web_search, web_fetch, browser.
6. **Acceptance criteria:** Answer cites sources with URLs. Provides analysis beyond restating search snippets. Well-structured with clear sections. Answers the specific question asked.
7. **Edge cases:** "Search for docker commands" could route to exec (keyword order handles this). Ambiguous queries like "latest version" might match without search intent.
8. **Confidence threshold:** Quality review checks for source citations, structure, and completeness. Score < 3 triggers revision pass.
9. **Human escalation:** None — web search is low-risk.
10. **Known failures:** "what is" and "who is" used to trigger web_search from keywords — removed because they're questions, not search actions. Quality review sometimes suggests infrastructure changes the revision LLM takes literally.
11. **Dispatch:** Arena (fleet-wide since 2026-08-21) — open ReAct loop with the tools listed in config, session history, natural stop; same 6 security layers + confirm ledger. Live-value lookups ("current price of X") remain in keyword fallback. *(Historical, pre-arena, retired 2026-08-21: deterministic web_search pipeline — extract → search → pick URLs → parallel fetch → synthesize → quality review → [revision]; extraction failure fell back to the raw message as query, July 2026.)*
12. **Test cases:** "search for the latest AI news" → web_search (keyword), "google quantum computing" → web_search (keyword), "look up the weather in NYC" → web_search (keyword).

---

## research

1. **User story:** User requests deep analysis, a report, a slide deck, or data-driven research on a topic.
2. **In scope:** "Research AAPL stock", "make me a deck on AI trends", "analyze the EV market", producing reports/decks with charts and citations.
3. **Out of scope:** Simple web searches ("what's the weather"), casual questions about a topic, browsing URLs.
4. **Data requirements:** Web search for sources, web_fetch for page content, code_session for charts (matplotlib/seaborn), write_file for deck output. When the request explicitly names a [FlowMCP](https://github.com/PeterGreenAppliedAI/FlowMCP) gathering flow ("use the weekly_gather tool"), the flow's compiled searches replace decompose+search — its sections become the facets, its links the sources; fetch/synthesis/verification unchanged.
5. **Tools:** local_search, web_search, web_fetch, code_session, write_file, read_file, document, mcp:flows.
6. **Acceptance criteria:** Structured report/deck with thesis, evidence, charts, source citations with actual URLs (not homepages), actionable recommendations. Charts have titles, labels, legends.
7. **Edge cases:** "Research" mentioned casually in conversation should NOT trigger research pipeline — only explicit research requests. Pre-model override handles compound intent (research + stock/market/trend).
8. **Confidence threshold:** Quality review checks for 3+ substantive sections, source URLs cited, detail level, date accuracy.
9. **Human escalation:** None — research is read-only.
10. **Known failures:** Model fabricated data in early versions — now uses code for charts (matplotlib). Quality review once suggested "use Playwright" literally in revision. Deck HTML sometimes dumped as text if write_file fails.
11. **Pipeline:** research — [flow_gather when a flow is named] → decompose → per-facet research (local index first, then search + fetch + synthesize, concurrent) → gap-fill → analytical synthesis → claim verification (cited-source + Tier-1 cross-check) → charts → deterministic markdown→HTML→PDF render with a `## Verification` appendix.
12. **Test cases:** "research AAPL stock performance" → research (override), "make me a PDF report on AI trends" → research (override), "analyze market trends for semiconductors" → research (override).

---

## multi

1. **User story:** User requests something requiring multiple tools, browser automation, or multi-step coordination — "go to eventbrite and find events", "search and save", "make me a spreadsheet".
2. **In scope:** Compound actions (search + save), browser navigation, document generation (xlsx, pptx), multi-tool tasks that don't fit a single specialist.
3. **Out of scope:** Simple search (→ web_search), simple exec (→ exec), simple task management (→ task).
4. **Data requirements:** Full tool access — browser, web_search, web_fetch, memory, tasks, exec, document, image_generate.
5. **Tools:** All available tools for the user's trust level.
6. **Acceptance criteria:** Completes the multi-step task, produces artifacts if requested, reports what was done.
7. **Edge cases:** "Find and save" triggers multi via keyword compound. "Go to amazon.com and find X" is `web_search` now (it holds `browser`; the override that forced `multi` was deleted 2026-09-26) — `multi` is for chained work ("go to eventbrite, find one, add it to my tasks"). Browser control mode runs on the foreground model with guided ReAct.
8. **Confidence threshold:** N/A — arena runs to natural stop. *(Historical, pre-arena: the plan pipeline had a self-reflection stage; skill matching reused successful past plans.)*
9. **Human escalation:** Destructive tools (exec, write_file) can be in confirmTools set. Since July 2026 the confirm gate is backed by the pending-action ledger (confirmation executes the exact previewed call) and applies to pipeline dispatches too; tools with `autonomy.tier: propose_confirm` metadata (send_message) are gated on every channel unless promoted via `autoApproveTools`.
10. **Known failures:** Plan pipeline matched wrong skills (inflated success count) — fixed with threshold + ratio + cap. Browser control pipeline failed (replaced with guided ReAct). Model hallucinated actions in plan.
11. **Dispatch:** Arena (fleet-wide since 2026-08-21) — open ReAct loop, tools listed in config, natural stop; multi also carries `pi_build` for code-shaped delegation. *(Historical, pre-arena, retired 2026-08-21: plan pipeline — LLM plan → self-reflect → execute loop (sub-dispatches) → summarize → skill save. Code still present, unused by dispatch.)*
12. **Test cases:** "go to eventbrite.com, find events, and add the best one to my tasks" → multi (model), "make me a spreadsheet of expenses" → multi (keyword), "find and save the best flight deals" → multi (keyword), "check my email" → multi (model, by description).

---

## exec

1. **User story:** User wants to run a shell command, read/write files, or perform system operations.
2. **In scope:** Shell commands (ls, git, npm, pip, sudo), file read/write, Docker operations, code execution.
3. **Out of scope:** Web search, scheduling (→ cron), task management (→ task), research.
4. **Data requirements:** Docker sandbox or command allowlist. Workspace file access.
5. **Tools:** exec, read_file, write_file, code_session, document, mcp:flows, mcp:blender (exec is the arena's general-purpose workhorse, so compiled flow tools live here too).
6. **Acceptance criteria:** Command executed, output returned, errors explained. Doesn't over-explore (ls data → just ls, not find + chmod + which).
7. **Edge cases:** *(Historical — the `config` category was retired 2026-08-10, which closed this one.)* "read the contents of config.json" used to route to config instead of exec due to keyword order. Fixed July 2026: bare "workspace" no longer hijacks exec requests to config ("run ls -la in the workspace" → exec); ls/pwd/chmod added to exec keyword hints. Model used 8 steps for simple `ls data` in ReAct — pipeline restored.
8. **Confidence threshold:** N/A — deterministic tool execution.
9. **Human escalation:** exec tool can be in confirmTools. Cron mode strips write tools.
10. **Known failures:** ReAct loop massive over-exploration for simple commands — exec pipeline restored. Code session required action:'start' before action:'run'. Exec tool doubled workspace paths (cwd path issue).
11. **Dispatch:** Arena (fleet-wide since 2026-08-21) — exec now runs the open ReAct loop like the rest of the fleet: tools listed in config, natural stop, same security layers + confirm ledger. *(Historical, pre-arena, retired 2026-08-21: deterministic exec pipeline — extract → tool → format — originally restored because small ReAct models over-explored simple commands.)*
12. **Test cases:** "install numpy with pip" → exec (keyword), "run npm install" → exec (keyword), "sudo apt-get update" → exec (keyword), "git status" → exec (keyword).

---

## image

1. **User story:** User wants to generate an image, illustration, photo, or diagram.
2. **In scope:** Image generation (text-to-image), diagram generation (architecture, flow), img2img with reference.
3. **Out of scope:** Image editing, video generation, image analysis (→ vision service, not specialist).
4. **Data requirements:** Flux model on Ollama for image generation. Python + matplotlib for diagrams.
5. **Tools:** image_generate, diagram_generate, read_file.
6. **Acceptance criteria:** Image generated on FIRST tool call. No step-back reasoning for simple image requests. Diagram requests get JSON spec and generate.
7. **Edge cases:** Model calls read_file or memory_search before generating — WRONG for simple image requests. Only appropriate for diagrams where accurate data is needed.
8. **Confidence threshold:** N/A — generative output is subjective.
9. **Human escalation:** None.
10. **Known failures:** Step-back prompting caused 3-6 iterations for simple requests. Model fell back to diagram_generate when image_generate failed (Ollama model not loaded). Hands/fingers are common failure mode for Flux.
11. **Pipeline:** None — ReAct with maxIterations=3.
12. **Test cases:** "generate an image of a sunset" → image (override), "draw a cat" → image.

**Recommended system prompt:**
```
You are an image generation specialist. You have two tools:
- image_generate: For illustrations, photos, art, creative images. Write a detailed prompt and call it immediately. Do NOT use read_file or memory_search first — just generate.
- diagram_generate: ONLY for technical diagrams (architecture, flow, infrastructure). Requires a JSON spec.

For image requests: call image_generate with a detailed, descriptive prompt on your FIRST action. Include style, composition, lighting, and specific details. Do not overthink — generate immediately.
```

**Recommended config:** maxIterations=3, temperature=0.3.

---

## memory

1. **User story:** User wants the assistant to recall something from past conversations or stored facts, store something explicitly, forget something, or search their document vault.
2. **In scope:** "what did we discuss yesterday", "remember that I prefer X", "forget the thing about Y", "what do you know about my job", searching/storing vault documents (`docs_search`/`docs_store`), importing a document into the knowledge base.
3. **Out of scope:** Questions about the external world (→ web_search), casual conversation that merely references the past (→ chat — sticky and the guard keep it there), automatic fact extraction (that is intake, not this specialist — see MEMORY-SYSTEM.md).
4. **Data requirements:** FalkorDB graph (vector KNN + entity traversal) with the flat JSONL store as fallback; Turn nodes for cross-session search; the document vault under the workspace; the EmbeddingStore for `knowledge_import`.
5. **Tools:** memory_search, memory_get, memory_save, memory_forget, knowledge_import, docs_search, docs_store.
6. **Acceptance criteria:** Recall answers cite what was actually stored (never invented); explicit saves confirm the exact text saved; forgets confirm what was removed; "I don't have that" when the graph is empty rather than a plausible guess.
7. **Edge cases:** "remember" as conversation ("remember when we…") is chat, not a save — the model must read intent. `memory_save` lands as `observed`, never `stated` (only `!save` after a human read the list claims `stated`). Removed facts are recorded so extraction never re-adds them.
8. **Confidence threshold:** N/A — the tools return what exists; the relevance floor (cosine ≥ 0.55) already gates injection elsewhere.
9. **Human escalation:** `memory_forget` is destructive but user-initiated; `!forget <term>` bypasses the router entirely. Autonomous deletion never happens here (heartbeat proposes, `!heartbeat yes/no` decides).
10. **Known failures:** Sticky routing carried plain conversation into `memory` after a `!forget` (shadow log 2026-09-25). Extraction inferred instead of recording ("one-time setup rather than recurring revenue") — fixed with the do-not-infer rule. The `memory_search` tool went a month with near-zero explicit uses because auto-injection covers most recall.
11. **Dispatch:** Arena (`dispatchMode: "arena"`, maxIterations 5, temperature 0.2, `think: false`). The `memory` pipeline definition is retained but bypassed.
12. **Test cases:** "what did we discuss yesterday" → memory (keyword), "forget X" → memory (Peter's labeling ruling), "what do you know about my wife" → memory (model).

---

## cron

1. **User story:** User wants something to happen on a schedule — a reminder at a time, a recurring job, an autonomous periodic check — or wants to list, edit, run, or remove one.
2. **In scope:** "remind me at 5pm", "every morning send me the weather", "list my cron jobs", "run the daily digest now", heartbeat tasks (autonomous checks that run together on the shared 2h schedule).
3. **Out of scope:** One-off tasks with no time component (→ task), the heartbeat's own maintenance (system-owned, not user-scheduled), sending a message now (→ message).
4. **Data requirements:** CronStore (persistent, croner-validated expressions, timezone-aware), the heartbeat task list, the channel/target the job should deliver to (defaults to the requesting conversation).
5. **Tools:** cron_add, cron_list, cron_remove, cron_edit, cron_run, heartbeat_add, heartbeat_list, heartbeat_remove.
6. **Acceptance criteria:** The job exists with the schedule the user meant (absolute time, correct timezone), the reply echoes schedule + delivery target + job id, edits resolve the id from `cron_list` rather than guessing, `cron_run` fires without touching the schedule.
7. **Edge cases:** "at 9" needs am/pm — ask rather than guess. Multi-job requests ("set up three reminders") need list → resolve id → edit → confirm room (maxIterations 10). Post-scheduling follow-ups ("did we do all three?") stay in cron via sticky routing — but "Awesome." after "Done, scheduled" is chat, which sticky gets wrong and a state-aware router gets right (DECISIONS 2026-09-26).
8. **Confidence threshold:** N/A — cron expressions are validated in code before persisting; an invalid one is rejected, never stored.
9. **Human escalation:** Scheduling itself is not confirm-gated. What the job may DO is the code gate: cron runs strip write tools, and `exec`/`send_message` are available only when the job was explicitly scheduled as that category (the owner-authored schedule is the authorization). Jobs retry 2× with backoff and notify on final failure.
10. **Known failures:** "did we do all three?" once routed to memory and got a confident wrong answer — cron became sticky. A plain `\bsetting\b` keyword hijacked a reminder paste — keyword patterns that can break sticky need override-grade precision. Sticky cron leaks: 3 of the first 8 shadow-router disagreements.
11. **Dispatch:** Arena (maxIterations 10, temperature 0.2, `think: false`). The `cron` pipeline definition is retained but bypassed.
12. **Test cases:** "remind me at 5pm" → cron (keyword), "We did all three or just the one?" with previousCategory=cron → cron (sticky), "add a heartbeat task to check disk space" → cron (keyword).

---

## task

1. **User story:** User wants to track to-do items — add, list, update, complete, remove — on a persistent board.
2. **In scope:** "add a task to buy groceries", "show my tasks", "mark a1b2c3d4 done", "move X to in progress", priorities/due dates/tags/assignees.
3. **Out of scope:** Anything time-triggered (→ cron), doing the work the task describes (→ whichever specialist does that — a task is a record, not an action), "add: fix typo in readme" phrased as a command to the codebase (genuinely ambiguous with exec; the synthetic-data round-trip filter lost 18% of `task` examples on exactly this boundary).
4. **Data requirements:** TaskStore (`tasks.json`) rendered to `TASKS.md` (protected — mutated only through the store); urgency tiers and calendar-day labels are computed in code (temporal module), never by the model.
5. **Tools:** task_add, task_list, task_update, task_done, task_remove.
6. **Acceptance criteria:** Default listing shows todo + in_progress; every mutation is confirmed back with the task id and new state; the model never invents ids — it lists first when the user names a task by words.
7. **Edge cases:** "add a task" and "show/list my tasks" are pre-model overrides (the model used to send them to chat). The heartbeat auto-completes/cancels tasks by code-computed rules and logs each as an `autonomous_action` — the specialist should not fight those labels.
8. **Confidence threshold:** N/A — deterministic store operations.
9. **Human escalation:** `task_add` is stripped in cron mode (automated jobs cannot create work for the owner without approval). Otherwise unconfirmed: reversible, owner-scoped.
10. **Known failures:** 568 uses all-time, then zero in the 30 days before the August trim — the category survived on principle (a task board is a daily-driver primitive), not on usage. Watch that it earns it.
11. **Dispatch:** Arena (maxIterations 5, temperature 0.2, `think: false`). The `task` pipeline definition is retained but bypassed.
12. **Test cases:** "add a task to call the dentist" → task (override), "show my tasks" → task (override), "mark the grocery task done" → task (keyword).

---

## message

1. **User story:** User wants the assistant to send a message somewhere else — another channel, a user, a Discord channel id — on their behalf.
2. **In scope:** "tell the team about the release in #general", "send Alex the address", "notify me on Telegram when done" (as a one-off send).
3. **Out of scope:** Replying in the current conversation (that is every specialist's normal output), email (no send capability exists — the steward is read-only forever), scheduled sends (→ cron with category message).
4. **Data requirements:** Channel registry (which adapters are connected), a resolvable destination (channel + channelId/target), the pending-action ledger, the standing-grants store.
5. **Tools:** send_message (`requiresConfirm: true`, `targetArgs: ['channel','channelId']`).
6. **Acceptance criteria:** The destination is resolved from the request, never guessed — ambiguous means ask. After calling the tool the specialist relays the preview/confirmation text and stops; it never claims the message was sent when the ledger is still waiting.
7. **Edge cases:** A send to the exact conversation the request came from never asks (implicit reply-origin approval). `always <id>` mints a target-bound grant for that channel+target only — never the whole tool. Keyword fallback for `tell|send|notify|message|announce` is broad; sticky and the conversational guard keep "tell me about X" in chat.
8. **Confidence threshold:** N/A — the confirmation is the gate, not a score.
9. **Human escalation:** Confirm-gated everywhere by default (propose_confirm tier: irreversible, visible to others). The confirmation executes the STORED call — sender-bound, single-use, 10-minute expiry. Confirm/Deny buttons on Discord/Telegram synthesize the typed reply. In cron mode the tool exists only when the job was scheduled as `message`.
10. **Known failures:** Six `message`-labeled router pairs in the training set were mislabeled chat (the class had effectively zero real examples). Confirm-result parity bugs on this seam (reply anchoring, media, continuation) — three in one week, July 2026.
11. **Dispatch:** Arena (maxIterations 5, temperature 0.5, `think: false`). The `message` pipeline definition is retained but bypassed.
12. **Test cases:** "tell the team about the release" → message (keyword), "send this to #announcements" → message (model), "tell me about the release" → chat (guard/sticky).

---

## website

1. **User story:** User gives a specific URL (or names a specific page / course material) and wants it read and summarized.
2. **In scope:** A bare URL, "check this: <url>", "what does this page say", teaching material and course content ("what homework is due", syllabus, lecture pages).
3. **Out of scope:** Finding pages (→ web_search), a URL inside a larger request ("research X, start from <url>" is research — the any-URL-anywhere rule hijacked those until July 2026), browsing-as-navigation across a site (→ web_search, which holds `browser`).
4. **Data requirements:** web_fetch (Readability extraction, page cache keyed by URL), browser (headless Chromium, DOM-first with visual escalation) for JS-heavy pages, web_search as the fallback when the page is unreachable; SSRF checks on every fetch.
5. **Tools:** web_fetch, browser, web_search.
6. **Acceptance criteria:** web_fetch first; browser only when the fetch is empty or blocked; a concise summary that says what the page is and what it says, with the URL; an honest "couldn't reach it" rather than a summary from memory.
7. **Edge cases:** A message that IS a bare URL is a pre-model override → website (the model classified those as web_search). Chrome-extension messages carry `[PAGE_CONTENT]` and are forced to chat — the content is already in the message, nothing to fetch.
8. **Confidence threshold:** N/A.
9. **Human escalation:** None — read-only.
10. **Known failures:** The original any-URL-anywhere override hijacked research requests; narrowed to bare URLs / short wrappers. JS-heavy sites returned empty from web_fetch → the browser fallback was added.
11. **Dispatch:** ReAct loop, default dispatch (no `dispatchMode`, no pipeline set): maxIterations 5, temperature 0.3, `think: false`.
12. **Test cases:** "https://example.com/post" → website (override), "what homework is due" → website (keyword), "research the EV market, start from https://…" → research (URL does not hijack).

---

## code_gen

1. **User story:** User wants code built — a project scaffold, a feature, a script, boilerplate, tests — or an existing project modified.
2. **In scope:** "build me a FastAPI service with tests", "scaffold a React app", "add a /health endpoint to the project in ./api", multi-step file processing on existing files (one `pi_build` call replaces a long chain of exec/read/write).
3. **Out of scope:** Running a one-liner or inspecting files (→ exec), Invarail modifying itself (that is the SIP rail: `!improve`, worktrees, merge gate — never this specialist), answering "how would I write X" conversationally (→ chat).
4. **Data requirements:** The Pi SDK adapter (`src/coding/pi-session.ts`), `pi.model` (provider/id from `~/.pi/agent/models.json`), an isolated build directory per project (cwd-scoped; context-file discovery suppressed so builds never inherit this repo's instructions), the config-declared Pi tool allowlist.
5. **Tools:** pi_build (`prompt`, optional `projectName` for new, `projectDir` + `sessionId` for modify/fix, optional `model`).
6. **Acceptance criteria:** The reply reports the build result and artifact paths from the tool's output, never fabricated; the brief passed to Pi is self-contained (goal, constraints, expected output); Pi's own lifecycle events (turns, tool calls, durations, errors) land in metrics with the JSONL transcript path recorded.
7. **Edge cases:** Fix/modify needs `projectDir` + `sessionId` from a prior build — the model must reuse them, not start a new project. Remote push is opt-in and off by default.
8. **Confidence threshold:** The intended gate is the actual test outcome from the pipeline's verify stage — not the model's self-assessment. **As configured today that gate does not run:** see 11.
9. **Human escalation:** None at the specialist level; `pi_build` is not confirm-gated (it writes only inside its build directory). Self-modification of Invarail is a different rail with two owner confirms.
10. **Known failures:** Pi duel + build duel (DECISIONS): a local 27B produced contract-grade work with a self-authored test suite in 384s; OpenCode was swapped out for Pi without the architecture noticing. The pipeline's verify/fix loop was the thing that made "it built" mean "it works".
11. **Dispatch:** `dispatchMode: "arena"` with `pi_build` as the only tool, model `glm-5.3-flash` (vLLM on the Spark), maxIterations 5. The `code_gen` pipeline definition (list_projects → enrich → build → verify → fix → re_verify → commit → report) exists and is what `pi-build.ts` was written for — but arena skips the pipeline even when one is set, so **the verify → fix → commit stages are bypassed as configured (found 2026-09-26; decision pending: drop `dispatchMode` on code_gen to restore the loop, or keep arena and accept unverified builds)**.
12. **Test cases:** "build me a CLI that renames files by date" → code_gen (model), "scaffold a Next.js app" → code_gen (model), "run npm install" → exec (keyword).
