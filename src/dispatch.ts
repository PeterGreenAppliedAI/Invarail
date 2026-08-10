import type { OllamaClient } from './ollama/client.js';
import type { ToolRegistry } from './tools/registry.js';
import type { InvarailConfig, SpecialistConfig, ChannelSecurity } from './config/types.js';
import type { ToolContext, ToolExecutor } from './tools/types.js';
import type { OllamaMessage } from './ollama/types.js';
import { classifyMessage, type ClassifyResult } from './router/classifier.js';
import { runToolLoop } from './tool-loop/engine.js';
import { ErrorLearningStore } from './learnings/error-store.js';
import { SessionStore } from './sessions/store.js';
import type { ConversationTurn, SessionState } from './sessions/types.js';
import { createEmptySessionState } from './sessions/types.js';
import {
  updateMechanicalState,
  extractSemanticDelta,
  applyDelta,
  serializeStatePreamble,
  SEMANTIC_INTERVAL,
} from './sessions/state-tracker.js';
import { resolveWorkspacePath } from './agents/scope.js';
import { buildWorkspaceContext, type WorkspaceCategory } from './agents/workspace.js';
import { logDispatch, logRouterClassification, logAutonomousAction, logReviewNote } from './metrics.js';

/**
 * Cached compaction results per session — used for async compaction.
 * On first message needing compaction: runs synchronously (unavoidable).
 * On subsequent messages: uses cached result, schedules fresh compaction async.
 */
const compactionCache = new Map<string, { messages: OllamaMessage[]; cachedAt: number; turnCount: number }>();
const COMPACTION_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const pendingCompactions = new Set<string>(); // prevent overlapping compactions

/**
 * Frozen workspace snapshot cache — workspace context is loaded once per session
 * and reused for all dispatches. This prevents mid-session memory writes from
 * destabilizing the conversation and enables prefix caching benefits.
 *
 * Clears on !reset (session clear) or after 2 hours of inactivity.
 */
const workspaceCache = new Map<string, { context: string; loadedAt: number }>();
const WORKSPACE_CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

function getCachedWorkspaceContext(
  sessionKey: string,
  workspacePath: string,
  category: WorkspaceCategory,
  channel?: string,
): string {
  const cached = workspaceCache.get(sessionKey);
  if (cached && Date.now() - cached.loadedAt < WORKSPACE_CACHE_TTL_MS) {
    return cached.context;
  }

  const context = buildWorkspaceContext(workspacePath, { category, channel });
  workspaceCache.set(sessionKey, { context, loadedAt: Date.now() });
  return context;
}

/**
 * Smart model routing heuristic — short simple messages don't need the heavy model.
 * Adapted from Hermes Agent's smart model routing.
 */
function shouldUseQuickModel(message: string): boolean {
  const trimmed = message.trim();
  // Long messages need the full model
  if (trimmed.length > 160) return false;
  // Code blocks need the full model
  if (trimmed.includes('```') || trimmed.includes('`')) return false;
  // Complex keywords suggest a real task
  const complexPatterns = /\b(search|find|research|analyze|create|build|write|code|debug|fix|deploy|schedule|remind|explain|compare|summarize)\b/i;
  if (complexPatterns.test(trimmed)) return false;
  // Short, simple message — use quick model
  return true;
}

/** Clear cached workspace context for a session (called on !reset) */
export function clearWorkspaceCache(sessionKey?: string): void {
  if (sessionKey) {
    workspaceCache.delete(sessionKey);
  } else {
    workspaceCache.clear();
  }
}

/** Clear cached compaction state — called on session reset so a fresh session
 *  can never reuse the prior session's compacted history. */
export function clearCompactionCache(agentId: string, sessionKey: string): void {
  compactionCache.delete(`${agentId}:${sessionKey}`);
}
import { computeBudget, trimHistoryToFit } from './context/budget.js';
import { pendingActions } from './security/pending-actions.js';
import { resolveGrantApproval, grantTargetFor } from './security/grants.js';
import { resolvePrincipal, isOwner as isOwnerPrincipal } from './identity/principal.js';
import { buildCompactedHistory } from './context/compactor.js';
import { PipelineRegistry } from './pipeline/registry.js';
import { runPipeline } from './pipeline/executor.js';
import type { PipelineContext } from './pipeline/types.js';
import { appendExecutionRecord } from './mcp/registry-feed.js';

export interface DispatchParams {
  client: OllamaClient;
  registry: ToolRegistry;
  config: InvarailConfig;
  message: string;
  agentId?: string;
  sessionKey?: string;
  history?: OllamaMessage[];
  sessionStore?: SessionStore;
  /** Source channel context — passed to specialists for delivery targeting */
  sourceContext?: {
    channel: string;      // e.g. "discord"
    channelId: string;    // Discord channel ID
    guildId?: string;
    senderId?: string;
  };
  /** Override category — skip router classification (used by cron) */
  overrideCategory?: string;
  /** Text to classify on (the user's caption) when `message` has injected attachment content
   *  prepended — keeps a document's text from hijacking keyword/override routing. */
  classifyText?: string;
  /** Stream callback — called with text deltas for progressive output */
  onStream?: (delta: string) => void;
  /** Progress callback — called with a user-facing note at labeled pipeline stage boundaries */
  onProgress?: (note: string) => void;
  /** Granular per-stage timing events (console-only surface — channels stay
   *  at milestone-level onProgress by design). */
  onStageComplete?: (info: { stage: string; type: string; ms: number }) => void;
  /** Steering: drained by the ReAct loop each iteration — messages the user
   *  sent while this dispatch was running (orchestrator queues them). */
  pollSteering?: () => string[];
  /** Force the code_gen pipeline to MODIFY this existing build slug (deterministic — bypasses the
   *  enrich stage guessing which project a request refers to). Used by the console "Continue" flow. */
  codeTargetSlug?: string;
  /** Override model — used by voice for faster responses */
  modelOverride?: string;
  /** Cron mode — strips write_file from tool set so automated tasks can't create files */
  cronMode?: boolean;
  /** FactStore for structured memory writes during compaction */
  factStore?: import('./memory/fact-store.js').FactStore;
  /** GraphMemoryStore for graph-based memory (FalkorDB) */
  graphMemory?: import('./memory/graph-store.js').GraphMemoryStore;
  /** Pipeline registry for deterministic pipeline dispatch */
  pipelineRegistry?: PipelineRegistry;
  /** Execution metrics store for recording pipeline run data */
  executionMetrics?: import('./metrics/execution-store.js').ExecutionMetricsStore;
  /** Skip pipeline — force ReAct tool-loop (used by plan sub-dispatch to prevent recursion) */
  skipPipeline?: boolean;
  /** Internal: prevent infinite re-route loops */
  _reRouted?: boolean;
}

export interface DispatchResult {
  answer: string;
  category: string;
  classification: ClassifyResult;
  iterations: number;
  hitMaxIterations: boolean;
  steps?: Array<{ tool?: string; params?: Record<string, unknown>; observation?: string }>;
  attachments?: Array<{ data: Buffer; mimeType: string; filename: string }>;
  /** Token usage from Ollama (prompt + completion) */
  promptTokens?: number;
  completionTokens?: number;
  /** Confirm-gate previews recorded during this dispatch — delivery surfaces
   *  attach confirm/always/deny buttons for the most recent one */
  pendingActions?: Array<{ id: string; tool: string }>;
}

/**
 * Strip thinking blocks from model output for display/channel delivery.
 * Handles:
 *   - Qwen-style: <think>...</think>
 *   - Gemma 4-style: <|channel>thought\n...<channel|>
 *   - Orphaned close tags, stray unclosed tags
 */
function stripThinking(text: string): string {
  return text
    // Qwen-style thinking
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/^[\s\S]{0,500}?<\/think>/g, '')
    .replace(/<\/?think>/g, '')
    // Gemma 4-style thinking
    .replace(/<\|channel>thought\n[\s\S]*?<channel\|>/g, '')
    .replace(/<\|channel>thought[\s\S]*$/g, '') // unclosed gemma think block
    .trim();
}

function resolveChannelSecurity(
  config: InvarailConfig,
  channel?: string,
): ChannelSecurity | undefined {
  if (!channel) return undefined;
  const chConfig = config.channels[channel];
  return chConfig?.security ?? undefined;
}

/** Tools stripped from ALL cron dispatches — automated jobs can't mutate state. */
const CRON_BLOCKED_TOOLS = new Set(['write_file', 'task_add', 'task_update', 'task_done', 'task_remove', 'workspace_write', 'memory_save']);

/**
 * Filter a specialist's tool list for cron mode. Beyond the always-blocked set,
 * exec and send_message are only available when the job was explicitly scheduled
 * as that category — owner-authored intent is the code gate. A web_search cron
 * job whose fetched page contains an injected "run this / message X" instruction
 * has no exec or send_message tool to reach for.
 */
function filterCronTools(tools: string[], category: string): string[] {
  return tools.filter(t => {
    if (CRON_BLOCKED_TOOLS.has(t)) return false;
    if (t === 'exec' && category !== 'exec') return false;
    if (t === 'send_message' && category !== 'message') return false;
    return true;
  });
}

/**
 * Effective confirm set = channel confirmTools ∪ tools whose autonomy metadata
 * declares propose_confirm, minus per-channel autoApproveTools promotions
 * (an explicit confirmTools entry always wins over a promotion).
 *
 * Cron pre-authorization: an owner-scheduled exec/message job IS the approval
 * for its category tool — nobody is present to confirm at run time. Only the
 * metadata-derived gate is waived; explicit channel confirmTools still hold.
 */
