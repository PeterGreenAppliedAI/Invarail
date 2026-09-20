import { z } from 'zod';

export const OllamaConfigSchema = z.object({
  url: z.string().default('http://127.0.0.1:11434'),
  keepAlive: z.string().default('30m'),
});

/** An OpenAI-compatible inference backend (e.g. ds4/DwarfStar, vLLM). Additive — Ollama path is unchanged. */
export const VllmBackendSchema = z.object({
  url: z.string(),
  apiKey: z.string().optional(),
  /** Exact model ids this backend serves, e.g. "deepseek-v4-flash" */
  models: z.array(z.string()).default([]),
  /** Whether this backend honors the per-request `think` field on chat completions
   *  (ds4/DwarfStar does — verified 2026-08-12: think:false → 1 completion token vs
   *  default thinking mode). Default false: generic OpenAI-compat servers silently
   *  ignore unknown fields, and a silent no-op is worse than an omitted field —
   *  only declare true after verifying the backend actually enforces it. */
  supportsThink: z.boolean().default(false),
  /** How a think-capable backend expresses the control: 'native' = top-level
   *  `think` (ds4/DwarfStar); 'qwen-template' = chat_template_kwargs.enable_thinking
   *  (SGLang serving Qwen — verified 2026-08-16; boolean only, effort strings omit). */
  thinkStyle: z.enum(['native', 'qwen-template']).default('native'),
});

/** A second Ollama-NATIVE host (not OpenAI-compat) — e.g. gemma4 on the .221 Mini,
 *  served by its own Ollama. Chat calls whose model matches route to this host's
 *  Ollama API; embeddings and the utility tier stay on the gateway. Native think
 *  control and response shape are identical to the gateway, so nothing to probe. */
export const OllamaBackendSchema = z.object({
  url: z.string(),
  keepAlive: z.string().optional(),
  /** Exact model ids this host serves, e.g. "gemma4:12b-mlx" */
  models: z.array(z.string()).default([]),
});

export const InferenceConfigSchema = z.object({
  /** Extra OpenAI-compatible backends (vLLM/ds4). Chat calls whose model matches route here; everything else stays on Ollama. */
  backends: z.array(VllmBackendSchema).default([]),
  /** Extra Ollama-native hosts. Chat calls whose model matches route to that host; the gateway keeps embeddings + the utility tier. */
  ollamaBackends: z.array(OllamaBackendSchema).default([]),
});

export const RouterCategorySchema = z.object({
  description: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  examples: z.array(z.string()).optional(),
});

export const RouterConfigSchema = z.object({
  model: z.string().default('phi4-mini'),
  timeout: z.number().default(2000),
  defaultCategory: z.string().default('chat'),
  categories: z.record(z.string(), RouterCategorySchema).default({}),
});

