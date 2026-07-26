# LocalClaw Roadmap

LocalClaw is a local-model-first AI agent framework running on personal infrastructure (DGX Spark, A5000, gateway). It handles Discord, Telegram, WhatsApp, and Web with a Router + Specialist architecture. Foreground reasoning runs on DeepSeek-V4-Flash via **vLLM** (a swappable foreground slot — was MiniMax-M2.7 before); small/modality models run on an Ollama-compatible gateway, routed by a `MultiBackendClient`. 39 tools, 12 pipelines, FalkorDB graph memory, autonomous heartbeats and briefings. 451 tests.

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
- **Chrome Extension** — Browser companion side panel (WXT + React + Manifest V3). Content script extracts page context, streams to LocalClaw via existing Web API. Right-click context menus. Works cross-network (extension on Windows, LocalClaw on Mac Mini)
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

---

## Next Up

| Priority | Feature | Description |
|----------|---------|-------------|
| ✅ Done | **SearXNG integration** | Self-hosted meta-search at 192.168.1.239:8080 is the web_search provider (replaced Brave) |
| ✅ Done | **MCP client bridge** | stdio + streamable-HTTP transports, zero-dep client, small-model translation layer, DCR OAuth (no broker), SecretStore. July 2026 |
| ✅ Done | **Proactive actions — ladder complete** | Ledger + buttons (Discord/Telegram) + deny + continuation-after-confirm + target-bound standing grants (`always <id>`, `!grants`) + auditable cron run sessions/artifacts + approval/resource metrics columns. July 2026 |
| ✅ Done | **Skill system (rebuilt)** | Semantic matching (measured 0.65 floor), triggers frontmatter, save-time dedup judge, skill_find progressive disclosure. July 2026 |
| Next | **Firecrawl integration** | Self-hosted web fetching between web_fetch (basic) and browser (heavy). Handles JS rendering without full Chromium |
| Next | **Blender MCP demo** | First real MCP consumer: `uvx blender-mcp` + Blender on the Mini; then MCP self-service setup (agent proposes+validates server config, confirm-gated) |
| Planned | **Self-wake** | `sleep_until`/`wake_on` tools with quotas (max pending, min interval, cronMode-filtered resume) — continuation machinery landed July 25 |
| Blocked | **Gateway passthrough** | Constrained decoding + keep_alive + full num_ctx blocked on the gateway's normalization-layer refactor (GATEWAY-REQUIREMENTS.md has the contract + acceptance tests) |
| Planned | **Cross-channel sessions** | Map user IDs across Discord/Telegram/WhatsApp to shared sessions (Slice 3 — principal layer landed; dragons documented in CONTINUATION.md) |
| Planned | **Rebrand** | Rename from LocalClaw to new identity (plan exists, 357 references mapped across 80 files) |

---

## Backlog

| Feature | Description |
|---------|-------------|
| **Router fine-tuning** | Fine-tune phi4-mini on collected training pairs (data/training/router-pairs.jsonl) for faster, more accurate routing |
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

- **Double message delivery on Discord** — Intermittent duplicates; July 20 instance was the model writing its answer twice in one completion (watch item — look at engine answer path, not delivery, if it recurs)
- ~~**WhatsApp connection drops**~~ — Fixed July 14: process-level unhandledRejection/uncaughtException handlers + FalkorDB error listener with lazy reconnect
