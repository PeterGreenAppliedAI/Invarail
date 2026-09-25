# Invarail Roadmap

Invarail is a local-model-first AI agent framework running on personal infrastructure (DGX Spark, A5000, gateway). It handles Discord, Telegram, and Web (plus the Chrome extension and read-only Gmail tools) with a Router + Specialist architecture — arena (open ReAct) dispatch fleet-wide, deterministic pipelines only for research and the heartbeat. Foreground reasoning runs on qwen3.8:27B on a 24GB A5000 (Ollama-native), set by a single root `defaultModel` config line that fills all specialist/briefing/heartbeat/vision slots (a swappable foreground slot — previously glm-5.3-flash, DeepSeek-V4-Flash, MiniMax-M2.7); glm-5.3-flash on the Spark keeps coding; the utility tier (phi4:latest router/extraction, phi4-mini NER, qwen2.5 voice) runs on a 3060 and the embedder on a Mac Mini, all routed by a `MultiBackendClient`. ~75 tools (incl. MCP), FalkorDB graph memory with epistemic provenance and continuous capture, autonomous heartbeats and briefings, a System-One shadow router. ~970 tests.

---

## Completed

- **Setup Wizard** — Interactive `npm run setup` with prerequisites check, auto-install (FalkorDB), model detection, channel security, heartbeat config, and complete production-ready config generation
- **FalkorDB Graph Memory** — Replaced flat JSONL with graph database. HNSW vector search, entity linking, SUPERSEDES chains, multi-hop traversal, bootstrapped NER, canonical entity normalization, importance-scored auto-injection
- **Analytics Pipeline** — Upload CSV/Excel/JSON → pandas computes all numbers → matplotlib charts → LLM executive interpretation. Code handles "what", model handles "so what"
- **Thinking Preservation** — Raw model output stored in transcripts for continuity across turns. Stripped only at display boundaries. Handles Qwen and Gemma 4 formats
- **Gemma4:26b for Chat** — MoE (3.8B active), replaced qwen3.5:9b which had self-prompting artifacts
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
- **SearXNG Integration** — Self-hosted meta-search at 192.168.77.239:8080 is the web_search provider (replaced Brave)
- **MCP Client Bridge (July 2026)** — stdio + streamable-HTTP transports, zero-dep client, small-model translation layer, DCR OAuth (no broker), SecretStore
- **Proactive Actions — Ladder Complete (July 2026)** — Ledger + buttons (Discord/Telegram) + deny + continuation-after-confirm + target-bound standing grants (`always <id>`, `!grants`) + auditable cron run sessions/artifacts + approval/resource metrics columns
- **Skill System (rebuilt July 2026)** — Semantic matching (measured 0.65 floor), triggers frontmatter, save-time dedup judge, skill_find progressive disclosure. Guards added Aug 2026: explicit-tool-mention override + no-credit-on-fallback (self-reinforcing hijack class)
- **FlowMCP Integration (Aug 2026)** — [FlowMCP](https://github.com/PeterGreenAppliedAI/FlowMCP) (Peter's workflow-first MCP server) as first real bridge consumer: compiled `weekly_gather` flow powers research-pipeline flow-first gathering (4s vs minutes) behind an explicit-naming code gate; verified live with a fabrication caught by verification
- **Arena Fleet-Wide (2026-08-21)** — cron, task, memory, message, website, web_search, exec, code_gen, multi all run `dispatchMode: "arena"`: open ReAct loop, session history, natural stop, same 6 security layers + confirm ledger. Plan pipeline retired from dispatch after the measured duel; deterministic pipelines remain only for research + heartbeat
- **SIP Live (2026-08-22)** — Self-modification in production: heartbeat drafts `!improve` specs from recurring tool errors → pending-action ledger, two owner confirms (attempt + merge, denial permanent), Pi implements in isolated worktrees, merge gate = tsc + full vitest + Tier-3 protected paths, supervised deploy with health-check + rollback, `!improve retry` re-gates after rebase
- **GLM Cutover (2026-08-26)** — glm-5.3-flash on vLLM (262K ctx) as the foreground model, configured by one root `defaultModel` line filling all specialist/briefing/heartbeat/vision slots. qwen3.8-27B/SGLang retired 2026-08-26; DeepSeek-V4-Flash/ds4 retired 2026-08-16
- **Email Steward (2026-08-29)** — Read-only email triage (no send capability exists): fast lane (support alias/VIP, 15-min poll, immediate ping), watch lane (owner-chosen bulk senders → heartbeat digest), judged lane (one constrained model judgment). Opt-in via `emailTriage`

---

## Next Up

| Priority | Feature | Description |
|----------|---------|-------------|
| **Now** | **Shadow router → `router.backend` switch** | Laya v3 logged beside phi4 on real traffic (`data/router-shadow.jsonl`). Decide on the disagreement rate + who was right on disagreements over a few days. Then: additive `router.backend: "systemone"` with keyword fallback; move the server to the Mini (needs Remote Login); same recipe for the steward's `needsPeter` |
| Next | **Memory synthesis pass** | Heartbeat-time "so what" over entity clusters as `(:Synthesis)` nodes with `provenance: inferred`, structural DERIVED_FROM edges, short expiry. Designed; NOT built — gate (`scripts/memory-cluster-check.ts`) failed on 24 facts. Re-run after capture has fed the graph a few weeks |
| Next | **Repo manifest + generalized merge gate** | Extend SIP beyond the Invarail repo: per-repo manifest, generalized merge gate, draft-PR path (DECISIONS: "The Factory") |
| Next | **GitHub intake cron** | Scheduled intake of GitHub work items feeding the factory loop |
| Next | **Rework loop** | `selfMod.reworkIterations` — bounded re-attempts when a SIP change fails its gate |
| Next | **Ladder promotions on track record** | Promote action types up the autonomy ladder based on the `autonomous_action` metrics record |
| Next | **Semantic flow proposal** | Floor-gated similarity check that PROPOSES a matching gathering flow for a research topic (asks, never silently selects) — the rung above strict naming |
| Next | **Firecrawl integration** | Self-hosted web fetching between web_fetch (basic) and browser (heavy). Handles JS rendering without full Chromium |
| Next | **Blender MCP demo** | First real MCP consumer: `uvx blender-mcp` + Blender on the Mini; then MCP self-service setup (agent proposes+validates server config, confirm-gated) |
| Planned | **Self-wake** | `sleep_until`/`wake_on` tools with quotas (max pending, min interval, cronMode-filtered resume) — continuation machinery landed July 25 |
| Blocked | **Gateway passthrough** | Constrained decoding + keep_alive + full num_ctx blocked on the gateway's normalization-layer refactor (GATEWAY-REQUIREMENTS.md has the contract + acceptance tests) |
| Planned | **Cross-channel sessions** | Map user IDs across channels to shared sessions (Slice 3 — principal layer landed; dragons documented in CONTINUATION.md) |
| Planned | **Rebrand** | Rename from Invarail to new identity (plan exists, 357 references mapped across 80 files) |

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