export const SpecialistConfigSchema = z.object({
  model: z.string(),
  systemPrompt: z.string().optional(),
  maxTokens: z.number().default(4096),
  /** Input context window override (compaction budget + num_ctx). Falls back to session.contextSize. Set high for big-context models like MiniMax. */
  contextSize: z.number().optional(),
  temperature: z.number().default(0.7),
  /** Sampling: top-K candidates (Ollama default: 40). Lower = more focused. */
  topK: z.number().optional(),
  /** Sampling: nucleus probability threshold (Ollama default: 0.9). Lower = less random. */
  topP: z.number().optional(),
  /** Sampling: repetition penalty (Ollama default: 1.1). Higher = less repetition. */
  repeatPenalty: z.number().optional(),
  maxIterations: z.number().default(10),
  tools: z.array(z.string()).default([]),
  /** 'arena' forces the open ReAct loop (natural stop, dispatch skips pipelines AND the
   *  legacy multi-orchestration) — the measured winner of the 2026-08-20 arena duel.
   *  Unset = existing behavior. Reversal is deleting this field. */
  dispatchMode: z.enum(['pipeline', 'arena']).optional(),
  /** Workspace context level: 'full' injects all workspace files, 'minimal' injects SOUL+IDENTITY only.
   *  Defaults to 'minimal' for tool-using specialists, 'full' for chat. */
  contextLevel: z.enum(['full', 'minimal']).optional(),
  /** Pipeline name — if set, routes to deterministic pipeline instead of ReAct loop */
  pipeline: z.string().optional(),
  /** Tool-calling convention. 'native' (default): tools passed via the API tools field
   *  only — no text-format instructions in the prompt. 'text': tools described in the
   *  prompt with Action:-format instructions, nothing passed natively — for models
   *  whose template lacks tool support. One convention per model, never both. */
  toolStyle: z.enum(['native', 'text']).default('native'),
  /** Thinking control for reasoning models (Ollama `think` passthrough).
   *  true = reason in the separated thinking channel; false = suppress reasoning
   *  (measured ~14x cheaper on qwen3.6 for equal chat quality, 2026-08 eval);
   *  unset = model default. Effort levels ('low'|'medium'|'high') are for the
   *  gpt-oss family — their native knob; they have no off-mode and silently
   *  ignore `false`. Ollama rejects the field on non-thinking models — only set
   *  for models that support it. On the OpenAI-compat path, forwarded only for
   *  backends declaring supportsThink (never silently dropped). */
  think: z.union([z.boolean(), z.enum(['low', 'medium', 'high'])]).optional(),
});

/** Identity: one principal (person) with per-channel sender aliases.
 *  Memory, the pending-action ledger, and trust checks key on the principal —
 *  fixes cross-channel fragmentation (measured: 55/64 facts under one channel's
 *  sender id). Session keys stay channel-scoped (conversation unification is a
 *  separate control-plane slice). */
export const PrincipalSchema = z.object({
  aliases: z.array(z.string()).default([]),
  /** Human name for prompts — lets models recognize the person in calendar
   *  metadata, email headers, etc. ("booked by <displayName>" is not a third party) */
  displayName: z.string().optional(),
  /** The person's OWN email addresses — models must never treat these as other people */
  emails: z.array(z.string()).default([]),
});

export const ChannelAllowFromSchema = z.object({
  guilds: z.array(z.string()).optional(),
  channels: z.array(z.string()).optional(),
  users: z.array(z.string()).optional(),
});

export const ChannelSecuritySchema = z.object({
  allowedCategories: z.array(z.string()).optional(),
  blockedTools: z.array(z.string()).optional(),
  trustedUsers: z.array(z.string()).optional(),
  restrictedCategories: z.array(z.string()).optional(),
  restrictedTools: z.array(z.string()).optional(),
  /** Tools that show a preview instead of executing — user must confirm in a follow-up message */
  confirmTools: z.array(z.string()).optional(),
  /** Promotion mechanism: tools promoted PAST their metadata-declared propose-confirm
   *  tier on this channel (earned with an autonomous_action track record). Does not
   *  override an explicit confirmTools entry. */
  autoApproveTools: z.array(z.string()).optional(),
  /** Tools only accessible to the config-level ownerId — stripped for everyone else, including trusted users */
  ownerOnlyTools: z.array(z.string()).optional(),
});

export const ChannelConfigSchema = z.object({
  enabled: z.boolean().default(false),
  token: z.string().optional(),
  allowFrom: ChannelAllowFromSchema.optional(),
  security: ChannelSecuritySchema.optional(),
}).passthrough();

export const AgentBindingMatchSchema = z.object({
  channel: z.string().optional(),
  guildId: z.string().optional(),
  peerId: z.string().optional(),
  accountId: z.string().optional(),
});

export const AgentBindingSchema = z.object({
  agentId: z.string(),
  match: AgentBindingMatchSchema.optional(),
});

export const AgentSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  workspace: z.string().optional(),
  routerOverrides: z.object({
    defaultCategory: z.string().optional(),
  }).optional(),
});

