# Invarail Roadmap

Invarail is a local-model-first AI agent framework running on personal infrastructure (DGX Spark for coding, a 24GB A5000 for the foreground model, a 3060 utility box, and two Mac minis — one embeds, one runs Invarail itself plus the Laya shadow router and the mlx-audio voice server). It handles Discord, Telegram, and Web (plus the Chrome extension and read-only Gmail tools) with a Router + Specialist architecture — arena (open ReAct) dispatch fleet-wide, deterministic pipelines only for research and the heartbeat. Foreground reasoning runs on qwen3.8:27B on a 24GB A5000 (Ollama-native), set by a single root `defaultModel` config line that fills all specialist/briefing/heartbeat/vision slots (a swappable foreground slot — previously glm-5.3-flash, DeepSeek-V4-Flash, MiniMax-M2.7); glm-5.3-flash on the Spark keeps coding; the utility tier (phi4:latest router/extraction, phi4-mini NER) runs on a 3060 and the embedder on a Mac Mini, all routed by a `MultiBackendClient`; voice replies run on the foreground model through the lean voice flow (`config.voice`). ~45 built-in tools plus MCP servers, FalkorDB graph memory with epistemic provenance and continuous capture (or the flat/vault tiers on a smaller box), autonomous heartbeats and briefings, a System-One shadow router. On a single small box the measured recommendation is qwen3.5:9b (36/36 on the front-door battery, `evals/2026-09-e2e/`). 1205 tests across 140 files; CI on Linux and Windows.

---

## Completed

