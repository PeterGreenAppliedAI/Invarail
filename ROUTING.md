# How Invarail Routes Messages: A Deep Dive

*How a local AI agent classifies user intent and dispatches to the right specialist — without cloud APIs, with 12 categories, and a multi-layer fallback system that handles everything from "hi" to "research AAPL stock and make me a deck."*

---

## The Problem

You have ~44 tools (plus whatever MCP servers add), 2 deterministic pipelines, an arena for everything else, and 12 categories. A user sends "search for tech events near me." Does that go to:
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
│  • URLs → website                                       │
│  • Speculative language ("I wonder…") → chat            │
│  • "make a PDF report" → research                       │
│  • explicit task / image commands → task / image        │
└───────────────────────┬─────────────────────────────────┘
                        ▼
┌─────────────────────────────────────────────────────────┐
│  [3] STICKY ROUTING                                     │
│  Mid-conversation? Stay on the same category unless:    │
│  • Explicit task command ("search for X", "create a")   │
│  • Greeting ("hi", "hello") — new conversation          │
│  • Strong new-topic signal ("look up", "schedule")      │
│  Sticky: chat, memory, briefing→chat, cron; rest don't  │
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
│  2. Owner-only tools (code gate — invisible to others)  │
│  3. Restricted categories (untrusted users blocked)     │
│  4. Blocked tools (channel-level blacklist)              │
│  5. Restricted tools (untrusted user blacklist)          │
│  6. Confirm tools (preview before execution)            │
└───────────────────────┬─────────────────────────────────┘
                        ▼