function resolveConfirmSet(
  registry: import('./tools/registry.js').ToolRegistry,
  security: ChannelSecurity | undefined,
  opts: { cronMode?: boolean; category: string },
): Set<string> {
  const explicit = new Set(security?.confirmTools ?? []);
  const set = new Set([...explicit, ...registry.getMetadataConfirmTools()]);
  for (const t of security?.autoApproveTools ?? []) {
    if (!explicit.has(t)) set.delete(t);
  }
  if (opts.cronMode) {
    const categoryTool = opts.category === 'message' ? 'send_message'
      : opts.category === 'exec' ? 'exec'
      : undefined;
    if (categoryTool && !explicit.has(categoryTool)) set.delete(categoryTool);
  }
  return set;
}

/**
 * Dispatch a message through the Router → Specialist pipeline.
 * Loads session transcript for context, saves turn after completion.
 */
/**
 * Build user priming context from graph memory or flat store.
 * Runs in parallel with router classification for latency savings.
 */
async function buildUserPriming(params: DispatchParams, message: string, senderId: string): Promise<string> {
  try {
    let stableFacts: string[] = [];
    let contextFacts: string[] = [];

    if (params.graphMemory) {
      const stable = await params.graphMemory.getStableFacts(senderId, 4);
      stableFacts = stable.slice(0, 5).map(f => `- ${f.text}`);

      if (message.length > 10) {
        // Relevance floor: multi-signal scoring only orders results — without a
        // similarity floor, fresh high-importance facts inject on EVERY turn
        // regardless of relevance, a topic-drift trap for small models.
        // 0.52 tuned on real corpus data (scripts/memory-floor-check.ts):
        // noise clusters ≤0.49, genuine signal starts ~0.546 on qwen3-embedding.
        const MIN_SIMILARITY = 0.52;
        const MAX_CONTEXT_FACTS = 3;
        const results = await params.graphMemory.search(message, senderId, 5, { minSimilarity: MIN_SIMILARITY });
        contextFacts = results
          .filter(r => !stableFacts.some(s => s.includes(r.text)))
          .slice(0, MAX_CONTEXT_FACTS)
          .map(r => `- ${r.text}`);

        // Lazy multi-hop: only when the query IS memory-relevant (some results
        // passed the floor) but sparse. Firing on zero relevant hits would add
        // tangentially-connected facts exactly when they'd be most distracting.
        if (results.length > 0 && results.length < 3) {
          try {
            const hops = await params.graphMemory.findMultiHop(message, senderId, 2, 3);
            const hopFacts = hops
              .filter(h => !stableFacts.some(s => s.includes(h.text)) && !contextFacts.some(c => c.includes(h.text)))
              .map(h => `- ${h.text}`);
            contextFacts.push(...hopFacts.slice(0, MAX_CONTEXT_FACTS - contextFacts.length));
          } catch { /* multi-hop optional */ }
        }
      }
    } else if (params.factStore) {
      const allFacts = params.factStore.loadFactsJson(senderId);
      stableFacts = allFacts
        .filter(f => (f.importance ?? 2) >= 4 && f.confidence >= 0.7)
        .sort((a, b) => (b.importance ?? 2) - (a.importance ?? 2))
        .slice(0, 5)
        .map(f => `- ${f.text}`);
    }

    let modelSummary: string | null = null;
    if (params.graphMemory) {
      try { modelSummary = await params.graphMemory.getUserModelSummary(senderId); } catch { /* best-effort */ }
    }

    const allPriming = [...new Set([...stableFacts, ...contextFacts])];
    const primingParts: string[] = [];
    if (allPriming.length > 0) {
      primingParts.push(`## Background context about this user (do NOT reference unless directly relevant)\n${allPriming.join('\n')}\nThese facts reflect when they were written — a file, URL, or plan they mention may have changed since; verify before relying on one.`);
    }

    // Lessons: floor-gated one-liners from past failures that have RECURRED
    // (evidence ≥ 2 — a one-off never steers). Zero hits = zero tokens.
    if (params.config.memory?.lessons?.enabled !== false && message.length > 10) {
      try {
        const { LessonStore } = await import('./learnings/lesson-store.js');
        const { relevantLessonLines } = await import('./learnings/lesson-semantic.js');
        const workspacePath = resolveWorkspacePath(params.agentId ?? params.config.agents.default, params.config);
        const lessonLines = await relevantLessonLines(params.client, new LessonStore(workspacePath), message);
        if (lessonLines.length > 0) {
          console.log(`[Dispatch] Lesson injection: ${lessonLines.length}`);
          primingParts.push(`## Lessons from past failures (steer around these)\n${lessonLines.join('\n')}`);
        }
      } catch { /* lessons are best-effort */ }
    }
    // Experiences: approach notes judged by REAL user signals. ADVISORY ONLY —
    // plain prompt text; never permissions/routing/confirm (the authority
    // boundary, DECISIONS 2026-08-10). Evidence ≥ 2: explicit signals
    // (reaction/deny) are born at 2; inferred ones must recur.
    if (params.config.memory?.experiences?.enabled !== false && message.length > 10) {
      try {
        const { sharedExperienceStore } = await import('./memory/experience-store.js');
        const matches = (await sharedExperienceStore(params.client).searchRelevant(message, 2, 0.6))
          .filter(m => m.evidenceCount >= 2);
        if (matches.length > 0) {
          console.log(`[Dispatch] Experience injection: ${matches.length}`);
          primingParts.push(`## Approach notes from similar past work (advisory — the user's reactions, not rules)\n${matches.map(m => `- ${m.text}`).join('\n')}`);
        }
      } catch { /* experiences are best-effort */ }
    }
    if (modelSummary) {
      primingParts.push(`## User preferences (adapt your style accordingly)\n${modelSummary}`);
    }
    if (primingParts.length > 0) {
      if (contextFacts.length > 0 || modelSummary) {
        console.log(`[Dispatch] Memory injection: ${stableFacts.length} stable + ${contextFacts.length} contextual${modelSummary ? ' + model' : ''} (graph)`);
      }
      return primingParts.join('\n\n');
    }
  } catch { /* Non-critical */ }
  return '';
}