export const AgentsConfigSchema = z.object({
  default: z.string().default('main'),
  list: z.array(AgentSchema).default([{ id: 'main' }]),
  bindings: z.array(AgentBindingSchema).default([]),
});

export const MemoryConsolidationSchema = z.object({
  enabled: z.boolean().default(false),
  model: z.string().default('phi4-mini'),
  similarityThreshold: z.number().min(0).max(1).default(0.85),
});

export const MemoryConfigSchema = z.object({
  backend: z.enum(['markdown']).default('markdown'),
  consolidation: MemoryConsolidationSchema.optional(),
  /** Model for fact extraction from transcripts. Defaults to router model. */
  extractionModel: z.string().optional(),
  /** Small fast model for graph NER (entity typing) + contradiction checks. Defaults to phi4-mini:latest. */
  nerModel: z.string().default('phi4-mini:latest'),
  /** Embedding model for ALL vector work — graph facts, experiences, knowledge import,
   *  lessons. Was hardcoded in four files (graph-store, experience-store, register-all,
   *  client default), so swapping embedders meant editing source (2026-09-19). */
  embeddingModel: z.string().default('qwen3-embedding:8b'),
  /** Vector width of embeddingModel — MUST match it or the FalkorDB index is built wrong.
   *  qwen3-embedding: 8b=4096, 4b=2560, 0.6b=1024. Changing either requires re-embedding
   *  every stored vector AND re-measuring the relevance floors (they are per-corpus). */
  embeddingDims: z.number().default(4096),
  /** Lessons — negative procedural memory ("approach X failed for task-shape Y").
   *  Heartbeat synthesizes from code-detected failure evidence; injection is
   *  gated on recurrence (evidence ≥ 2). Gate covers synthesis AND injection. */
  lessons: z.object({
    enabled: z.boolean().default(true),
  }).default({}),
  /** Graph experience memory: what approaches worked/failed per task shape,
   *  judged by REAL user signals (reactions, denials, corrections). Advisory
   *  injection only — the authority boundary (see DECISIONS 2026-08-10). */
  experiences: z.object({
    enabled: z.boolean().default(true),
  }).default({}),
  /** Minimum hours between heartbeat memory-review prompts ("still accurate? !heartbeat yes/no").
   *  The heartbeat runs every ~2h, but nagging the user that often is review fatigue — gate the
   *  prompt to at most once per this interval. Default once a day. */
  reviewIntervalHours: z.number().nonnegative().default(24),
  /** FalkorDB connection — defaults match a local Docker install. Set these if
   *  FalkorDB runs on another host/port (portability: nothing infra-specific is
   *  hardcoded; localhost:6379 is only a default). */
  falkordb: z.object({
    host: z.string().default('localhost'),
    port: z.number().default(6379),
    graphName: z.string().default('invarail_memory'),
  }).default({}),
});

export const VerificationConfigSchema = z.object({
  /**
   * Verify research claims against the cached sources that actually mention them before
   * publishing. Hedges/attributes overstated or single-sourced claims (never deletes).
   */
  enabled: z.boolean().default(true),
  /** Fast model for atomic-claim extraction. Defaults to the pipeline's router model. */
  extractorModel: z.string().optional(),
  /** Model for the entailment judge (claim vs. cited source). Defaults to the research specialist. */
  judgeModel: z.string().optional(),
  /** Max claims verified per report (highest-impact first). Higher cap lets thinly-sourced
   *  figures (e.g. a single weak-domain manufacturing stat) also get checked instead of riding
   *  through unverified; each adds one bounded entailment call (concurrency 3). */
  maxClaims: z.number().int().positive().default(18),
  /** Tier-1 independent cross-check: one fresh search per high-impact claim to catch
   *  faithfully-cited wrong facts (dates, deals, figures). Bounded by maxCrossChecks. */
  crossCheck: z.boolean().default(true),
  /** Max claims escalated to an independent search (keeps the search budget bounded). */
  maxCrossChecks: z.number().int().nonnegative().default(4),
});

