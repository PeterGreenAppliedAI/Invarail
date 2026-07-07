import { resolveWorkspacePath } from '../agents/scope.js';
import { resolvePrincipal } from '../identity/principal.js';
import { logAutonomousAction } from '../metrics.js';
import type { LocalClawConfig } from '../config/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { SessionStore } from '../sessions/store.js';
import {
  pendingActions,
  PendingActionStore,
  CONFIRMATION_PATTERN,
  CONFIRMATION_NEAR_MISS,
  BARE_CONFIRM_MAX_AGE_MS,
  parseConfirmationId,
} from './pending-actions.js';

/**
 * THE confirm entry point — every channel path calls this one function.
 *
 * Previously the orchestrator and the console chat handler each carried their
 * own copy of this logic; any behavior fix had to land twice or the two
 * surfaces drifted (the exact bug class the confusion audit flagged). The
 * control-plane rule: one pending-interaction behavior, many delivery
 * surfaces.
 *
 * Semantics (all audit-hardened):
 *  - "confirm <id>" executes that stored action — principal-bound
 *  - bare "confirm"/"go ahead" only matches an entry recorded < 10 min ago on
 *    the SAME channel (stale 12h briefing proposals require the id)
 *  - near-misses ("confirm 2", typo'd ids) get an error + the open list,
 *    never a fall-through to chat
 *  - the exchange is written to the proposal's session transcript
 */
export interface ConfirmOutcome {
  /** true = the message was a confirmation interaction; deliver `reply` and stop */
  handled: boolean;
  reply?: string;
}

export interface ConfirmContext {
  message: string;
  /** RAW channel sender id — principal resolution happens here */
  senderId: string;
  channel: string;
  config: LocalClawConfig;
  toolRegistry: ToolRegistry;
  sessionStore?: SessionStore;
  store?: PendingActionStore;
}

export async function handleConfirmation(ctx: ConfirmContext): Promise<ConfirmOutcome> {
  const trimmed = ctx.message.trim();
  const isStrict = CONFIRMATION_PATTERN.test(trimmed);
  const isNearMiss = !isStrict && CONFIRMATION_NEAR_MISS.test(trimmed);
  if (!isStrict && !isNearMiss) return { handled: false };

  const store = ctx.store ?? pendingActions;
  const principal = resolvePrincipal(ctx.senderId, ctx.config);
  const targetId = isStrict ? parseConfirmationId(trimmed) : null;

  const pending = targetId
    ? store.findById(targetId, principal)
    : isStrict
      ? store.latestFor(principal, ctx.channel, BARE_CONFIRM_MAX_AGE_MS)
      : null;

  if (!pending) {
    // Bare confirm with nothing recent is NOT a confirmation interaction —
    // "go ahead" mid-conversation should reach the model as normal chat
    if (isStrict && !targetId) return { handled: false };

    const open = store.listFor(principal);
    const openList = open.length > 0
      ? `\nOpen proposals:\n${open.map(p => `- \`confirm ${p.id}\` → ${p.tool}`).join('\n')}`
      : '\nNo open proposals.';
    return { handled: true, reply: `That doesn't match a pending action — it may have expired or already run.${openList}` };
  }

  store.consume(pending.id);
  let reply: string;
  try {
    const executor = ctx.toolRegistry.createScopedExecutor(new Set([pending.tool]));
    const workspacePath = resolveWorkspacePath(pending.agentId, ctx.config);
    const observation = await executor(pending.tool, pending.params, {
      agentId: pending.agentId,
      sessionKey: pending.sessionKey,
      workspacePath,
      senderId: principal,
      channel: ctx.channel,
    });
    logAutonomousAction({ action: `confirmed:${pending.tool}`, tier: 'propose_confirm', source: 'user_confirm', reversible: false, outcome: 'confirmed', detail: JSON.stringify(pending.params).slice(0, 120) });
    reply = `✅ Ran **${pending.tool}**: ${observation}`;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logAutonomousAction({ action: `confirmed:${pending.tool}`, tier: 'propose_confirm', source: 'user_confirm', reversible: false, outcome: 'failure', detail: errMsg.slice(0, 120) });
    reply = `❌ **${pending.tool}** failed: ${errMsg}`;
  }

  if (ctx.sessionStore) {
    try {
      ctx.sessionStore.appendTurn(pending.agentId, pending.sessionKey, { role: 'user', content: trimmed, timestamp: new Date().toISOString() });
      ctx.sessionStore.appendTurn(pending.agentId, pending.sessionKey, { role: 'assistant', content: reply, timestamp: new Date().toISOString() });
    } catch (err) {
      console.warn('[Confirm] Failed to record exchange in transcript:', err instanceof Error ? err.message : err);
    }
  }

  return { handled: true, reply };
}
