import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { google } from 'googleapis';
import { getAuth } from '../tools/gmail-read.js';
import { chatMaybeStructured } from '../pipeline/extractor.js';
import { parseJsonLoose } from '../pipeline/verification.js';
import { stripThinkingTags } from '../utils/text.js';
import { logAutonomousAction } from '../metrics.js';
import type { OllamaClient } from '../ollama/client.js';
import type { InvarailConfig } from '../config/types.js';

/**
 * Email steward v1 (DECISIONS "The Factory", phase 1). READ-ONLY FOREVER: informs
 * Peter of mail that needs him; never writes, drafts, or replies (no send capability
 * exists — the boundary is tool absence, not policy).
 *
 * Shape: one delta poll — code filters automated mail, fast-lane matches (support
 * alias / VIP senders) ping immediately without a model call, everything else gets
 * ONE grammar-constrained needs-Peter judgment; flagged non-fast mail accumulates
 * for the heartbeat digest. Every alert logs an autonomous_action row — the 👍/👎
 * track record that any later ladder promotion must cite.
 */

const STATE_PATH = 'data/steward/email-seen.json';
const SEEN_CAP = 500;

export interface FlaggedEmail {
  id: string;
  from: string;
  subject: string;
  date: string;
  reason: string;
  lane: 'fast' | 'judged';
}

interface StewardState {
  seenIds: string[];
  digest: FlaggedEmail[];
}

export interface StewardDeps {
  config: InvarailConfig;
  client: OllamaClient;
  send: (target: { channel: string; channelId: string }, text: string) => Promise<void>;
  statePath?: string;
}

function loadState(path: string): StewardState {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as StewardState;
  } catch {
    return { seenIds: [], digest: [] };
  }
}

function saveState(path: string, state: StewardState): void {
  state.seenIds = state.seenIds.slice(-SEEN_CAP);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path + '.tmp', JSON.stringify(state));
  renameSync(path + '.tmp', path);
}

/** Automated senders never reach the model — code-detectable noise. */
export function isAutomated(from: string, listUnsubscribe: string | undefined): boolean {
  if (listUnsubscribe) return true;
  return /\b(no-?reply|donotreply|notifications?|mailer(-daemon)?|newsletter|updates?|alerts?|billing|receipts?)@/i.test(from);
}

/** Sender match: exact address ("a@b.com") or bare domain ("b.com", subdomains included). */
export function matchesSenders(from: string, senders: string[]): boolean {
  const fromAddr = (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase();
  return senders.some(s => {
    const needle = s.toLowerCase();
    return needle.includes('@') ? fromAddr === needle : fromAddr.endsWith('@' + needle) || fromAddr.endsWith('.' + needle);
  });
}

/** Fast-lane: delivered to a watched alias, or from a VIP address/domain. */
export function isFastLane(from: string, to: string, cfg: { aliases: string[]; senders: string[] }): boolean {
  const toLower = to.toLowerCase();
  if (cfg.aliases.some(a => toLower.includes(a.toLowerCase()))) return true;
  return matchesSenders(from, cfg.senders);
}

const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    needsPeter: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['needsPeter', 'reason'],
};

const JUDGE_SYSTEM = [
  'You triage ONE email for a busy owner. Decide if it NEEDS his personal attention.',
  'needsPeter=true ONLY for: a direct question or explicit request addressed to him,',
  'money/deadline/legal/contract matters, or a real human clearly waiting on his reply.',
  'needsPeter=false for: marketing, FYI threads, receipts, social notifications,',
  'automated reports, mail he is only CCed on with no ask.',
  'JSON only: {"needsPeter": bool, "reason": "<under 15 words>"}',
].join('\n');

export function formatAlert(f: FlaggedEmail): string {
  return `📧 **${f.from.replace(/<[^>]*>/g, '').trim() || f.from}** — ${f.subject}\n> ${f.reason} · ${f.date}`;
}

/**
 * One poll cycle. Returns counts for logging/tests. Failures degrade to silence
 * (a broken steward must never spam) but always warn to the log.
 */
