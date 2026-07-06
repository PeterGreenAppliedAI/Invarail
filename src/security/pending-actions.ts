import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Pending-action ledger for the confirmTools gate.
 *
 * Structural property this enforces: a confirmation executes EXACTLY the tool
 * call that was previewed — stored params, not model-regenerated ones. Entries
 * are sender-bound, single-use, and expire. "Go ahead" from a user with no
 * pending entry arms nothing.
 */
export interface PendingAction {
  id: string;
  tool: string;
  params: Record<string, unknown>;
  /** The sender who triggered the preview — only they can confirm it */
  sender: string;
  channel: string;
  agentId: string;
  sessionKey: string;
  createdAt: string;
  expiresAt: string;
}

const TTL_MS = 10 * 60 * 1000;
const STORE_PATH = 'data/pending-actions.json';

/** Matches a bare confirmation message ("confirm", "yes do it", "go ahead", ...). */
export const CONFIRMATION_PATTERN = /^(confirm|yes,?\s*do it|approved?|go ahead|proceed)\s*[.!]?$/i;

export class PendingActionStore {
  constructor(private readonly path: string = STORE_PATH) {}

  private load(): PendingAction[] {
    try {
      const all = JSON.parse(readFileSync(this.path, 'utf-8')) as PendingAction[];
      // Prune expired on every read
      const now = Date.now();
      return all.filter(a => new Date(a.expiresAt).getTime() > now);
    } catch {
      return [];
    }
  }

  private save(actions: PendingAction[]): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(actions, null, 2));
    } catch (err) {
      console.warn('[PendingActions] Save failed:', err instanceof Error ? err.message : err);
    }
  }

  /** Record a previewed action. Returns the entry (with id) for display. */
  record(entry: Omit<PendingAction, 'id' | 'createdAt' | 'expiresAt'>): PendingAction {
    const now = Date.now();
    const action: PendingAction = {
      ...entry,
      id: randomBytes(4).toString('hex'),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + TTL_MS).toISOString(),
    };
    const actions = this.load();
    actions.push(action);
    this.save(actions);
    console.log(`[PendingActions] Recorded ${action.tool} (id=${action.id}) for ${action.sender}`);
    return action;
  }

  /** Most recent unexpired action for a sender (sender-bound lookup). */
  latestFor(sender: string): PendingAction | null {
    const actions = this.load().filter(a => a.sender === sender);
    return actions.length > 0 ? actions[actions.length - 1] : null;
  }

  /** Remove and return an entry — single-use semantics. */
  consume(id: string): PendingAction | null {
    const actions = this.load();
    const idx = actions.findIndex(a => a.id === id);
    if (idx === -1) return null;
    const [action] = actions.splice(idx, 1);
    this.save(actions);
    return action;
  }
}

/** Shared ledger instance — preview sites (dispatch) and confirm sites (orchestrator, console) must see the same entries. */
export const pendingActions = new PendingActionStore();
