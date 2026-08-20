import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { chatMaybeStructured } from '../pipeline/extractor.js';
import { parseJsonLoose } from '../pipeline/verification.js';
import { stripThinkingTags } from '../utils/text.js';
import { ErrorLearningStore } from '../learnings/error-store.js';
import type { OllamaClient } from '../ollama/client.js';

/**
 * Self-improvement proposals (DECISIONS: config-not-code Phase 2, generalized to code).
 * CODE detects recurring tool-failure signatures; the MODEL only phrases the !improve
 * spec; the OWNER confirms on the ledger; the existing self-mod rail does the rest
 * (Pi worktree → gates → second confirm for the merge → supervised deploy).
 * This module changes who INITIATES — never what the walls permit.
 */

export interface ImprovementCandidate {
  /** Stable dedup key: `${tool}:${normalized error prefix}` */
  signature: string;
  tool: string;
  error: string;
  count: number;
  examples: string[];
  lessonBoundary?: string;
}

export interface ProposalHistoryEntry {
  signature: string;
  spec: string;
  proposedAt: string;
  outcome: 'proposed' | 'denied' | 'confirmed';
  pendingId?: string;
}

export interface DraftedProposal {
  signature: string;
  spec: string;
  rationale: string;
  tool: string;
  count: number;
  error: string;
}

const HISTORY_PATH = 'data/self-mod/proposal-history.jsonl';
const DENIAL_CURSOR_PATH = 'data/self-mod/proposal-denial-cursor.json';

// ---------------------------------------------------------------- history

export class ProposalHistory {
  constructor(
    private readonly historyPath: string = HISTORY_PATH,
    private readonly cursorPath: string = DENIAL_CURSOR_PATH,
    private readonly metricsPath: string = 'data/metrics.jsonl',
  ) {}

  private loadRaw(): ProposalHistoryEntry[] {
    try {
      return readFileSync(this.historyPath, 'utf-8')
        .split('\n').filter(Boolean)
        .map(l => { try { return JSON.parse(l) as ProposalHistoryEntry; } catch { return null; } })
        .filter((e): e is ProposalHistoryEntry => e !== null);
    } catch {
      return [];
    }
  }

  /** Latest outcome wins per signature (append-only log, last-write-wins semantics). */
  bySignature(): Map<string, ProposalHistoryEntry> {
    const map = new Map<string, ProposalHistoryEntry>();
    for (const e of this.loadRaw()) map.set(e.signature, e);
    return map;
  }

  append(entry: ProposalHistoryEntry): void {
    mkdirSync(dirname(this.historyPath), { recursive: true });
    appendFileSync(this.historyPath, JSON.stringify(entry) + '\n');
  }

  /**
   * Pull denials from metrics (cursor-based — zero confirm-handler changes): a
   * `denied:self_improve` autonomous-action row marks that signature denied forever.
   * The pending action's params carry the signature in `detail` via the confirm handler's
   * denial log (detail = JSON params preview) — match by pendingId when present, else
   * by signature substring.
   */
  absorbDenialsFromMetrics(): number {
    let since = '';
    try { since = (JSON.parse(readFileSync(this.cursorPath, 'utf-8')) as { last: string }).last ?? ''; } catch { /* first run */ }
    let rows: Array<Record<string, unknown>> = [];
    try {
      rows = readFileSync(this.metricsPath, 'utf-8')
        .split('\n').filter(Boolean)
        .map(l => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } })
        .filter((r): r is Record<string, unknown> => r !== null)
        .filter(r => typeof r.timestamp === 'string' && (r.timestamp as string) > since)
        .filter(r => r.type === 'autonomous_action' && String(r.action ?? '').startsWith('denied:self_improve'));
    } catch {
      return 0;
    }
    if (rows.length === 0) return 0;

    const current = this.bySignature();
    let marked = 0;
    let newest = since;
    for (const r of rows) {
      const ts = r.timestamp as string;
      if (ts > newest) newest = ts;
      const detail = String(r.detail ?? '');
      for (const [signature, entry] of current) {
        if (entry.outcome === 'proposed' && (detail.includes(signature) || (entry.pendingId && detail.includes(entry.pendingId)))) {
          this.append({ ...entry, outcome: 'denied' });
          marked++;
        }
      }
    }
    try {
      mkdirSync(dirname(this.cursorPath), { recursive: true });
      writeFileSync(this.cursorPath + '.tmp', JSON.stringify({ last: newest }));
      renameSync(this.cursorPath + '.tmp', this.cursorPath);
    } catch { /* cursor is best-effort; worst case we rescan */ }
    return marked;
  }

  /** May this signature be proposed now? denied = never; proposed = cooldown; confirmed = cooldown. */
  eligible(signature: string, cooldownDays: number, now = Date.now()): boolean {
    const entry = this.bySignature().get(signature);
    if (!entry) return true;
    if (entry.outcome === 'denied') return false;
    const age = now - Date.parse(entry.proposedAt);
    return age > cooldownDays * 86_400_000;
  }
}