export const CronConfigSchema = z.object({
  enabled: z.boolean().default(false),
  store: z.string().default('data/cron.json'),
});

export const SessionConfigSchema = z.object({
  transcriptDir: z.string().default('data/sessions'),
  maxHistoryTurns: z.number().default(100),
  contextSize: z.number().default(32768),
  recentTurnsToKeep: z.number().default(6),
  /** Use a fast LLM to summarize old tool observations instead of hard-truncating.
   *  Only activates for observations >1000 chars when context budget is tight. */
  summarizeToolObservations: z.boolean().default(false),
  /** Model for observation summarization (defaults to router model if not set). */
  summarizationModel: z.string().optional(),
  /** After a confirmed action executes, dispatch ONE follow-up turn in the
   *  originating session (with the original category's tools) so multi-step
   *  work survives the confirm gap instead of dying at the preview. */
  continueAfterConfirm: z.boolean().default(true),
});

export const WebSearchConfigSchema = z.object({
  provider: z.enum(['brave', 'perplexity', 'grok', 'tavily', 'searxng']).default('brave'),
  apiKey: z.string().optional(),
  /** Base URL for self-hosted providers (searxng), e.g. "http://192.168.77.239:8080". No API key needed. */
  baseUrl: z.string().optional(),
  cacheTtlMs: z.number().default(15 * 60 * 1000),
});

export const WebFetchConfigSchema = z.object({
  maxChars: z.number().default(30000),
  firecrawlApiKey: z.string().optional(),
  firecrawlBaseUrl: z.string().optional(),
});

export const SessionExecConfigSchema = z.object({
  idleTimeoutMs: z.number().default(300_000),
  maxSessions: z.number().default(3),
  maxOutputBytes: z.number().default(1024 * 1024),
  allowedRuntimes: z.array(z.enum(['python', 'node', 'bash'])).default(['python', 'node', 'bash']),
});

export const DockerConfigSchema = z.object({
  image: z.string().default('invarail-sandbox:latest'),
  mountMode: z.enum(['ro', 'rw']).default('ro'),
  memoryLimit: z.string().default('512m'),
  cpuLimit: z.string().default('1.0'),
  networkMode: z.string().default('none'),
});

export const ExecConfigSchema = z.object({
  security: z.enum(['allowlist', 'docker']).default('allowlist'),
  allowlist: z.array(z.string()).default(['ls', 'cat', 'python3', 'node', 'git']),
  timeout: z.number().default(30000),
  sessions: SessionExecConfigSchema.optional(),
  docker: DockerConfigSchema.optional(),
});

export const WebsiteConfigSchema = z.object({
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
});

export const BrowserConfigSchema = z.object({
  enabled: z.boolean().default(false),
  headless: z.boolean().default(true),
  executablePath: z.string().optional(),
  /** Xvfb display for visual mode (e.g., ":99"). When set, browser launches non-headless against this virtual display. */
  display: z.string().optional(),
  /** Vision model for visual browser interactions (e.g., "qwen3-vl:8b"). Falls back to config.vision.model. */
  visionModel: z.string().optional(),
  /** Model for browser-control reasoning (extension remote-bridge mode). Falls back to the dispatched specialist's model. */
  controlModel: z.string().optional(),
});

export const TTSConfigSchema = z.object({
  enabled: z.boolean().default(false),
  url: z.string().default('http://127.0.0.1:5005'),
  voice: z.string().default('serena'),
  format: z.enum(['wav', 'opus', 'mp3']).default('opus'),
});

export const STTConfigSchema = z.object({
  enabled: z.boolean().default(false),
  url: z.string().default('http://127.0.0.1:8000'),
  model: z.string().default('whisper-large-v3'),
  language: z.string().default('en'),
});