export async function dispatchMessage(params: DispatchParams): Promise<DispatchResult> {
  const { client, registry, config, message, agentId = 'main', sessionKey = 'default', sessionStore } = params;

  // 1. Load session history — budget-aware compaction replaces simple truncation
  let history = params.history;
  if (!history && sessionStore) {
    // Resolve workspace path and specialist early for budget calculation
    const workspacePath = resolveWorkspacePath(agentId, config);
    const tempClassification = params.overrideCategory
      ? { category: params.overrideCategory }
      : null;
    const tempSpecialist = tempClassification
      ? config.specialists[tempClassification.category]
      : null;
    const outputReserve = tempSpecialist?.maxTokens ?? 4096;

    // Build workspace context for budget estimation (frozen per session)
    const wsCtx = getCachedWorkspaceContext(sessionKey, workspacePath, 'minimal');
    const budget = computeBudget({
      contextSize: tempSpecialist?.contextSize ?? config.session.contextSize,
      systemPrompt: tempSpecialist?.systemPrompt ?? '',
      workspaceContext: wsCtx,
      currentMessage: message,
      outputReserve,
    });

    const compactionKey = `${agentId}:${sessionKey}`;
    const cachedCompaction = compactionCache.get(compactionKey);
    // Turn count gates cache validity: a cached compaction is only safe to reuse if
    // NO new turns were appended since it was built. Otherwise it omits the most recent
    // exchange. Cheap read (meta.json), not the full transcript.
    const currentTurnCount = sessionStore.getMetadata(agentId, sessionKey)?.turnCount ?? 0;
    const compactionParams = {
      store: sessionStore, client, agentId, sessionKey,
      budgetTokens: budget.historyBudget,
      recentTurnsToKeep: config.session.recentTurnsToKeep,
      model: tempSpecialist?.model ?? config.router.model,
      workspacePath,
      factStore: params.factStore,
      senderId: resolvePrincipal(params.sourceContext?.senderId, config),
    };

    const cacheValid = cachedCompaction
      && cachedCompaction.turnCount === currentTurnCount
      && Date.now() - cachedCompaction.cachedAt < COMPACTION_CACHE_TTL_MS;

    if (cacheValid) {
      // Use cached compaction result (fast path). The entry is EXACT for this turn count
      // (turn-count gated), so there is nothing to refresh — the prewarm after the previous
      // response already built this. No async refresh here: it would cache an obsolete turn
      // count and block the post-append prewarm (the only one that matters for the next msg).
      history = cachedCompaction!.messages;
      console.log(`[Dispatch] Using cached compaction (${Math.round((Date.now() - cachedCompaction!.cachedAt) / 1000)}s old, ${currentTurnCount} turns)`);
    } else {
      // No valid cache — run synchronously (first message, expired, or new turns appended)
      try {
        const compacted = await buildCompactedHistory(compactionParams);
        history = compacted.messages;
        compactionCache.set(compactionKey, { messages: compacted.messages, cachedAt: Date.now(), turnCount: currentTurnCount });
        if (compacted.compacted) {
          console.log(`[Dispatch] History compacted (budget: ${budget.historyBudget} tokens)`);
        }
      } catch (err) {
        console.warn('[Dispatch] Compaction failed, falling back to turn-count truncation:', err);
        const transcript = sessionStore.loadTranscript(agentId, sessionKey, config.session.maxHistoryTurns);
        history = transcript.map(t => ({
          role: t.role as 'user' | 'assistant',
          content: t.role === 'assistant' ? stripThinking(t.content) : t.content,
        }));
      }
    }
  }

  // 2. Classify (or use override)
  // Extract previous category from last assistant turn for sticky routing
  let previousCategory: string | undefined;
  if (sessionStore) {
    const recentTurns = sessionStore.loadTranscript(agentId, sessionKey, 4);
    for (let i = recentTurns.length - 1; i >= 0; i--) {
      if (recentTurns[i].role === 'assistant' && recentTurns[i].category) {
        previousCategory = recentTurns[i].category;
        break;
      }
    }
  }

  // Run classification and memory injection IN PARALLEL (saves 800-1500ms)
  // Classification doesn't need memory results; memory doesn't need classification.
  const classifyStart = Date.now();
  const classifyPromise = params.overrideCategory
    ? Promise.resolve({ category: params.overrideCategory, confidence: 'override' as any } as ClassifyResult)
    : classifyMessage(client, config.router, message, previousCategory, params.classifyText);

  // Start memory priming in background (will be awaited later before specialist runs)
  // Identity: resolve the channel sender to its principal — memory, ledger,
  // and trust key on the PERSON, not the channel account. Unmapped ids pass
  // through, so a config without `principals` behaves exactly as before.
  const senderId = resolvePrincipal(params.sourceContext?.senderId, config);
  const memoryPromise = (senderId && !params.cronMode && (params.graphMemory || params.factStore))
    ? buildUserPriming(params, message, senderId)
    : Promise.resolve('');

  let classification = await classifyPromise;
  const { category } = classification;
  const classifyMs = Date.now() - classifyStart;
  logRouterClassification({ category, confidence: classification.confidence, durationMs: classifyMs });
  console.log(`[Dispatch] Routing: ${classifyMs}ms (memory running in parallel)`);

  console.log(`[Dispatch] Category: ${category} (${classification.confidence})`);

  // 2b. Channel security — category enforcement
  const channelSecurity = resolveChannelSecurity(config, params.sourceContext?.channel);
  // senderId already declared above (parallel section) — principal-resolved.
  // Trust lists may contain raw channel ids OR principal names; match either.
  const rawSenderId = params.sourceContext?.senderId;
  const isTrusted = senderId !== undefined && (!channelSecurity?.trustedUsers
    || channelSecurity.trustedUsers.includes(senderId)
    || (rawSenderId !== undefined && channelSecurity.trustedUsers.includes(rawSenderId)));
  let effectiveCategory = category;

  if (channelSecurity?.allowedCategories && !channelSecurity.allowedCategories.includes(category)) {
    effectiveCategory = channelSecurity.allowedCategories.includes('chat')
      ? 'chat'
      : channelSecurity.allowedCategories[0] ?? config.router.defaultCategory;
    console.log(`[Dispatch] Channel "${params.sourceContext?.channel}" blocked category "${category}" → "${effectiveCategory}"`);
  }

  // 2c. Per-user category restrictions — untrusted users can't use restricted categories
  if (!isTrusted && channelSecurity?.restrictedCategories?.includes(effectiveCategory)) {
    const fallback = 'chat';
    console.log(`[Dispatch] Untrusted user "${senderId}" blocked from restricted category "${effectiveCategory}" → "${fallback}"`);
    effectiveCategory = fallback;
  }

  // 3. Resolve specialist config
  let specialistConfig = config.specialists[effectiveCategory] ?? getDefaultSpecialist(config, effectiveCategory);

  // 3b. Channel security — tool enforcement
  if (specialistConfig && channelSecurity?.blockedTools) {
    const filtered = specialistConfig.tools.filter(t => !channelSecurity.blockedTools!.includes(t));
    if (filtered.length !== specialistConfig.tools.length) {
      console.log(`[Dispatch] Channel stripped tools: [${specialistConfig.tools.filter(t => channelSecurity.blockedTools!.includes(t)).join(', ')}]`);
      specialistConfig = { ...specialistConfig, tools: filtered };
    }
  }

  // 3c. Owner-only tools — stripped for everyone except the config-level ownerId
  // This is a code gate — the model never sees these tools for non-owners
  const isOwner = isOwnerPrincipal(rawSenderId, config);
  if (!isOwner && specialistConfig && channelSecurity?.ownerOnlyTools) {
    const filtered = specialistConfig.tools.filter(t => !channelSecurity.ownerOnlyTools!.includes(t));
    if (filtered.length !== specialistConfig.tools.length) {
      console.log(`[Dispatch] Non-owner "${senderId}" stripped owner-only tools: [${specialistConfig.tools.filter(t => channelSecurity.ownerOnlyTools!.includes(t)).join(', ')}]`);
      specialistConfig = { ...specialistConfig, tools: filtered };
    }
  }

  // 3d. Per-user tool restrictions — untrusted users can't use restricted tools
  if (!isTrusted && specialistConfig && channelSecurity?.restrictedTools) {
    const filtered = specialistConfig.tools.filter(t => !channelSecurity.restrictedTools!.includes(t));
    if (filtered.length !== specialistConfig.tools.length) {
      console.log(`[Dispatch] Untrusted user "${senderId}" stripped restricted tools: [${specialistConfig.tools.filter(t => channelSecurity.restrictedTools!.includes(t)).join(', ')}]`);
      specialistConfig = { ...specialistConfig, tools: filtered };
    }
  }

  // 3d. Voice model override — only for chat (no tools) to keep tool-calling reliable
  if (params.modelOverride && specialistConfig && specialistConfig.tools.length === 0) {
    console.log(`[Dispatch] Model override: ${specialistConfig.model} → ${params.modelOverride}`);
    specialistConfig = { ...specialistConfig, model: params.modelOverride };
  }

  // 3e. Smart model routing — ONLY for trivial greetings/acknowledgments (whitelist, not heuristic)
  // Prevents 60s model load for "hi" while keeping the full model for real conversation
  if (!params.modelOverride && specialistConfig && effectiveCategory === 'chat'
    && specialistConfig.tools.length === 0 && !previousCategory) {
    const TRIVIAL = /^\s*(hi|hey|hello|yo|sup|howdy|hola|what'?s up|how'?s it going|good (morning|afternoon|evening)|thanks|thank you|ok|okay|cool|got it|nope|yep|bye|goodbye|gn|night|lol|haha|nice)\s*[.!?]*\s*$/i;
    if (TRIVIAL.test(message)) {
      const quickModel = 'phi4-mini';
      console.log(`[Dispatch] Quick greeting: "${message.trim()}" → ${quickModel}`);
      specialistConfig = { ...specialistConfig, model: quickModel };
    }
  }

  // 4. Session state — load structured state and inject preamble
  let sessionState: SessionState | null = null;
  let statePreamble = '';
  if (sessionStore) {
    sessionState = sessionStore.loadState(agentId, sessionKey);
    if (sessionState) {
      // Filter knownFacts against recently removed — prevents deleted facts from resurfacing via session state
      if (sessionState.knownFacts.length > 0 && params.factStore && senderId) {
        const removed = params.factStore.loadRecentlyRemoved(senderId);
        if (removed.length > 0) {
          const removedLower = removed.map(r => r.text.toLowerCase());
          sessionState.knownFacts = sessionState.knownFacts.filter(f =>
            !removedLower.some(r => f.toLowerCase().includes(r) || r.includes(f.toLowerCase())),
          );
        }
      }
      statePreamble = serializeStatePreamble(sessionState);
      if (statePreamble) {
        console.log(`[Dispatch] State preamble: turn=${sessionState.turnCount}, topic="${sessionState.currentTopic.slice(0, 60)}"`);
      }
    }
  }

  // 4a2. Conversational guard — lightweight version (June 2026)
  // Only guards short ambiguous messages (<30 chars, no verb) mid-conversation.
  // Long or explicit messages trust the router. No keyword matching — just length + context.
  if (effectiveCategory !== 'chat' && !params.cronMode && !params._reRouted && !params.overrideCategory && params.sourceContext?.channel !== 'console') {
    if (sessionState && sessionState.turnCount > 0 && message.trim().length < 30) {
      console.log(`[Dispatch] Conversational guard: ${effectiveCategory} → chat (short ambiguous message, turn ${sessionState.turnCount})`);
      effectiveCategory = 'chat';
      classification = { category: 'chat', confidence: 'sticky' as const };
      specialistConfig = config.specialists.chat ?? specialistConfig;
    }
  }

  // 4a3. Browser control: guided ReAct with code guardrails
  let browserControlMode = false;
  if (params.sourceContext?.channel === 'console') {
    try {
      const { remoteBridge } = await import('./browser/remote-bridge.js');
      if (remoteBridge.isConnected()) {
        browserControlMode = true;
        // Override to the configured browser-control model, strip pipeline (use ReAct), strip web_fetch
        specialistConfig = {
          ...specialistConfig,
          model: config.browser.controlModel ?? specialistConfig.model,
          pipeline: undefined as any, // force ReAct, no pipeline
          maxIterations: 20,
          maxTokens: 16384,
          tools: specialistConfig.tools.filter(t => t !== 'web_fetch'),
        };
        console.log('[Dispatch] Browser control mode → guided ReAct');
      }
    } catch { /* remote-bridge not available */ }
  }

  // 4b. User priming — await the parallel memory promise started earlier
  const memoryStart = Date.now();
  let userPriming = '';
  try {
    userPriming = await memoryPromise;
  } catch {
    // Non-critical — continue without priming
  }
  const memoryMs = Date.now() - memoryStart;
  if (memoryMs > 10) {
    console.log(`[Dispatch] Memory priming: ${memoryMs}ms (waited after routing)`);
  }

  // 4c. Continuation context — for short follow-ups, also include the last assistant message
  let effectiveMessage = message;
  if (
    classification.confidence === 'sticky' &&
    message.trim().length < 150 &&
    history &&
    history.length >= 1
  ) {
    const lastAssistant = [...history].reverse().find(h => h.role === 'assistant');
    if (lastAssistant?.content) {
      const cleanContent = stripThinking(lastAssistant.content);
      const preview = cleanContent.length > 300
        ? cleanContent.slice(-300) + '...'
        : cleanContent;
      effectiveMessage = `[Continuation — the user is responding to your previous message: "${preview}"]\n\n${message}`;
      console.log(`[Dispatch] Injected continuation context (${preview.slice(0, 60)}...)`);
    }
  }

  let result: DispatchResult;
  const dispatchStart = Date.now();

  // Pass effective message through to specialists
  const effectiveParams = effectiveMessage !== message ? { ...params, message: effectiveMessage } : params;

  if (!specialistConfig) {
    result = await runAsBareChat(client, config, effectiveMessage, classification, history, undefined, params.onStream, agentId, params.sourceContext, !!params.modelOverride, statePreamble, userPriming);
  } else if (specialistConfig.tools.length === 0) {
    // No tools — skip ReAct loop, just chat directly
    result = await runAsBareChat(client, config, effectiveMessage, classification, history, specialistConfig, params.onStream, agentId, params.sourceContext, !!params.modelOverride, statePreamble, userPriming);
  } else if (
    !params.skipPipeline
    && specialistConfig.pipeline === 'exec'
    && params.registry.findExplicitToolMentions(effectiveMessage, params.registry.expandToolNames(specialistConfig.tools))
      .some(n => params.registry.get(n)?.category.startsWith('mcp:'))
  ) {
    // Explicit MCP-tool mention: the shell-command pipeline is provably the
    // wrong destination — the named tool only exists in the ReAct loop.
    // (weekly_gather Aug 1 and blender Aug 6 both fell into this trap.)
    console.log('[Dispatch] Explicit MCP tool mention — exec pipeline bypassed for ReAct');
    result = await runSpecialist(effectiveParams, classification, specialistConfig, history, statePreamble, userPriming, browserControlMode);
  } else if (!params.skipPipeline && specialistConfig.pipeline && params.pipelineRegistry?.has(specialistConfig.pipeline)) {
    // Deterministic pipeline — LLM fills params, code decides workflow
    result = await runPipelineDispatch(effectiveParams, classification, specialistConfig, history, statePreamble, userPriming);
  } else if (!params.skipPipeline && effectiveCategory === 'multi') {
    result = await runMultiOrchestration(effectiveParams, classification, specialistConfig, history, statePreamble);
  } else {
    result = await runSpecialist(effectiveParams, classification, specialistConfig, history, statePreamble, userPriming, browserControlMode);
  }

  result.category = effectiveCategory;

  // Log token usage if available
  const promptTok = (result as any).promptTokens;
  const completionTok = (result as any).completionTokens;
  if (promptTok || completionTok) {
    console.log(`[Dispatch] Tokens: ${promptTok ?? 0} prompt + ${completionTok ?? 0} completion = ${(promptTok ?? 0) + (completionTok ?? 0)} total (${effectiveCategory})`);
  }

  // LLM-as-judge quality scoring for pipeline categories
  const QUALITY_CATEGORIES = new Set(['web_search', 'research', 'multi', 'exec', 'code_gen']);
  if (QUALITY_CATEGORIES.has(effectiveCategory) && result.answer?.length > 100 && !params.cronMode) {
    try {
      const qualityResponse = await client.chat({
        model: config.router?.model ?? 'phi4:14b',
        messages: [{
          role: 'user',
          content: `Rate this response for a ${effectiveCategory} task. User asked: "${message.slice(0, 200)}"\nResponse: "${result.answer.slice(0, 2000)}"\n\nScoring guide (1=bad, 3=adequate, 5=excellent):\n- accuracy: Does it contain correct information? For web_search: are facts sourced? For exec: did the command work?\n- relevance: Does it answer what was asked? Ignore unrelated session context.\n- completeness: Does it cover the topic sufficiently for a ${effectiveCategory} response? A web search summary doesn't need to be a research paper.\n\nScore generously for responses that accomplish the task. A structured answer with sources is at least a 4.\nJSON only: {"accuracy": N, "relevance": N, "completeness": N}`,
        }],
        options: { temperature: 0.1, num_predict: 64 },
      });
      const qRaw = (qualityResponse.message?.content ?? '').trim();
      const qMatch = qRaw.match(/\{[\s\S]*\}/);
      if (qMatch) {
        const scores = JSON.parse(qMatch[0]) as { accuracy?: number; relevance?: number; completeness?: number };
        const avg = ((scores.accuracy ?? 3) + (scores.relevance ?? 3) + (scores.completeness ?? 3)) / 3;
        const level = avg >= 4 ? 'GOOD' : avg >= 3 ? 'OK' : 'POOR';
        console.log(`[Quality] ${effectiveCategory}: ${level} (acc=${scores.accuracy}, rel=${scores.relevance}, comp=${scores.completeness})`);

        // Log to JSONL for weekly review
        try {
          const { appendFileSync, mkdirSync } = await import('node:fs');
          const { join } = await import('node:path');
          const qualityDir = join(process.cwd(), 'data', 'quality');
          mkdirSync(qualityDir, { recursive: true });
          appendFileSync(join(qualityDir, 'quality-scores.jsonl'), JSON.stringify({
            timestamp: new Date().toISOString(),
            category: effectiveCategory,
            scores,
            avg: Math.round(avg * 10) / 10,
            level,
            messagePreview: message.slice(0, 100),
            answerLength: result.answer.length,
          }) + '\n');
        } catch { /* best-effort logging */ }
      }
    } catch { /* quality scoring is best-effort */ }
  }

  // --- Re-route helper: summarize conversation intent before handing off to another specialist ---
  const summarizeForHandoff = async (): Promise<string> => {
    if (!history || history.length === 0) return message;
    try {
      const recentHistory = history.slice(-6).map(h => `${h.role}: ${stripThinking(h.content ?? '').slice(0, 300)}`).join('\n');
      const response = await client.chat({
        model: config.router.model,
        messages: [{
          role: 'user',
          content: `Summarize what the user is asking for in ONE clear sentence. This will be passed to a search specialist.\n\nConversation:\n${recentHistory}\nUser: ${message}\n\nWrite ONLY the search query, nothing else.`,
        }],
        options: { temperature: 0.1, num_predict: 100 },
      });
      const summary = response.message?.content?.trim();
      if (summary && summary.length > 5) {
        console.log(`[Dispatch] Handoff summary: "${summary.slice(0, 80)}"`);
        return summary;
      }
    } catch {
      // Fall back to raw message
    }
    return message;
  };

  // Pipeline downgrade: research pipeline aborted because request is conversational, not a report
  if (result.answer === '__DOWNGRADE_TO_WEB_SEARCH__' && !params._reRouted) {
    const handoffMessage = await summarizeForHandoff();
    console.log('[Dispatch] Research pipeline downgraded to web_search (conversational context)');
    return dispatchMessage({
      ...params,
      message: handoffMessage,
      overrideCategory: 'web_search',
      _reRouted: true,
    });
  }

  // Silent re-route: if chat couldn't fulfill the request, re-classify and re-dispatch
  // Strip thinking first to avoid false positives from reasoning like "I don't have access to..."
  if (effectiveCategory === 'chat' && !params.overrideCategory && !params._reRouted) {
    const CAPABILITY_GAP_PATTERNS = [
      /\bI (?:don't|do not|can't|cannot|am unable to) (?:have access|access|search|browse|check|look up|execute|run|send|schedule)/i,
      /\bI (?:would need|need) (?:to |access |tools)/i,
      /\bif I (?:had|could) (?:access|tools|the ability)/i,
      /\byou (?:would need to|should|could try|might want to) (?:use|open|go to|check|visit)/i,
      /\bI don't have (?:the ability|access|tools|a way|direct)/i,
      // Narrated tool calls — model writes tool syntax as text without actually calling tools
      /\[\w+\s*\(.*\)\]/i,
      // Promises of action chat can't keep — "let me search", "I'll look that up", "going to find"
      // Chat has no tools, so a future-action promise is a capability gap → re-route to a specialist.
      // Requires a search/research VERB so generic acks ("on it", "I'll help") don't trigger.
      /\b(?:let me|i'?ll|i will|i'?m going to|i'?m gonna|give me a (?:sec|moment) and i'?ll)\s+(?:search|look up|look into|find|check|pull up|pull together|dig up|dig into|google|research|fetch|browse)/i,
    ];
    if (CAPABILITY_GAP_PATTERNS.some(p => p.test(stripThinking(result.answer)))) {
      const handoffMessage = await summarizeForHandoff();
      const reClassification = await classifyMessage(client, config.router, handoffMessage);
      if (reClassification.category !== 'chat') {
        console.log(`[Dispatch] Silent re-route: chat gap detected → ${reClassification.category}`);
        return dispatchMessage({
          ...params,
          message: handoffMessage,
          overrideCategory: reClassification.category,
          _reRouted: true,
        });
      }
    }
  }

  // Strip thinking tags for display/channel delivery — but preserve raw answer in transcript
  // so the model can see its own reasoning on subsequent turns.
  const displayAnswer = stripThinking(result.answer);

  // Post-task self-review (Feature 4): lightweight quality check for tool-heavy responses
  // Corrections are logged for learning but NOT appended to user-facing answer
  if (!params.cronMode) {
    const correction = await runPostTaskReview(client, config, message, displayAnswer, result.steps, effectiveCategory);
    if (correction) {
      console.log(`[Dispatch] Post-task review: ${correction.slice(0, 150)}`);
      // Persisted as inferred dissatisfaction evidence for the experience layer
      logReviewNote({ category: effectiveCategory, note: correction.slice(0, 200) });
    }
  }

  logDispatch({
    category: effectiveCategory,
    confidence: classification.confidence,
    iterations: result.iterations,
    hitMaxIterations: result.hitMaxIterations,
    durationMs: Date.now() - dispatchStart,
    toolCalls: result.steps?.map(s => s.tool).filter(Boolean) as string[] | undefined,
    messagePreview: message.slice(0, 120),
  });

  // Store conversation turns in graph for cross-session search (stripped — graph is for search, not reasoning)
  if (params.graphMemory && senderId && !params.cronMode && !params._reRouted) {
    const sk = params.sessionKey ?? 'default';
    params.graphMemory.addTurn(message, 'user', senderId, sk).catch(() => {});
    params.graphMemory.addTurn(displayAnswer.slice(0, 500), 'assistant', senderId, sk).catch(() => {});
  }

  // 5. Update session state (use stripped answer — mechanical state doesn't need reasoning)
  if (sessionStore) {
    const toolNames = (result.steps?.map(s => s.tool).filter(Boolean) as string[]) ?? [];
    sessionState = updateMechanicalState(
      sessionState ?? createEmptySessionState(effectiveCategory),
      effectiveCategory,
      toolNames,
      displayAnswer,
    );

    // Periodic semantic extraction (skip for cron — no human in the loop)
    if (!params.cronMode && sessionState.turnCount - sessionState.lastSemanticUpdate >= SEMANTIC_INTERVAL) {
      try {
        const recentTurns = sessionStore.loadTranscript(agentId, sessionKey, 10);
        const delta = await extractSemanticDelta(
          client,
          config.router.model,
          recentTurns,
          sessionState,
        );
        sessionState = applyDelta(sessionState, delta);
        console.log(`[Dispatch] Semantic state updated: topic="${sessionState.currentTopic.slice(0, 60)}", facts=${sessionState.knownFacts.length}`);
      } catch (err) {
        console.warn('[Dispatch] Semantic extraction failed:', err instanceof Error ? err.message : err);
      }
    }

    sessionStore.saveState(agentId, sessionKey, sessionState);
  }

  // 6. Persist turns if session store available — store RAW answer with thinking preserved
  if (sessionStore) {
    const now = new Date().toISOString();
    sessionStore.appendTurn(agentId, sessionKey, {
      role: 'user',
      content: message,
      timestamp: now,
      category: effectiveCategory,
    });
    sessionStore.appendTurn(agentId, sessionKey, {
      role: 'assistant',
      content: result.answer,
      timestamp: now,
      category: effectiveCategory,
      model: specialistConfig?.model,
      iterations: result.iterations,
    });

    // Prewarm compaction for the NEXT dispatch: build + cache it keyed to the post-append
    // turn count. Without this, the turn-count gate would miss after every exchange and
    // recompute synchronously. Best-effort, background; uses the pre-routing budget so the
    // cached result matches what the next message's pre-routing compaction would produce.
    const newTurnCount = sessionStore.getMetadata(agentId, sessionKey)?.turnCount ?? 0;
    const prewarmKey = `${agentId}:${sessionKey}`;
    if (!pendingCompactions.has(prewarmKey)) {
      pendingCompactions.add(prewarmKey);
      const wsPath = resolveWorkspacePath(agentId, config);
      const wsCtx = getCachedWorkspaceContext(sessionKey, wsPath, 'minimal');
      const prewarmBudget = computeBudget({
        contextSize: config.session.contextSize,
        systemPrompt: '',
        workspaceContext: wsCtx,
        currentMessage: '',
        outputReserve: 4096,
      });
      buildCompactedHistory({
        store: sessionStore, client, agentId, sessionKey,
        budgetTokens: prewarmBudget.historyBudget,
        recentTurnsToKeep: config.session.recentTurnsToKeep,
        model: config.router.model,
        workspacePath: wsPath,
        factStore: params.factStore,
        senderId: resolvePrincipal(params.sourceContext?.senderId, config),
      }).then(result => {
        compactionCache.set(prewarmKey, { messages: result.messages, cachedAt: Date.now(), turnCount: newTurnCount });
      }).catch(err => {
        console.warn('[Dispatch] Prewarm compaction failed:', err instanceof Error ? err.message : err);
      }).finally(() => {
        pendingCompactions.delete(prewarmKey);
      });
    }
  }

  // Return with display-safe answer (thinking stripped for channel delivery)
  return { ...result, answer: displayAnswer };
}

