import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LocalClawTool } from '../tools/types.js';

/**
 * Target-bound standing grants — the autonomy-ladder rung between
 * propose_confirm and blanket autoApproveTools promotion.
 *
 * A grant binds a TOOL to ONE EXACT TARGET ("send_message → discord:123"),
 * minted only from an explicit "always <id>" on a confirm preview. Structural
 * properties: only tools declaring `targetArgs` are eligible (exec never is),
 * matching is exact-string (no globs), grants are principal-bound and
 * individually revocable via !grants.
 */
export interface StandingGrant {
  id: string;
  tool: string;
  /** Joined targetArgs values, e.g. "discord:1234567890" */
  target: string;
  /** Principal (not raw channel sender) who granted it */
  principal: string;
  channel: string;
  createdAt: string;
  source: 'confirm' | 'cron_creation';
}

const STORE_PATH = 'data/grants.json';

/** Compute the grant key for a call, or null when the tool is grant-ineligible
 *  or any target param is missing/empty (fail-closed on both). */
export function grantTargetFor(tool: LocalClawTool | undefined, params: Record<string, unknown>): string | null {
  if (!tool?.targetArgs?.length) return null;
  const parts: string[] = [];
  for (const arg of tool.targetArgs) {
    const value = params[arg];
    if (typeof value !== 'string' || value.trim() === '') return null;
    parts.push(value.trim());
  }
  return parts.join(':');
}

export class GrantStore {
  constructor(private readonly path: string = STORE_PATH) {}

  private load(): StandingGrant[] {
    try {
      return JSON.parse(readFileSync(this.path, 'utf-8')) as StandingGrant[];
    } catch {
      return [];
    }
  }

  private save(grants: StandingGrant[]): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(grants, null, 2));
    } catch (err) {
      console.warn('[Grants] Save failed:', err instanceof Error ? err.message : err);
    }
  }

  record(entry: Omit<StandingGrant, 'id' | 'createdAt'>): StandingGrant {
    const existing = this.findMatch(entry.tool, entry.target, entry.principal);
    if (existing) return existing;
    const grant: StandingGrant = {
      ...entry,
      id: randomBytes(4).toString('hex'),
      createdAt: new Date().toISOString(),
    };
    const grants = this.load();
    grants.push(grant);
    this.save(grants);
    console.log(`[Grants] Standing grant minted: ${grant.tool} → ${grant.target} (id=${grant.id}, by ${grant.principal})`);
    return grant;
  }

  /** Exact-match lookup — tool + target + principal must all match. */
  findMatch(tool: string, target: string, principal: string): StandingGrant | null {
    return this.load().find(g => g.tool === tool && g.target === target && g.principal === principal) ?? null;
  }

  listFor(principal: string): StandingGrant[] {
    return this.load().filter(g => g.principal === principal);
  }

  revoke(id: string, principal: string): StandingGrant | null {
    const grants = this.load();
    const idx = grants.findIndex(g => g.id === id && g.principal === principal);
    if (idx === -1) return null;
    const [revoked] = grants.splice(idx, 1);
    this.save(grants);
    console.log(`[Grants] Revoked: ${revoked.tool} → ${revoked.target} (id=${revoked.id})`);
    return revoked;
  }
}

/** Shared instance — preview/enforcement sites (dispatch) and mint/revoke sites
 *  (confirm-handler, orchestrator commands) must see the same grants. */
export const standingGrants = new GrantStore();

/**
 * Should this confirm-gated call run WITHOUT asking?
 *  - 'standing'     — an "always" grant covers this exact tool→target
 *  - 'reply_origin' — the target IS the conversation the request came from
 *    (asking permission to reply to the person who just asked is ceremony)
 * Null = ask as usual. Both paths still require the tool to declare targetArgs.
 */
export function resolveGrantApproval(
  tool: LocalClawTool | undefined,
  params: Record<string, unknown>,
  principal: string,
  origin?: { channel: string; channelId: string },
  store: GrantStore = standingGrants,
): 'standing' | 'reply_origin' | null {
  if (!tool) return null;
  const target = grantTargetFor(tool, params);
  if (!target) return null;
  if (store.findMatch(tool.name, target, principal)) return 'standing';
  if (origin && target === `${origin.channel}:${origin.channelId}`) return 'reply_origin';
  return null;
}
