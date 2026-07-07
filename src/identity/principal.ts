import type { LocalClawConfig } from '../config/types.js';

/**
 * Principal resolution — the identity pillar of the session control plane.
 *
 * A principal is a PERSON; channel sender ids (Discord snowflake, Telegram id,
 * WhatsApp jid, "console-user") are aliases of one. Memory, the pending-action
 * ledger, and trust checks key on the principal so knowledge and authority
 * follow the person across channels instead of fragmenting per channel.
 *
 * Unmapped sender ids pass through unchanged — the layer is purely additive
 * and a config without `principals` behaves exactly as before.
 */

const mapCache = new WeakMap<object, Map<string, string>>();

function aliasMap(config: LocalClawConfig): Map<string, string> {
  let map = mapCache.get(config);
  if (!map) {
    map = new Map();
    for (const [principal, def] of Object.entries(config.principals ?? {})) {
      map.set(principal, principal);
      for (const alias of def.aliases) {
        const prior = map.get(alias);
        if (prior && prior !== principal) {
          console.warn(`[Identity] Alias "${alias}" claimed by both "${prior}" and "${principal}" — keeping "${prior}"`);
          continue;
        }
        map.set(alias, principal);
      }
    }
    mapCache.set(config, map);
  }
  return map;
}

/** Resolve a channel sender id to its principal. Unmapped ids pass through. */
export function resolvePrincipal(senderId: string, config: LocalClawConfig): string;
export function resolvePrincipal(senderId: string | undefined, config: LocalClawConfig): string | undefined;
export function resolvePrincipal(senderId: string | undefined, config: LocalClawConfig): string | undefined {
  if (!senderId) return senderId;
  return aliasMap(config).get(senderId) ?? senderId;
}

/** Is this sender the owner? Matches ownerId directly OR via shared principal. */
export function isOwner(senderId: string | undefined, config: LocalClawConfig): boolean {
  if (!senderId || !config.ownerId) return false;
  if (senderId === config.ownerId) return true;
  return resolvePrincipal(senderId, config) === resolvePrincipal(config.ownerId, config);
}