async function runSpecialist(
  params: DispatchParams,
  classification: ClassifyResult,
  specialist: SpecialistConfig,
  history?: OllamaMessage[],
  statePreamble?: string,
  userPriming?: string,
  /** Chrome extension bridge connected — browser-automation prompt + guardrail tweaks.
   *  Computed by dispatchMessage from the remote bridge, NOT from a model name. */
  browserControlMode = false,
): Promise<DispatchResult> {
  const { client, registry, message, agentId = 'main', sessionKey = 'default', config } = params;
  const { category } = classification;

  // Expand mcp:<server> tokens BEFORE filtering — filters and the scoped
  // executor must operate on real tool names
  const expandedTools = registry.expandToolNames(specialist.tools);
  // Cron mode: strip write tools so automated tasks can't mutate state
  const tools = params.cronMode
    ? filterCronTools(expandedTools, category)
    : expandedTools;
  if (params.cronMode && tools.length !== expandedTools.length) {
    const stripped = expandedTools.filter(t => !tools.includes(t));
    console.log(`[Dispatch] Cron mode: stripped [${stripped.join(', ')}] from tool set`);
  }

  const toolDefs = registry.getDefinitions(tools);
  // Scoped executor — final enforcement gate. Only tools in the filtered list can execute.
  const allowedToolSet = new Set(tools);
  const scopedExecutor = registry.createScopedExecutor(allowedToolSet);
  const workspacePath = resolveWorkspacePath(agentId, config);
  const errorStore = new ErrorLearningStore(workspacePath);

  // Confirmation gate: tools in confirmTools return a preview instead of executing.
  // The previewed call is recorded in the pending-action ledger — a later "confirm"
  // executes the STORED params, never a model-regenerated call.
  const channelSecurity = resolveChannelSecurity(config, params.sourceContext?.channel);
  const confirmSet = resolveConfirmSet(registry, channelSecurity, { cronMode: params.cronMode, category });
  const recordedPending: Array<{ id: string; tool: string }> = [];
  const executor: import('./tools/types.js').ToolExecutor = confirmSet.size > 0
    ? async (toolName, toolParams, ctx) => {
        if (confirmSet.has(toolName)) {
          const principal = resolvePrincipal(params.sourceContext?.senderId, config) ?? 'unknown';
          const grantApproval = resolveGrantApproval(
            registry.get(toolName), toolParams, principal,
            params.sourceContext ? { channel: params.sourceContext.channel, channelId: params.sourceContext.channelId } : undefined,
          );
          if (grantApproval) {
            console.log(`[Dispatch] ${toolName} auto-approved (${grantApproval})`);
            logAutonomousAction({ action: `grant_used:${toolName}`, tier: 'act_then_notify', source: grantApproval, reversible: false, outcome: 'success', detail: JSON.stringify(toolParams).slice(0, 120), approval: 'granted', resource: grantTargetFor(registry.get(toolName), toolParams) ?? undefined });
            return scopedExecutor(toolName, toolParams, ctx);
          }
          const preview = JSON.stringify(toolParams, null, 2);
          console.log(`[Dispatch] Confirmation required for ${toolName}`);
          const recorded = pendingActions.record({
            tool: toolName,
            params: toolParams,
            sender: principal,
            channel: params.sourceContext?.channel ?? 'unknown',
            agentId,
            sessionKey,
            category,
          });
          recordedPending.push({ id: recorded.id, tool: recorded.tool });
          return `⚠️ Confirmation required — about to run **${toolName}**:\n\`\`\`\n${preview}\n\`\`\`\nTell the user what you're about to do and ask them to reply "confirm ${recorded.id}" to proceed once, or "always ${recorded.id}" to also stop asking for this exact target (expires in 10 minutes).`;
        }
        return scopedExecutor(toolName, toolParams, ctx);
      }
    : scopedExecutor;
  const toolContext: ToolContext = {
    agentId,
    sessionKey,
    workspacePath,
    senderId: resolvePrincipal(params.sourceContext?.senderId, config),
    channel: params.sourceContext?.channel,
  };

  // Build workspace context — tool-using specialists get minimal context (SOUL+IDENTITY)
  // to preserve token budget for tool results. Chat gets full context.
  const wsCategory = category === 'cron'
    ? 'cron' as const
    : specialist.contextLevel === 'full'
      ? 'chat' as const
      : 'minimal' as const;
  const workspaceContext = getCachedWorkspaceContext(
    params.sessionKey ?? 'default', workspacePath, wsCategory, params.sourceContext?.channel,
  );

  // Channel context for delivery targets (cron scheduling, send_message, etc.)
  let systemPrompt = specialist.systemPrompt;

  // Browser control prompt — replaces specialist prompt when extension is connected
  // Gated on the bridge flag — this was `specialist.model === 'qwen3.6:35b'`, a
  // model literal that silently killed browser-control mode when the model fleet
  // changed (exactly why model literals in logic are banned)
  if (browserControlMode && !specialist.pipeline) {
    systemPrompt = `You are a browser automation agent controlling the user's real Chrome browser. They can see every action you take in real time.

ACTIONS AVAILABLE:
- snapshot: See the page with numbered interactive elements.
- screenshot: Take a visual screenshot — use this when snapshot doesn't show prices/products (JS-heavy sites).
- click ref=N: Click element N from the snapshot.
- type ref=N text="...": Type into element N.
- pressKey text="Enter": Press a key after typing in search fields.
- navigate url="...": Go to a URL. PREFER direct URLs (google.com/search?q=..., amazon.com/s?k=...).
- text_content: Read visible text of the page.
- scroll: Scroll down to see more content.

WORKFLOW:
1. Navigate to the target site using a direct URL when possible.
2. Take a snapshot or screenshot to see what's on the page.
3. If snapshot doesn't show product data/prices, use screenshot — it reads the rendered page visually.
4. Extract the data you need, then move to the next site if comparing vendors.
5. When you have enough data, provide your final answer.

RULES:
- NEVER call the same action twice in a row with the same parameters.
- For price comparison tasks, visit 2-3 different vendor sites (Google Shopping, eBay, Amazon, Newegg).
- Prefer direct URLs over multi-step UI interaction.
- If an action fails or a URL 404s, skip it and try a different source.
- When you have enough data, STOP and give your final answer. Don't navigate back or close the browser.
- URLs must be ACTUAL vendor URLs (amazon.com/dp/..., newegg.com/p/..., ebay.com/itm/...). Never use Google redirect links (google.com/shopping/product/...). If you only have Google Shopping results, navigate to the actual vendor site to get the real URL.`;
  }

  if (params.sourceContext) {
    const ctx = params.sourceContext;
    systemPrompt = (systemPrompt ?? '') +
      `\n\nCurrent message context: channelId="${ctx.channelId}"${ctx.guildId ? `, guildId="${ctx.guildId}"` : ''}. Use these values for delivery targets (e.g., cron job channel and target fields).`;
  }

  // Re-budget against the REAL prompt. The pre-classification budget used an
  // empty system prompt and ignored tool definitions entirely, systematically
  // overestimating history room by 3-6k tokens for tool-using specialists —
  // enough to starve an 8-16k model. Trim oldest turns to the refined budget.
  if (history && history.length > 0) {
    const toolsText = specialist.toolStyle === 'text'
      ? toolDefs.map(t => `${t.name} ${t.description} ${t.parameterDescription} ${t.example ?? ''}`).join('\n')
      : JSON.stringify(toolDefs.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })));
    const refined = computeBudget({
      contextSize: specialist.contextSize ?? config.session.contextSize,
      systemPrompt: systemPrompt ?? '',
      workspaceContext: workspaceContext ?? '',
      currentMessage: message,
      outputReserve: specialist.maxTokens,
      extraSections: [toolsText, statePreamble ?? '', userPriming ?? ''],
    });
    const before = history.length;
    history = trimHistoryToFit(history, refined.historyBudget);
    if (history.length < before) {
      console.log(`[Dispatch] Refined budget trimmed history ${before} → ${history.length} messages (historyBudget=${refined.historyBudget})`);
    }
  }

  const result = await runToolLoop({
    client,
    config: {
      model: specialist.model,
      maxIterations: specialist.maxIterations,
      temperature: specialist.temperature,
      maxTokens: specialist.maxTokens,
      // Browser control: skip growing-text drift detection (model needs room for long answers)
      // Repeat detection still active via action dedup in engine
      skipDriftDetection: browserControlMode,
      topK: specialist.topK,
      topP: specialist.topP,
      repeatPenalty: specialist.repeatPenalty,
      systemPrompt,
      contextSize: specialist.contextSize ?? config.session.contextSize,
      toolStyle: specialist.toolStyle,
    },
    tools: toolDefs,
    executor,
    toolContext,
    userMessage: message,
    history,
    workspaceContext,
    promptContext: {
      channel: params.sourceContext?.channel,
      isVoice: !!params.modelOverride,
      statePreamble: statePreamble || undefined,
      workspacePath,
      userPriming: userPriming || undefined,
    },
    errorStore,
    onProgress: params.onProgress,
    pollSteering: params.pollSteering,
    summarizeObservations: config.session.summarizeToolObservations
      ? { enabled: true, client, model: config.session.summarizationModel ?? config.router.model }
      : undefined,
    onStream: params.onStream,
  });

  // FlowMCP detection feed: one execution record per tool-using dispatch
  // (open contract — detect.ts nominates recurring procedures for compilation)
  const executionsLog = config.tools?.mcp?.executionsLog;
  const toolCalls = result.steps.filter(s => s.action);
  // [SYSTEM] dispatches (post-confirm continuations) are not user tasks —
  // recording them pollutes FlowMCP detection AND breaks the experience
  // harvester's signal→task pairing (a 👎 landed on a continuation record)
  if (executionsLog && toolCalls.length > 0 && !message.startsWith('[SYSTEM]')) {
    appendExecutionRecord(executionsLog, {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      task: message.slice(0, 100),
      agent: specialist.model,
      ts: new Date().toISOString(),
      success: !result.hitMaxIterations && !!result.answer.trim(),
      tokens: (result.promptTokens ?? 0) + (result.completionTokens ?? 0),
      calls: toolCalls.map(s => ({ name: s.action!.tool, args: s.action!.params })),
    });
  }

  return {
    answer: result.answer,
    category,
    classification,
    iterations: result.iterations,
    hitMaxIterations: result.hitMaxIterations,
    steps: result.steps.filter(s => s.action).map(s => ({
      tool: s.action!.tool,
      params: s.action!.params,
      observation: s.observation,
    })),
    ...(recordedPending.length > 0 ? { pendingActions: recordedPending } : {}),
  };
}

