/**
 * Who a web/console request IS — resolved in one place (reviews F07/F08, 2026-09-27).
 *
 * The token is the wall (DECISIONS "Two Outside Reviews Land"). Once a request has passed
 * the Bearer check, the credential it presented is the OWNER's credential — there is one
 * token and one owner — so the principal is `config.ownerId`, full stop. The `senderId` a
 * caller puts in the body or the query string (the extension mints a random one per
 * device; the console may pass one) is still useful, but only as a SESSION partition: each
 * device keeps its own transcript. It never decides ownership, trust, or tool visibility.
 *
 * Without a token (loopback bind, or `insecureOpen` chosen on purpose) the request has no
 * credential to derive identity from, so the caller's claim stands as before — loopback is
 * the owner's own machine, and insecureOpen is an explicit opt-in the doctor warns about.
 */
import type { InvarailConfig } from '../config/types.js';

export interface WebIdentity {
  /** The principal security decisions run as (ownership, trust, owner-only tools). */
  senderId: string;
  /** What partitions the session — the caller's claimed id when it differs from the principal. */
  channelId: string;
  /** How the principal was decided — for logs. */
  by: 'token→owner' | 'claimed' | 'default';
}

export function resolveWebIdentity(opts: {
  /** Absent (an adapter answering before the console deps are wired) = no credential to derive from. */
  config?: InvarailConfig | null;
  /** The sender the caller asked to be (body/query), if any. */
  claimed?: string | null;
  /** Session partition when the caller claims nothing. */
  channelId: string;
  /** Fallback principal when no token and no claim. */
  fallback: string;
}): WebIdentity {
  const tokenConfigured = !!opts.config?.channels.web?.token;
  const owner = opts.config?.ownerId;
  const claimed = opts.claimed?.trim() || undefined;
  if (tokenConfigured && owner) {
    // Authenticated: the owner. A claimed id that is not the owner's partitions the session.
    return { senderId: owner, channelId: claimed && claimed !== owner ? `${opts.channelId}:${claimed}` : opts.channelId, by: 'token→owner' };
  }
  if (claimed) return { senderId: claimed, channelId: opts.channelId, by: 'claimed' };
  return { senderId: opts.fallback, channelId: opts.channelId, by: 'default' };
}
