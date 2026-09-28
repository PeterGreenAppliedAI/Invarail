import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, existsSync, statSync } from 'node:fs';
import { Cron } from 'croner';
import type { InvarailConfig } from './config/types.js';
import type { ChannelAdapterConfig, InboundMessage } from './channels/types.js';
import { OllamaClient } from './ollama/client.js';
import { createInferenceClient } from './ollama/multi-backend.js';
import { embeddingsEnabled, wantsGraph, okfEnabled, memoryBackend } from './memory/policy.js';
import { abortAllInference } from './ollama/abort.js';
import { ToolRegistry } from './tools/registry.js';
import { ChannelRegistry } from './channels/registry.js';
import { SessionStore } from './sessions/store.js';
import { CronStore } from './cron/store.js';
import { CronService } from './cron/service.js';
import { TaskStore } from './tasks/store.js';
import { dispatchMessage } from './dispatch.js';
import { SelfModService } from './coding/self-mod-service.js';
import { appendRunRecord, appendDeadLetter, scanArtifacts } from './cron/run-log.js';
import { handleConfirmation } from './security/confirm-handler.js';
import { PrepContextStore, captureBriefingAnswer } from './services/prep-context.js';
import { resolvePrincipal, ownerNames } from './identity/principal.js';
import { resolveRoute } from './agents/resolve-route.js';
import { registerAllTools } from './tools/register-all.js';
import { bootstrapWorkspace } from './agents/workspace.js';
import { resolveWorkspacePath } from './agents/scope.js';
import { MemoryCapture } from './services/memory-capture.js';
import { fitLinesToTokenBudget } from './memory/extraction-window.js';
import type { EmbeddingStore } from './memory/embeddings.js';
import { FactStore } from './memory/fact-store.js';
import type { FactInput } from './config/types.js';
import { TTSService } from './services/tts.js';
import { STTService } from './services/stt.js';
import { VisionService } from './services/vision.js';
import { saveAttachment } from './services/attachments.js';
import { ollamaUnreachable, toolExecutionError, InvarailError } from './errors.js';
import { PipelineRegistry } from './pipeline/registry.js';
import { registerAllPipelines } from './pipeline/definitions/index.js';
import { ExecutionMetricsStore } from './metrics/execution-store.js';
import type { ConsoleApiDeps } from './console/types.js';
import { GraphMemoryStore } from './memory/graph-store.js';
import type { WebApiAdapter } from './channels/web/adapter.js';
// Pipeline utilities kept in src/services/tts-stream.ts for future use with slower TTS models

// Extracted utilities — imported from dedicated modules
import { extractMediaAttachments, isImageTransformRequest } from './services/media-extraction.js';
import { stripThinkingTags } from './utils/text.js';
import { splitFinalMessage } from './utils/text.js';
import { runBuiltinCommand, type CommandHost } from './commands/builtin.js';
import { RateLimiter } from './services/rate-limiter.js';
import { MediaDebouncer } from './services/media-debouncer.js';
import { MessageDebouncer } from './services/message-debouncer.js';
import { runHeartbeat } from './services/heartbeat-service.js';
import { runBriefing } from './services/briefing-service.js';

// Rate limiting and media debouncing now handled by extracted services

export class Orchestrator {
  private client: OllamaClient;
  private toolRegistry: ToolRegistry;
  private channelRegistry: ChannelRegistry;
  private sessionStore: SessionStore;
  private cronService?: CronService;
  private ttsService: TTSService;
  private sttService: STTService;
  private visionService: VisionService;
  private config: InvarailConfig;
  private rateLimiter = new RateLimiter();
  private mediaDebouncer = new MediaDebouncer();
  private messageDebouncer = new MessageDebouncer();
  private heartbeatCron?: Cron;
  private embeddingStore?: EmbeddingStore;
  private webIndex?: import('./webindex/service.js').WebIndexService;
  private mcpManager?: import('./mcp/manager.js').McpManager;
  private selfModService?: SelfModService;
  /** sessionKey → full inbound messages typed while that session's dispatch is
   *  running (full messages so undrained leftovers can replay as normal traffic) */
  private steeringQueues = new Map<string, InboundMessage[]>();
  /** sessionKeys whose in-flight run should stop at the next iteration boundary (!stop) */
  private cancelRequests = new Set<string>();
  private factStore?: FactStore;
  private graphMemory?: GraphMemoryStore;
  /** Built in start(), so optional — handleMessage only runs after start(). */
  private memoryCapture?: MemoryCapture;
  private taskStore?: TaskStore;
  private pipelineRegistry: PipelineRegistry;
  executionMetrics: ExecutionMetricsStore;

  constructor(config: InvarailConfig) {
    this.config = config;
    this.client = createInferenceClient(config.ollama.url, config.ollama.keepAlive, config.inference?.backends, config.inference?.ollamaBackends, config.ollama.defaultContextSize);
    this.toolRegistry = new ToolRegistry();
    this.channelRegistry = new ChannelRegistry();
    this.sessionStore = new SessionStore(config.session.transcriptDir);
    this.ttsService = new TTSService(config.tts);
    this.sttService = new STTService(config.stt);
    this.visionService = new VisionService(config.vision, config.ollama.url);
    this.pipelineRegistry = new PipelineRegistry();
    registerAllPipelines(this.pipelineRegistry);
    this.executionMetrics = new ExecutionMetricsStore('data/metrics/execution.db');
  }

  getToolRegistry(): ToolRegistry {
    return this.toolRegistry;
  }

  getChannelRegistry(): ChannelRegistry {
    return this.channelRegistry;
  }

