# Working Notes: What Six Months of Building Agents Actually Showed

*A brief for Peter's own synthesis. This document reports what happened and what claims are on the table. It deliberately draws no conclusion — where an argument appeared in our conversations, it is labeled as a claim, not a fact. The evidence citations are your own artifacts.*

---

## 1. What was built, and what happened to it

**LocalClaw** (Feb–Aug 2026): a local-first agent system on small models (7-30B), built on the principle "code decides, model executes." It grew: a router with four fallback tiers, thirteen deterministic pipelines, a six-layer security stack, a confirm ledger with grants and buttons, dual-backend memory, three self-improvement stores (skills, lessons, error learning), an MCP bridge, and a research pipeline with claim verification.

**FlowMCP** (born July 31 from a LinkedIn post about tool sprawl): a standalone MCP server where each tool is one deterministic workflow. It grew, mostly autonomously via a Claude Code instance: a benchmark, a trace-to-flow compiler, a detection layer that nominates flows from usage logs, a registry with promotion states, and a shadow-verification harness. Published to npm as v0.7.

**The measured result that anchors everything** (your benchmark, frozen tag `bench-2026-07-31`, McNemar-tested): a small model given ~40 primitive tools completed 10% of tasks; the same model given a handful of workflow tools completed 79%. A 7B model on the workflow surface beat a 35B model on the primitive surface.

## 2. The failure record (from DECISIONS.md, condensed)

Patterns that repeated, regardless of which subsystem they appeared in:

- **Hand-authored workflows needed continuous repair.** Every pipeline written by hand required patches when reality touched it: sentence-splicing broke on URLs, then on decimal numbers; the exec pipeline swallowed tool requests; the plan pipeline's reflection padded broken plans past safety checks.
- **Learned behavior captured requests it shouldn't have.** The skill system hijacked three explicitly-worded requests in one evening, and grew *stronger* from runs it derailed (success credit + trigger append on fallback runs). Fixes were possible, but each was another gate.
- **Parallel code paths drifted apart.** The confirm-result path lacked, at different times: correct reply anchoring, media extraction, and continuation context. Three parity bugs on one seam in one week.
- **The single compiled workflow never needed maintenance.** `weekly_gather` — improvised once by a model, compiled from its trace, governed by a registry — ran in production without a single internal tweak. Its one failure (a padded argument, a wrong working directory) was at the *boundary*, and boundary fixes were one-time.
- **Small models failed fast and legibly; that was the debugging method.** Nearly every architectural lesson arrived the same evening as the mistake, via the live log.

## 3. Usage data (metrics.jsonl, Feb 22 → Aug 8; 28,345 events)

Last 30 days of dispatches: chat 179, image 21, exec 18, web_search 12, research 10, multi 7, memory 6; everything else ≈0. The task system: 568 uses all-time, zero in 30 days. Four channel adapters: zero sessions ever. The explicit memory-search tool: 1,873 calls all-time, one in the last month (automatic injection replaced it). The daily value as-lived: chat with memory on two channels, image generation, one verified weekly research report, briefings and reminders.

Separate decision already made on principle, not usage: WhatsApp (active daily) is being removed because it answered messages *as* Peter. The line drawn: an agent you talk to is an assistant; an agent that talks as you is impersonation.

## 4. Positions on the table

Each stated in its strongest form. None adjudicated here.

**A. Hand-authored determinism.** Workflows should be written by engineers as code; models fill parameters and synthesize. *For it:* the research pipeline — the most complex hand-built artifact — produces verified reports and caught a fabricated model release via independent cross-check. *Against it:* the failure record above; the maintenance cost never declined; each workflow is a standing repair obligation.

**B. Model-as-orchestrator.** Give a capable model many tools and let it decide the workflow. This is the current enterprise default (Copilot, Agent Studio, connector ecosystems). *For it:* it rides model improvement for free; distribution has already won; frontier models increasingly cope with large tool surfaces. *Against it:* your benchmark's 10%; every live failure this month happened precisely where the model decided the workflow; a claim made in conversation — that enterprise adoption reflects bundling rather than architecture working — is plausible but unproven.

**C. Grown harnesses (the FlowMCP loop).** The model improvises a solution once, expensively; a trace is captured; a compiler emits a deterministic workflow; a registry governs promotion; usage signals trigger recompilation. Humans build the substrate, not the workflows. *For it:* the one artifact from this loop was the one maintenance-free artifact; the compiler, detection, and registry all exist and work. *Against it:* sample size is one; the loop has only compiled a read-only gathering task; nobody has yet grown a workflow with side effects through it.

**D. Ungoverned self-modification.** (Prime Intellect's "Prime Agent," published Aug 2026.) The agent's own prompts, skills, memory, and sub-agents are objects it edits live; a `/refine` step reads its trajectories and patches its own harness. *For it:* 95.5% on ARC-AGI 3 exceeding a human-expert baseline; strong results with fewer tokens; treats harness design as something models can learn. *Against it:* no audit story — the scaffold that approved an action can be rewritten by the thing it governs; demonstrated on frontier-class and 744B-class models, not small ones.

**E. The bitter-lesson objection.** Scaffolding encodes yesterday's model's weaknesses; capability growth deletes hand-built structure; betting on harnesses is betting against scaling. *For it:* the history of ML (features, parsers, pipelines — all flattened by scale); parts of LocalClaw already died this way (context-rationing caps that rotted into bugs when the model got bigger). *Against it (a claim from conversation, not a proof):* capability may delete the *competence-compensation* layer while leaving the *governance* layer (authorization, audit, provenance, locality) untouched, because governance serves the principal's needs, not the model's limits. Where each piece of the current harness falls on that line has not been formally sorted.

**F. Convergence as validation — or as commoditization.** Flyte v2 (workflow engines, from the data-infrastructure side) and Prime Agent (self-modifying harnesses, from the frontier side) both landed near positions this project reached independently. One reading: the thesis is confirmed from both flanks. Another reading: if funded teams arrive at the same place, the individual's version has no moat except evidence, writing, and specific niches (local, governed, small-model). Both readings can be true simultaneously.

## 5. Facts about position, stated plainly

- One person, employed elsewhere, operated three AI instances as staff for a month and produced: a published npm package, a frozen benchmark, a working reference system, and a several-hundred-entry decision log. This throughput is itself a datum about AI leverage.
- The individual's structural advantages, as observed: small-model constraint (fast honest feedback), an evidence culture (decisions recorded with receipts, including disproven theories), no institutional inertia.
- The individual's structural disadvantages: no distribution, no capital, one person's maintenance bandwidth — the failure record in §2 is partly a bandwidth story.
- The salvageable assets are independent of any decision about LocalClaw: FlowMCP (published, self-sufficient), the benchmark (citable), the DECISIONS corpus (unique raw material for writing), the working knowledge (employable).

## 6. Open questions — for your synthesis, not mine

1. Which pieces of the harness govern the model (authorization, audit, provenance) and which apologize for it (repair prompts, drift detection, description curation)? Does that line actually predict what survives model improvement?
2. Does the grown-harness loop (C) work for workflows with side effects, or only for read-only gathering? What would the first consequential compiled flow be, and what promotion gate would you demand?
3. Is the enterprise 10%-architecture moment a market that will come to you, or a tide to stop fighting? What evidence would distinguish those within a year?
4. What is the minimum system that serves your actual usage (§3) — and is maintaining anything beyond that minimum a research activity, a content activity, or a habit?
5. If the leverage finding (§5) is the real result, what's the highest-value use of the *next* month of it: slimming a system, growing the loop, client work, or writing?

*No conclusion follows. That part is yours.*