- **Setup Wizard** — Interactive `npm run setup` with prerequisites check, model detection, channel security, heartbeat config, and complete production-ready config generation. Rebuilt detect-first 2026-09-27: environment probed before any question, installed models ranked by measured eval score + VRAM/RAM fit (`src/setup/measured-models.ts`), `promptProfile: "small"` written for a ≤14B foreground, sidecars (FalkorDB, SearXNG) offered with a default of yes, system software named with its install command and never installed unasked; `npm run doctor` checks what the config enables (also on the console dashboard)
- **FalkorDB Graph Memory** — Replaced flat JSONL with graph database. HNSW vector search, entity linking, SUPERSEDES chains, multi-hop traversal, bootstrapped NER, canonical entity normalization, importance-scored auto-injection
- **Analytics Pipeline** — Upload CSV/Excel/JSON → pandas computes all numbers → matplotlib charts → LLM executive interpretation. Code handles "what", model handles "so what". *Retired 2026-08-10 with the `analytics` category: data-file uploads route to `exec`, and `code_session` covers pandas work on request*
- **Thinking Preservation** — Raw model output stored in transcripts for continuity across turns. Stripped only at display boundaries. Handles Qwen and Gemma 4 formats
- **Gemma4:26b for Chat** — MoE (3.8B active), replaced qwen3.5:9b which had self-prompting artifacts. *Since superseded by the single `defaultModel` foreground; qwen3.5:9b (think off) came back as the measured small-tier recommendation in September*
- **Website Specialist** — URL pre-model override, web_fetch → browser fallback for JS-heavy sites
- **Context Compaction** — Budget-aware structured compression with memory flush and summary prefix
- **Observation Summarization** — LLM-based summarization for old tool observations instead of hard truncation
- **Non-streaming Message Splitting** — Long responses split correctly on all code paths
- **Conversational Guard** — Lightweight length-based guard for short ambiguous messages. Replaced keyword-based task intent matching (too fragile). Speculative language ("I wonder", "what if") routed to chat via pre-model override
- **Chrome Extension** — Browser companion side panel (WXT + React + Manifest V3). Content script extracts page context, streams to Invarail via existing Web API. Right-click context menus. Works cross-network (extension on Windows, Invarail on Mac Mini)
- **Browser Control** — Remote browser bridge: model calls browser tool → extension executes DOM actions on user's real Chrome tab. Screenshot + vision for JS-heavy sites. Guided ReAct with action dedup (deterministic pipeline attempted and reverted — documented in DECISIONS.md)
- **Memory Decay + Contradiction Eviction** — Automatic confidence decay by importance tier. Contradiction detection on addFact() via phi4-mini. Human-in-the-loop fact review via heartbeat
- **Token Economics Monitoring** — Capture eval_count/prompt_eval_count from Ollama responses, log per dispatch
- **LLM-as-Judge Quality Scoring** — Post-dispatch quality check for pipeline categories, scores to JSONL
- **Security Hardening** — Path traversal fixes (relative() check), scoped tool executor, session agentId sanitization, Telegram allowFrom, web API warning
- **Orchestrator Decomposition** — 2,019 → 1,347 lines. Extracted: heartbeat service, briefing service, rate limiter, media debouncer, command router, text utilities, media extraction, training collector
- **Latency Optimization** — Parallel memory + router (800-1500ms saved), turn-count-gated async compaction with prewarm, tool-loop streaming with status events, web-fetch page caching, expanded pre-model overrides
- **Routing Test Corpus** — 363 tests covering pre-model overrides, keyword fallback, sticky routing, speculative language, security, search buckets
- **Media Burst Handling** — Vision queue (sequential, not parallel), 3-second media debounce, video file path, rate limiter adjustment
- **Multi-Backend Inference (vLLM)** — MultiBackendClient routes by model id; DeepSeek-V4-Flash on vLLM (OpenAI-compatible) for foreground reasoning, Ollama gateway for small/modality models. OpenAICompatClient handles the format translation (incl. reserving reasoning headroom on max_tokens so short stages don't return empty). Per-specialist contextSize; 256K context. Foreground model is a swappable config slot — was MiniMax-M2.7 before.
- **Memory Integrity** — Importance-aware FactStore char bound (never evicts imp 4-5), graph provenance edges (EXTRACTED_FROM + SUPERSEDES) wired.
- **Search Source Buckets** — Topic→curated-domain buckets with anchors; real_estate + civic (NYC/NY Open Data); web_search freshness forcing + recency-aware quality judge; over-trigger fix.
- **Small-Model Hardening (July 2026)** — One tool-calling convention per model (`toolStyle`, native default — halves fixed prompt overhead); grammar-constrained decoding (`format`/guided_json) for extraction, branching, router, claim extraction with automatic fallback; extraction degrade-not-abort (JSON5, post-parse validation, deterministic fallbacks); research correction as code-driven sentence splice; memory injection relevance floor (0.55) + caps; real-prompt context budgeting; enforced router timeout; tool-loop bug batch (scaffolding leak, sanitizer corruption, dedup double-push, empty-completion retry, hallucination false-positives). Live-verified on real phi4 + qwen3.6:35b (`scripts/*-live-check.ts`). See DECISIONS.md July 5-6.
- **Bounded-Autonomy Gates (July 2026)** — Pending-action ledger (confirmations execute the exact previewed call: sender-bound, single-use, expiring; closes the pipeline + console bypasses); tool `autonomy {tier, reversible, blastRadius}` metadata with `autoApproveTools` per-channel promotion; cron category-conditional exec/send_message; heartbeat stale-fact deletion demoted to propose-and-confirm; `autonomous_action` metrics as the promotion track record. First rungs of the autonomy ladder — structural, code-enforced.
- **SearXNG Integration** — Self-hosted meta-search on the LAN is the web_search provider in the reference build (replaced Brave; the schema default provider is still `brave`). Outbound calls paced, plus a daily query ceiling (`dailyQueryCeiling`, the wizard writes 250) — see SEARXNG.md
- **MCP Client Bridge (July 2026)** — stdio + streamable-HTTP transports, zero-dep client, small-model translation layer, DCR OAuth (no broker), SecretStore
- **Proactive Actions — Ladder Complete (July 2026)** — Ledger + buttons (Discord/Telegram) + deny + continuation-after-confirm + target-bound standing grants (`always <id>`, `!grants`) + auditable cron run sessions/artifacts + approval/resource metrics columns
- **Skill System (rebuilt July 2026)** — Semantic matching (measured 0.65 floor), triggers frontmatter, save-time dedup judge, skill_find progressive disclosure. Guards added Aug 2026: explicit-tool-mention override + no-credit-on-fallback (self-reinforcing hijack class). *Retired 2026-08-10; successor: graph experience memory — experience informs execution, never expands authority*
- **FlowMCP Integration (Aug 2026)** — [FlowMCP](https://github.com/PeterGreenAppliedAI/FlowMCP) (Peter's workflow-first MCP server) as first real bridge consumer: compiled `weekly_gather` flow powers research-pipeline flow-first gathering (4s vs minutes) behind an explicit-naming code gate; verified live with a fabrication caught by verification
- **Arena Fleet-Wide (2026-08-21)** — cron, task, memory, message, website, web_search, exec, code_gen, multi all run `dispatchMode: "arena"`: open ReAct loop, session history, natural stop, same 6 security layers + confirm ledger. Plan pipeline retired from dispatch after the measured duel; deterministic pipelines remain only for research + heartbeat
- **SIP Live (2026-08-22)** — Self-modification in production: heartbeat drafts `!improve` specs from recurring tool errors → pending-action ledger, two owner confirms (attempt + merge, denial permanent), Pi implements in isolated worktrees, merge gate = tsc + full vitest + Tier-3 protected paths, supervised deploy with health-check + rollback, `!improve retry` re-gates after rebase
- **GLM Cutover (2026-08-26)** — glm-5.3-flash on vLLM (262K ctx) as the foreground model, configured by one root `defaultModel` line filling all specialist/briefing/heartbeat/vision slots. qwen3.8-27B/SGLang retired 2026-08-26; DeepSeek-V4-Flash/ds4 retired 2026-08-16. *Foreground since moved to qwen3.8:27B Ollama-native on the A5000 (2026-09-19); glm-5.3-flash stays on the Spark for coding*
- **Coding substrate Phase A + measured foundations (Aug–Sep 2026)** — Pi SDK adapter with lifecycle observability · the published 39-row engine-in-the-loop model eval (`evals/`) · per-stage thinking control with boot-time capability validation · evidence gates and research claim verification with Tier-1 cross-checks · the personal web index (local-first research) · the Lessons system · SGLang foreground cutover with real continuous batching (since superseded by the A5000/Ollama cutover, 2026-09-19)
- **Email Steward (2026-08-29)** — Read-only email triage (no send capability exists): fast lane (support alias/VIP, 15-min poll, immediate ping), watch lane (owner-chosen bulk senders → heartbeat digest), judged lane (one constrained model judgment). Opt-in via `emailTriage`
- **Memory Tiers (2026-09-27)** — `memory.backend` = `graph` | `flat` | `vault` beside the legacy `markdown` (graph if it answers, else flat); `embeddingModel: "none"` runs memory with no embedder; `vault.okf` puts the Obsidian-editable vault on the Open Knowledge Format (facts mirrored as notes with provenance, `index.md`/`log.md`, `docs_read`); `npm run vault:okf` converts an existing folder in place (report first, `--apply` to write)
- **Front-Door e2e Harness (2026-09-27)** — `scripts/e2e-eval.ts` (modules in `scripts/e2e/`) runs a wizard-generated config through `dispatchMessage` with the real registry, stores and pipelines, web stubbed over a fixed corpus, code oracles only; `--selftest` runs in CI; the harness is type-checked by `npm run typecheck` (`tsconfig.scripts.json`). Found the one-model reload and the thinking-router bugs before it could score anything
- **Security Review Fixes (2026-09-27/28)** — the web token is the owner's credential (a client-sent sender id only partitions sessions); code sessions run inside the Docker sandbox and fail closed; a requested-but-missing sandbox means no exec at all; REPL sessions owned per principal
- **Windows in CI (2026-09-28)** — a blocking `windows-latest` job: typecheck, the full suite, the e2e selftest, headless wizard smokes whose generated config must parse, console build; Node supervisor port (`npm run supervise`). Tested in CI, not yet a supported install
- **Routing Levers (2026-09-29)** — default category descriptions say what each specialist *cannot* do, and a specialist reroute (`router.reroute`, default on) gives one re-dispatch when an arena answer claims or ends announcing an action whose tool the specialist lacks. Two-specialist requests 18/30 → 30/30; full three-rep battery qwen3.5:9b 36/36, gemma4:12b 36/36, qwen2.5:7b 30/36. A `handoff` tool was built, measured harmful, and removed

---

## Next Up

| Priority | Feature | Description |
|----------|---------|-------------|
| **Now** | **Setup that detects, not asks** | `npm run doctor` + the wizard's detect-first flow landed 2026-09-27; since then the doctor is on the console dashboard (`GET /console/api/doctor`) and CI runs headless wizard smokes (Windows) plus the e2e selftest. Next: a fresh-clone CI smoke that boots against a stub model, and a `bin` entry (`npx invarail setup/doctor/start`) |
| **Now** | **Shadow router → `router.backend` switch** | Laya v3 logged beside phi4 on real traffic (`data/router-shadow.jsonl`). Decide on the disagreement rate + who was right on disagreements over a few days (66 msgs in: 88% agree, Laya right 5/8). Likely a **v4 fine-tune with state** (`{previous_category, assistant_last_reply, message}` — replaces sticky routing too) before any switch. Then: additive `router.backend: "systemone"` with keyword fallback; move the server to the Mini (needs Remote Login); same recipe for the steward's `needsPeter` |
| Next | **Memory synthesis pass** | Heartbeat-time "so what" over entity clusters as `(:Synthesis)` nodes with `provenance: inferred`, structural DERIVED_FROM edges, short expiry. Designed; NOT built — gate (`scripts/memory-cluster-check.ts`) failed on 24 facts. Re-run after capture has fed the graph a few weeks |
| Next | **Repo manifest + generalized merge gate** | Extend SIP beyond the Invarail repo: per-repo manifest, generalized merge gate, draft-PR path (DECISIONS: "The Factory") |
| Next | **GitHub intake cron** | Scheduled intake of GitHub work items feeding the factory loop |
| Next | **Rework loop** | `selfMod.reworkIterations` — bounded re-attempts when a SIP change fails its gate |
| Next | **Ladder promotions on track record** | Promote action types up the autonomy ladder based on the `autonomous_action` metrics record |
| Next | **Semantic flow proposal** | Floor-gated similarity check that PROPOSES a matching gathering flow for a research topic (asks, never silently selects) — the rung above strict naming |
| Next | **Firecrawl integration** | Self-hosted web fetching between web_fetch (basic) and browser (heavy). Handles JS rendering without full Chromium |
| Next | **Blender MCP demo** | First real MCP consumer: `uvx blender-mcp` + Blender on the Mini; then MCP self-service setup (agent proposes+validates server config, confirm-gated) |
| Next | **Config-not-code Phase 1** | A machine-writable, code-clamped overlay for all model-shaped tuning (per-backend concurrency, budgets, think policy); Phase 2: evidence-driven self-tuning proposals on the confirmation ledger |
| Planned | **Coding substrate Phase C** | Falkor experience briefs into Pi sessions; post-session harvest (events → graph); memory verified only by the merge gate's own validation event |
| Planned | **Weekly research newsletter** | Cron-scheduled verified research digest with flow-powered gathering |
| Planned | **Self-wake** | `sleep_until`/`wake_on` tools with quotas (max pending, min interval, cronMode-filtered resume) — continuation machinery landed July 25 |
| Retired | **Gateway passthrough** | The gateway left the inference path 2026-09-19 — every host is Ollama-native direct (A5000, 3060, Mini) or vLLM direct (Spark). GATEWAY-REQUIREMENTS.md stays as the contract if a gateway returns |
| Planned | **Cross-channel sessions** | Map user IDs across channels to shared sessions (Slice 3 — principal layer landed; dragons documented in CONTINUATION.md) |
| Done | **Rebrand** | LocalClaw → Invarail (the plan mapped 357 references across 80 files). Carried on purpose: the pre-rename graph name `localclaw_memory` for history |

**Horizon** (see DECISIONS.md): dsh adoption re-eval · event-sourced sessions · Polar training · bitemporal fact validity (valid_at vs recorded_at as FalkorDB properties + query filter — Hypha steal-back; EXTRACTED_FROM/SUPERSEDES provenance is halfway there)

---

## Backlog

| Feature | Description |
|---------|-------------|
| ~~**Router fine-tuning**~~ | Done 2026-09-25 as a Laya (421M encoder) fine-tune, not phi4-mini — 80.8% vs 76.9%, 63ms vs 270ms on the held-out set; now in shadow mode (see Next Up) |
| **RBAC** | Named roles (owner/admin/user/guest) replacing binary trusted/untrusted. Per-role permissions |
| **Audit logging** | Structured log of all security decisions, tool executions, user actions |
| **Google Sheets tools** | Read/write cells, append rows. Useful for CRM and reporting |
| **Gmail compose** | Outbound email tool (currently read-only) |
| **Video pipeline** | Multimodal video/meeting summarization via nemotron |
| **Memory namespacing** | Scoped search across facts, preferences, conversations, knowledge |
| **ConnectorDescriptor pattern** | Data-driven token connectors (Notion/Linear/HubSpot ≈ 30 lines + whoami validator) — from the OpenWorker harvest |
| **Persona manifests** | User-authorable specialists as markdown frontmatter over a closed tool catalog |

---

## Known Issues

- ~~**Double message delivery on Discord**~~ — Two causes found and fixed 2026-09-20: a stream-bubble race on no-tool arena answers (delivery now waits for the in-flight bubble), and the premature-answer guard re-answering short follow-ups (skipped under 30 chars with history). The July 20 instance (model wrote its answer twice in one completion) remains a watch item
- **Email/calendar routing** — the live router sent "check my email" / "what's on my calendar" to chat/memory/cron 6/6 (no category description mentioned Gmail/Calendar after `personal` was retired). Fixed in config 2026-09-25 (`multi` description); verify after restart via the shadow log
- ~~**WhatsApp connection drops**~~ — Fixed July 14: process-level unhandledRejection/uncaughtException handlers + FalkorDB error listener with lazy reconnect
