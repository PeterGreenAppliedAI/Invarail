# How Invarail Routes Messages: A Deep Dive

*How a local AI agent classifies user intent and dispatches to the right specialist — without cloud APIs, with 12 categories, and a multi-layer fallback system that handles everything from "hi" to "research AAPL stock and make me a deck."*

---

## The Problem

You have ~44 tools (plus whatever MCP servers add), two deterministic specialist pipelines (`research`, `code_gen`) plus the system heartbeat, an arena for everything else, and 12 categories. A user sends "search for tech events near me." Does that go to:
- **web_search** (search the internet)?
- **multi** (browse Eventbrite with the browser tool)?
- **chat** (answer from memory)?
- **research** (a verified report on local tech events)?

A cloud model like GPT-4 handles this with a massive context window and strong instruction following. A local 14B model needs a harness. That harness is the routing system.

---

## Architecture Overview

Every message flows through a multi-layer pipeline before reaching a specialist. Each layer narrows the decision. By the time a message reaches a specialist, the routing is deterministic and auditable.

```
┌─────────────────────────────────────────────────────────┐
│                    Inbound Message                       │
└───────────────────────┬─────────────────────────────────┘
                        ▼
┌─────────────────────────────────────────────────────────┐
│  [1] FILE TYPE ROUTING                                  │
│  Images → vision → chat                                 │
│  Data files (.csv, .xlsx, .json) → exec (code_session)  │
│  PDFs → text extraction → normal routing                │
│  Text files → ask user (knowledge base or read as text) │
└───────────────────────┬─────────────────────────────────┘
                        ▼
┌─────────────────────────────────────────────────────────┐
│  [2] PRE-MODEL OVERRIDES                                │
│  High-confidence regex patterns that skip the model:    │
│  • Bare URLs → website                                  │
│  • Speculative language ("I wonder…") → chat            │
│  • "did you… / have you…" meta-questions → chat         │
│  • research/analyze + stock/market/data → research      │
│  • explicit task / image commands → task / image        │
└───────────────────────┬─────────────────────────────────┘
                        ▼
┌─────────────────────────────────────────────────────────┐
│  [3] STICKY ROUTING                                     │
│  Mid-conversation? Stay on the same category unless:    │
│  • Explicit task command ("search for X", "create a")   │
│  • Greeting ("hi", "hello") — new conversation          │
│  • Strong new-topic signal ("look up", "schedule")      │
│  Sticky: chat, briefing→chat, cron; rest don't          │
└───────────────────────┬─────────────────────────────────┘
                        ▼
┌─────────────────────────────────────────────────────────┐
│  [4] MODEL CLASSIFICATION                               │
│  phi4 (router.model) classifies into 12 categories      │
│  • Temperature 0.1 (deterministic)                      │
│  • ~200ms warm on the 3060 (shadow encoder: ~65ms)      │
│  • 20 tokens max (just the category name)               │
│  • Minimal prompt: categories + descriptions + message  │
└───────────────────────┬─────────────────────────────────┘
                        ▼
┌─────────────────────────────────────────────────────────┐
│  [5] KEYWORD FALLBACK                                   │
│  When the model fails, times out, or returns garbage:   │
│  • Specific patterns first (exec, task, cron)           │
│  • Broad patterns last (web_search)                     │
│  • Order matters — first match wins                     │
└───────────────────────┬─────────────────────────────────┘
                        ▼
┌─────────────────────────────────────────────────────────┐
│  [6] DEFAULT → chat                                     │
└───────────────────────┬─────────────────────────────────┘
                        ▼
┌─────────────────────────────────────────────────────────┐
│  [7] SECURITY FILTERING (6 layers)                      │
│  1. Channel whitelist (allowedCategories)                │
│  2. Restricted categories (untrusted users blocked)     │
│  3. Blocked tools (channel-level blacklist)              │
│  4. Owner-only tools (code gate — invisible to others)  │
│  5. Restricted tools (untrusted user blacklist)          │
│  6. Confirm tools (preview before execution)            │
└───────────────────────┬─────────────────────────────────┘
                        ▼
┌─────────────────────────────────────────────────────────┐
│  [8] CONVERSATIONAL GUARD                               │
│  Mid-conversation, a SHORT (<30 chars) message the      │
│  model sent to a tool specialist → chat. Sticky, owner- │
│  forced, cron, and rerouted dispatches are exempt;      │
│  skipped for console/extension (browser control needs   │
│  the router's classification to stick)                  │
└───────────────────────┬─────────────────────────────────┘
                        ▼
┌─────────────────────────────────────────────────────────┐
│  [9] DISPATCH DECISION                                  │
│  • No tools → bare chat (direct LLM, no loop)           │
│  • research / code_gen (+ system heartbeat) → pipeline  │
│  • Everything else → arena (open ReAct tool loop)       │
└───────────────────────┬─────────────────────────────────┘
                        ▼
                  Specialist Execution
                        ▼
┌─────────────────────────────────────────────────────────┐
│  [10] POST-DISPATCH RE-ROUTES (one per message)         │
│  • chat admits a capability gap → re-classify           │
│  • arena specialist claims/announces an action whose    │
│    tool it lacks → specialist reroute (2026-09-29)      │
│  • research aborts as conversational → web_search       │
└─────────────────────────────────────────────────────────┘
```

