import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { FactInput, InvarailConfig } from '../config/types.js';
import type { ConversationTurn } from '../sessions/types.js';
import type { FactStore } from '../memory/fact-store.js';
import type { GraphMemoryStore } from '../memory/graph-store.js';

/** How many turns of a session we have already extracted from, per session key. */
type CaptureState = Record<string, number>;

export interface MemoryCaptureDeps {
  config: InvarailConfig;
  /** Thunks, not values: graphMemory is set to undefined if the FalkorDB connect
   *  fails after construction, so a snapshot taken here would go stale. */
  factStore: () => FactStore | undefined;
  graphMemory: () => GraphMemoryStore | undefined;
  /** Loads a session transcript (agentId, sessionKey) — injected to keep this
   *  module free of a SessionStore dependency it would only use once. */
  loadTranscript: (agentId: string, sessionKey: string) => ConversationTurn[];
  /** The orchestrator's extraction call. Injected rather than imported: extraction
   *  owns the prompt, the already-stored suppression list and the model choice. */
  extract: (
    transcript: ConversationTurn[],
    recentlyRemoved: Array<{ text: string; reason: string }> | undefined,
    senderId: string,
  ) => Promise<FactInput[]>;
  workspacePathFor: (agentId: string) => string;
}

/**
 * Incremental fact capture — closes the gap between a thing being said and that
 * thing being in the graph.
 *
 * Before this, extraction ran at `!reset` and on the 2h heartbeat and nowhere else,
 * so a fact said at 01:30 was unreachable until 03:00 and, if the session was never
 * reset, was simply lost. The visible symptom was a 24-fact graph after months.
 *
 * Three properties are load-bearing:
 *
 * 1. **The trigger is code.** Every N unprocessed turns. The obvious alternative —
 *    asking a model to notice topic shifts ("anyway...") — puts a model call on the
 *    hot path to decide whether to make another model call, and model judgment is
 *    exactly what this architecture makes into code gates everywhere else.
 * 2. **It runs after delivery.** Fire-and-forget on the utility tier, never awaited
 *    by the message path, hard-bounded by a timeout. Peter's prefill measurements
 *    are the reason: nothing new goes in front of a reply.
 * 3. **It cannot claim 'stated'.** Nobody confirmed these. They land as 'observed'
 *    and render to the model as unconfirmed.
 *
 * The heartbeat still owns reconciliation — consolidation, contradiction checks,
 * staleness review. This only closes the capture gap.
 */
export class MemoryCapture {
  /** Sessions with a capture in flight — a slow utility model must not stack runs. */
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: MemoryCaptureDeps) {}

  private statePath(agentId: string): string {
    const dir = join(this.deps.workspacePathFor(agentId), 'memory');
    mkdirSync(dir, { recursive: true });
    return join(dir, 'capture-state.json');
  }

  private loadState(agentId: string): CaptureState {
    try {
      return JSON.parse(readFileSync(this.statePath(agentId), 'utf-8')) as CaptureState;
    } catch {
      return {};
    }
  }

  private saveState(agentId: string, state: CaptureState): void {
    try {
      writeFileSync(this.statePath(agentId), JSON.stringify(state, null, 2));
    } catch (err) {
      console.warn('[Capture] Could not persist capture state:', err instanceof Error ? err.message : err);
    }
  }

  /**
   * Fire-and-forget entry point. Returns immediately; never throws into the caller.
   * The message path calls this after the reply is already delivered.
   */
  schedule(agentId: string, sessionKey: string, senderId: string): void {
    void this.maybeCapture(agentId, sessionKey, senderId).catch(err =>
      console.warn('[Capture] Failed:', err instanceof Error ? err.message : err),
    );
  }

  /**
   * Returns the number of facts written (0 when the trigger did not fire).
   * Exposed separately from `schedule` so tests can await it.
   */
  async maybeCapture(agentId: string, sessionKey: string, senderId: string): Promise<number> {
    const cfg = this.deps.config.memory?.capture;
    if (cfg?.enabled === false) return 0;
    const everyTurns = cfg?.everyTurns ?? 8;
    const overlapTurns = cfg?.overlapTurns ?? 2;
    const timeoutMs = cfg?.timeoutMs ?? 60_000;

    const guardKey = `${agentId}:${sessionKey}`;
    if (this.inFlight.has(guardKey)) return 0;

    const transcript = this.deps.loadTranscript(agentId, sessionKey);
    const state = this.loadState(agentId);
    const processed = state[sessionKey] ?? 0;

    // A cleared session (!reset) leaves a shorter transcript than the marker.
    // Rewind rather than waiting for the new session to grow past the old count.
    if (transcript.length < processed) {
      state[sessionKey] = transcript.length;
      this.saveState(agentId, state);
      return 0;
    }

    if (transcript.length - processed < everyTurns) return 0;

    // Re-read a little before the window: a fact stated across the boundary would
    // otherwise be split in half and extracted from neither side. Dedup absorbs
    // the overlap.
    const window = transcript.slice(Math.max(0, processed - overlapTurns));
    if (window.filter(t => t.role === 'user').length < 2) {
      // Not enough user content to be worth a model call, but the turns ARE
      // consumed — otherwise an assistant-heavy stretch re-triggers every turn.
      state[sessionKey] = transcript.length;
      this.saveState(agentId, state);
      return 0;
    }

    this.inFlight.add(guardKey);
    try {
      const recentlyRemoved = this.deps.factStore()?.loadRecentlyRemoved(senderId) ?? [];
      const facts = await withTimeout(
        this.deps.extract(window, recentlyRemoved, senderId),
        timeoutMs,
      );

      // Advance the marker even when extraction yields nothing: the turns were
      // read. Not advancing would re-send the same window on every later message.
      state[sessionKey] = transcript.length;
      this.saveState(agentId, state);

      if (facts.length === 0) return 0;

      // 'observed' is the schema default, but say it here: this is the one path
      // where a reader might assume a mid-conversation capture is the user's word.
      const observed: FactInput[] = facts.map(f => ({ ...f, provenance: 'observed' as const }));

      let written = 0;
      const factStore = this.deps.factStore();
      if (factStore) {
        const entries = await factStore.writeFactsBatch(observed, senderId, `capture/${sessionKey}`);
        factStore.rebuildFacts(senderId);
        written = entries.length;
      }
      const graphMemory = this.deps.graphMemory();
      if (graphMemory) {
        for (const fact of observed) {
          try {
            await graphMemory.addFact(fact, senderId, sessionKey);
          } catch (err) {
            console.warn(`[Capture] Graph write failed for "${fact.text.slice(0, 50)}":`, err instanceof Error ? err.message : err);
          }
        }
      }

      console.log(`[Capture] ${written || observed.length} fact(s) from ${sessionKey} (turns ${processed}→${transcript.length})`);
      return written || observed.length;
    } finally {
      this.inFlight.delete(guardKey);
    }
  }
}

/** Bound a promise. Capture is off the hot path, so a hung utility model costs
 *  nothing visible — but it must not accumulate handlers either. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`capture timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