/** Categories that benefit from post-task review */
const REVIEW_CATEGORIES = new Set(['exec', 'multi', 'web_search']);

/**
 * Post-task self-review — lightweight quality check on specialist output.
 * Uses the router model (fast) to verify the answer addresses the request
 * and tool errors weren't glossed over. Returns a correction note or null.
 */
async function runPostTaskReview(
  client: OllamaClient,
  config: InvarailConfig,
  originalMessage: string,
  answer: string,
  steps: Array<{ tool?: string; observation?: string }> | undefined,
  category: string,
): Promise<string | null> {
  // Only review tool-heavy responses in relevant categories
  if (!REVIEW_CATEGORIES.has(category)) return null;
  const toolSteps = steps?.filter(s => s.tool) ?? [];
  if (toolSteps.length < 2) return null;

  const toolSummary = toolSteps.map(s => `${s.tool}: ${(s.observation ?? '').slice(0, 80)}`).join('\n');

  try {
    const response = await client.chat({
      model: config.router.model,
      messages: [{
        role: 'user',
        content: `Review this AI response for quality. Be brief.

Request: "${originalMessage.slice(0, 200)}"
Response: "${answer.slice(0, 500)}"
Tool calls (${toolSteps.length}):
${toolSummary.slice(0, 400)}

Check: (1) Does it answer the question? (2) Were tool errors ignored? (3) Is info fabricated?
If issues found, respond starting with "Note:" and a brief correction.
If adequate, respond with just "OK".`,
      }],
      options: { num_predict: 256, temperature: 0.2 },
    });

    const text = (response.message?.content ?? '').trim();
    if (text.startsWith('Note:') || text.startsWith('note:')) {
      console.log(`[Dispatch] Post-task review correction: ${text.slice(0, 100)}`);
      return text;
    }
    return null;
  } catch (err) {
    // Review is best-effort — don't block the response
    console.warn('[Dispatch] Post-task review failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Deterministic pipeline dispatch — replaces ReAct for specialists with a `pipeline` config.
 * The pipeline defines the exact workflow; the LLM only extracts params or synthesizes text.
 */
async function runPipelineDispatch(
  params: DispatchParams,
  classification: ClassifyResult,
  specialist: SpecialistConfig,
  history?: OllamaMessage[],
  statePreamble?: string,
  userPriming?: string,
): Promise<DispatchResult> {
  const { client, registry, message, agentId = 'main', sessionKey = 'default', config } = params;
  const { category } = classification;

  const pipelineDef = params.pipelineRegistry!.get(specialist.pipeline!);
  if (!pipelineDef) {
    // Fallback to ReAct if pipeline not found (shouldn't happen — checked in caller)
    console.warn(`[Dispatch] Pipeline "${specialist.pipeline}" not found, falling back to ReAct`);
    return runSpecialist(params, classification, specialist, history, statePreamble, userPriming);
  }

  // Cron mode: strip write tools (mcp:<server> tokens expanded first)
  const pipelineTools = registry.expandToolNames(specialist.tools);
  const tools = params.cronMode
    ? filterCronTools(pipelineTools, category)
    : pipelineTools;

  // Scoped executor — final enforcement gate for pipelines too
  const allowedToolSet = new Set(tools);
  const scopedExecutor = registry.createScopedExecutor(allowedToolSet);
  const workspacePath = resolveWorkspacePath(agentId, config);
  const errorStore = new ErrorLearningStore(workspacePath);

  // Confirmation gate — same behavior as the ReAct path. Without this, routing
  // a message to a pipeline (e.g. category "message" → send_message) silently
  // bypassed confirmTools entirely.
  const channelSecurity = resolveChannelSecurity(config, params.sourceContext?.channel);
  const confirmSet = resolveConfirmSet(registry, channelSecurity, { cronMode: params.cronMode, category });
  const recordedPending: Array<{ id: string; tool: string }> = [];
  const gatedExecutor: ToolExecutor = confirmSet.size > 0
    ? async (toolName, toolParams, ctx) => {
        if (confirmSet.has(toolName)) {
          const principal = resolvePrincipal(params.sourceContext?.senderId, config) ?? 'unknown';
          const grantApproval = resolveGrantApproval(
            registry.get(toolName), toolParams, principal,
            params.sourceContext ? { channel: params.sourceContext.channel, channelId: params.sourceContext.channelId } : undefined,
          );
          if (grantApproval) {
            console.log(`[Dispatch] ${toolName} auto-approved (${grantApproval}, pipeline)`);
            logAutonomousAction({ action: `grant_used:${toolName}`, tier: 'act_then_notify', source: grantApproval, reversible: false, outcome: 'success', detail: JSON.stringify(toolParams).slice(0, 120), approval: 'granted', resource: grantTargetFor(registry.get(toolName), toolParams) ?? undefined });
            return scopedExecutor(toolName, toolParams, ctx);
          }
          const preview = JSON.stringify(toolParams, null, 2);
          console.log(`[Dispatch] Confirmation required for ${toolName} (pipeline)`);
          const recorded = pendingActions.record({
            tool: toolName,
            params: toolParams,
            sender: principal,
            channel: params.sourceContext?.channel ?? 'unknown',
            agentId,
            sessionKey,
            category,
          });
          recordedPending.push({ id: recorded.id, tool: recorded.tool });
          return `⚠️ Confirmation required — about to run **${toolName}**:\n\`\`\`\n${preview}\n\`\`\`\nReply "confirm ${recorded.id}" to proceed once, or "always ${recorded.id}" to also stop asking for this exact target (expires in 10 minutes).`;
        }
        return scopedExecutor(toolName, toolParams, ctx);
      }
    : scopedExecutor;

  // Wrap gated executor to record errors for learning
  const executor: ToolExecutor = async (toolName, toolParams, ctx) => {
    try {
      return await gatedExecutor(toolName, toolParams, ctx);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      errorStore.recordError({ tool: toolName, params: toolParams, error: errMsg, step: 0, category });
      throw err;
    }
  };

  const toolContext: ToolContext = {
    agentId,
    sessionKey,
    workspacePath,
    senderId: resolvePrincipal(params.sourceContext?.senderId, config),
    channel: params.sourceContext?.channel,
    config: { imageGen: config.imageGen },
  };

  // Context isolation: pipeline dispatches get fresh context (no parent history)
  // to prevent prior session topics from biasing search/synthesis.
  const isolateContext = !!specialist.pipeline;

  const wsCategory = category === 'cron'
    ? 'cron' as const
    : isolateContext
      ? 'progressive' as const
      : specialist.contextLevel === 'full'
        ? 'chat' as const
        : 'minimal' as const;
  // Plan pipeline gets fresh context (progressive, no caching). Others use frozen snapshot.
  const workspaceContext = isolateContext
    ? buildWorkspaceContext(workspacePath, { category: wsCategory, channel: params.sourceContext?.channel })
    : getCachedWorkspaceContext(params.sessionKey ?? 'default', workspacePath, wsCategory, params.sourceContext?.channel);

  // Resolve anaphoric references: if the message is short and the session has a topic,
  // prepend the topic so the pipeline knows what "it", "one", "that" refers to.
  // If topic is empty but there's chat history, summarize the conversation for context.
  // NEVER for the message pipeline: a send must come from the user's explicit words —
  // the rewrite once rebuilt send params (target id + text) from conversation history,
  // turning a meta-question ("did you actually send it?") into a fresh send proposal.
  let pipelineMessage = message;
  if (isolateContext && specialist.pipeline !== 'message' && message.length < 150) {
    const sessionState = params.sessionStore?.loadState(agentId, sessionKey ?? 'default');
    if (sessionState?.currentTopic) {
      pipelineMessage = `[Context: ${sessionState.currentTopic}]\n${message}`;
      console.log(`[Dispatch] Pipeline context injection: topic="${sessionState.currentTopic.slice(0, 60)}"`);
    } else if (history && history.length > 0) {
      // Topic not yet computed — summarize conversation for the pipeline
      try {
        const recentHistory = history.slice(-6).map(h => `${h.role}: ${stripThinking(h.content ?? '').slice(0, 300)}`).join('\n');
        const response = await client.chat({
          model: config.router.model,
          messages: [{
            role: 'user',
            content: `The user said: "${message}"\n\nThis is a follow-up to this conversation:\n${recentHistory}\n\nRewrite the user's message as a clear, self-contained request in one sentence. Include the specific topic. Write ONLY the rewritten request.`,
          }],
          options: { temperature: 0.1, num_predict: 100 },
        });
        const rewritten = response.message?.content?.trim();
        if (rewritten && rewritten.length > 10) {
          pipelineMessage = rewritten;
          console.log(`[Dispatch] Pipeline context rewrite: "${rewritten.slice(0, 80)}"`);
        }
      } catch {
        // Fall back to raw message
      }
    }
  }

  // Explicit tool naming is a code gate: pipelines use it to outrank skill
  // matching and to trigger flow-first gathering. Flow mentions carry the bare
  // flow name (registry keys upstream) + the server's registry-log path so the
  // research pipeline can emit staleness signals per FlowMCP's open contract.
  const explicitToolMentions = registry.findExplicitToolMentions(pipelineMessage, tools);
  const explicitFlowMentions = explicitToolMentions
    .filter(n => registry.get(n)?.category.startsWith('mcp:'))
    .map(n => {
      const server = registry.get(n)!.category.slice(4);
      const serverCfg = config.tools?.mcp?.servers?.find(s => s.name === server);
      return {
        tool: n,
        flow: n.startsWith(`${server}_`) ? n.slice(server.length + 1) : n,
        registryLog: serverCfg?.registryLog,
      };
    });
  if (explicitToolMentions.length > 0) {
    console.log(`[Dispatch] Explicit tool mention(s): ${explicitToolMentions.join(', ')}`);
  }

  const ctx: PipelineContext = {
    userMessage: pipelineMessage,
    params: {
      _verification: config.verification,
      _pi: config.pi,
      _codeTargetSlug: params.codeTargetSlug,
      _explicitToolMentions: explicitToolMentions,
      _explicitFlowMentions: explicitFlowMentions,
    },
    stageResults: {},
    steps: [],
    client,
    executor,
    toolContext,
    history: isolateContext ? undefined : history,
    workspaceContext,
    userPriming: userPriming || undefined,
    model: specialist.model,
    contextSize: specialist.contextSize ?? config.session.contextSize,
    routerModel: config.router?.model,
    sourceContext: params.sourceContext,
    cronMode: params.cronMode,
    onStream: params.onStream,
    onProgress: params.onProgress,
    onStageComplete: params.onStageComplete,
    conversational: !params.cronMode && (() => {
      const state = params.sessionStore?.loadState(agentId, sessionKey ?? 'default');
      return !!state && state.turnCount > 0;
    })(),
  };

  // Sub-dispatch for plan pipeline orchestration — delegates sub-tasks to specialists
  if (isolateContext) {
    ctx.subDispatch = async (subMessage: string, subCategory: string) => {
      console.log(`[Plan] Sub-dispatch: "${subMessage.slice(0, 60)}..." → ${subCategory}`);
      const result = await dispatchMessage({
        ...params,
        message: subMessage,
        overrideCategory: subCategory,
        skipPipeline: true, // go to tool-loop, not pipeline (prevents plan→plan recursion)
        onStream: undefined, // don't stream sub-task responses
      });

      const answer = result.answer;
      // Extract structured references at the dispatch layer (not post-hoc in plan.ts)
      const filePaths = answer.match(/(?:data\/|research\/|\.plan-artifacts\/)[^\s,)"]+/g) ?? [];
      const urls = [...new Set(answer.match(/https?:\/\/[^\s)"\]]+/g) ?? [])];

      return { answer, steps: result.steps, status: 'success' as const, filePaths, urls, category: subCategory };
    };
  }

  // Create metrics collector for plan pipeline runs
  let collector: import('./metrics/collector.js').MetricsCollector | undefined;
  if (specialist.pipeline === 'plan' && params.executionMetrics) {
    const { MetricsCollector } = await import('./metrics/collector.js');
    collector = new MetricsCollector();
    collector.pipeline = specialist.pipeline;
    collector.category = category;
    collector.userMessage = message;
    ctx.metricsCollector = collector;
  }

  console.log(`[Dispatch] Pipeline dispatch: "${specialist.pipeline}" for category "${category}"`);

  const pipelineResult = await runPipeline(pipelineDef, ctx);

  // Flush metrics
  if (collector && params.executionMetrics) {
    collector.answer = pipelineResult.answer;
    try {
      collector.flush(params.executionMetrics);
    } catch (err) {
      console.warn(`[Metrics] Failed to flush: ${err instanceof Error ? err.message : err}`);
    }
  }

  return {
    answer: pipelineResult.answer,
    category,
    classification,
    iterations: pipelineResult.iterations,
    hitMaxIterations: pipelineResult.hitMaxIterations,
    steps: pipelineResult.steps,
    ...(recordedPending.length > 0 ? { pendingActions: recordedPending } : {}),
  };
}

/**
 * Multi orchestration: decompose complex requests into sub-tasks,
 * dispatch each to the appropriate specialist, aggregate results.
 */
async function runMultiOrchestration(
  params: DispatchParams,
  classification: ClassifyResult,
  specialist: SpecialistConfig,
  history?: OllamaMessage[],
  _statePreamble?: string,
): Promise<DispatchResult> {
  const { client, registry, config, message } = params;
  const categories = Object.keys(config.specialists).filter(c => c !== 'multi');

  // Step 1: Ask the model to decompose the request into sub-tasks
  const decomposePrompt = `You are a task decomposer. Break the user's request into individual sub-tasks that can each be handled by one specialist.

Available specialists: ${categories.join(', ')}
- chat: Simple conversation
- web_search: Internet lookups, current info
- memory: Save/retrieve stored information
- exec: Run commands, file operations
- cron: Schedule recurring tasks
- message: Send messages to channels

Respond with a JSON array of sub-tasks. Each sub-task has "category" (specialist) and "message" (the prompt for that specialist).
Example: [{"category": "web_search", "message": "Find the current weather in NYC"}, {"category": "memory", "message": "Save the weather info"}]

IMPORTANT: Respond with ONLY the JSON array, no other text.`;

  const decomposeResponse = await client.chat({
    model: specialist.model,
    messages: [
      { role: 'system', content: decomposePrompt },
      { role: 'user', content: message },
    ],
    options: { temperature: 0.2, num_predict: 1024 },
  });

  // Parse sub-tasks
  let subTasks: Array<{ category: string; message: string }> = [];
  try {
    const content = decomposeResponse.message?.content ?? '';
    // Extract JSON array from response (may have markdown fences)
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      subTasks = JSON.parse(jsonMatch[0]);
    }
  } catch {
    // Decomposition failed — fall back to running multi specialist directly
    console.log('[Dispatch] Multi decomposition failed, falling back to direct specialist');
    return runSpecialist(params, classification, specialist, history);
  }

  if (subTasks.length === 0) {
    return runSpecialist(params, classification, specialist, history);
  }

  console.log(`[Dispatch] Multi decomposed into ${subTasks.length} sub-tasks: ${subTasks.map(t => t.category).join(' → ')}`);

  // Step 2: Execute sub-tasks sequentially, passing results forward
  const subResults: string[] = [];
  let totalIterations = 1; // count decompose step

  for (const task of subTasks) {
    // Validate sub-task has required shape
    if (typeof task.category !== 'string' || typeof task.message !== 'string') {
      subResults.push('[unknown] Skipped: invalid sub-task format');
      continue;
    }

    // Enforce channel security on LLM-chosen category
    const subChannelSecurity = resolveChannelSecurity(config, params.sourceContext?.channel);
    if (subChannelSecurity?.allowedCategories && !subChannelSecurity.allowedCategories.includes(task.category)) {
      subResults.push(`[${task.category}] Skipped: category not allowed on this channel`);
      continue;
    }
    const subSenderId = params.sourceContext?.senderId;
    const subIsTrusted = subSenderId !== undefined && (!subChannelSecurity?.trustedUsers || subChannelSecurity.trustedUsers.includes(subSenderId));
    if (!subIsTrusted && subChannelSecurity?.restrictedCategories?.includes(task.category)) {
      subResults.push(`[${task.category}] Skipped: restricted category for untrusted user`);
      continue;
    }

    const taskSpecialist = config.specialists[task.category];
    if (!taskSpecialist) {
      subResults.push(`[${task.category}] Skipped: unknown specialist`);
      continue;
    }

    // Enhance the sub-task message with context from previous results
    let enhancedMessage = task.message;
    if (subResults.length > 0) {
      enhancedMessage += `\n\nContext from previous steps:\n${subResults.join('\n')}`;
    }

    try {
      const subResult = await dispatchMessage({
        ...params,
        message: enhancedMessage,
        overrideCategory: task.category,
        onStream: undefined, // don't stream sub-tasks
      });
      subResults.push(`[${task.category}] ${subResult.answer}`);
      totalIterations += subResult.iterations;
    } catch (err) {
      subResults.push(`[${task.category}] Error: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Step 3: Synthesize final answer
  const synthesizeResponse = await client.chat({
    model: specialist.model,
    messages: [
      { role: 'system', content: 'Synthesize the results from multiple sub-tasks into a single cohesive response for the user. Be concise and natural.' },
      { role: 'user', content: `Original request: ${message}\n\nSub-task results:\n${subResults.join('\n\n')}` },
    ],
    options: { temperature: 0.5, num_predict: specialist.maxTokens },
  });

  return {
    answer: synthesizeResponse.message?.content ?? subResults.join('\n\n'),
    category: 'multi',
    classification,
    iterations: totalIterations + 1,
    hitMaxIterations: false,
  };
}

async function runAsBareChat(
  client: OllamaClient,
  config: InvarailConfig,
  message: string,
  classification: ClassifyResult,
  history?: OllamaMessage[],
  specialist?: SpecialistConfig,
  onStream?: (delta: string) => void,
  agentId = 'main',
  sourceContext?: DispatchParams['sourceContext'],
  isVoice = false,
  statePreamble?: string,
  userPriming?: string,
): Promise<DispatchResult> {
  const chatModel = specialist?.model ?? config.specialists.chat?.model ?? config.router.model;
  const temperature = specialist?.temperature ?? 0.8;
  const maxTokens = specialist?.maxTokens ?? 2048;

  // Inject workspace context — chat gets TOOLS.md for self-awareness
  const workspacePath = resolveWorkspacePath(agentId, config);
  const workspaceContext = getCachedWorkspaceContext(agentId, workspacePath, 'chat', sourceContext?.channel);
  let systemContent = specialist?.systemPrompt ?? 'You are a helpful AI assistant. Respond naturally and concisely.';
  if (workspaceContext) {
    systemContent += '\n\n' + workspaceContext;
  }
  if (sourceContext) {
    systemContent += `\n\nCurrent message context: The user is messaging from channel="${sourceContext.channel}"${sourceContext.guildId ? `, guildId="${sourceContext.guildId}"` : ''}.`;
  }
  if (isVoice) {
    systemContent += '\n\nIMPORTANT: This is a voice conversation. Your response will be spoken aloud via TTS. Keep responses concise. Do NOT use emojis, markdown formatting, bullet points, or special characters — they will be verbalized. Use plain conversational English only.';
  }
  if (statePreamble) {
    systemContent += '\n\n' + statePreamble;
  }
  if (userPriming) {
    systemContent += '\n\n' + userPriming;
  }

  // Strip thinking from history for chat — Gemma 4 docs: "No Thinking Content in History"
  // and old qwen3 thinking tags in history confuse other models into generating massive output.
  const cleanHistory = (history ?? []).map(h => h.role === 'assistant' && h.content
    ? { ...h, content: stripThinking(h.content) }
    : h,
  );

  const messages: OllamaMessage[] = [
    { role: 'system', content: systemContent },
    ...cleanHistory,
    { role: 'user', content: message },
  ];

  const options: Record<string, unknown> = { temperature, num_predict: maxTokens };
  const effectiveContextSize = specialist?.contextSize ?? config.session.contextSize;
  if (effectiveContextSize) options.num_ctx = effectiveContextSize;
  if (specialist?.topK !== undefined) options.top_k = specialist.topK;
  if (specialist?.topP !== undefined) options.top_p = specialist.topP;
  if (specialist?.repeatPenalty !== undefined) options.repeat_penalty = specialist.repeatPenalty;

  const chatParams = {
    model: chatModel,
    messages,
    options,
  };

  const response = onStream
    ? await client.chatStream(chatParams, onStream)
    : await client.chat(chatParams);

  return {
    answer: response.message?.content ?? '',
    category: classification.category,
    classification,
    iterations: 1,
    hitMaxIterations: false,
  };
}

function getDefaultSpecialist(config: InvarailConfig, category: string): SpecialistConfig | undefined {
  if (category === 'chat') {
    return {
      model: config.router.model,
      maxTokens: 2048,
      temperature: 0.8,
      maxIterations: 1,
      tools: [],
      toolStyle: 'native',
    };
  }
  return undefined;
}
