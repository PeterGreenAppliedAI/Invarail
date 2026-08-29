import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { selectCandidates, draftProposal, ProposalHistory, type ImprovementCandidate } from '../../src/coding/improvement-proposals.js';
import { ErrorLearningStore } from '../../src/learnings/error-store.js';
import type { OllamaClient } from '../../src/ollama/client.js';

describe('selectCandidates', () => {
  let ws: string;
  beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'sip-')); });
  afterEach(() => rmSync(ws, { recursive: true, force: true }));

  it('groups by tool + error prefix, requires minOccurrences, sorts by count', () => {
    const store = new ErrorLearningStore(ws);
    for (let i = 0; i < 4; i++) store.recordError({ tool: 'web_fetch', params: {}, error: 'HTTP 403 blocked by host', step: 1, category: 'multi' });
    for (let i = 0; i < 3; i++) store.recordError({ tool: 'exec', params: {}, error: 'SyntaxError: unterminated string literal', step: 1, category: 'multi' });
    store.recordError({ tool: 'browser', params: {}, error: 'once only', step: 1, category: 'multi' });

    const candidates = selectCandidates({ workspacePath: ws });
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({ tool: 'web_fetch', count: 4 });
    expect(candidates[1]).toMatchObject({ tool: 'exec', count: 3 });
    expect(candidates[0].signature).toContain('web_fetch:');
  });

  it('attaches lesson boundaries when the lookup knows the tool', () => {
    const store = new ErrorLearningStore(ws);
    for (let i = 0; i < 3; i++) store.recordError({ tool: 'exec', params: {}, error: 'same failure', step: 1, category: 'x' });
    const [c] = selectCandidates({ workspacePath: ws, lessonLookup: t => t === 'exec' ? 'never use shell redirects' : undefined });
    expect(c.lessonBoundary).toBe('never use shell redirects');
  });
});

describe('ProposalHistory', () => {
  let dir: string;
  let history: ProposalHistory;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sip-hist-'));
    history = new ProposalHistory(join(dir, 'history.jsonl'), join(dir, 'cursor.json'), join(dir, 'metrics.jsonl'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('denied signatures are permanently ineligible; proposed ones cool down', () => {
    history.append({ signature: 'exec:boom', spec: 's', proposedAt: new Date().toISOString(), outcome: 'proposed' });
    expect(history.eligible('exec:boom', 7)).toBe(false); // in cooldown
    expect(history.eligible('exec:boom', 0, Date.now() + 1000)).toBe(true); // cooldown elapsed

    history.append({ signature: 'exec:boom', spec: 's', proposedAt: new Date().toISOString(), outcome: 'denied' });
    expect(history.eligible('exec:boom', 0, Date.now() + 999_999_999)).toBe(false); // denied = never
    expect(history.eligible('fresh:signature', 7)).toBe(true);
  });

  it('absorbs denials from metrics rows by pendingId, once (cursor advances)', () => {
    history.append({ signature: 'web_fetch:403', spec: 's', proposedAt: new Date().toISOString(), outcome: 'proposed', pendingId: 'abc12345' });
    appendFileSync(join(dir, 'metrics.jsonl'), JSON.stringify({
      timestamp: new Date().toISOString(), type: 'autonomous_action',
      action: 'denied:self_improve', outcome: 'rejected', detail: 'denied abc12345 {"spec":"..."}',
    }) + '\n');

    expect(history.absorbDenialsFromMetrics()).toBe(1);
    expect(history.bySignature().get('web_fetch:403')?.outcome).toBe('denied');
    expect(history.absorbDenialsFromMetrics()).toBe(0); // cursor advanced — no rescan
  });

  it('absorbs legacy rows where truncation ate the id: matches by spec prefix', () => {
    // Pre-fix denial rows: detail = params JSON sliced at 120 chars — a long spec
    // means neither pendingId nor signature ever appears (drill 2026-08-20).
    const spec = "Add a 'retry' option with default set to false and an exponential backoff strategy when using the `navigateTo` method of the browser tool.";
    history.append({ signature: 'browser:timeout', spec, proposedAt: new Date().toISOString(), outcome: 'proposed', pendingId: '9f85f39a' });
    appendFileSync(join(dir, 'metrics.jsonl'), JSON.stringify({
      timestamp: new Date().toISOString(), type: 'autonomous_action',
      action: 'denied:self_improve', outcome: 'rejected',
      detail: JSON.stringify({ spec, signature: 'browser:timeout' }).slice(0, 120),
    }) + '\n');

    expect(history.absorbDenialsFromMetrics()).toBe(1);
    expect(history.bySignature().get('browser:timeout')?.outcome).toBe('denied');
  });
});

describe('draftProposal', () => {
  const candidate: ImprovementCandidate = {
    signature: 'web_fetch:http 403', tool: 'web_fetch', error: 'HTTP 403 blocked', count: 5,
    examples: ['HTTP 403 blocked'],
  };
  const client = (json: unknown): OllamaClient =>
    ({ chat: vi.fn(async () => ({ message: { role: 'assistant', content: JSON.stringify(json) } })) }) as unknown as OllamaClient;

  it('returns a grounded draft', async () => {
    const draft = await draftProposal(client({ worthProposing: true, spec: 'Make web_fetch retry 403s with a UA fallback.', rationale: 'r' }), 'm', candidate);
    expect(draft?.spec).toContain('web_fetch');
    expect(draft?.signature).toBe(candidate.signature);
  });

  it('discards: not worth proposing, tool not mentioned, garbage output', async () => {
    expect(await draftProposal(client({ worthProposing: false, spec: 'x web_fetch', rationale: '' }), 'm', candidate)).toBeNull();
    expect(await draftProposal(client({ worthProposing: true, spec: 'Improve the thing generally.', rationale: '' }), 'm', candidate)).toBeNull();
    expect(await draftProposal(client('not json' as never), 'm', candidate)).toBeNull();
  });
});

describe('recency window (the done-marker)', () => {
  it('stale errors do not qualify; fresh recurrence after a fix does', () => {
    const ws = mkdtempSync(join(tmpdir(), 'sip-recency-'));
    const store = new ErrorLearningStore(ws);
    // Simulate 4 stale errors by writing entries with old timestamps directly
    mkdirSync(join(ws, '.learnings'), { recursive: true });
    const old = new Date(Date.now() - 60 * 86_400_000).toISOString();
    for (let i = 0; i < 4; i++) {
      appendFileSync(join(ws, '.learnings', 'errors.jsonl'), JSON.stringify({
        timestamp: old, tool: 'document', params: {}, error: 'conversion produced no output', step: 1, category: 'x',
      }) + '\n');
    }
    expect(selectCandidates({ workspacePath: ws })).toHaveLength(0); // stale = no evidence

    // Fresh recurrence AFTER the fix window re-qualifies legitimately
    for (let i = 0; i < 3; i++) store.recordError({ tool: 'document', params: {}, error: 'conversion produced no output', step: 1, category: 'x' });
    expect(selectCandidates({ workspacePath: ws })).toHaveLength(1);
    rmSync(ws, { recursive: true, force: true });
  });
});