// Pi (picoder) coding agent — replaces OpenCode. Headless, cwd-scoped, no server/global-DB.
// Model id is `provider/id` from ~/.pi/agent/models.json (e.g. vllm/deepseek-v4-flash).
export const PiConfigSchema = z.object({
  enabled: z.boolean().default(false),
  model: z.string().default('vllm/deepseek-v4-flash'),
  apiKey: z.string().default('vllm'),           // dummy — vLLM ignores it, Pi requires a value
  // Tools Pi may use during a build. Excludes nothing dangerous beyond what cwd-scoping bounds;
  // `bash` is needed to run/scaffold but is the main escape vector — kept because builds need it.
  tools: z.array(z.string()).default(['read', 'write', 'edit', 'ls', 'grep', 'find', 'bash']),
  timeout: z.number().default(600000),          // 10 min per build invocation
  maxFixIterations: z.number().default(3),      // outer loop: build → test → fix, bounded
  // Reasoning effort for Pi's model. 'medium' matches the SDK default we were silently
  // getting — now explicit in config and recorded on every pi_session metric.
  thinkingLevel: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']).default('medium'),
  git: z.object({
    // Local commit is autonomous (reversible, internal). Remote push is OPT-IN (visible to
    // others, harder to reverse) — off by default so an experimental loop can't publish under
    // your name without you turning it on. Requires `gh` CLI authed when enabled.
    commitLocal: z.boolean().default(true),
    pushRemote: z.boolean().default(false),
    visibility: z.enum(['private', 'public']).default('private'),
  }).default({}),
});

// Self-modification (Phase B): Pi implements changes to Invarail's OWN repo in isolated git
// worktrees; merges are gate-checked and ALWAYS owner-confirmed via the pending-action ledger.
export const SelfModConfigSchema = z.object({
  enabled: z.boolean().default(false),
  // Extends the built-in Tier-3 protected-path list (merge-gate.ts). Config may only ADD
  // paths — the built-ins are code-clamped and cannot be removed from here.
  protectedPathsExtra: z.array(z.string()).default([]),
  // Pi session budget for a self-mod worktree session; falls back to pi.timeout when unset.
  sessionTimeoutMs: z.number().optional(),
  gateTimeoutMs: z.number().default(600000),    // tsc + full suite in the worktree
});

export const ImageGenConfigSchema = z.object({
  enabled: z.boolean().default(false),
  url: z.string().default('http://127.0.0.1:11434'),
  model: z.string().default('x/flux2-klein:4b-fp8'),
});

export const VisionConfigSchema = z.object({
  enabled: z.boolean().default(false),
  model: z.string().default('qwen3-vl:8b'),
  prompt: z.string().default('Describe this image in detail. Include text content, visual elements, layout, and any relevant context.'),
  maxTokens: z.number().default(512),
});

export const KnowledgeConfigSchema = z.object({
  maxChunkSize: z.number().default(800),
  overlapSize: z.number().default(100),
  allowedExtensions: z.array(z.string()).default(['.pdf', '.csv', '.md', '.txt', '.html', '.htm']),
});