  async start(): Promise<void> {
    // Check Ollama
    const available = await this.client.isAvailable();
    if (!available) {
      throw ollamaUnreachable(this.config.ollama.url);
    }

    // Bootstrap workspaces
    for (const agent of this.config.agents.list) {
      const ws = resolveWorkspacePath(agent.id, this.config);
      bootstrapWorkspace(ws, agent.name);
    }

    // Initialize FactStore (legacy) + GraphMemoryStore
    const defaultWorkspacePath = resolveWorkspacePath(this.config.agents.default, this.config);
    // Memory tier (src/memory/policy.ts): the flat store never embeds without an embedder,
    // mirrors facts into the vault as OKF concepts on the vault tier, and the graph is only
    // attempted when the tier asks for it.
    this.factStore = new FactStore(defaultWorkspacePath, embeddingsEnabled(this.config.memory) ? this.client : undefined, {
      okf: okfEnabled(this.config) ? { vaultPath: this.config.vault.path, owner: this.config.ownerId } : undefined,
    });

    if (wantsGraph(this.config)) {
      // Initialize graph memory (FalkorDB) — non-blocking, falls back to FactStore if unavailable
      // Embedding model + dims come from config (were hardcoded in the store, 2026-09-19).
      this.graphMemory = new GraphMemoryStore(this.client, {
        nerModel: this.config.memory?.nerModel,
        embeddingModel: this.config.memory?.embeddingModel,
        embeddingDims: this.config.memory?.embeddingDims,
        ownerNames: ownerNames(this.config),
        ...this.config.memory.falkordb,
      });
      this.graphMemory.connect().then(() => {
        console.log('[Orchestrator] Graph memory connected');
      }).catch(err => {
        console.warn(`[Orchestrator] Graph memory unavailable, using flat FactStore${memoryBackend(this.config) === 'graph' ? ' (memory.backend is "graph" — run npm run doctor)' : ''}:`, err instanceof Error ? err.message : err);
        this.graphMemory = undefined;
      });
    } else {
      console.log(`[Orchestrator] Memory tier: ${memoryBackend(this.config)}${embeddingsEnabled(this.config.memory) ? '' : ', no embedder'}${okfEnabled(this.config) ? `, OKF vault at ${this.config.vault.path}` : ''}`);
    }

    // Incremental capture — closes the 2h hole between "said" and "in the graph".
    // Stores are passed as thunks: graphMemory becomes undefined if connect fails.
    this.memoryCapture = new MemoryCapture({
      config: this.config,
      factStore: () => this.factStore,
      graphMemory: () => this.graphMemory,
      loadTranscript: (agentId, sessionKey) => this.sessionStore.loadTranscript(agentId, sessionKey),
      extract: (transcript, recentlyRemoved, senderId) => this.extractFacts(transcript, recentlyRemoved, senderId),
      workspacePathFor: (agentId) => resolveWorkspacePath(agentId, this.config),
    });

    // Set up cron service
    if (this.config.cron.enabled) {
      const cronStore = new CronStore(this.config.cron.store);
      this.cronService = new CronService({
        store: cronStore,
        timezone: this.config.timezone,
        onTrigger: async (job) => {
          // No sessionStore — cron runs are stateless so each trigger
          // starts fresh without accumulating history from previous runs
          // If category is "cron" (generic default), let the router classify the message
          // to find the right pipeline. Explicit categories (web_search, research, etc.) are respected.
          const effectiveCategory = job.category === 'cron' ? undefined : job.category;

          // Every run gets its OWN persisted session (cron:<job>:<run>) — fresh
          // context (unique key = empty history) but an auditable, continuable
          // transcript. Cross-session memory search covers runs for free.
          const runId = Math.random().toString(36).slice(2, 8);
          const runSessionKey = `cron:${job.id}:${runId}`;
          const agentId = this.config.agents.default;
          const runStart = Date.now();
          const workspacePath = resolveWorkspacePath(agentId, this.config);

          const result = await dispatchMessage({
            client: this.client,
            registry: this.toolRegistry,
            config: this.config,
            message: job.message,
            overrideCategory: effectiveCategory,
            cronMode: true,
            agentId,
            sessionKey: runSessionKey,
            sessionStore: this.sessionStore,
            pipelineRegistry: this.pipelineRegistry,
            executionMetrics: this.executionMetrics,
            sourceContext: {
              channel: job.delivery.channel,
              channelId: job.delivery.target ?? '',
              // Cron jobs are owner-authored (cron_add is the code gate), so a run —
              // scheduled or manually triggered — inherits the owner's identity.
              // Without this every fire dispatched as "Untrusted user undefined" and
              // the untrusted layer stripped tools the job legitimately needs
              // (research charts lost code_session). cronMode's write-tool stripping
              // still applies on top — identity and autonomy bounds stay separate.
              senderId: this.config.ownerId,
            },
          });

          // Code-driven deliverable capture: files the run left in the workspace
          const artifacts = scanArtifacts(workspacePath, runStart);
          appendRunRecord({
            jobId: job.id,
            runId,
            name: job.name,
            sessionKey: runSessionKey,
            startedAt: new Date(runStart).toISOString(),
            durationMs: Date.now() - runStart,
            status: 'success',
            artifacts,
            resultPreview: result.answer.slice(0, 200),
          });

          if (job.delivery.target) {
            // Extract [FILE:]/[IMAGE:] tokens into real attachments (same as the normal message
            // path) — otherwise a cron that produces a PDF leaks the raw token into the chat text
            // and never delivers the file.
            const media = extractMediaAttachments(result.answer, { agentId });
            const artifactNote = artifacts.length > 0
              ? `\n📎 Files from this run:\n${artifacts.map(a => `- ${a}`).join('\n')}`
              : '';
            await this.channelRegistry.send(
              { channel: job.delivery.channel, channelId: job.delivery.target },
              {
                text: `[Cron: ${job.name}]\n${media.cleanText || result.answer}${artifactNote}`,
                attachments: media.attachments.length > 0 ? media.attachments : undefined,
              },
            );
          }
        },
        onFailure: async (job, error) => {
          appendDeadLetter({ source: 'cron', detail: job.name, error: error.slice(0, 300) });
          if (job.delivery.target) {
            await this.channelRegistry.send(
              { channel: job.delivery.channel, channelId: job.delivery.target },
              { text: `[Cron: ${job.name}] Failed after 3 attempts: ${error}` },
            ).catch((err) => { console.warn('[Cron] Failed to send failure notification:', err instanceof Error ? err.message : err); });
          }
        },
      });
    }

    // Set up task store
    const defaultWorkspace = resolveWorkspacePath(this.config.agents.default, this.config);
    this.taskStore = new TaskStore(
      join(defaultWorkspace, 'tasks.json'),
      join(defaultWorkspace, 'TASKS.md'),
    );
    const taskStore = this.taskStore;

    // Self-modification service (Phase B) — worktree arenas, gate, ledger-confirmed merges.
    // exit(42) is the supervisor handshake: "deploy restart requested" (0 = intentional stop).
    if (this.config.selfMod?.enabled) {
      const { sharedExperienceStore, experienceStoreConfigFrom } = await import('./memory/experience-store.js');
      this.selfModService = new SelfModService({
        config: this.config,
        graphMemory: this.graphMemory,
        experienceStore: sharedExperienceStore(this.client, experienceStoreConfigFrom(this.config.memory)),
        client: this.client,
        workspacePath: defaultWorkspace,
        onRestartRequested: () => {
          setTimeout(async () => {
            console.log('[SelfMod] Exiting 42 for supervised deploy restart');
            await this.stop().catch(() => undefined);
            process.exit(42);
          }, 3000); // grace for the confirmation reply to reach the channel
        },
      });
      this.selfModService.bootSweep();
    }

    // Interrupted-run sweep: journals surviving a restart are runs killed mid-flight —
    // write a synthetic transcript note so neither the model nor the user sees a silent vanish.
    try {
      const { sweepInterruptedRuns } = await import('./services/run-journal.js');
      const swept = sweepInterruptedRuns(this.sessionStore);
      if (swept > 0) console.log(`[Orchestrator] Swept ${swept} interrupted run(s) into session transcripts`);
    } catch (err) {
      console.warn('[Orchestrator] Run-journal sweep failed:', err instanceof Error ? err.message : err);
    }

    // Register all tools
    const { embeddingStore, mcpManager, webIndex } = await registerAllTools(this.toolRegistry, this.config, {
      cronService: this.cronService,
      channelRegistry: this.channelRegistry,
      ollamaClient: this.client,
      taskStore,
      heartbeatConfig: this.config.heartbeat,
      factStore: this.factStore,
      graphMemory: this.graphMemory,
      selfModService: this.selfModService,
    });
    this.embeddingStore = embeddingStore;
    this.mcpManager = mcpManager;
    this.webIndex = webIndex;
    this.webIndex?.start();

    // Set up message handler
    this.channelRegistry.onMessage(async (msg) => {
      await this.handleMessage(msg);
    });

    // Connect all enabled channels
    const channelConfigs: Record<string, ChannelAdapterConfig> = {};
    for (const [id, cfg] of Object.entries(this.config.channels)) {
      channelConfigs[id] = cfg as ChannelAdapterConfig;
    }
    await this.channelRegistry.connectAll(channelConfigs);

    // Inject console API deps into web adapter
    const webAdapter = this.channelRegistry.get('web') as WebApiAdapter | undefined;
    if (webAdapter?.injectDeps) {
      const consoleDeps: ConsoleApiDeps = {
        config: this.config,
        ollamaClient: this.client,
        toolRegistry: this.toolRegistry,
        channelRegistry: this.channelRegistry,
        sessionStore: this.sessionStore,
        taskStore: this.taskStore!,
        cronService: this.cronService,
        factStore: this.factStore,
        graphMemory: this.graphMemory,
        visionService: this.visionService,
        executionMetrics: this.executionMetrics,
        dispatch: (params) => dispatchMessage({
          client: this.client,
          registry: this.toolRegistry,
          config: this.config,
          pipelineRegistry: this.pipelineRegistry,
            executionMetrics: this.executionMetrics,
          ...params,
        }),
      };
      webAdapter.injectDeps(consoleDeps);
    }

    // Start cron
    if (this.cronService) {
      await this.cronService.start();
    }

    // Set up heartbeat (maintenance only — transcript review, cleanup, promotion)
    if (this.config.heartbeat?.enabled) {
      const hb = this.config.heartbeat;
      this.heartbeatCron = new Cron(hb.schedule, { timezone: this.config.timezone }, async () => {
        await this.runHeartbeat();
      });
      const next = this.heartbeatCron.nextRun();
      console.log(`[Heartbeat] Scheduled (${hb.schedule}) — next run: ${next?.toISOString() ?? 'unknown'}`);

      // Briefings — separate schedule: 8:00am, 1:15pm, 5:00pm
      const briefingSchedule = '0 8 * * *;15 13 * * *;0 17 * * *';
      for (const schedule of briefingSchedule.split(';')) {
        new Cron(schedule.trim(), { timezone: this.config.timezone }, async () => {
          await this.runBriefing();
        });
      }
      console.log('[Briefing] Scheduled at 8:00am, 1:15pm, 5:00pm');
    }

    // Email steward fast-lane poll (read-only, informs only — never writes email).
    // Peter's rule: EMPTY fast-lane lists → this cron is not scheduled at all; the 2h
    // heartbeat still runs the inbox check itself, so the digest lane works regardless.
    const et = this.config.emailTriage;
    if (et?.enabled && (et.fastLane.aliases.length + et.fastLane.senders.length > 0)) {
      const { checkInbox } = await import('./services/email-steward.js');
      new Cron(`*/${et.pollMinutes} * * * *`, { timezone: this.config.timezone }, async () => {
        try {
          await checkInbox({
            config: this.config,
            client: this.client,
            send: (target, text) => this.channelRegistry.send({ channel: target.channel, channelId: target.channelId }, { text }).then(() => undefined),
          });
        } catch (err) {
          console.warn('[Steward] Poll failed:', err instanceof Error ? err.message : err);
        }
      });
      console.log(`[Steward] Email fast-lane poll every ${et.pollMinutes}m (${et.fastLane.aliases.length} alias(es), ${et.fastLane.senders.length} VIP sender(s))`);
    } else if (et?.enabled) {
      console.log('[Steward] Email triage enabled, fast-lane lists empty — digest-only via heartbeat (no poll cron)');
    }

    const models = await this.client.listModels();
    console.log(`[Orchestrator] Models: ${models.length} | Tools: ${this.toolRegistry.list().length} | Channels: ${this.channelRegistry.list().join(', ') || 'none'}`);
    console.log('[Orchestrator] Started');
  }