// ---------------------------------------------------------------- selection (pure code)

export function selectCandidates(opts: {
  workspacePath: string;
  minOccurrences?: number;
  lessonLookup?: (tool: string) => string | undefined;
}): ImprovementCandidate[] {
  const min = opts.minOccurrences ?? 3;
  const store = new ErrorLearningStore(opts.workspacePath);
  const entries = store.loadAll();
  const groups = new Map<string, ImprovementCandidate>();
  for (const e of entries) {
    const signature = `${e.tool}:${e.error.slice(0, 60).toLowerCase().trim()}`;
    const g = groups.get(signature);
    if (g) {
      g.count++;
      if (g.examples.length < 3 && !g.examples.includes(e.error.slice(0, 150))) g.examples.push(e.error.slice(0, 150));
    } else {
      groups.set(signature, {
        signature,
        tool: e.tool,
        error: e.error.slice(0, 150),
        count: 1,
        examples: [e.error.slice(0, 150)],
        lessonBoundary: opts.lessonLookup?.(e.tool),
      });
    }
  }
  return [...groups.values()].filter(g => g.count >= min).sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------- drafting (model phrases)

const DRAFT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    worthProposing: { type: 'boolean' },
    spec: { type: 'string' },
    rationale: { type: 'string' },
  },
  required: ['worthProposing', 'spec', 'rationale'],
};

const DRAFT_SYSTEM = [
  'You draft a code-improvement request from observed tool-failure evidence. The request will be',
  'implemented by a coding agent in the Invarail codebase (TypeScript) AFTER human approval.',
  'Rules:',
  '- The spec must name the failing tool and describe the SMALLEST code change that would prevent',
  '  this failure class: a clearer tool description, better error handling, a parameter fix.',
  '- Base the spec ONLY on the evidence given. Never invent errors or behaviors not shown.',
  '- If the evidence looks like user error, a transient outage, or is too vague to act on,',
  '  return worthProposing: false.',
  '- One to three sentences. JSON only: {"worthProposing": bool, "spec": "...", "rationale": "..."}',
].join('\n');

export async function draftProposal(
  client: OllamaClient,
  model: string,
  candidate: ImprovementCandidate,
): Promise<DraftedProposal | null> {
  const evidence = [
    `Tool: ${candidate.tool}`,
    `Failure (${candidate.count} occurrences): ${candidate.error}`,
    ...candidate.examples.slice(1).map(e => `Also seen: ${e}`),
    ...(candidate.lessonBoundary ? [`Known lesson: ${candidate.lessonBoundary}`] : []),
  ].join('\n');
  const raw = await chatMaybeStructured(client, model, [
    { role: 'system', content: DRAFT_SYSTEM },
    { role: 'user', content: evidence },
  ], DRAFT_JSON_SCHEMA, 512);
  const parsed = parseJsonLoose<{ worthProposing?: unknown; spec?: unknown; rationale?: unknown }>(stripThinkingTags(raw));
  if (!parsed || parsed.worthProposing !== true) return null;
  const spec = typeof parsed.spec === 'string' ? parsed.spec.trim() : '';
  // Discard guard (batch-distrust cousin): a spec that never mentions the failing tool
  // is not grounded in the evidence.
  if (!spec || !spec.toLowerCase().includes(candidate.tool.toLowerCase())) return null;
  return {
    signature: candidate.signature,
    spec,
    rationale: typeof parsed.rationale === 'string' ? parsed.rationale.slice(0, 300) : '',
    tool: candidate.tool,
    count: candidate.count,
    error: candidate.error,
  };
}