export const McpServerConfigSchema = z.object({
  name: z.string(),                                   // registry prefix + log identity
  transport: z.enum(['stdio', 'http']).default('stdio'),
  command: z.string().optional(),                     // stdio: e.g. "uvx"
  args: z.array(z.string()).default([]),              // stdio: e.g. ["blender-mcp"]
  /** stdio: working directory for the spawned server. Servers that resolve
   *  their own relative paths (config files, child processes) need to run
   *  from their repo root, not Invarail's. */
  cwd: z.string().optional(),
  url: z.string().optional(),                         // http: e.g. "https://mcp.linear.app/mcp"
  /** http: authorize via local OAuth 2.1 + PKCE + DCR (tokens in the secret
   *  store; run scripts/mcp-oauth-setup.ts once — background paths NEVER open a browser) */
  oauth: z.boolean().default(false),
  env: z.record(z.string(), z.string()).default({}),
  enabled: z.boolean().default(true),
  /** 'confirm': non-readOnlyHint tools are confirm-gated (default). 'auto': owner
   *  waives the gate for this server — owner-authored config is the code gate. */
  trust: z.enum(['confirm', 'auto']).default('confirm'),
  timeoutMs: z.number().default(60000),
  /** When set, only these tool names register — first lever against 40-tool servers drowning a small model */
  toolAllowlist: z.array(z.string()).optional(),
  /** Operator attestation that these tools (original names) are pure reads —
   *  waives the no-readOnlyHint confirm default per tool. For servers that
   *  don't annotate (blender-mcp gates even get_scene_info without this).
   *  Owner-authored config = code gate; writes stay confirm-gated. */
  readOnlyTools: z.array(z.string()).default([]),
  toolPrefix: z.string().optional(),                  // defaults to "<name>_"
  /** Hand-curated description rewrites for tools whose upstream prose confuses small models */
  toolDescriptions: z.record(z.string(), z.string()).default({}),
  /** Per-server tool result cap (chars) — Blender scene dumps outgrow the 2000 default */
  maxResultChars: z.number().optional(),
  /** Path to the server's registry-log.jsonl (FlowMCP v0.6 open contract).
   *  When set, consumer-side staleness signals (research gap-check lenses on
   *  flow-gathered runs) are appended as {kind:'signal'} records. */
  registryLog: z.string().optional(),
}).refine(s => (s.transport === 'stdio' ? !!s.command : !!s.url), {
  message: 'stdio servers need "command"; http servers need "url"',
});

export const McpConfigSchema = z.object({
  servers: z.array(McpServerConfigSchema).default([]),
  /** When set, one JSONL line per completed tool-using dispatch is appended in
   *  FlowMCP's detection contract ({id,task,agent,ts,success,tokens,calls[]}) —
   *  feed for detect.ts flow nomination. */
  executionsLog: z.string().optional(),
});

export const ToolsConfigSchema = z.object({
  web: z.object({
    search: WebSearchConfigSchema.optional(),
    fetch: WebFetchConfigSchema.optional(),
  }).optional(),
  exec: ExecConfigSchema.optional(),
  website: WebsiteConfigSchema.optional(),
  knowledge: KnowledgeConfigSchema.optional(),
  mcp: McpConfigSchema.optional(),
});

export const VoiceConfigSchema = z.object({
  model: z.string().default('qwen2.5:7b'),
});

export const HeartbeatConfigSchema = z.object({
  enabled: z.boolean().default(false),
  schedule: z.string().default('0 */2 * * *'), // every 2 hours
  /** Model used for heartbeat reasoning (memory diff, task summary, user model). */
  model: z.string().default('qwen3.6:35b'),
  delivery: z.object({
    channel: z.string().default('discord'),
    target: z.string(), // Discord channel ID or user ID for DMs
  }),
  /** Self-improvement proposals (OPT-IN — a new autonomy surface enters the ladder
   *  disabled): recurring code-detected tool failures become drafted !improve specs on
   *  the pending-action ledger. Confirming runs the existing self-mod rail; denying is
   *  permanent for that failure signature. Requires selfMod.enabled. */
  selfImprovement: z.object({
    enabled: z.boolean().default(false),
    minOccurrences: z.number().default(3),
    cooldownDays: z.number().default(7),
  }).default({}),
});

/** Email steward (2026-08-29, DECISIONS "The Factory" phase 1). READ-ONLY FOREVER —
 *  the steward informs, it never writes email (no gmail-send tool exists; the boundary
 *  is capability absence, not policy). One delta poll every pollMinutes: fast-lane
 *  matches (support alias / VIP senders) ping immediately; everything else gets one
 *  narrow model judgment and flagged mail rides the 2h heartbeat digest. Peter's rule:
 *  EMPTY fast-lane lists → the poll cron is not scheduled at all (digest-only). */
