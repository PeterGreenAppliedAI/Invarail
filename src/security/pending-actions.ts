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

/** Matches a confirmation message: bare ("confirm", "yes do it", "go ahead")
 *  or id-targeted ("confirm 3fa2c1b9") for multi-proposal flows (briefing prep). */
export const CONFIRMATION_PATTERN = /^(?:confirm|yes,?\s*do it|approved?|go ahead|proceed)(?:\s+([a-f0-9]{6,12}))?\s*[.!]?$/i;

/** Near-miss: confirm-verb + a short token that is NOT a valid id ("confirm 2",
 *  a typo'd id). These must get an error reply, never fall through to chat where
 *  the model may hallucinate "Done!". Longer phrases ("confirm my flight") still
 *  route to chat as normal requests. */
export const CONFIRMATION_NEAR_MISS = /^(?:confirm|approved?|ok)\s+([a-z0-9]{1,12})\s*[.!]?$/i;

/** Bare confirms ("go ahead") only fire on RECENT interactive previews. Without
 *  this, a casual "go ahead" hours later executes a stale 12h briefing proposal
 *  as a non-sequitur. Long-TTL proposals always require "confirm <id>". */
export const BARE_CONFIRM_MAX_AGE_MS = 10 * 60 * 1000;

/** Extract the optional action id from a confirmation message (null = bare confirm). */
export function parseConfirmationId(message: string): string | null {
  const m = message.trim().match(CONFIRMATION_PATTERN);
  return m?.[1]?.toLowerCase() ?? null;
}

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

  /** Record a previewed action. Returns the entry (with id) for display.
   *  ttlMs defaults to 10 min (interactive confirms); briefing prep proposals
   *  pass a longer TTL since the user may read the briefing much later. */
  record(entry: Omit<PendingAction, 'id' | 'createdAt' | 'expiresAt'>, ttlMs = TTL_MS): PendingAction {
    const now = Date.now();
    const action: PendingAction = {
      ...entry,
      id: randomBytes(4).toString('hex'),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMs).toISOString(),
    };
    const actions = this.load();
    actions.push(action);
    this.save(actions);
    console.log(`[PendingActions] Recorded ${action.tool} (id=${action.id}) for ${action.sender}`);
    return action;
  }

  /** Most recent unexpired action for a sender (sender-bound; optionally channel-bound
   *  and age-bound). Channel binding prevents cross-channel confirmation when generic
   *  sender ids (e.g. "console-user") could collide across channels. maxAgeMs limits
   *  bare confirms to recent interactive previews (see BARE_CONFIRM_MAX_AGE_MS). */
  latestFor(sender: string, channel?: string, maxAgeMs?: number): PendingAction | null {
    const cutoff = maxAgeMs !== undefined ? Date.now() - maxAgeMs : null;
    const actions = this.load().filter(a =>
      a.sender === sender
      && (channel === undefined || a.channel === channel)
      && (cutoff === null || new Date(a.createdAt).getTime() >= cutoff));
    return actions.length > 0 ? actions[actions.length - 1] : null;
  }

  /** Find a specific pending action by id — still sender-bound (the confirmer
   *  must be the person the proposal was addressed to). */
  findById(id: string, sender: string): PendingAction | null {
    return this.load().find(a => a.id === id && a.sender === sender) ?? null;
  }

  /** All unexpired actions for a sender — for listing open proposals. */
  listFor(sender: string): PendingAction[] {
    return this.load().filter(a => a.sender === sender);
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
