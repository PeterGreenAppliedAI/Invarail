import { basename } from 'node:path';
import type { z } from 'zod';
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import type { PiConfigSchema } from '../config/schema.js';
import { configInvalid } from '../errors.js';
import { logPiSession, logPiSessionEvent } from '../metrics.js';

type PiConfig = z.infer<typeof PiConfigSchema>;

/**
 * PiCodingAdapter — the ONLY module that touches the Pi SDK (the McpManager
 * pattern: one wrapping surface, swappable). Replaces the CLI spawn: same
 * cwd-scoping (SDK tools are bound to the session cwd, not process.cwd()),
 * same context-file suppression, same auth/model/tool wiring the CLI flags
 * provided — plus lifecycle events into metrics and the session JSONL path
 * surfaced for provenance.
 */

export interface PiSessionRequest {
  prompt: string;
  /** Project directory — every tool (read/write/edit/bash) is scoped here */
  cwd: string;
  /** provider/id override; defaults to config.model */
  model?: string;
  /** Metrics grouping label; defaults to basename(cwd) */
  label?: string;
}

export interface PiSessionStats {
  turns: number;
  toolCalls: number;
  toolErrors: number;
  durationMs: number;
}

export interface PiSessionResult {
  ok: boolean;
  timedOut: boolean;
  sessionId?: string;
  /** Path to the session JSONL on disk — Phase C's provenance anchor */
  sessionFile?: string;
  stats: PiSessionStats;
  error?: string;
}

/** How long after abort() we wait for prompt() to settle before giving up on
 *  a wedged tool child. abort() is cooperative where the CLI's SIGKILL was
 *  absolute — bounded so a stuck bash can't hang the caller forever. */
const ABORT_GRACE_MS = 30_000;

export class PiCodingAdapter {
  constructor(private readonly config: PiConfig) {}

  async runSession(req: PiSessionRequest): Promise<PiSessionResult> {
    const modelRef = req.model ?? this.config.model;
    const slash = modelRef.indexOf('/');
    if (slash <= 0 || slash === modelRef.length - 1) {
      throw configInvalid(`pi model must be "provider/id", got "${modelRef}"`);
    }
    const provider = modelRef.slice(0, slash);
    const modelId = modelRef.slice(slash + 1);

    const agentDir = getAgentDir();
    const authStorage = AuthStorage.create();
    const modelRegistry = ModelRegistry.create(authStorage);
    const model = modelRegistry.find(provider, modelId);
    if (!model) {
      throw configInvalid(`pi model "${modelRef}" not found in ${agentDir}/models.json`);
    }
    // Same mechanism the CLI's --api-key uses: runtime-only, never persisted.
    authStorage.setRuntimeApiKey(provider, this.config.apiKey);

    const settingsManager = SettingsManager.create(req.cwd, agentDir);
    // noContextFiles ≙ the CLI's --no-context-files: without it Pi walks UP
    // from the build dir and loads Invarail's own CLAUDE.md into every build.
    const resourceLoader = new DefaultResourceLoader({
      cwd: req.cwd,
      agentDir,
      settingsManager,
      noContextFiles: true,
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      cwd: req.cwd,
      model,
      tools: [...this.config.tools],
      authStorage,
      modelRegistry,
      settingsManager,
      resourceLoader,
    });

    const slug = req.label ?? basename(req.cwd);
    const sessionId = session.sessionId;
    const stats: PiSessionStats = { turns: 0, toolCalls: 0, toolErrors: 0, durationMs: 0 };
    const toolStarts = new Map<string, number>();
    const start = Date.now();

    const unsubscribe = session.subscribe(event => {
      switch (event.type) {
        case 'agent_start':
        case 'agent_end':
          logPiSessionEvent({ sessionId, slug, event: event.type });
          break;
        case 'turn_start':
          stats.turns++;
          logPiSessionEvent({ sessionId, slug, event: 'turn_start' });
          break;
        case 'turn_end':
          logPiSessionEvent({ sessionId, slug, event: 'turn_end' });
          break;
        case 'tool_execution_start':
          // Tracked only to compute durations — deliberately not logged.
          toolStarts.set(event.toolCallId, Date.now());
          break;
        case 'tool_execution_end': {
          const startedAt = toolStarts.get(event.toolCallId);
          toolStarts.delete(event.toolCallId);
          stats.toolCalls++;
          if (event.isError) stats.toolErrors++;
          logPiSessionEvent({
            sessionId,
            slug,
            event: 'tool_execution_end',
            toolName: event.toolName,
            isError: event.isError,
            durationMs: startedAt !== undefined ? Date.now() - startedAt : undefined,
          });
          break;
        }
      }
    });

    let timedOut = false;
    let error: string | undefined;
    try {
      const promptPromise = session.prompt(req.prompt).then(
        () => 'done' as const,
        (err: unknown) => {
          error = err instanceof Error ? err.message : String(err);
          return 'error' as const;
        },
      );
      let timer: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<'timeout'>(resolve => {
        timer = setTimeout(() => resolve('timeout'), this.config.timeout);
      });
      const outcome = await Promise.race([promptPromise, timeoutPromise]);
      clearTimeout(timer);

      if (outcome === 'timeout') {
        timedOut = true;
        await session.abort().catch(() => undefined);
        await Promise.race([
          promptPromise,
          new Promise(resolve => setTimeout(resolve, ABORT_GRACE_MS)),
        ]);
      }
      // Post-acceptance model failures surface via session state, not a
      // prompt() rejection — pick them up so callers see the real outcome.
      if (!error && session.agent.state.errorMessage) {
        error = session.agent.state.errorMessage;
      }
    } finally {
      unsubscribe();
      session.dispose();
    }

    stats.durationMs = Date.now() - start;
    const result: PiSessionResult = {
      ok: !timedOut && !error,
      timedOut,
      sessionId,
      sessionFile: session.sessionFile,
      stats,
      ...(error ? { error } : {}),
    };
    logPiSession({
      slug,
      model: modelRef,
      sessionId,
      sessionFile: result.sessionFile,
      ok: result.ok,
      timedOut,
      durationMs: stats.durationMs,
      turns: stats.turns,
      toolCalls: stats.toolCalls,
      toolErrors: stats.toolErrors,
      ...(error ? { error: error.slice(0, 500) } : {}),
    });
    return result;
  }
}