export const EmailTriageConfigSchema = z.object({
  enabled: z.boolean().default(false),   // opt-in — every autonomy surface enters disabled
  pollMinutes: z.number().default(15),
  /** Additional Gmail accounts beyond the default (GOOGLE_REFRESH_TOKEN). Each needs its
   *  own refresh token (mint with scripts/google-auth.ts signed into that account) named
   *  by refreshTokenEnv. Missing env → that account skip-warns, never breaks the poll.
   *  Motivating case: GitHub-facing outreach lands on the personal address, not the
   *  business one the default token covers. */
  accounts: z.array(z.object({
    label: z.string(),
    refreshTokenEnv: z.string(),
  })).default([]),
  fastLane: z.object({
    /** Inbound addresses that always flag + ping immediately (e.g. support@devmesh.tech). */
    aliases: z.array(z.string()).default([]),
    /** VIP sender addresses or bare domains ("client.com") — immediate ping. */
    senders: z.array(z.string()).default([]),
  }).default({}),
  /** Watched senders/domains (owner-chosen groups, orgs, event lists): always flagged
   *  into the DIGEST lane, no model call — and they BYPASS the automated-mail filter,
   *  because group/event mail is bulk by nature and bulk ≠ unwanted when the owner
   *  chose the sender. The actual list is personal — it lives ONLY in the gitignored
   *  config, never in code, tests, or commits. */
  watch: z.object({
    senders: z.array(z.string()).default([]),
  }).default({}),
  /** Model for the one needs-Peter judgment per email. Defaults to heartbeat model. */
  model: z.string().optional(),
  /** Delivery target; defaults to heartbeat.delivery. */
  delivery: z.object({ channel: z.string(), target: z.string() }).optional(),
});

/** Briefing reasoning config. Timing is fixed (8am/1:15pm/5pm); model is configurable. */
export const BriefingConfigSchema = z.object({
  model: z.string().default('qwen3.6:35b'),
  /** Calendar prep proposals: per upcoming event, the briefing asks a targeted
   *  question or proposes an executable prep action (reminder/task) that runs
   *  on "confirm <id>". First rung of proactive autonomy — everything proposes. */
  prepProposals: z.boolean().default(true),
});

// --- Fact / Memory schemas ---

export const FactCategorySchema = z.enum(['stable', 'context', 'decision', 'question']);

/** Epistemic provenance — HOW we know a fact. Orthogonal to `source`, which is a
 *  free-text WHERE ("session/foo.json", "consolidation/llm-merge") and cannot carry
 *  this distinction. Retrieval and injection need it: "the owner confirmed this" is
 *  a different claim from "the heartbeat noticed it" or "a model merged it out of
 *  two other facts", and a model that can't tell them apart will assert all three
 *  with equal confidence.
 *    stated   — the owner asserted or explicitly confirmed it (the !save gate)
 *    observed — extracted autonomously from what was said or done, never confirmed
 *    inferred — a model derived it rather than reading it off a turn
 *  Defaults to 'observed': the conservative read for any writer that doesn't
 *  declare, and for every fact written before this field existed. */
export const FactProvenanceSchema = z.enum(['stated', 'observed', 'inferred']);

export const FactEntrySchema = z.object({
  id: z.string(),
  text: z.string(),
  category: FactCategorySchema.default('stable'),
  confidence: z.number().min(0).max(1).default(0.8),
  source: z.string(),
  provenance: FactProvenanceSchema.default('observed'),
  createdAt: z.string(),
  expiresAt: z.string().optional(),
  hash: z.string(),
  senderId: z.string().optional(),
  tags: z.array(z.string()).default([]),
  entities: z.array(z.string()).default([]),
  /** Timestamp of last heartbeat review — prevents review fatigue */
  lastReviewedAt: z.string().optional(),
  /** Importance tier: 5=critical (health/family), 4=identity (job/projects), 3=preference, 2=context, 1=ephemeral */
  importance: z.number().min(1).max(5).default(2),
});

/** Input shape for creating a new fact (id/hash/createdAt auto-generated). */
export const FactInputSchema = z.object({
  text: z.string(),
  category: FactCategorySchema.default('stable'),
  confidence: z.number().min(0).max(1).default(0.8),
  source: z.string().optional(),
  provenance: FactProvenanceSchema.default('observed'),
  expiresAt: z.string().optional(),
  tags: z.array(z.string()).default([]),
  entities: z.array(z.string()).default([]),
  /** Importance tier: 5=critical (health/family), 4=identity (job/projects), 3=preference, 2=context, 1=ephemeral */
  importance: z.number().min(1).max(5).default(2),
});

