import type { InvarailConfig } from '../config/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import { isOwner } from '../identity/principal.js';

/**
 * The channel + specialist tool policy as ONE question: may this principal run this
 * tool in this category on this channel? Dispatch applies the same layers while
 * building a scope; the confirm handler asks this at confirmation time, because a
 * stored action executes long after the scope that produced it is gone — and a
 * confirmation must approve an action inside the caller's permissions, never widen
 * them (outside review F02, 2026-09-27).
 */
export interface ToolPolicyQuery {
  tool: string;
  category?: string;
  channel?: string;
  /** Resolved principal. */
  senderId: string;
  /** Raw channel id, when known — trust/owner lists may hold either spelling. */
  rawSenderId?: string;
}

export type ToolPolicyVerdict = { allowed: true } | { allowed: false; reason: string };

export function checkToolPolicy(config: InvarailConfig, registry: ToolRegistry, q: ToolPolicyQuery): ToolPolicyVerdict {
  const deny = (reason: string): ToolPolicyVerdict => ({ allowed: false, reason });
  const security = q.channel ? config.channels?.[q.channel]?.security : undefined;
  const owner = isOwner(q.senderId, config) || (q.rawSenderId !== undefined && isOwner(q.rawSenderId, config));
  const trusted = !security?.trustedUsers
    || security.trustedUsers.includes(q.senderId)
    || (q.rawSenderId !== undefined && security.trustedUsers.includes(q.rawSenderId));

  // Category layers first — dispatch applies them before any tool layer (re-review N01, 2026-09-27).
  if (q.category && security?.allowedCategories && !security.allowedCategories.includes(q.category)) {
    return deny(`category "${q.category}" is not allowed on the ${q.channel} channel`);
  }
  if (q.category && !trusted && security?.restrictedCategories?.includes(q.category)) {
    return deny(`category "${q.category}" is restricted for untrusted users`);
  }
  if (security?.blockedTools?.includes(q.tool)) return deny(`"${q.tool}" is blocked on the ${q.channel} channel`);
  if (!owner && security?.ownerOnlyTools?.includes(q.tool)) return deny(`"${q.tool}" is owner-only`);
  if (!trusted && security?.restrictedTools?.includes(q.tool)) return deny(`"${q.tool}" is restricted for untrusted users`);

  if (q.category) {
    const specialist = config.specialists?.[q.category];
    if (specialist && typeof registry.expandToolNames === 'function') {
      const expanded = registry.expandToolNames(specialist.tools ?? []);
      if (!expanded.includes(q.tool)) return deny(`"${q.tool}" is not in the ${q.category} specialist's tool set`);
    }
  }
  return { allowed: true };
}