  async stop(): Promise<void> {
    // FIRST: tear down every in-flight inference request — orphaned generations
    // and embeds wedge upstream queues for the next boot (2026-08-16).
    abortAllInference('orchestrator stop');
    this.heartbeatCron?.stop();
    this.cronService?.stop();
    this.webIndex?.stop();
    this.embeddingStore?.close();
    await this.mcpManager?.stop();
    await this.channelRegistry.disconnectAll();
    console.log('[Orchestrator] Stopped');
  }

  /** Heartbeat — delegates to extracted HeartbeatService */
  /** Confirm/Always/Deny buttons for the most recent pending action a dispatch
   *  recorded. A press synthesizes the equivalent typed reply ("confirm <id>")
   *  through the normal inbound path — same choke point, zero new surface. */
  private confirmActionsFor(result: { pendingActions?: Array<{ id: string; tool: string }> }): Array<{ command: string; label: string; style?: 'primary' | 'success' | 'danger' }> | undefined {
    if (!result.pendingActions?.length) return undefined;
    const p = result.pendingActions[result.pendingActions.length - 1];
    return [
      { command: `confirm ${p.id}`, label: '✅ Confirm', style: 'success' },
      { command: `always ${p.id}`, label: '🔓 Always for this target', style: 'primary' },
      { command: `deny ${p.id}`, label: '🚫 Deny', style: 'danger' },
    ];
  }

  private async runHeartbeat(): Promise<void> {
    await runHeartbeat({
      config: this.config,
      client: this.client,
      toolRegistry: this.toolRegistry,
      channelRegistry: this.channelRegistry,
      sessionStore: this.sessionStore,
      factStore: this.factStore,
      graphMemory: this.graphMemory,
      taskStore: this.taskStore,
      cronService: this.cronService,
      embeddingStore: this.embeddingStore,
      selfModService: this.selfModService,
      extractFacts: this.extractFacts.bind(this),
      reviewTranscripts: this.reviewTranscripts.bind(this),
      promoteRecurringLearnings: this.promoteRecurringLearnings.bind(this),
      cleanupOldMedia: this.cleanupOldMedia.bind(this),
      heartbeatPendingPath: this.heartbeatPendingPath.bind(this),
    });
  }

  /** Briefing — delegates to extracted BriefingService */
  private async runBriefing(): Promise<void> {
    await runBriefing({
      config: this.config,
      client: this.client,
      toolRegistry: this.toolRegistry,
      channelRegistry: this.channelRegistry,
      factStore: this.factStore,
      taskStore: this.taskStore,
      sessionStore: this.sessionStore,
    });
  }