/** Personal vertical index — leg 1 of the search stack (see DECISIONS "the
 *  fabrication gate"): curate what we FETCH, never constrain what we SEARCH.
 *  RSS-first ingestion over owner-curated seeds; local_search is tried before
 *  any web search; web search remains the unconstrained fallback. */
export const IndexSeedSchema = z.object({
  url: z.string(),
  /** 'rss' = feed (items + 1-hop to item pages); 'page' = fetch the page itself */
  kind: z.enum(['rss', 'page']).default('rss'),
  /** Optional tags for retrieval filtering/weighting (e.g. "papers", "releases") */
  tags: z.array(z.string()).default([]),
  /** For aggregator feeds (HN, reddit): follow each item's OUTBOUND link and
   *  index the target page (bounded per cycle) — the discovery layer. */
  followLinks: z.boolean().default(false),
});

export const LocalIndexConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** Refresh schedule (5-field cron, local tz). Default: every 3 hours. */
  refreshCron: z.string().default('0 */3 * * *'),
  seeds: z.array(IndexSeedSchema).default([]),
  /** Per-domain minimum ms between fetches (politeness) */
  perDomainIntervalMs: z.number().default(1000),
  /** Max item pages fetched per feed per cycle (bounds 1-hop follows) */
  maxPagesPerFeedPerCycle: z.number().default(5),
  /** Days after which unrefreshed content stops surfacing in local_search */
  maxAgeDays: z.number().default(90),
});

export const InvarailConfigSchema = z.object({
  /** THE foreground model — filled into every specialist/briefing/heartbeat/vision
   *  slot that doesn't override it (pre-parse, in the loader). A model cutover is
   *  this ONE line plus the backend entry; per-slot `model:` remains an override. */
  defaultModel: z.string().optional(),
  /** Owner user ID — the single person who can access owner-only tools (gmail, calendar, etc.). Checked in code, not by the model. */
  ownerId: z.string().optional(),
  /** Principals: person → channel sender aliases. See PrincipalSchema. */
  principals: z.record(z.string(), PrincipalSchema).default({}),
  /** Document vault: domain-organized markdown/PDF store as source of truth.
   *  Subfolders are the domains (business/, coding/, ...). Edit with any
   *  editor (Obsidian works — it's just files); heartbeat reindexes changes. */
  vault: z.object({
    path: z.string().default('vault'),
  }).default({}),
  timezone: z.string().default('America/New_York'),
  ollama: OllamaConfigSchema.default({}),
  inference: InferenceConfigSchema.default({}),
  briefing: BriefingConfigSchema.default({}),
  router: RouterConfigSchema.default({}),
  specialists: z.record(z.string(), SpecialistConfigSchema).default({}),
  channels: z.record(z.string(), ChannelConfigSchema).default({}),
  agents: AgentsConfigSchema.default({}),
  memory: MemoryConfigSchema.default({}),
  localIndex: LocalIndexConfigSchema.default({}),
  verification: VerificationConfigSchema.default({}),
  cron: CronConfigSchema.default({}),
  session: SessionConfigSchema.default({}),
  tools: ToolsConfigSchema.optional(),
  browser: BrowserConfigSchema.default({}),
  tts: TTSConfigSchema.default({}),
  stt: STTConfigSchema.default({}),
  vision: VisionConfigSchema.default({}),
  imageGen: ImageGenConfigSchema.default({}),
  pi: PiConfigSchema.default({}),
  selfMod: SelfModConfigSchema.default({}),
  voice: VoiceConfigSchema.default({}),
  heartbeat: HeartbeatConfigSchema.optional(),
  emailTriage: EmailTriageConfigSchema.optional(),
});