┌─────────────────────────────────────────────────────────┐
│  [8] CONVERSATIONAL GUARD                               │
│  Prevents pipeline misroutes mid-conversation:          │
│  "What do you think about performance?" ≠ research      │
│  Only explicit task intent breaks through the guard     │
│  Skipped for console/extension (browser control needs   │
│  the router's classification to stick)                  │
└───────────────────────┬─────────────────────────────────┘
                        ▼
┌─────────────────────────────────────────────────────────┐
│  [9] DISPATCH DECISION                                  │
│  • No tools → bare chat (direct LLM, no loop)           │
│  • research / heartbeat → deterministic pipeline        │
│  • Everything else → arena (open ReAct tool loop)       │
└───────────────────────┬─────────────────────────────────┘
                        ▼
                  Specialist Execution
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
| "Make a PDF report" | `research` | Model classified report generation as `multi` or `chat` |
| ~~"Go to [site]" + domain~~ | ~~`multi`~~ | Deleted 2026-09-26. It predates `web_search` holding `browser`; it contradicted the doc and the Laya labels (browse-a-named-site = `web_search`) and hijacked chained requests into `multi` before either router saw them. The descriptions decide now; the keyword fallback for browse phrasing says `web_search` |
| "Research/analyze" + "stock/market/trend" | `research` | Model classified research requests as `web_search` |

**The principle:** Pre-model overrides only exist for patterns where the model has proven unreliable. Every override was added because of a real misclassification observed in production. We don't override everything — just the cases with a documented history of failure.

---

## Layer 3: Sticky Routing

Multi-turn conversations should stay in the same category. If you're chatting about cooking and ask "what about chicken?", that should stay in `chat`, not route to `web_search` because the model sees a question.

**How it works:**
- Sticky categories: `chat`, `memory`, `briefing` (replies are answers, target `chat`), and `cron`. Most pipeline categories (web_search, exec, research) finish in one turn — no sticking needed.
- `cron` is sticky because post-scheduling follow-ups ("did we do all three?", a re-paste of jobs that didn't get created) belong back in the cron pipeline, whose list branch answers from `cron_list` — without it, "did we do all three?" routed to memory and confabulated from a saved fact (July 20 incident).
- Short follow-up messages stay on the previous category.
- Long messages (>200 chars) also stay sticky — they're likely continuing a discussion.

**What sticky cannot know (2026-09-26):** sticky keeps the previous turn's *category*, not its *state*. "Awesome." after "Done — you'll get a Discord DM Tuesday" is an acknowledgment (chat); "yes do it" after "Want me to set that up?" is a confirmation (cron). The 30-char heuristic sends both to cron. In the shadow log, sticky is the live router's main leak (3 of the first 8 disagreements; Laya right on all 3). A System-One router given `{previous_category, assistant_last_reply, message}` as state makes the distinction zero-shot — probed live against v3: "yes do it" chat 0.28 bare → cron 0.95 with state; "Awesome." after "Done" stays chat. That is the shape of the planned v4 fine-tune: the model that replaces phi4 replaces this layer in the same move.

**What breaks through sticky:**
- Imperative commands: "search for X", "create a report", "run this command"
- Greetings: "hi", "hey", "hello" — starts fresh classification
- New-topic signals: "search the web for", "look up", "find me a"
- Keyword matches that point to a different category than the current one. Keyword patterns that can break sticky need pre-model-override precision — plain `\bsetting\b` matched "setting up a business" and hijacked a reminder paste, so the config pattern is now `settings?(?! up)`.

**Why sticky exists:** Without it, every message mid-conversation gets re-classified independently. "What do you think about the trade-offs?" during an AI discussion gets classified as `research` because "trade-offs" sounds analytical. Sticky keeps the conversation flowing.

Note: sticky routing governs *classification* (which category the message lands in) and is independent of *dispatch type* — whether that category then runs as an arena ReAct loop or a deterministic pipeline is decided separately at Layer 9.

---

## Layer 4: Model Classification

If pre-overrides and sticky routing don't apply, the router model classifies the message.

**Model:** `router.model` — phi4:latest on the 3060 utility box (the `:14b` tag does not exist there; a stale tag cost one fact extraction to a 404 on 2026-09-19)
**Temperature:** 0.1 (very low — same message should always produce the same category)
**Output:** Single word — enum-grammar-constrained via `format` when the backend supports it (the model physically cannot emit an invalid category); plain generation + sanitize otherwise
**Latency:** ~200ms warm; up to several seconds when the gateway has evicted the model
**Timeout:** `router.timeout` is ENFORCED (July 2026) — a hung/dead backend costs exactly the configured budget before keyword fallback, not the HTTP client's retry loop (~12s). The abandoned request's result is discarded.

The prompt is intentionally minimal. It lists the configured categories (12 since the 2026-08-10 trim) with one-line descriptions and asks for exactly one word back. **Those descriptions are the router's whole world** — when `personal` was retired, nothing said where Gmail and Calendar lived, and "check my email" went to `chat`/`memory`/`cron` six times out of six until the `multi` description said so (2026-09-25). The model doesn't see conversation history, tools, or system context — just the message and the category list.

**Why phi4:** Fast classification at 200 tokens per decision. Few-shot capable — understands category descriptions. Dense model — no thinking overhead. The router doesn't need reasoning, it needs pattern matching at scale.

**12 categories (three retired, kept for the record):**

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

Browse-a-named-site ("go to meetup.com and find tech events") is `web_search`, not `multi`: `web_search` holds the `browser` tool now, and the router's own rule is *match the capability*. The historical `multi` label for those dates from when only `multi` had the browser — which is exactly the kind of drift a training set collected from the router's own past decisions inherits (see the shadow section below).

---

## Layer 4b: Shadow Router (observation only, 2026-09-25)

A second classifier answers the same question on every message and **never decides**. `router.shadow { enabled, url, timeoutMs, logPath }` points at a System-One decision server (`/v1/systemone`, TypeSafe Jev's wire protocol, served locally by Laya): state = the message, one typed `choice` question whose options are `router.categories` descriptions **verbatim** — the option text is model input, so the checkpoint is trained on exactly that string and config is the single source for both sides.

The hook wraps `classifyMessage` (`src/router/shadow.ts`), so the shadow is compared against whatever actually decided — override, sticky, model, keyword, or fallback — and it is fire-and-forget with a hard bound: it never changes the result, never delays it, and a dead server costs one warning. Every message appends `{ts, preview, decided, decidedBy, shadow, confidence, top, ms}` to `data/router-shadow.jsonl` and prints `[RouterShadow] live=… shadow=… AGREE/DIFFER` with a running agreement rate.

Why it exists: a 421M Laya encoder fine-tuned on the owner's own routing history scored **80.8% vs phi4's 76.9%** on the corrected held-out set at **63ms vs 270ms** (90.8% vs 80.0% weighted by real traffic). **Readings so far (66 messages, 2026-09-26):** 88% agreement, p50 185ms over HTTP; Laya right on 5 of 8 disagreements, wrong on 2 (the `data … research` keyword-override class at 0.96 — the training gap — and one `memory` call at 0.49), one toss-up. Every agreement scored ≥ 0.92 and the two clearly wrong model-layer calls were the only rows under 0.9 — the first real-traffic sign the probability could gate. Plan: observe through the week, likely a v4 fine-tune (with state, see Layer 3) before any switch.

**A System-One decision model as router (2026-09-25).** Jev/Laya-style models take state plus a typed question and return a calibrated choice in one forward pass — nothing generated, nothing to parse. A 421M Laya encoder fine-tuned for 55 minutes on this Mac, on 1,248 cleaned real routing pairs plus 777 round-trip-validated synthetic ones, scored **80.8% vs phi4's 76.9%** on the corrected held-out set at **63ms vs 270ms** (90.8% vs 80.0% weighted by real traffic). It runs in **shadow mode** — `router.shadow` asks it the same question beside phi4 on every message and logs both; phi4 still decides. A disagreement rate on real traffic, not a 78-item eval, is what earns the switch. Full write-up with the disproven parts (zero-shot is useless; the confidence-gated hybrid lost) in [DECISIONS.md](DECISIONS.md).

A 78-item eval is not a reason to change routers; an agreement rate on the real distribution — and, on the disagreements, which one was right — is. Full method, the dataset cleaning (the collected pairs were phi4's own decisions, not truth), the synthetic-data round-trip filter, and what was disproven (zero-shot; the confidence-gated hybrid) are in DECISIONS.md, "A 421M Encoder Out-Routes phi4".

---

## Layer 5: Keyword Fallback

When the model fails, times out, or returns an invalid category, regex patterns take over.

**Order matters.** Specific patterns match before broad ones. This prevents "search for docker commands" from routing to `web_search` instead of `exec`.

```
Priority order (first match wins — 21 patterns, `KEYWORD_HINTS` in classifier.ts):
  1. Document formats (pdf, xlsx) → multi
  2. Research requests (with explicit markers) → research
  3. Compound actions (search + save) → multi; browse-a-site phrasing → web_search
  4. Heartbeat management → cron
  5. System commands (npm, git, sudo, ls) → exec
  6. Task management (todo, kanban) → task
  7. Scheduling (remind, cron, daily) → cron
  8. Memory recall (remember, last time) → memory
  9. Messaging (send, notify) → message
  10. Fetch-this-page phrasing → website
  11. Search (google, look up, news) → web_search  ← broadest
  12. Image generation verbs → image
  (config/settings → `config` was removed with the category, 2026-08-10)
```

**What we removed from keywords:** "what is" and "who is" used to trigger `web_search`. But "what is the meaning of life?" is a chat question. Removing these broad patterns reduced false keyword matches significantly. Also removed (July 2026): bare `workspace` from the config pattern — it captured exec requests like "run ls in the workspace". Added: `ls`/`pwd`/`chmod` to exec hints, and live-value lookups ("current price of X") → `web_search` (previously fell to the chat default, answering stale).

---

## Layer 6: Default

If nothing matches: `chat`. The safest default — the chat specialist can handle most things conversationally, and if it can't, the silent re-route (post-dispatch) catches it.

---

## Layer 7: Security Filtering

After classification, six security gates filter what a user can do. These run in order, each narrowing permissions:

```
Layer 1: allowedCategories
  └── Channel whitelist. A public Telegram channel might only allow chat + web_search.
      Category not in the list → downgraded to chat.

Layer 2: ownerOnlyTools
  └── CODE GATE. Owner-only tools (exec, gmail, calendar) are completely
      invisible to non-owners. The model never sees them in the tool list.
      Not a prompt instruction — a code-level filter before the model runs.

Layer 3: restrictedCategories
  └── Untrusted users can't access these categories at all.

Layer 4: blockedTools
  └── Channel-level tool blacklist. Everyone on this channel loses these tools.

Layer 5: restrictedTools
  └── Untrusted users on this channel lose these specific tools.

Layer 6: confirmTools
  └── Preview before execution. The previewed call is recorded in the
      pending-action ledger; "confirm" executes the STORED params —
      sender-bound, single-use, 10-min expiry. Never a model-regenerated
      call. Applies to pipeline dispatches too (was a bypass until July 2026).
      Effective set = channel confirmTools ∪ tools whose autonomy metadata
      declares propose_confirm − channel autoApproveTools (promotion lever).
```

**The owner-only gate is critical.** It's not a prompt telling the model "don't use exec for non-owners." The tools are stripped from the model's vocabulary entirely. The model can't use what it can't see. You can't prompt-inject past a code gate.

---

## Layer 8: Conversational Guard

The most nuanced layer. Prevents pipeline misroutes when a user is mid-conversation.

**The problem:** You're discussing AI model architectures. You say "what do you think about the performance improvements?" The router classifies this as `research` because it sees "performance" and "improvements." Without the guard, your casual question triggers a full research pipeline with parallel searches and chart generation.

**How it works:** If the message is classified as a non-chat category but the session has prior turns and the message has no explicit task intent, downgrade to `chat`.

**What breaks through the guard:**
- Explicit task commands: "search for X", "create a report", "generate an image"
- Pre-model overrides (already classified before guard runs)
- First messages (no session history)
- Cron jobs (autonomous, no conversation context)
- Console/extension messages (browser control needs direct routing)

**What it catches:** Everything the model gets wrong mid-conversation. "Tell me more about that" classified as `message`. "Can you explain the research?" classified as `research`. "What's the latest on this?" classified as `web_search`. All correctly downgraded to `chat`.

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
│ system heartbeat │     │ Code controls the workflow    │
│                  │     │ LLM fills params, synthesizes │
└─────────────────┘     └──────────────────────────────┘

┌─────────────────┐     ┌──────────────────────────────┐
│ Everything else  │────▶│ Arena (open ReAct tool loop)  │
│ (multi, exec,    │     │ Model decides what tools to   │
│  web_search,     │     │ use and in what order —       │
│  chat, cron...)  │     │ natural stop, session history │
└─────────────────┘     └──────────────────────────────┘
```

Since the arena rollout (fleet-wide 2026-08-21), the open ReAct loop is the default dispatch: `multi`, `exec`, `web_search`, `cron`, `task`, `memory`, `message`, `website`, and `code_gen` all run `dispatchMode: "arena"` — same 6 security layers and confirm ledger, no staged workflow. The plan pipeline (LLM decomposition for `multi`) was retired from dispatch at the same time. Deterministic pipelines remain only where determinism pays: `research` (claim verification + PDF render) and the system heartbeat.

**The principle:** If the workflow is predictable (search → fetch → synthesize), use a pipeline. If the workflow depends on what the model finds (open-ended conversation, calendar queries, image generation), use ReAct.

---

## Post-Dispatch: Silent Re-Route

After the specialist produces a response, one more safety net runs.

If the chat specialist says "I don't have access to search the web" or narrates a tool call without actually executing it, the system detects the capability gap, re-classifies the message, and dispatches to the specialist that has the right tools — silently, without the user needing to rephrase.

This catches the long tail of misclassifications that none of the other layers caught. The chat specialist admits it can't help, and the system automatically finds the specialist that can.

A `_reRouted` flag prevents infinite loops — if the re-routed specialist also fails, it stops.

---

## Special Routing Modes

### Browser Control (Chrome Extension)

When the Chrome extension is connected, console channel messages get special treatment:
- Runs on the foreground model (`defaultModel`) — multi-step browser tasks need the big model
- Pipeline is stripped (forced ReAct — browser control is inherently reactive)
- web_fetch tool is removed (forces the browser tool for navigation)
- Max iterations bumped to 20
- System prompt replaced with browser-specific instructions
- Conversational guard is skipped (router classification needs to stick)

### Cron Jobs

Cron jobs dispatch with an explicit category override and `cronMode: true`. Cron mode strips write tools (write_file, task_add, memory_save) so automated tasks can't modify state without human approval. Additionally (July 2026): `exec` and `send_message` are only available when the job was explicitly scheduled as that category — the owner-authored schedule is the code gate. A web_search cron job whose fetched page contains an injected "run this / message X" instruction has no tool to reach for.

### Smart Model Routing

For trivial greetings ("hi", "thanks", "cool"), a lighter model — `router.quickModel`, unset = no fast path — handles the response. No need to wake the foreground model for "hello." This is a latency optimization, not a routing change — the message still goes to `chat`, just with a faster model.

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
[Router] Pre-model override: "https://reddit.com/..." → website
[Router] Sticky: "what about the pricing?" → chat (follow-up)
[Dispatch] Category: web_search (model)
[Dispatch] Category: chat (override)
[Dispatch] Conversational guard: research → chat (no task intent, turn 3)
[Dispatch] Browser control mode → guided ReAct
[Dispatch] Silent re-route: chat gap detected → web_search
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
When the chat specialist admits it can't do something, the system re-classifies and dispatches without the user needing to rephrase.

**8. Not everything needs a pipeline.**
Browser control failed as a deterministic pipeline but works as guided ReAct. If the workflow is unpredictable, let the model react. If it's predictable, use a pipeline. Don't force one pattern on everything.

---

**9. A router's training data is its own past decisions unless you clean it.**
`data/training/router-pairs.jsonl` recorded `{message, category}` as routed — phi4's labels, not truth — plus 85 pipeline handoffs and `[SYSTEM]` notices no human typed. Re-labeling under the *current* prompt, ruling on the disagreement patterns, and round-trip-validating synthetic examples was most of the work of beating the incumbent. Even the hand-labeled eval set had rotted as category definitions moved (2026-09-25).

---

*Invarail is an open-source local-model-first AI agent framework. The routing system described here handles ~75 tools across 12 categories — arena dispatch fleet-wide, two deterministic pipelines — all running on personal hardware.*