---

## Layer 1: File Type Routing

Before the message hits the router, attachments are pre-processed. The file extension determines the path — no model involved.

```
attachment → check extension
  → image (.png, .jpg, .gif, .webp)     → vision describes it → chat
  → PDF (.pdf)                           → extract text → inject → route normally
  → data (.csv, .xlsx, .json, .tsv)      → exec (code_session / pandas)
  → text (.md, .txt, .html, .log)        → ask user: knowledge base or read as text?
  → unknown                              → ask user same choice
```

The data-file rule is the strongest example of code-driven routing: a CSV upload always lands in `exec`, where `code_session` does the pandas work (the dedicated analytics pipeline was retired 2026-08-10 — it had 0 uses). The model never decides — the file extension does.

---

## Layer 2: Pre-Model Overrides

High-confidence patterns that the router model gets wrong often enough to warrant a code override. These fire before any LLM call.

| Pattern | Routes To | Why It Exists |
|---------|-----------|---------------|
| Message IS a bare URL (or a short "check this" wrapper with no other intent) | `website` | Model classified bare URLs as `web_search`. Narrowed July 2026: the original any-URL-anywhere rule hijacked "research X, start from <url>" into a page summary — a URL inside a larger request now lets the model see the full intent |
| ~~Email/calendar + time words~~ | ~~`personal`~~ | Retired with the category (2026-08-10). Email/calendar reads now reach `multi` through its description — 6/6 misroutes until the description said so (2026-09-25) |
| ~~"Make a PDF report"~~ | ~~`research`~~ | Removed with the other bare-keyword document/email overrides: they matched a word anywhere in the text, so "pdf" or "email" inside pasted/attached content hijacked routing. Report requests now reach `research` through its description (capability-aware router prompt) and the research keyword hints |
| ~~"Go to [site]" + domain~~ | ~~`multi`~~ | Deleted 2026-09-26. It predates `web_search` holding `browser`; it contradicted the doc and the Laya labels (browse-a-named-site = `web_search`) and hijacked chained requests into `multi` before either router saw them. The descriptions decide now; the keyword fallback for browse phrasing says `web_search` |
| "Research/analyze" + "stock/market/data/trend/performance/price" (either order) | `research` | Model classified research requests as `web_search` |
| Opens with speculative language ("I wonder", "what if", "do you think", "I was thinking") | `chat` | "I wonder if you could create…" went to `multi` |
| Opens with a meta-question about the agent's own past ("did you…", "have you…", "what did you…") | `chat` | "did you actually send a message?" classified as `message` and proposed ANOTHER send (July 7). Past/perfective only — "can you send…" is untouched |
| Opens with "add/create/make a task" or "show/list/check my tasks" | `task` | The model sent task-board commands to `chat` |
| Opens with "generate/create/draw/make an image/picture/illustration/photo" | `image` | Explicit generation requests |

All of these live in `PRE_MODEL_OVERRIDES` in `src/router/classifier.ts` (seven regexes; the bare-URL rule is code just before them). They run on the capped routing text (`capForClassification`: head + tail, 600 chars, so a big paste cannot time the router out) and on the user's instruction rather than attachment bodies. Overrides beat sticky routing.

**The principle:** Pre-model overrides only exist for patterns where the model has proven unreliable. Every override was added because of a real misclassification observed in production. We don't override everything — just the cases with a documented history of failure.

---

## Layer 3: Sticky Routing

Multi-turn conversations should stay in the same category. If you're chatting about cooking and ask "what about chicken?", that should stay in `chat`, not route to `web_search` because the model sees a question.