  private async extractFacts(
    transcript: import('./sessions/types.js').ConversationTurn[],
    recentlyRemoved?: Array<{ text: string; reason: string }>,
    senderId?: string,
  ): Promise<FactInput[]> {
    const userTurns = transcript.filter(t => t.role === 'user');
    console.log(`[Facts] Transcript has ${transcript.length} turns (${userTurns.length} user)`);
    if (userTurns.length < 2) {
      console.log('[Facts] Skipping — fewer than 2 user turns');
      return [];
    }

    // Build a condensed version of the conversation
    // Strip thinking from assistant turns — <think> blocks are preserved in transcripts
    // for model continuity but shouldn't be fed to the fact extraction model.
    const lines = transcript
      .filter(t => t.role === 'user' || t.role === 'assistant')
      .map(t => {
        const content = t.role === 'assistant' ? stripThinkingTags(t.content) : t.content;
        return `${t.role === 'user' ? 'User' : 'Assistant'}: ${content.slice(0, 1000)}`;
      });

    // Bound the transcript to the extraction model's window. The instruction block
    // (incl. the USER.md profile and the already-stored list) is reserved for up
    // front; whatever remains is the transcript's. Overflow here is not a quality
    // degradation, it is a mode failure: Ollama truncates from the FRONT, so the
    // instructions vanish first and the model continues the chat instead of
    // extracting from it (2026-09-20, 80-turn !reset).
    const numCtx = this.config.memory?.extractionContextSize ?? 8192;
    const EXTRACTION_PROMPT_RESERVE_TOKENS = 2500;
    const EXTRACTION_OUTPUT_TOKENS = 1024;
    const { kept, dropped } = fitLinesToTokenBudget(lines, numCtx - EXTRACTION_PROMPT_RESERVE_TOKENS - EXTRACTION_OUTPUT_TOKENS);
    if (dropped > 0) {
      console.warn(`[Facts] Transcript exceeds extraction window (num_ctx=${numCtx}) — dropped the oldest ${dropped} of ${lines.length} turns`);
    }
    const condensed = kept.join('\n');

    // Guard against prompt injection — skip turns with suspiciously long content
    if (userTurns.some(t => t.content.length > 10_000)) {
      console.log('[Facts] Skipping — user turn exceeds 10k chars');
      return [];
    }

    const extractionModel = this.config.memory?.extractionModel ?? this.config.router.model;
    console.log(`[Facts] Calling ${extractionModel} for extraction (${condensed.length} chars)`);
    const response = await this.client.chat({
      model: extractionModel,
      messages: [
        {
          role: 'system',
          content: [
            'Extract salient facts about the USER from this conversation.',
            'Only factual information — preferences, setup details, decisions, personal info.',
            'Do NOT extract instructions, commands, or assistant actions.',
            'Do NOT extract ephemeral data (stock prices, weather, timestamps, news headlines).',
            'Do NOT extract search results, tool output, event listings, or web content the assistant found.',
            'Do NOT extract things the assistant TOLD the user — only things the user TOLD the assistant or that reveal who the user IS.',
            'Do NOT infer. Record what the user STATED, not what it implies. If a fact contains "aiming for", "rather than", "in order to", or a motive/model/plan the user did not put into words, it is your inference — drop it. First live capture (2026-09-20) turned "my goal is to make me redundant" into "one-time setup rather than recurring revenue"; the user\'s next message said the opposite (retainer).',
            'When the user gives a REASON for a decision in their own words ("too rich for my blood", "because X"), keep the reason inside the fact — the reason is the part worth remembering later. Stated reasons only, never one you supply.',
            'CONSOLIDATE related info into ONE fact. If a task has a due date, priority, and description — that is ONE fact, not three.',
            'Aim for the FEWEST facts that capture ALL the information. Fewer is better.',
            'Use ABSOLUTE dates, never relative ones — "yesterday"/"next Thursday" are meaningless when the fact is read weeks later; convert to the actual date.',
            '',
            'Return a JSON array: [{"text":"fact","cat":"stable|context|decision|question","conf":0.0-1.0,"tags":["keyword"],"entities":["ProperNoun"],"imp":1-5}]',
            '',
            'Categories: stable = permanent facts, context = temporary/situational, decision = choices made, question = open questions.',
            '',
            'IMPORTANCE (imp) — you MUST assign this accurately:',
            '  5 = critical: health conditions, family members, safety issues',
            '  4 = identity: job title, employer, key projects, certifications',
            '  3 = preference: tool choices, food preferences, communication style',
            '  2 = context: current tasks, upcoming events, temporary situations',
            '  1 = ephemeral: one-off mentions, passing comments',
            '',
            'Examples:',
            '  User: "My partner has been dealing with back pain" → imp:5 (family + health)',
            '  User: "I work at DevMesh as an ML engineer" → imp:4 (identity)',
            '  User: "I prefer dark mode in all my editors" → imp:3 (preference)',
            '  User: "I have a meeting with the team tomorrow" → imp:2 (context)',
            '  User: "Yeah I saw that article too" → imp:1 or skip entirely',
            '',
            'If nothing worth remembering, return [].',
            ...((() => {
              // USER.md is the authoritative owner profile — hand-written, read-only
              // to the agent. Anything already in it must never become a graph fact:
              // that is the two-stores-one-truth seam, and the duplicate would carry
              // a weaker provenance than the file it copied.
              try {
                const profile = readFileSync(join(resolveWorkspacePath(this.config.agents.default, this.config), 'USER.md'), 'utf-8').trim();
                if (profile) return ['', 'OWNER PROFILE (authoritative — do NOT extract anything already stated here):', profile.slice(0, 2000)];
              } catch { /* no USER.md is fine */ }
              return [];
            })()),
            ...((() => {
              // Show existing facts so the LLM avoids re-extracting them
              if (this.factStore && senderId) {
                try {
                  const existing = this.factStore.loadFactsJson(senderId);
                  if (existing.length > 0) {
                    const summary = existing.slice(0, 15).map(f => `- "${f.text}"`).join('\n');
                    return ['', `ALREADY STORED (do NOT re-extract these or paraphrases of these):`, summary];
                  }
                } catch { /* best-effort */ }
              }
              return [];
            })()),
            ...(recentlyRemoved && recentlyRemoved.length > 0 ? [
              '',
              'IMPORTANT: The user has explicitly REMOVED these facts. Do NOT re-extract anything similar:',
              ...recentlyRemoved.slice(0, 10).map(r => `- "${r.text}" (removed: ${r.reason})`),
            ] : []),
          ].join('\n'),
        },
        { role: 'user', content: condensed },
      ],
      options: { temperature: 0.1, num_predict: EXTRACTION_OUTPUT_TOKENS, num_ctx: numCtx },
    });

    const raw = response.message.content.trim();
    console.log(`[Facts] Model response: ${raw.slice(0, 300)}`);
    try {
      const match = raw.match(/\[[\s\S]*\]/);
      if (!match) {
        console.log('[Facts] No JSON array found in response');
        return [];
      }
      const parsed = JSON.parse(match[0]);
      if (!Array.isArray(parsed)) return [];

      // Support both structured objects and plain strings (backward compat)
      const facts: FactInput[] = parsed
        .filter((f: unknown) => f && (typeof f === 'string' || typeof f === 'object'))
        .map((f: unknown): FactInput => {
          if (typeof f === 'string') {
            return { text: f, category: 'stable', confidence: 0.8, tags: [], entities: [] };
          }
          const obj = f as Record<string, unknown>;
          const tags = Array.isArray(obj.tags)
            ? obj.tags.filter((t: unknown): t is string => typeof t === 'string')
            : [];
          const entities = Array.isArray(obj.entities)
            ? obj.entities.filter((e: unknown): e is string => typeof e === 'string')
            : [];
          return {
            text: String(obj.text ?? ''),
            category: (['stable', 'context', 'decision', 'question'].includes(obj.cat as string)
              ? obj.cat as FactInput['category']
              : 'stable'),
            confidence: typeof obj.conf === 'number' ? Math.min(1, Math.max(0, obj.conf)) : 0.8,
            importance: typeof obj.imp === 'number'
              ? Math.min(5, Math.max(1, Math.round(obj.imp)))
              : (console.warn(`[Facts] Missing imp for "${String(obj.text).slice(0, 50)}" — defaulting to 2`), 2),
            tags,
            entities,
          };
        })
        .filter(f => f.text.length > 0);

      console.log(`[Facts] Extracted ${facts.length} fact(s)`);
      return facts;
    } catch {
      console.warn('[Facts] Failed to parse model response as JSON');
      return [];
    }
  }

  /** The orchestrator as the built-in commands see it (src/commands/builtin.ts). */
  private commandHost(): CommandHost {
    return {
      config: this.config,
      client: this.client,
      toolRegistry: this.toolRegistry,
      channelRegistry: this.channelRegistry,
      sessionStore: this.sessionStore,
      pipelineRegistry: this.pipelineRegistry,
      executionMetrics: this.executionMetrics,
      selfModService: this.selfModService,
      factStore: this.factStore,
      graphMemory: this.graphMemory,
      memoryCapture: this.memoryCapture,
      steeringQueues: this.steeringQueues,
      cancelRequests: this.cancelRequests,
      pendingPath: (w, s) => this.pendingPath(w, s),
      heartbeatPendingPath: (w, s) => this.heartbeatPendingPath(w, s),
      extractFacts: (t, r, s) => this.extractFacts(t, r, s),
      promoteRecurringLearnings: (w) => this.promoteRecurringLearnings(w),
      confirmActionsFor: (r) => this.confirmActionsFor(r),
    };
  }

  private pendingPath(workspacePath: string, senderId: string): string {
    return join(workspacePath, 'memory', senderId, 'pending.json');
  }

  private heartbeatPendingPath(workspacePath: string, senderId: string): string {
    return join(workspacePath, 'memory', senderId, 'heartbeat-pending.json');
  }

