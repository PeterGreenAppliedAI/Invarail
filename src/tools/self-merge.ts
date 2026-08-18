import type { InvarailTool } from './types.js';
import type { SelfModService } from '../coding/self-mod-service.js';

/**
 * self_merge — the ledger-only merge executor for self-modification. Registered so the
 * confirm path can execute stored actions, but NEVER added to any specialist's tools list:
 * models cannot see or call it. No targetArgs → structurally grant-INELIGIBLE ("always"
 * can never mint a standing merge approval; every merge is confirmed, forever).
 */
export function createSelfMergeTool(service: SelfModService): InvarailTool {
  return {
    name: 'self_merge',
    description: 'Merge a gate-passed self-modification branch into main and restart under the supervisor. Executed only via owner confirmation of an !improve proposal.',
    parameterDescription: 'slug, branch, baseSha, headSha — recorded by the propose flow; never model-authored.',
    category: 'code',
    requiresConfirm: true,
    async execute(params): Promise<string> {
      return service.executeMerge(params);
    },
  };
}