**How it works:**
- Sticky categories: `chat`, `briefing` (replies are answers, target `chat`), and `cron`. `memory` was sticky until 2026-09-26: a memory question is one-shot, and a session that landed there had no breaker for plain conversation — a 40-turn DM spent 20 turns in the memory arena (10–42s replies, repair-prompted tool calls) while the shadow router said chat on every one. Follow-ups now re-route through the model, which says memory again if it is one. Most pipeline categories (web_search, exec, research) finish in one turn — no sticking needed.
- `cron` is sticky because post-scheduling follow-ups ("did we do all three?", a re-paste of jobs that didn't get created) belong back in cron, which answers from `cron_list` (the cron pipeline's list branch did at the time; the cron arena does now) — without it, "did we do all three?" routed to memory and confabulated from a saved fact (July 20 incident).
- Short follow-up messages stay on the previous category.
- Long messages (>200 chars) also stay sticky — they're likely continuing a discussion.
- Replies after a briefing are presumed to be ANSWERS (briefing → chat): only an imperative or a keyword hit breaks out, because the fuzzy new-topic signals misfire on answers ("I just need to get him a link" matched get…a → `message` → tried to SEND the user's words, July 7).
- Commands (`!…`) are never follow-ups.

**What sticky cannot know (2026-09-26):** sticky keeps the previous turn's *category*, not its *state*. "Awesome." after "Done — you'll get a Discord DM Tuesday" is an acknowledgment (chat); "yes do it" after "Want me to set that up?" is a confirmation (cron). The 30-char heuristic sends both to cron. In the shadow log, sticky is the live router's main leak (3 of the first 8 disagreements; Laya right on all 3). A System-One router given `{previous_category, assistant_last_reply, message}` as state makes the distinction zero-shot — probed live against v3: "yes do it" chat 0.28 bare → cron 0.95 with state; "Awesome." after "Done" stays chat. That is the shape of the planned v4 fine-tune: the model that replaces phi4 replaces this layer in the same move.

**What breaks through sticky:**
- Imperative commands (after stripping a polite prefix like "can you" / "please" / "I need you to"): build, create, make, generate, write, scaffold, implement, produce, draft, prepare, search for, run, execute, send, schedule
- Greetings: "hi", "hey", "hello" — starts fresh classification
- New-topic signals (`NEW_TOPIC_PATTERNS`): "search the web for", "look up", "find me a", "remind me", "what's the/my …", "create a report/deck/pdf", …
- Any pre-model override (they run before sticky)
- Keyword matches that point to a different category than the current one. Keyword patterns that can break sticky need pre-model-override precision — plain `\bsetting\b` matched "setting up a business" and hijacked a reminder paste; the fix was `settings?(?! up)` on the config pattern, and the whole config pattern left with the `config` category (2026-08-10).

**Why sticky exists:** Without it, every message mid-conversation gets re-classified independently. "What do you think about the trade-offs?" during an AI discussion gets classified as `research` because "trade-offs" sounds analytical. Sticky keeps the conversation flowing.

Note: sticky routing governs *classification* (which category the message lands in) and is independent of *dispatch type* — whether that category then runs as an arena ReAct loop or a deterministic pipeline is decided separately at Layer 9. A sticky classification also changes two things downstream: it is exempt from the conversational guard (Layer 8), and a short sticky follow-up (<150 chars) gets the tail of the previous assistant message injected as continuation context.

---

## Layer 4: Model Classification

If pre-overrides and sticky routing don't apply, the router model classifies the message.

**Model:** `router.model` — phi4:latest on the 3060 utility box in the reference build (the `:14b` tag does not exist there; a stale tag cost one fact extraction to a 404 on 2026-09-19). The schema default is `phi4-mini`; the setup wizard picks a measured utility model, and on a one-model install the foreground model routes its own requests.
**Temperature:** 0.1 (very low — same message should always produce the same category), `num_predict` 20, `num_ctx` = `router.contextSize` (default 8192 — matched to extraction so the shared utility model never reloads at a different context size)
**Thinking:** always `think: false`. On a thinking model the constrained answer landed in the `thinking` field with an EMPTY `response`, which read as garbage and sent every message to the keyword fallback — qwen3.5:9b routed 0/11 by model until this was pinned (e2e eval 2026-09-27). A model answer that is not a category is now logged (`[Router] Model returned no category …`) instead of falling through silently.
**Output:** Single word — enum-grammar-constrained via `format` when the backend supports it (the model physically cannot emit an invalid category); plain generation + sanitize otherwise
**Latency:** ~200ms warm; up to several seconds when the gateway has evicted the model
**Timeout:** `router.timeout` (schema default 2000ms) is ENFORCED (July 2026) — a hung/dead backend costs exactly the configured budget before keyword fallback, not the HTTP client's retry loop (~12s). The abandoned request's result is discarded.

The prompt (`src/router/prompt.ts`) is intentionally minimal. It lists the configured categories (12 since the 2026-08-10 trim) with one-line descriptions, a few fixed rules (MATCH THE CAPABILITY; web_search only for an active look-up; classify by the instruction, not by stray words inside pasted content), and asks for exactly one word back. **Those descriptions are the router's whole world** — when `personal` was retired, nothing said where Gmail and Calendar lived, and "check my email" went to `chat`/`memory`/`cron` six times out of six until the `multi` description said so (2026-09-25). The model doesn't see conversation history, tools, or system context — just the message and the category list.

**The descriptions now say what each specialist CANNOT do (2026-09-29).** The wizard defaults (`ROUTER_CATEGORIES` in `src/setup/defaults.ts`) end `web_search` with "answers in the reply only; cannot write files or add tasks", `exec` with "cannot search the web or use the task board", `task` with "task tools only; cannot read or write files", and `multi` with "Pick this whenever no single category above has every tool the request needs." On the two-specialist requests (read a file + add a task + write a file; look something up + write it to a file) that wording alone took gemma4:12b from 7/10 to 10/10 (evals/2026-09-e2e/routing/). An existing config keeps its own descriptions — these are defaults, not overrides.

**Stale text in the prompt code, kept on measurement (2026-09-30):** the fixed rules still name the retired `analytics` and `personal` categories and call memory READ-only, though the memory specialist holds `memory_save`. A corrected version was measured and reverted: alternating arms on the same card, it routed qwen2.5:7b's "Remember this: …" to `cron` 0/20 times against 16/20 correct for the current text; phi4 scored 54/54 on the live check either way. The built-in `DEFAULT_CATEGORIES` list (used only when `router.categories` is empty) no longer offers the retired categories. Treat the rules block as a measured artifact: change it only with an A/B. Configured categories are what the model is actually offered, and enum-constrained output confines it to them, but the stray names are prompt noise.

**Why phi4:** Fast classification at 200 tokens per decision. Few-shot capable — understands category descriptions. Dense model — no thinking overhead. The router doesn't need reasoning, it needs pattern matching at scale.

**12 categories (four retired, kept for the record):**

| Category | What It Handles |
|----------|----------------|
| `chat` | Conversation, opinions, questions answerable from context |
| `web_search` | Questions needing current internet information |
| `memory` | Questions about past conversations or stored facts |
| `exec` | Shell commands, file operations, system administration |
| `cron` | Schedule, list, or manage recurring tasks |
| `message` | Send messages to other channels/users |
| `website` | URL fetching and summarization |
| `multi` | Complex requests chaining several different tools — and the only specialist that reads the owner's Gmail/Calendar (the tools are owner-only and live here) |
| `task` | Create, list, update, or complete tasks |
| `research` | Deep multi-source research that produces a PDF report |
| `image` | Image generation |
| `code_gen` | Build/scaffold/implement code (delegated to Pi) |
| ~~`config`~~ | Retired 2026-08-10 → workspace/cron tools inside the arenas |
| ~~`personal`~~ | Retired 2026-08-10 → email/calendar reads route to `multi` by capability |
| ~~`analytics`~~ | Retired 2026-08-10 → data-file uploads route to `exec` |
| ~~`document`~~ | Retired 2026-08-10 → the `document` tool stays as an execution primitive (in `exec`, `multi`, `research`); document-format keywords fall back to `exec` |

Browse-a-named-site ("go to meetup.com and find tech events") is `web_search`, not `multi`: `web_search` holds the `browser` tool now, and the router's own rule is *match the capability*. The historical `multi` label for those dates from when only `multi` had the browser — which is exactly the kind of drift a training set collected from the router's own past decisions inherits (see the shadow section below).

---

## Layer 4b: Shadow Router (observation only, 2026-09-25)

A second classifier answers the same question on every message and **never decides**. `router.shadow { enabled, url, timeoutMs, logPath }` points at a System-One decision server (`/v1/systemone`, TypeSafe Jev's wire protocol, served locally by Laya): state = the message, one typed `choice` question whose options are `router.categories` descriptions **verbatim** — the option text is model input, so the checkpoint is trained on exactly that string and config is the single source for both sides.

The hook wraps `classifyMessage` (`src/router/shadow.ts`), so the shadow is compared against whatever actually decided — override, sticky, model, keyword, or fallback — and it is fire-and-forget with a hard bound: it never changes the result, never delays it, and a dead server costs one warning. Every message appends `{ts, preview, decided, decidedBy, shadow, confidence, top, ms}` to `data/router-shadow.jsonl` and prints `[RouterShadow] live=… shadow=… AGREE/DIFFER` with a running agreement rate.

Why it exists: a 421M Laya encoder fine-tuned on the owner's own routing history scored **80.8% vs phi4's 76.9%** on the corrected held-out set at **63ms vs 270ms** (90.8% vs 80.0% weighted by real traffic). **Readings so far (66 messages, 2026-09-26):** 88% agreement, p50 185ms over HTTP; Laya right on 5 of 8 disagreements, wrong on 2 (the `data … research` keyword-override class at 0.96 — the training gap — and one `memory` call at 0.49), one toss-up. Every agreement scored ≥ 0.92 and the two clearly wrong model-layer calls were the only rows under 0.9 — the first real-traffic sign the probability could gate. Plan: observe through the week, likely a v4 fine-tune (with state, see Layer 3) before any switch.

**A System-One decision model as router (2026-09-25).** Jev/Laya-style models take state plus a typed question and return a calibrated choice in one forward pass — nothing generated, nothing to parse. A 421M Laya encoder fine-tuned for 55 minutes on this Mac, on 1,248 cleaned real routing pairs plus 777 round-trip-validated synthetic ones, scored **80.8% vs phi4's 76.9%** on the corrected held-out set at **63ms vs 270ms** (90.8% vs 80.0% weighted by real traffic). It runs in **shadow mode** — `router.shadow` asks it the same question beside phi4 on every message and logs both; phi4 still decides. A disagreement rate on real traffic, not a 78-item eval, is what earns the switch. Full write-up with the disproven parts (zero-shot is useless; the confidence-gated hybrid lost) in [DECISIONS.md](../DECISIONS.md).

A 78-item eval is not a reason to change routers; an agreement rate on the real distribution — and, on the disagreements, which one was right — is. Full method, the dataset cleaning (the collected pairs were phi4's own decisions, not truth), the synthetic-data round-trip filter, and what was disproven (zero-shot; the confidence-gated hybrid) are in DECISIONS.md, "A 421M Encoder Out-Routes phi4".

---

## Layer 5: Keyword Fallback

When the model fails, times out, or returns an invalid category, regex patterns take over.

**Order matters.** Specific patterns match before broad ones. This prevents "search for docker commands" from routing to `web_search` instead of `exec`.

```
Priority order (first match wins — 21 patterns, `KEYWORD_HINTS` in classifier.ts):
  1. Compound actions (save/read file + search; search + save/send/sign up;
     find … and/then) → multi
  2. Research requests (explicit markers; chart/plot + data/stock/trend) → research
  3. Browse-a-site phrasing (go to / visit / navigate to … .com/site/page) → web_search
  4. Heartbeat management → cron
  5. Document formats (pdf, docx, xlsx, pptx, spreadsheet, slide deck) → exec
     (the `document` tool lives there; this said `multi` before the category trim)
  6. System commands (npm, git, sudo, ls), run/build a script, list files, read a file → exec
  7. Task management (todo, kanban) → task
  8. Scheduling (remind, cron, daily, at 5pm) → cron
  9. Memory recall (remember, last time) → memory
  10. Messaging (tell, send, notify) → message
  11. Course material (homework, syllabus, lecture) → website
  12. Search intent (search for, google, look up) → web_search  ← broadest
  13. Live-value lookups (current price of X) → web_search
  14. Image generation verbs → image
  (config/settings → `config` was removed with the category, 2026-08-10)
```

**What we removed from keywords:** "what is" and "who is" used to trigger `web_search`. But "what is the meaning of life?" is a chat question. Removing these broad patterns reduced false keyword matches significantly. Also removed (July 2026): bare `workspace` from the config pattern — it captured exec requests like "run ls in the workspace". Added: `ls`/`pwd`/`chmod` to exec hints, and live-value lookups ("current price of X") → `web_search` (previously fell to the chat default, answering stale).

---

## Layer 6: Default

If nothing matches: `router.defaultCategory` (`chat`). The safest default — the chat specialist can handle most things conversationally, and if it can't, the silent re-route (post-dispatch) catches it.

---

## Layer 7: Security Filtering

After classification, six security gates filter what a user can do. These run in order in `dispatchMessage`, each narrowing permissions (the two category gates first, then the tool gates — `mcp:<server>` tokens are expanded to concrete tool names BEFORE the tool gates, so a rule naming one MCP tool cannot be sidestepped by the server token):

```
Layer 1: allowedCategories
  └── Channel whitelist. A public Telegram channel might only allow chat + web_search.
      Category not in the list → downgraded to chat (or the channel's first allowed category).

Layer 2: restrictedCategories
  └── Untrusted users can't access these categories at all (→ chat).

Layer 3: blockedTools
  └── Channel-level tool blacklist. Everyone on this channel loses these tools.

Layer 4: ownerOnlyTools
  └── CODE GATE. Owner-only tools (exec, gmail, calendar) are completely
      invisible to non-owners. The model never sees them in the tool list.
      Not a prompt instruction — a code-level filter before the model runs.

Layer 5: restrictedTools
  └── Untrusted users on this channel lose these specific tools.

Layer 6: confirmTools
  └── Preview before execution. The previewed call is recorded in the
      pending-action ledger; "confirm" executes the STORED params —
      sender-bound, single-use, 10-min expiry. Never a model-regenerated
      call. Applies to pipeline dispatches too (was a bypass until July 2026).
      Effective set = channel confirmTools ∪ tools declaring requiresConfirm
      (the one autonomy bit — send_message, MCP tools without readOnlyHint)
      − channel autoApproveTools (promotion lever; an explicit confirmTools
      entry always wins).
```

**The owner-only gate is critical.** It's not a prompt telling the model "don't use exec for non-owners." The tools are stripped from the model's vocabulary entirely. The model can't use what it can't see. You can't prompt-inject past a code gate.

---

## Layer 8: Conversational Guard

The most nuanced layer. Prevents pipeline misroutes when a user is mid-conversation.

**The problem:** You're discussing AI model architectures. You say "what do you think about the performance improvements?" The router classifies this as `research` because it sees "performance" and "improvements." Without the guard, your casual question triggers a full research pipeline with parallel searches and chart generation.

**How it works (the lightweight guard, June 2026 — no keyword matching, just length + context):** if the message was classified as a non-chat category, the session already has turns, and the message is SHORT (under 30 characters), downgrade to `chat`. Longer or explicit messages trust the router. (The earlier version downgraded ANY mid-conversation message without explicit task intent, whatever its length.)

**What bypasses the guard:**
- Sticky classifications (2026-08-21) — sticky already IS the context signal; a short "Yes" answering a specialist's own "run it now?" must return to that specialist, not to toolless chat
- First messages (no session state yet)
- Owner-forced categories (`overrideCategory` — `!research`, confirm continuations, re-routes)
- Cron jobs (autonomous, no conversation context)
- Re-routed dispatches (`_reRouted`)
- Console/extension messages (browser control needs direct routing)

**What it catches:** Short fragments the model gets wrong mid-conversation. "Tell me more" classified as `message`. "and the research?" classified as `research`. "latest on this?" classified as `web_search`. All downgraded to `chat` — where, if chat really cannot answer, the silent re-route still catches it.

---

## Layer 9: Dispatch Decision

The final routing — how the message gets processed. One code gate applies at this layer before any pipeline starts: **explicit tool mentions**. `findExplicitToolMentions` (registry) scans the message against the specialist's allowed tool names — word-boundary, case-insensitive, with bare-name aliasing for MCP-prefixed tools ("weekly_gather" matches `flows_weekly_gather`). Hits are injected into pipeline params and consumed twice: the research pipeline's `flow_gather` stage (a named gathering flow replaces decompose+search), and the plan pipeline's skill guard (a matched skill whose steps never mention an explicitly named tool is ignored — explicit instruction outranks learned habit; historical — the plan pipeline was retired from dispatch 2026-08-21). Like the pre-model overrides in Layer 2, this is deterministic string matching, not model judgment.

```
┌─────────────────┐     ┌──────────────────────────────┐
│ No tools         │────▶│ Bare chat (direct LLM)       │
│ (e.g., greeting) │     │ No tool loop, just respond    │
└─────────────────┘     └──────────────────────────────┘

┌─────────────────┐     ┌──────────────────────────────┐
│ research /       │────▶│ Deterministic pipeline        │
│ code_gen /       │     │ Code controls the workflow    │
│ system heartbeat │     │                               │
│                  │     │ LLM fills params, synthesizes │
└─────────────────┘     └──────────────────────────────┘

┌─────────────────┐     ┌──────────────────────────────┐
│ Everything else  │────▶│ Arena (open ReAct tool loop)  │
│ (multi, exec,    │     │ Model decides what tools to   │
│  web_search,     │     │ use and in what order —       │
│  chat, cron...)  │     │ natural stop, session history │
└─────────────────┘     └──────────────────────────────┘
```

Since the arena rollout (fleet-wide 2026-08-21), the open ReAct loop is the default dispatch: `multi`, `exec`, `web_search`, `cron`, `task`, `memory`, and `message` run `dispatchMode: "arena"`; `website` and `image` have no pipeline set and run the same ReAct loop by default — same 6 security layers and confirm ledger, no staged workflow. The plan pipeline (LLM decomposition for `multi`) was retired from dispatch at the same time. Deterministic pipelines remain only where the stages are an oracle: `research` (claim verification + PDF render), `code_gen` (build → verify → bounded fix → commit — the test outcome is the gate; it ran as arena from 2026-08-21 until a doc audit found the verify loop bypassed on 2026-09-26, and neither the current config nor the wizard default sets `dispatchMode` on it now), and the system heartbeat. Order of the checks in code: no specialist / no tools → bare chat; arena → loop; a registered `pipeline:` → pipeline; otherwise the ReAct loop.

**The principle:** If the workflow is predictable (search → fetch → synthesize), use a pipeline. If the workflow depends on what the model finds (open-ended conversation, calendar queries, image generation), use ReAct.

---

## Post-Dispatch: Silent Re-Route

After the specialist produces a response, one more safety net runs.

If the chat specialist says "I don't have access to search the web" or narrates a tool call without actually executing it, the system detects the capability gap, re-classifies the message, and dispatches to the specialist that has the right tools — silently, without the user needing to rephrase.

This catches the long tail of misclassifications that none of the other layers caught. The chat specialist admits it can't help, and the system automatically finds the specialist that can.

Mechanics: the router model first condenses the last few turns plus the message into ONE sentence (the handoff), the router classifies that sentence, and only a non-chat answer re-dispatches — as `overrideCategory`, so the security layers apply to the new category as to any message. Gap patterns include "I don't have access to…", "you would need to use…", narrated tool syntax (`[tool(...)]`), and a promise with a search verb ("let me look that up") — chat has no tools, so a promise of action is a gap. Thinking is stripped before matching, so reasoning like "I don't have access" inside `<think>` doesn't trigger it.

A `_reRouted` flag prevents infinite loops — if the re-routed specialist also fails, it stops. One re-route per message, whichever kind fired.

A sibling: when the research pipeline decides mid-run that the request is conversational, not a report, it returns a downgrade marker and the message is re-dispatched to `web_search` with the same handoff summary.

---

## Post-Dispatch: Specialist Reroute (2026-09-29)

The silent re-route covers `chat`. The same failure happens one level down: the router's pick decides a specialist's TOOLSET, and when the pick is wrong the specialist does not stop — it improvises with the wrong tools and the answer looks finished. A `task` specialist with no file tools adds the task, then says "Next, I will read releases.txt" and stops; an `exec` specialist with no task tools writes "I have added a task … to your task board." The specialist is the only party that discovers the gap, because it finds out while it works. `src/router/reroute.ts` turns that into ONE bounded re-dispatch.

**Signals are read from the finished answer — nothing is added to the prompt.** Strongest first:
- **claimed** — the answer claims an action whose tool the specialist does not hold (first-person "I have added a task…", "…has been added to your board", "I've written notes.md", "I have sent a message", "I've scheduled"). False by construction. Anchored so a summary that QUOTES "added task queue support" from release notes does not trip it.
- **announced** — the answer ENDS (last 500 chars) announcing an action it has no tool for: "Next, I will…", "let me…", "I'm going to…" + read/write a file, search the web, add a task, send a message, schedule.

**Rules (agreed before any code):**
1. **The specialist never picks the category.** The router is re-asked with a hint that LEADS the message ("the `task` specialist could not finish this — it needs to read a file…") — leading, because the anchored overrides (`^add a task` → task) would otherwise send the request straight back. Code refuses a same-category or `chat` answer; then the original answer ships with an honest note ("This also needs to …, which I can't do from here, and no other route was found for it.").
2. **A reroute never widens authority.** The re-dispatch re-enters `dispatchMessage` with the new category as `overrideCategory`, so all six security layers apply exactly as to a fresh message.
3. **Once.** `_reRouted` — a second gap ends with an honest reply. Never in cron mode, never when the owner forced the category, only for arena specialists with tools, never from chat (chat has its own re-route).
4. **Confirm gates are untouched.** The second specialist receives the ORIGINAL request plus a handoff note listing what the first one already did (tool, params, observation — "do NOT repeat these", so a second `task_add` doesn't duplicate the board) and that anything awaiting confirmation stays pending. The transcript keeps the user's own words, not the handoff note; the result carries `reroutedFrom`.

Config: `router.reroute.enabled` (default `true`).

**Evidence** (evals/2026-09-e2e/routing/, two requests that need tools from two specialists, five reps each on qwen3.5:9b, gemma4:12b, qwen2.5:7b): 18/30 correct at baseline → 30/30 with the new category descriptions (Layer 4) plus the reroute; on the final code every one of qwen2.5:7b's five release-notes misroutes to `exec` was rerouted and finished (three by the claimed signal, two by the announced one). Full 12-task battery unchanged or better (36/36, 36/36, 30/36).

**Disproven first:** a `handoff` tool offered to every specialist. One extra tool made qwen3.5:9b emit malformed tool calls on the task board (2/5 vs 5/5) and cost qwen2.5:7b exec accuracy (7/10 vs 10/10). Built, measured harmful, removed the same night — reading the answer the model already writes costs the model nothing.

---

## Special Routing Modes

### Browser Control (Chrome Extension)

When the Chrome extension is connected, console channel messages get special treatment:
- Runs on `browser.controlModel` when set, else the specialist's own model (the foreground `defaultModel` in practice) — multi-step browser tasks need the big model
- Pipeline is stripped (forced ReAct — browser control is inherently reactive)
- web_fetch tool is removed (forces the browser tool for navigation)
- Max iterations bumped to 20, max tokens to 16384
- System prompt replaced with browser-specific instructions
- Conversational guard is skipped (router classification needs to stick)

### Cron Jobs

Cron jobs dispatch with an explicit category override and `cronMode: true` (so neither the conversational guard nor either re-route applies). Cron mode strips write tools (write_file, workspace_write, memory_save, and task_add/update/done/remove) so automated tasks can't modify state without human approval. Additionally (July 2026): `exec` and `send_message` are only available when the job was explicitly scheduled as that category — the owner-authored schedule is the code gate. A web_search cron job whose fetched page contains an injected "run this / message X" instruction has no tool to reach for.

### Smart Model Routing

For trivial greetings ("hi", "thanks", "cool" — a whitelist regex matching the whole message, only when there is no previous category), a lighter model — `router.quickModel`, unset = no fast path — handles the response. No need to wake the foreground model for "hello." This is a latency optimization, not a routing change — the message still goes to `chat`, just with a faster model.

---

## Two Dispatch Paths

A critical architectural detail. There are two ways messages reach dispatch:

```
Discord / Telegram / Gmail
  → orchestrator.handleMessage()
    → attachment pre-processing
    → resolveRoute()
    → dispatchMessage()

Web console / Chrome extension
  → POST /console/api/chat
    → chat.ts handler
    → dispatchMessage()
```

The console path handles its own attachment processing, command parsing (`!research`, `!reset`), and page context token stripping. **Routing changes added to the orchestrator do NOT affect the console path.** This has been a source of bugs — any routing override needs to exist in both places or it only works on one set of channels.

---

## Observability

Every routing decision is logged with the layer that made it:

```
[Router] URL override: "https://example.com/..." → website (bare URL)
[Router] Pre-model override: "add a task to call the dentist..." → task
[Router] Sticky: "what about the pricing?" → chat (follow-up to chat)
[Router] Model returned no category (response="") — keyword fallback
[Dispatch] Category: web_search (model)
[Dispatch] Category: task (keyword)          ← pre-model overrides report as keyword
[Dispatch] Category: web_search (override)   ← owner-forced / re-dispatched category
[Dispatch] Conversational guard: research → chat (short ambiguous message, turn 3)
[Dispatch] Browser control mode → guided ReAct
[Dispatch] Silent re-route: chat gap detected → web_search
[Dispatch] Reroute (announced): task → multi (missing: read a file)
[RouterShadow] live=chat(model) shadow=chat conf=0.97 AGREE 62ms
```

No black boxes. Every misroute is traceable to the layer that made the decision.

---

## The Numbers

- **12 categories** covering all user intents (3 retired 2026-08-10)
- **8 pre-model overrides** catching high-confidence patterns
- **21 keyword fallback patterns** as safety net
- **6 security layers** per message
- **~200ms** warm for model classification on the 3060 (~65ms for the 421M shadow encoder)
- **4 tiers of fallback:** overrides → model → keywords → default
- **3 post-classification guards:** security → conversational guard → dispatch decision
- **1 post-dispatch re-route per message:** chat capability gap, specialist reroute, or research downgrade

---

## Lessons Learned

**1. Pre-model overrides exist because models fail predictably.**
When you see the same misclassification 3+ times, add an override. Don't fight the model — route around it.

**2. Sticky routing prevents the most common misroute.**
Without it, every question mid-conversation gets independently classified. "What do you think?" becomes a research task.

**3. The conversational guard is the most important post-classification layer.**
It catches everything the model gets wrong mid-conversation. Explicit task intent is the only way to break through.

**4. Keyword fallback order matters.**
Specific before broad. `exec` before `web_search`. Otherwise "search for docker commands" routes wrong.

**5. Security is a code gate, not a prompt.**
The model never sees owner-only tools. You can't bypass this with prompt injection because the tools aren't in the model's vocabulary.

**6. Two dispatch paths means two places for routing logic.**
The console API bypasses the orchestrator. Every routing change needs to be applied in both places.

**7. Silent re-routing catches the long tail.**
When the chat specialist admits it can't do something, the system re-classifies and dispatches without the user needing to rephrase. Since 2026-09-29 the same holds one level down: an arena specialist that claims or announces an action it has no tool for gets one reroute — read from its answer, decided by the router, gated by code.

**8. Not everything needs a pipeline.**
Browser control failed as a deterministic pipeline but works as guided ReAct. If the workflow is unpredictable, let the model react. If it's predictable, use a pipeline. Don't force one pattern on everything.

---

**9. A router's training data is its own past decisions unless you clean it.**
`data/training/router-pairs.jsonl` recorded `{message, category}` as routed — phi4's labels, not truth — plus 85 pipeline handoffs and `[SYSTEM]` notices no human typed. Re-labeling under the *current* prompt, ruling on the disagreement patterns, and round-trip-validating synthetic examples was most of the work of beating the incumbent. Even the hand-labeled eval set had rotted as category definitions moved (2026-09-25).

---

**10. Tell the router what a specialist cannot do.**
A description that lists only capabilities invites the router to pick the closest match and let the specialist improvise. "cannot write files or add tasks" on `web_search` and "pick this whenever no single category has every tool" on `multi` moved two-specialist requests more than any prompt rule. And an extra tool is not free: the `handoff` tool that would have let specialists ask for help made a 9B worse at the tools it already had.

---

*Invarail is an open-source local-model-first AI agent framework. The routing system described here handles ~75 tools across 12 categories — arena dispatch for most, deterministic pipelines for research and code_gen — all running on personal hardware.*