  /**
   * Review recent session transcripts and extract facts via FactStore.
   * Called by the heartbeat — autonomous, no user approval needed.
   */
  /**
   * Scan error store for recurring patterns (3+ occurrences) and promote
   * them to LEARNINGS.md in the workspace root for injection into context.
   */
  /** Delete generated media files older than 7 days. Returns count of files removed. */
  private cleanupOldMedia(): number {
    const MEDIA_DIRS = ['data/media/documents', 'data/media/browser'];
    const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
    const now = Date.now();
    let removed = 0;

    for (const dir of MEDIA_DIRS) {
      if (!existsSync(dir)) continue;
      try {
        for (const file of readdirSync(dir)) {
          const filePath = join(dir, file);
          try {
            const stat = statSync(filePath);
            if (stat.isFile() && now - stat.mtimeMs > MAX_AGE_MS) {
              unlinkSync(filePath);
              removed++;
            }
          } catch { /* skip unreadable files */ }
        }
      } catch { /* skip unreadable dirs */ }
    }

    // Also clean old research HTML files (not the workspace, just research output)
    const researchDir = 'data/workspaces/main/research';
    if (existsSync(researchDir)) {
      try {
        for (const entry of readdirSync(researchDir)) {
          const entryPath = join(researchDir, entry);
          try {
            const stat = statSync(entryPath);
            if (stat.isFile() && now - stat.mtimeMs > MAX_AGE_MS) {
              unlinkSync(entryPath);
              removed++;
            }
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }

    return removed;
  }

  private async promoteRecurringLearnings(workspacePath: string): Promise<number> {
    try {
      const { ErrorLearningStore } = await import('./learnings/error-store.js');
      const store = new ErrorLearningStore(workspacePath);
      const entries = store.loadAll();
      if (entries.length === 0) return 0;

      // Group by tool + normalized error prefix (first 60 chars)
      const groups = new Map<string, { tool: string; error: string; count: number }>();
      for (const e of entries) {
        const key = `${e.tool}:${e.error.slice(0, 60).toLowerCase().trim()}`;
        const existing = groups.get(key);
        if (existing) {
          existing.count++;
        } else {
          groups.set(key, { tool: e.tool, error: e.error.slice(0, 150), count: 1 });
        }
      }

      // Filter to patterns with 3+ occurrences
      const recurring = [...groups.values()].filter(g => g.count >= 3);
      if (recurring.length === 0) return 0;

      // Read existing LEARNINGS.md for dedup
      const learningsPath = join(workspacePath, 'LEARNINGS.md');
      let existing = '';
      try { existing = readFileSync(learningsPath, 'utf-8'); } catch { /* doesn't exist yet */ }

      const newLines: string[] = [];
      for (const r of recurring) {
        const line = `- **${r.tool}**: ${r.error} (${r.count}x)`;
        // Dedup: skip if tool+error prefix already in file
        if (existing.includes(r.tool) && existing.includes(r.error.slice(0, 40))) continue;
        newLines.push(line);
      }

      if (newLines.length === 0) return 0;

      const content = existing
        ? existing.trimEnd() + '\n' + newLines.join('\n') + '\n'
        : `# Learnings\n\nRecurring error patterns promoted from tool execution history.\n\n${newLines.join('\n')}\n`;

      writeFileSync(learningsPath, content);
      return newLines.length;
    } catch (err) {
      console.warn('[Heartbeat] Learning promotion failed:', err instanceof Error ? err.message : err);
      return 0;
    }
  }

  private async reviewTranscripts(workspacePath: string, agentId: string): Promise<FactInput[]> {
    const sessionsDir = join(this.config.session.transcriptDir, agentId);
    if (!existsSync(sessionsDir)) return [];

    // Load last review timestamp
    const markerPath = join(workspacePath, 'memory', 'last-review.json');
    let lastReviewAt = 0;
    try {
      const marker = JSON.parse(readFileSync(markerPath, 'utf-8'));
      lastReviewAt = new Date(marker.reviewedAt).getTime();
    } catch { /* first run */ }

    // Find session files modified since last review
    const sessionFiles = readdirSync(sessionsDir)
      .filter(f => f.endsWith('.json') && !f.endsWith('.meta.json') && !f.endsWith('.summary.json'));

    const allFacts: FactInput[] = [];

    for (const file of sessionFiles) {
      const filePath = join(sessionsDir, file);
      const stat = statSync(filePath);
      if (stat.mtimeMs <= lastReviewAt) continue;

      // Extract senderId from session filename (format: agentId:channel:...:senderId.json)
      const sessionKey = file.replace(/\.json$/, '');
      const parts = sessionKey.split(':');
      // Session filenames carry the raw channel sender — facts key on the principal
      const senderId = resolvePrincipal(parts.length > 0 ? parts[parts.length - 1] : 'unknown', this.config);

      try {
        const data = readFileSync(filePath, 'utf-8');
        const transcript = JSON.parse(data) as import('./sessions/types.js').ConversationTurn[];
        if (!Array.isArray(transcript) || transcript.length === 0) continue;

        // Load recently-removed facts to suppress re-extraction
        const recentlyRemoved = this.factStore?.loadRecentlyRemoved(senderId) ?? [];
        const facts = await this.extractFacts(transcript, recentlyRemoved, senderId);
        if (facts.length > 0) {
          allFacts.push(...facts);
          console.log(`[Heartbeat] Extracted ${facts.length} facts from ${file} (user: ${senderId})`);

          // Write through FactStore (flat) + GraphMemory (graph)
          if (this.factStore) {
            await this.factStore.writeFactsBatch(facts, senderId, `session/${file}`);
            this.factStore.rebuildFacts(senderId);
          }
          if (this.graphMemory) {
            for (const fact of facts) {
              try {
                await this.graphMemory.addFact(fact, senderId, sessionKey);
              } catch (err) {
                console.warn(`[Heartbeat] Graph write failed for "${fact.text.slice(0, 50)}":`, err instanceof Error ? err.message : err);
              }
            }
          }
        }
      } catch {
        // Skip unreadable/corrupt transcripts
      }
    }

    // Update marker
    mkdirSync(join(workspacePath, 'memory'), { recursive: true });
    writeFileSync(markerPath, JSON.stringify({ reviewedAt: new Date().toISOString() }));

    return allFacts;
  }

  private async handleMessage(msg: InboundMessage): Promise<void> {
    // Media debounce: batch rapid media-only messages from the same sender
    if (this.mediaDebouncer.tryBatch(msg, (batchedMsg) => this.handleMessage(batchedMsg))) {
      return; // Message collected, waiting for batch timer
    }

    // Text debounce: reassemble a long paste that the channel split into multiple messages,
    // so it routes as ONE job instead of scattering across categories.
    if (this.messageDebouncer.tryBatch(msg, (batchedMsg) => this.handleMessage(batchedMsg))) {
      return;
    }

    if (this.rateLimiter.isLimited(msg.senderId)) {
      console.log(`[Orchestrator] Rate limited: ${msg.senderId}`);
      await this.channelRegistry.send(
        { channel: msg.channel, channelId: msg.channelId!, replyToId: msg.id },
        { text: 'You\'re sending messages too quickly. Please wait a moment.' },
      ).catch((err) => {
        console.warn('[Orchestrator] Failed to send rate-limit notice:', err instanceof Error ? err.message : err);
      });
      return;
    }

    // Identity: memory, ledger, and review files key on the PRINCIPAL so the
    // person's knowledge follows them across channels. Routing/session keys
    // deliberately stay on the raw sender (conversation unification = Slice 3).
    const principal = resolvePrincipal(msg.senderId, this.config);
    // Set when this handler registers a steering queue — the finally block
    // MUST clear it or the session reads as busy forever
    let activeSteeringKey: string | null = null;

    // Handle slash commands — every `!…` lives in src/commands/builtin.ts (carved out
    // 2026-09-27; behavior-preserving). It answers and returns true, or defers to dispatch.
    const trimmed = msg.content.trim().toLowerCase();
    if (trimmed.startsWith('!') && await runBuiltinCommand(this.commandHost(), msg, principal, trimmed)) return;

    // Handle pending file choice (user replies "1" or "2" after text file upload)
    if (trimmed === '1' || trimmed === '2') {
      const route = resolveRoute(
        { channel: msg.channel, senderId: msg.senderId, guildId: msg.guildId, channelId: msg.channelId },
        this.config,
      );
      const workspacePath = resolveWorkspacePath(route.agentId, this.config);
      const pendingFilePath = join(workspacePath, 'memory', principal, 'pending-file.json');
      try {
        const raw = readFileSync(pendingFilePath, 'utf-8');
        const pending = JSON.parse(raw) as { filePath: string; filename: string; mimeType: string };
        unlinkSync(pendingFilePath);

        if (trimmed === '1') {
          // Import to knowledge base
          const importTool = this.toolRegistry.get('knowledge_import');
          if (importTool) {
            const result = await importTool.execute({ path: pending.filePath }, {
              agentId: route.agentId,
              sessionKey: route.sessionKey,
              workspacePath,
              senderId: principal,
            });
            await this.channelRegistry.send(
              { channel: msg.channel, channelId: msg.channelId!, replyToId: msg.id },
              { text: `Imported **${pending.filename}** to knowledge base. ${result}` },
            );
          } else {
            await this.channelRegistry.send(
              { channel: msg.channel, channelId: msg.channelId!, replyToId: msg.id },
              { text: 'Knowledge import tool not available.' },
            );
          }
        } else {
          // Read as text and inject into next message context
          const { readFileSync: readFs } = await import('node:fs');
          const content = readFs(pending.filePath, 'utf-8');
          const preview = content.length > 5000 ? content.slice(0, 5000) + '\n... [truncated]' : content;
          msg.content = `[File content: ${pending.filename}]\n\n${preview}\n\nUser message: ${msg.content}`;
          // Fall through to normal dispatch below
        }
        if (trimmed === '1') return;
      } catch {
        // No pending file — treat as normal message, fall through
      }
    }

    // STT pre-processing: transcribe voice messages to text
    const hadAudio = !!msg.audio;
    // Voice turns log a per-stage breakdown — "it's slow" was unanswerable without
    // it (2026-09-25: the seconds were model eviction on the 3060, not the servers).
    let sttMs = 0;
    if (msg.audio && this.sttService.enabled) {
      const sttStart = Date.now();
      const transcription = await this.sttService.transcribe(msg.audio.data, msg.audio.mimeType);
      sttMs = Date.now() - sttStart;
      if (transcription) {
        console.log(`[Orchestrator] STT transcribed: "${transcription.slice(0, 80)}${transcription.length > 80 ? '...' : ''}"`);
        msg.content = transcription;
        msg.onProgress?.('stt', { transcript: transcription });
      } else {
        console.warn('[Orchestrator] STT transcription failed, using original content');
      }
    }

    // Attachment pre-processing: save files, route by file type
    let hasImageAttachment = false;
    let attachedImagePath: string | undefined;
    let fileOverrideCategory: string | undefined;
    const DATA_EXTENSIONS = new Set(['csv', 'xlsx', 'xls', 'json', 'tsv']);
    const TEXT_EXTENSIONS = new Set(['md', 'txt', 'html', 'htm', 'log', 'xml', 'yaml', 'yml']);
    const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'avi', 'webm', 'mkv', 'm4v']);

    // The user's actual instruction, captured before any attachment text is prepended — used
    // for routing so a document's contents can't hijack keyword/override classification.
    const userCaption = msg.content;

    if (msg.attachments?.length) {
      const prefixes: string[] = [];
      const suffixes: string[] = [];

      for (const att of msg.attachments) {
        const saved = saveAttachment(att, msg.channel, msg.id);
        if (!saved) continue;

        const ext = saved.filename.split('.').pop()?.toLowerCase() ?? '';

        if (saved.isImage) {
          hasImageAttachment = true;
          if (attachedImagePath === undefined) attachedImagePath = saved.localPath;
          if (this.visionService.enabled) {
            console.log(`[Orchestrator] Running vision on ${saved.filename} (${att.data.length} bytes, ${att.mimeType})`);
            const description = await this.visionService.describe(att.data, att.mimeType);
            if (description) {
              console.log(`[Orchestrator] Vision result: "${description.slice(0, 100)}..."`);
              prefixes.push(`[The user attached an image. Vision analysis: ${description}]\nUse the above description to answer the user's question about the image.`);
            } else {
              console.log('[Orchestrator] Vision returned null');
              prefixes.push(`[The user attached an image (${saved.filename}) but vision analysis was unavailable.]`);
            }
          } else {
            prefixes.push(`[The user attached an image (${saved.filename}) but vision is not enabled.]`);
          }
        } else if (att.mimeType === 'application/pdf') {
          try {
            const pdfParse = (await import('pdf-parse')).default;
            const pdf = await pdfParse(att.data);
            const text = pdf.text.trim();
            if (text) {
              console.log(`[Orchestrator] Extracted ${text.length} chars from PDF: ${saved.filename}`);
              // End-delimited so the memory-priming query can strip the body: embedding
              // 9K chars of document on the Mini blew the 8s priming cap (2026-09-21).
              prefixes.push(`[The user attached a PDF: ${saved.filename}. Extracted text below:]\n\n${text}\n\n[End of attached PDF text]`);
            } else {
              suffixes.push(`[Attached PDF: ${saved.filename} but no text could be extracted (scanned/image PDF).]`);
            }
          } catch (err) {
            const wrapped = err instanceof InvarailError ? err : toolExecutionError('pdf-parse', err);
            console.warn(`[Orchestrator] PDF extraction failed for ${saved.filename}: ${wrapped.message}`);
            suffixes.push(`[Attached file: ${saved.localPath}] (${saved.filename}, ${saved.mimeType})`);
          }
        } else if (DATA_EXTENSIONS.has(ext)) {
          // Data files → exec (the analytics pipeline was retired 2026-08-10;
          // exec's code_session covers pandas/matplotlib work on request)
          console.log(`[Orchestrator] Data file detected: ${saved.filename} → exec`);
          fileOverrideCategory = 'exec';
          prefixes.push(`[The user uploaded a data file: ${saved.localPath}] (${saved.filename}) — analyze it with code_session (pandas) if asked for stats or charts.`);
          msg.content = msg.content || `Analyze this ${ext.toUpperCase()} file`;
        } else if (TEXT_EXTENSIONS.has(ext) || ext === 'docx') {
          // Text-based files → ask user what to do
          console.log(`[Orchestrator] Text file detected: ${saved.filename} — asking user`);
          await this.channelRegistry.send(
            { channel: msg.channel, channelId: msg.channelId!, replyToId: msg.id },
            { text: `I received **${saved.filename}**. Would you like me to:\n1. **Import** it to the knowledge base (searchable across sessions)\n2. **Read** it as text for this conversation\n\nReply **1** or **2**.` },
          );
          // Store pending file choice (similar to !save pending). MUST use the same
          // route + principal resolution as the "1"/"2" reply handler — the writer
          // keyed on raw msg.senderId while the reader keyed on the resolved principal
          // (live-caught 2026-08-28: "2" fell through to the model, which had never
          // seen the question). Same siloing class the principals migration fixed.
          const pendingRoute = resolveRoute(
            { channel: msg.channel, senderId: msg.senderId, guildId: msg.guildId, channelId: msg.channelId },
            this.config,
          );
          const pendingDir = join(resolveWorkspacePath(pendingRoute.agentId, this.config), 'memory', principal);
          mkdirSync(pendingDir, { recursive: true });
          writeFileSync(join(pendingDir, 'pending-file.json'), JSON.stringify({
            filePath: saved.localPath,
            filename: saved.filename,
            mimeType: saved.mimeType,
            channel: msg.channel,
            channelId: msg.channelId,
          }));
          return; // Wait for user's reply
        } else if (VIDEO_EXTENSIONS.has(ext) || att.mimeType.startsWith('video/')) {
          // Videos: save but don't process (no video analysis pipeline yet)
          const sizeMB = (att.size / (1024 * 1024)).toFixed(1);
          console.log(`[Orchestrator] Video saved: ${saved.filename} (${sizeMB} MB)`);
          suffixes.push(`[The user sent a video: ${saved.filename} (${sizeMB} MB). The video has been saved but video analysis is not currently available.]`);
        } else {
          suffixes.push(`[Attached file: ${saved.localPath}] (${saved.filename}, ${saved.mimeType})`);
        }
      }

      if (prefixes.length > 0) {
        msg.content = prefixes.join('\n\n') + '\n\n' + msg.content;
      }
      if (suffixes.length > 0) {
        msg.content = msg.content + '\n' + suffixes.join('\n');
      }
    }

    const route = resolveRoute(
      {
        channel: msg.channel,
        senderId: msg.senderId,
        guildId: msg.guildId,
        channelId: msg.channelId,
      },
      this.config,
    );

    console.log(`[Orchestrator] ${msg.senderName ?? msg.senderId} → agent:${route.agentId} (${route.matchedBy})`);

    try {
      const format = this.config.tts.format;
      const mimeMap: Record<string, string> = { opus: 'audio/ogg', wav: 'audio/wav', mp3: 'audio/mpeg' };
      const audioMime = mimeMap[format] ?? 'audio/ogg';

      // Confirmation follow-up — ONE entry point shared with the console path
      // (src/security/confirm-handler.ts). Executes stored params, principal-
      // bound, audit-hardened semantics.
      const confirmOutcome = await handleConfirmation({
        message: trimmed,
        senderId: msg.senderId,
        channel: msg.channel,
        config: this.config,
        toolRegistry: this.toolRegistry,
        sessionStore: this.sessionStore,
      });
      if (confirmOutcome.handled) {
        // Confirmed tools can produce media (image_generate, document) — run
        // the same [FILE:] extraction as the normal reply path, else the token
        // prints as literal text and the attachment never reaches the channel
        const confirmMedia = extractMediaAttachments(confirmOutcome.reply!, { agentId: confirmOutcome.executed?.agentId });
        await this.channelRegistry.send(
          { channel: msg.channel, channelId: msg.channelId!, guildId: msg.guildId, replyToId: msg.id },
          {
            text: confirmMedia.cleanText || confirmOutcome.reply!,
            attachments: confirmMedia.attachments.length > 0 ? confirmMedia.attachments : undefined,
          },
        );
        // Continuation: feed the confirmed tool result back into the
        // originating session for ONE follow-up turn (with the original
        // category's toolset) so multi-step work survives the confirm gap
        // instead of dying at the preview. Any NEW confirm-gated call inside
        // the continuation is gated again — no loophole.
        if (confirmOutcome.executed && this.config.session.continueAfterConfirm) {
          const ex = confirmOutcome.executed;
          try {
            const cont = await dispatchMessage({
              client: this.client,
              registry: this.toolRegistry,
              config: this.config,
              message: `[SYSTEM] The user approved and ${ex.tool} has now run: ${ex.observation.slice(0, 600)}\nIf the original task had remaining steps, continue them now. If it is complete, reply with a single short wrap-up line.`,
              agentId: ex.agentId,
              sessionKey: ex.sessionKey,
              sessionStore: this.sessionStore,
              pipelineRegistry: this.pipelineRegistry,
              overrideCategory: ex.category ?? 'chat',
              sourceContext: {
                channel: msg.channel,
                channelId: msg.channelId ?? '',
                guildId: msg.guildId,
                senderId: msg.senderId,
              },
              factStore: this.factStore,
              graphMemory: this.graphMemory,
            });
            // Replay circuit breaker: a continuation asking to confirm the
            // SAME tool that just ran successfully is re-deriving the task
            // (the Aug 6 continuation-replay class — full redesign still
            // planned). The deliverable already exists; cancel the replayed
            // pending and wrap up instead of a déjà-vu confirm button.
            const replays = (cont.pendingActions ?? []).filter(p => p.tool === ex.tool);
            if (replays.length > 0) {
              const { pendingActions: ledger } = await import('./security/pending-actions.js');
              for (const r of replays) ledger.consume(r.id);
              console.log(`[Orchestrator] Continuation replay broken: cancelled ${replays.length} duplicate ${ex.tool} confirm(s)`);
              await this.channelRegistry.send(
                { channel: msg.channel, channelId: msg.channelId! },
                { text: `✅ All done — **${ex.tool}** already ran and the result was delivered above.` },
              ).catch(() => {});
            } else {
              const contText = cont.answer?.trim();
              if (contText) {
                await this.channelRegistry.send(
                  { channel: msg.channel, channelId: msg.channelId! },
                  { text: contText, actions: this.confirmActionsFor(cont) },
                );
              }
            }
          } catch (err) {
            console.warn('[Orchestrator] Post-confirm continuation failed:', err instanceof Error ? err.message : err);
          }
        }
        return;
      }

      // Steering: a message arriving while THIS session is mid-dispatch folds
      // into the running tool loop (drained between iterations) instead of
      // colliding as a parallel dispatch on the same session. Full inbound
      // messages are queued so anything the loop finishes without draining is
      // replayed as a normal message — nothing is silently lost.
      const steeringKey = `${route.agentId}:${route.sessionKey}`;
      const activeQueue = this.steeringQueues.get(steeringKey);
      if (activeQueue) {
        activeQueue.push(msg);
        console.log(`[Orchestrator] Steering queued for busy session ${steeringKey}: "${msg.content.slice(0, 60)}"`);
        await this.channelRegistry.send(
          { channel: msg.channel, channelId: msg.channelId!, replyToId: msg.id },
          { text: '📥 Got it — folding that into the task that\'s already running.' },
        ).catch(() => {});
        return;
      }
      this.steeringQueues.set(steeringKey, []);
      activeSteeringKey = steeringKey;

      // Browser extension injects [PAGE:] context — route to chat, content is already in the message
      const fromExtension = msg.content.includes('[PAGE:');
      if (fromExtension) {
        console.log('[Orchestrator] Browser extension context detected → chat');
      }

      // Intake write-side: a reply following a briefing may answer one of its
      // prep questions — capture it into the prep-context store so the question
      // is never re-asked. Fire-and-forget: the chat reply must not wait on it.
      try {
        const lastTurns = this.sessionStore.loadTranscript(route.agentId, route.sessionKey, 2);
        const lastAssistant = [...lastTurns].reverse().find(t => t.role === 'assistant');
        if (lastAssistant?.category === 'briefing' && lastAssistant.content.includes('❓')) {
          const wsPath = resolveWorkspacePath(route.agentId, this.config);
          captureBriefingAnswer({
            client: this.client,
            model: this.config.router.model,
            userMessage: msg.content,
            store: PrepContextStore.forPrincipal(wsPath, principal),
          }).then(captured => {
            if (captured) console.log('[Orchestrator] Prep answer captured from briefing reply');
          }).catch(err => console.warn('[Orchestrator] Prep answer capture failed:', err instanceof Error ? err.message : err));
        }
      } catch { /* capture is best-effort */ }

      // Image attachments default to chat+vision (ask ABOUT the image) — but a
      // TRANSFORM caption ("make this picture anime style") routes to the image
      // specialist with the saved file as the img2img reference. The July 29
      // failure: the unconditional chat override meant the model truthfully
      // said "I have no image tools" while image_generate sat unreachable.
      const imageTransform = hasImageAttachment && attachedImagePath !== undefined && isImageTransformRequest(userCaption);
      if (imageTransform) {
        // Plain-text path note, deliberately NOT [FILE:] syntax — that token
        // family is stripped before the model sees it
        msg.content += `\n[Attached image saved at: ${attachedImagePath} — pass this path as reference_image_path to image_generate for img2img.]`;
        console.log('[Orchestrator] Image transform intent → image specialist (img2img)');
      }

      const dispatchBase = {
        client: this.client,
        registry: this.toolRegistry,
        config: this.config,
        message: msg.content,
        agentId: route.agentId,
        sessionKey: route.sessionKey,
        sessionStore: this.sessionStore,
        pipelineRegistry: this.pipelineRegistry,
            executionMetrics: this.executionMetrics,
        classifyText: userCaption,
        ...(fromExtension ? { overrideCategory: 'chat' as const }
          : imageTransform ? { overrideCategory: 'image' as const }
          : hasImageAttachment ? { overrideCategory: 'chat' as const }
          : fileOverrideCategory ? { overrideCategory: fileOverrideCategory }
          : {}),
        sourceContext: {
          channel: msg.channel,
          channelId: msg.channelId ?? '',
          guildId: msg.guildId,
          senderId: msg.senderId,
        },
        modelOverride: hadAudio ? this.config.voice.model : undefined,
        contextSizeOverride: hadAudio ? this.config.voice.contextSize : undefined,
        maxTokensOverride: hadAudio ? this.config.voice.maxTokens : undefined,
        factStore: this.factStore,
        graphMemory: this.graphMemory,
        pollSteering: () => (this.steeringQueues.get(steeringKey)?.splice(0) ?? []).map(m => m.content),
        isCancelled: () => this.cancelRequests.has(steeringKey),
      };

      // Voice path: single-shot TTS on full response
      if (hadAudio && this.ttsService.enabled) {
        msg.onProgress?.('thinking');

        const dispatchStart = Date.now();
        const result = await dispatchMessage({ ...dispatchBase });
        const dispatchMs = Date.now() - dispatchStart;

        console.log(`[Orchestrator] → ${result.category} (${result.iterations} steps, voice)`);

        // Strip [FILE:] tokens before TTS — an unstripped token gets SPOKEN ALOUD,
        // and the file never arrives. Same class as the !research leak (2026-09-19).
        const voiceMedia = extractMediaAttachments(result.answer, { agentId: route.agentId });
        const voiceText = voiceMedia.cleanText || result.answer;

        msg.onProgress?.('tts');
        const ttsStart = Date.now();
        const audioBuffer = await this.ttsService.synthesize(voiceText);
        const ttsMs = Date.now() - ttsStart;
        console.log(`[Voice] stt=${sttMs}ms dispatch=${dispatchMs}ms tts=${ttsMs}ms total=${sttMs + dispatchMs + ttsMs}ms model=${this.config.voice.model} reply=${voiceText.length} chars`);
        const target = { channel: msg.channel, channelId: msg.channelId!, guildId: msg.guildId, replyToId: msg.id };
        const voiceAttachments = voiceMedia.attachments.length > 0 ? voiceMedia.attachments : undefined;

        if (audioBuffer) {
          console.log(`[Orchestrator] TTS: ${audioBuffer.length} bytes`);
          await this.channelRegistry.send(target, { text: voiceText, audio: { data: audioBuffer, mimeType: audioMime }, attachments: voiceAttachments });
        } else {
          console.warn('[Orchestrator] TTS synthesis failed');
          await this.channelRegistry.send(target, { text: voiceText, attachments: voiceAttachments });
        }
      } else {
        // Non-voice path: Discord text streaming (existing behavior)
        let streamMsg: any = null;
        // The bubble is created by an un-awaited send() inside onStream. When the
        // final answer is the FIRST stream event (a no-tool arena answer), delivery
        // runs before that send resolves, sees streamMsg === null, sends the answer
        // as a fresh message — and the bubble then lands as a second copy ending in
        // " ..." (live 2026-09-20: every short follow-up in the memory arena). Track
        // the in-flight creation so delivery can wait for it.
        let streamMsgPending: Promise<void> | null = null;
        let streamBuffer = '';
        let lastEditAt = 0;
        const EDIT_THROTTLE_MS = 1000;

        const onStream = async (delta: string) => {
          streamBuffer += delta;
          const now = Date.now();
          if (now - lastEditAt < EDIT_THROTTLE_MS) return;
          lastEditAt = now;

          try {
            // Stream previews show raw model output — scrub thinking AND narrated
            // tool-call markup before it hits the channel (a raw <tool_call> block
            // reached a Discord DM via this path, 2026-08-21). Empty after scrub =
            // nothing worth previewing yet; skip this tick.
            const scrubbed = stripThinkingTags(streamBuffer);
            if (!scrubbed) return;
            if (!streamMsg) {
              const adapter = this.channelRegistry.get(msg.channel);
              if (adapter && 'getClient' in adapter) {
                const client = (adapter as any).getClient();
                const ch = await client?.channels.fetch(msg.channelId);
                if (ch && 'send' in ch) {
                  const initContent = scrubbed.length > 1990
                    ? scrubbed.slice(0, 1990) + ' ...'
                    : scrubbed + ' ...';
                  const creation = (ch as any).send({
                    content: initContent,
                    reply: { messageReference: msg.id },
                  }) as Promise<any>;
                  streamMsgPending = creation.then(m => { streamMsg = m; }, () => undefined);
                  await streamMsgPending;
                }
              }
            } else {
              // Discord message limit is 2000 chars — truncate stream preview
              const preview = scrubbed.length > 1990
                ? scrubbed.slice(0, 1990) + ' ...'
                : scrubbed + ' ...';
              await streamMsg.edit(preview);
            }
          } catch (err) {
            console.warn('[Orchestrator] Stream edit failed:', err instanceof Error ? err.message : err);
          }
        };

        msg.onProgress?.('thinking');

        // Step-wise progress: long pipelines emit milestone notes; surface each as its own message
        // so the channel doesn't look dead during multi-minute runs. Fire-and-forget, never blocks.
        const onProgress = (note: string) => {
          this.channelRegistry
            .send({ channel: msg.channel, channelId: msg.channelId! }, { text: note })
            .catch(err => console.warn('[Orchestrator] Progress send failed:', err instanceof Error ? err.message : err));
        };

        const result = await dispatchMessage({ ...dispatchBase, onStream, onProgress });

        console.log(`[Orchestrator] → ${result.category} (${result.iterations} steps)`);

        // Let an in-flight bubble creation settle before deciding edit-vs-send
        // (bounded: a stuck Discord call must not hold the reply hostage).
        if (streamMsgPending) {
          await Promise.race([streamMsgPending, new Promise<void>(r => setTimeout(r, 3000))]);
        }

        if (streamMsg) {
          const media = extractMediaAttachments(result.answer, { agentId: route.agentId });
          const chunks = splitFinalMessage(media.cleanText || result.answer, 2000);
          // The delivery backstop can scrub an answer to nothing (e.g. a bare-chat model
          // that emitted only tool-call markup). Discord rejects empty sends/edits —
          // deliver an honest fallback instead of crashing the whole handler (2026-08-21).
          if (!chunks[0]?.trim()) chunks[0] = '⚠️ I produced no usable answer for that — please try again.';
          // Short runs: morph the stream bubble into the answer (nice, low-noise).
          // Long runs: the user has stopped watching, and Discord does NOT notify on
          // edits — a 30-step arena run delivered its answer as a silent edit of a
          // status bubble (2026-08-20) and looked like no reply at all. Close the
          // bubble and send the answer as a REAL message so it notifies.
          const longRun = result.iterations > 4;
          if (longRun) {
            await streamMsg.edit('✅ Done — answer below.').catch(() => undefined);
            const adapter = this.channelRegistry.get(msg.channel);
            if (adapter) {
              await adapter.send(
                { channel: msg.channel, channelId: msg.channelId!, replyToId: msg.id },
                { text: chunks[0] },
              );
            }
          } else {
            // Always do final edit — stream preview has " ..." suffix that needs to be replaced
            await streamMsg.edit(chunks[0]);
          }
          if (chunks.length > 1) {
            for (let i = 1; i < chunks.length; i++) {
              const adapter = this.channelRegistry.get(msg.channel);
              if (adapter) {
                await adapter.send(
                  { channel: msg.channel, channelId: msg.channelId! },
                  { text: chunks[i] },
                );
              }
            }
          }
          // Send image attachments as follow-up (can't attach to edited stream message)
          if (media.attachments.length > 0) {
            const adapter = this.channelRegistry.get(msg.channel);
            if (adapter) {
              await adapter.send(
                { channel: msg.channel, channelId: msg.channelId! },
                { text: '', attachments: media.attachments },
              );
            }
          }
          // Buttons can't attach to an edited stream message — follow up
          const streamActions = this.confirmActionsFor(result);
          if (streamActions) {
            await this.channelRegistry.send(
              { channel: msg.channel, channelId: msg.channelId! },
              { text: '⏳ Your call:', actions: streamActions },
            ).catch(err => console.warn('[Orchestrator] Button send failed:', err instanceof Error ? err.message : err));
          }
        } else {
          const media = extractMediaAttachments(result.answer, { agentId: route.agentId });
          const text = media.cleanText || result.answer;
          const chunks = splitFinalMessage(text, 2000);
          // Same guard the streaming branch has had since 2026-08-21 — this branch
          // never got it. An empty arena answer (qwen3.8 task_add, 2026-09-20) hit
          // Discord's empty-send rejection here and surfaced as a generic error.
          if (!chunks[0]?.trim()) chunks[0] = '⚠️ I produced no usable answer for that — please try again.';
          const target = { channel: msg.channel, channelId: msg.channelId!, guildId: msg.guildId, replyToId: msg.id };
          const actions = this.confirmActionsFor(result);
          await this.channelRegistry.send(target, {
            text: chunks[0],
            attachments: media.attachments.length > 0 ? media.attachments : undefined,
            actions: chunks.length === 1 ? actions : undefined,
          });
          for (let i = 1; i < chunks.length; i++) {
            await this.channelRegistry.send(
              { channel: msg.channel, channelId: msg.channelId! },
              { text: chunks[i], actions: i === chunks.length - 1 ? actions : undefined },
            );
          }
        }
      }

    } catch (err) {
      const wrapped = err instanceof InvarailError ? err : new InvarailError('TOOL_EXECUTION_ERROR', 'Message handling failed', err);
      console.error(`[Orchestrator] ${wrapped.code}: ${wrapped.message}`);
      try {
        await this.channelRegistry.send(
          {
            channel: msg.channel,
            channelId: msg.channelId!,
            guildId: msg.guildId,
            replyToId: msg.id,
          },
          { text: 'Sorry, I encountered an error processing your request.' },
        );
      } catch (sendErr) {
        console.warn('[Orchestrator] Failed to send error response:', sendErr instanceof Error ? sendErr.message : sendErr);
      }
    } finally {
      if (activeSteeringKey) {
        this.cancelRequests.delete(activeSteeringKey);
        const leftovers = this.steeringQueues.get(activeSteeringKey) ?? [];
        this.steeringQueues.delete(activeSteeringKey);
        // Steering messages the loop finished without draining become normal
        // messages — queued input is never silently dropped
        for (const leftover of leftovers) {
          console.log(`[Orchestrator] Replaying undrained steering message: "${leftover.content.slice(0, 60)}"`);
          void this.handleMessage(leftover).catch(err =>
            console.warn('[Orchestrator] Steering replay failed:', err instanceof Error ? err.message : err));
        }
      }

      // Incremental capture: AFTER the reply is delivered, never in front of it.
      // Fire-and-forget by design — this must not extend the turn, and a failure
      // here is a missed capture, not a failed message. Runs in `finally` so an
      // errored turn still banks whatever the user said before it broke.
      this.memoryCapture?.schedule(route.agentId, route.sessionKey, principal);
    }
  }
}