export async function checkInbox(deps: StewardDeps): Promise<{ fetched: number; pinged: number; queued: number }> {
  const cfg = deps.config.emailTriage;
  if (!cfg?.enabled) return { fetched: 0, pinged: 0, queued: 0 };
  const auth = getAuth();
  if (!auth) {
    console.warn('[Steward] Gmail not configured (GOOGLE_* env) — skipping poll');
    return { fetched: 0, pinged: 0, queued: 0 };
  }
  const statePath = deps.statePath ?? STATE_PATH;
  const state = loadState(statePath);
  const gmail = google.gmail({ version: 'v1', auth });

  const list = await gmail.users.messages.list({ userId: 'me', q: 'in:inbox newer_than:2d', maxResults: 25 });
  const ids = (list.data.messages ?? []).map(m => m.id!).filter(id => !state.seenIds.includes(id));
  let pinged = 0;
  let queued = 0;

  const delivery = cfg.delivery ?? deps.config.heartbeat?.delivery;
  const model = cfg.model ?? deps.config.heartbeat?.model ?? deps.config.router.model;

  for (const id of ids) {
    state.seenIds.push(id);
    try {
      const msg = await gmail.users.messages.get({
        userId: 'me', id, format: 'metadata',
        metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Date', 'List-Unsubscribe'],
      });
      const h = Object.fromEntries((msg.data.payload?.headers ?? []).map(x => [x.name ?? '', x.value ?? '']));
      const from = h.From ?? '';
      const to = `${h.To ?? ''} ${h.Cc ?? ''}`;
      const subject = h.Subject ?? '(no subject)';
      const date = h.Date ?? '';
      const snippet = msg.data.snippet ?? '';

      let flagged: FlaggedEmail | null = null;
      if (isFastLane(from, to, cfg.fastLane)) {
        // Fast lane checks BEFORE the automated filter — a chosen sender is never bulk.
        flagged = { id, from, subject, date, reason: 'fast lane (watched alias/sender)', lane: 'fast' };
      } else if (matchesSenders(from, cfg.watch.senders)) {
        // Watch lane: always-flag into the digest, no model call. Also bypasses the
        // automated filter — group/event mail is bulk by nature, and bulk ≠ unwanted
        // when the owner chose the sender.
        flagged = { id, from, subject, date, reason: 'watched sender', lane: 'judged' };
      } else if (isAutomated(from, h['List-Unsubscribe'])) {
        continue;
      } else {
        try {
          const raw = await chatMaybeStructured(deps.client, model, [
            { role: 'system', content: JUDGE_SYSTEM },
            { role: 'user', content: `From: ${from}\nTo: ${to}\nSubject: ${subject}\nSnippet: ${snippet.slice(0, 400)}` },
          ], JUDGE_SCHEMA, 256);
          const verdict = parseJsonLoose<{ needsPeter?: unknown; reason?: unknown }>(stripThinkingTags(raw));
          if (verdict?.needsPeter === true) {
            flagged = { id, from, subject, date, reason: typeof verdict.reason === 'string' ? verdict.reason.slice(0, 120) : 'needs your attention', lane: 'judged' };
          }
        } catch (err) {
          console.warn('[Steward] Judgment failed (leaving unflagged):', err instanceof Error ? err.message : err);
        }
      }
      if (!flagged) continue;

      logAutonomousAction({
        action: 'email_alert', tier: 'silent', source: 'steward', reversible: true,
        outcome: 'proposed', detail: `${flagged.lane}: ${from.slice(0, 60)} — ${subject.slice(0, 60)}`,
      });
      if (flagged.lane === 'fast' && delivery) {
        await deps.send({ channel: delivery.channel, channelId: delivery.target }, formatAlert(flagged));
        pinged++;
      } else {
        state.digest.push(flagged);
        queued++;
      }
    } catch (err) {
      console.warn('[Steward] Message fetch failed:', err instanceof Error ? err.message : err);
    }
  }

  saveState(statePath, state);
  if (ids.length > 0) console.log(`[Steward] Poll: ${ids.length} new, ${pinged} pinged, ${queued} queued for digest`);
  return { fetched: ids.length, pinged, queued };
}

/** Drain flagged-but-not-pinged mail for the heartbeat digest. Empties the pile. */
export function drainDigest(statePath = STATE_PATH): FlaggedEmail[] {
  const state = loadState(statePath);
  const out = state.digest;
  state.digest = [];
  saveState(statePath, state);
  return out;
}
