import type { InvarailTool } from './types.js';
import type { SelfModService } from '../coding/self-mod-service.js';
import type { ChannelRegistry } from '../channels/registry.js';
import { ProposalHistory } from '../coding/improvement-proposals.js';

/**
 * self_improve — ledger-only executor for heartbeat-drafted improvement proposals.
 * Registered so the confirm path can run stored actions; NEVER in any specialist's tools
 * list (models cannot see or call it); no targetArgs (structurally grant-INELIGIBLE —
 * "always" can never mint self-improvement autonomy). Confirming this is gate ONE of two:
 * it starts the existing self-mod rail, which ends in its own self_merge confirmation.
 * The delivery target rides IN the params (recorded by the heartbeat at proposal time) —
 * recovery/reporting state never depends on execution context.
 */
export function createSelfImproveTool(deps: {
  service: SelfModService;
  channelRegistry: ChannelRegistry;
  history?: ProposalHistory;
}): InvarailTool {
  const history = deps.history ?? new ProposalHistory();
  return {
    name: 'self_improve',
    description: 'Start a heartbeat-proposed self-improvement: Pi implements the drafted spec in an isolated worktree, gates run, and the merge requires its own separate confirmation. Executed only via owner confirmation of a heartbeat proposal.',
    parameterDescription: 'spec, signature, notifyChannel, notifyTarget — drafted and recorded by the heartbeat; never model-invoked.',
    category: 'code',
    requiresConfirm: true,
    async execute(params, ctx): Promise<string> {
      const spec = String(params.spec ?? '').trim();
      const signature = String(params.signature ?? '');
      if (!spec) return 'Error: proposal spec is missing.';

      history.append({
        signature, spec, proposedAt: new Date().toISOString(), outcome: 'confirmed',
      });

      const notifyChannel = String(params.notifyChannel ?? '');
      const notifyTarget = String(params.notifyTarget ?? '');
      // Fire-and-report (the !improve handler's pattern): the Pi session + gate take
      // minutes — report completion to the heartbeat's delivery target when it lands.
      void deps.service.propose(spec, ctx.senderId ?? 'owner', notifyChannel || 'heartbeat')
        .then(res => {
          if (notifyChannel && notifyTarget) {
            return deps.channelRegistry.send({ channel: notifyChannel, channelId: notifyTarget }, { text: res.reply });
          }
          console.log(`[SelfImprove] Propose finished (no delivery target): ${res.reply.slice(0, 120)}`);
        })
        .catch(err => {
          const msg = `Self-improvement attempt failed: ${err instanceof Error ? err.message : String(err)}`;
          console.warn('[SelfImprove]', msg);
          if (notifyChannel && notifyTarget) {
            return deps.channelRegistry.send({ channel: notifyChannel, channelId: notifyTarget }, { text: msg }).catch(() => undefined);
          }
        });

      return `Started — Pi is implementing the proposal in an isolated worktree. Gate results and the merge confirmation will follow.\nSpec: ${spec.slice(0, 200)}`;
    },
  };
}
