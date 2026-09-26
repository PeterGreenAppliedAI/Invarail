import { describe, it, expect } from 'vitest';
import { condenseToKeywords, buildSweepQueries, isRecencyShaped } from '../../src/pipeline/definitions/research.js';

describe('condenseToKeywords', () => {
  it('turns a question-shaped facet into a keyword query', () => {
    expect(condenseToKeywords('What are the emerging best practices in AI engineering this week?'))
      .toBe('emerging best practices AI engineering week');
  });

  it('handles the live failure case (Gemma/Llama style facet)', () => {
    const out = condenseToKeywords('What new model releases or updates happened this week in open source AI?');
    expect(out).toContain('model releases');
    expect(out).not.toMatch(/\bwhat\b|\bthe\b|\bhappened\b/i);
  });

  it('caps term count and strips punctuation', () => {
    const out = condenseToKeywords('Why, exactly, does the quick brown fox jump over the lazy dog again and again?', 4);
    expect(out.split(' ').length).toBeLessThanOrEqual(4);
    expect(out).not.toMatch(/[?,.]/);
  });

  it('keeps meaningful short queries intact', () => {
    expect(condenseToKeywords('Nemotron benchmarks')).toBe('Nemotron benchmarks');
  });
});

describe('isRecencyShaped', () => {
  it('matches news/week/release-shaped topics', () => {
    expect(isRecencyShaped('AI news this week')).toBe(true);
    expect(isRecencyShaped('What was announced at the conference')).toBe(true);
    expect(isRecencyShaped('latest local model releases')).toBe(true);
  });

  it('does not match timeless research topics', () => {
    expect(isRecencyShaped('heat pumps for old New England homes')).toBe(false);
    expect(isRecencyShaped('how does HNSW indexing work')).toBe(false);
  });
});

describe('buildSweepQueries', () => {
  it('builds generic keyword sweeps with month grounding', () => {
    const qs = buildSweepQueries('What is new in open source AI this week?', new Date('2026-08-14T12:00:00Z'));
    expect(qs).toHaveLength(2);
    expect(qs[0]).toBe('open source AI news');
    expect(qs[1]).toContain('August 2026');
    for (const q of qs) expect(q.split(' ').length).toBeLessThanOrEqual(8);
  });
});

describe('evidence gates — degrade honestly, never fabricate', () => {
  it('research: zero facets with findings aborts before synthesis', async () => {
    const { researchPipeline } = await import('../../src/pipeline/definitions/research.js');
    const gate = researchPipeline.stages.find(s => s.name === 'evidence_gate') as { execute: (ctx: unknown) => void };
    const ctx: Record<string, unknown> = { params: { _angleResults: [], topic: 'AI news this week' }, answer: '' };
    gate.execute(ctx);
    expect(ctx.abort).toBe(true);
    expect(String(ctx.answer)).toMatch(/won'?t write a report from memory/i);
  });

  it('research: gate is a no-op when findings exist', async () => {
    const { researchPipeline } = await import('../../src/pipeline/definitions/research.js');
    const gate = researchPipeline.stages.find(s => s.name === 'evidence_gate') as { execute: (ctx: unknown) => void };
    const ctx: Record<string, unknown> = { params: { _angleResults: [{ angle: 'a', findings: 'real', sources: ['u'] }], topic: 't' }, answer: '' };
    gate.execute(ctx);
    expect(ctx.abort).toBeUndefined();
  });

  it('web_search: zero urls aborts with the provider message quoted', async () => {
    const { webSearchPipeline } = await import('../../src/pipeline/definitions/web-search.js');
    const gate = webSearchPipeline.stages.find(s => s.name === 'evidence_gate') as { execute: (ctx: unknown) => void };
    const ctx: Record<string, unknown> = { params: { _urls: [] }, stageResults: { search: 'No results found for "x"' }, answer: '' };
    gate.execute(ctx);
    expect(ctx.abort).toBe(true);
    expect(String(ctx.answer)).toContain('No results found');
    expect(String(ctx.answer)).toMatch(/won'?t answer .* from memory/i);
  });

  it('web_search: gate is a no-op when urls exist', async () => {
    const { webSearchPipeline } = await import('../../src/pipeline/definitions/web-search.js');
    const gate = webSearchPipeline.stages.find(s => s.name === 'evidence_gate') as { execute: (ctx: unknown) => void };
    const ctx: Record<string, unknown> = { params: { _urls: ['https://a'] }, stageResults: { search: 'ok' }, answer: '' };
    gate.execute(ctx);
    expect(ctx.abort).toBeUndefined();
  });
});

describe('discovery sweep — every topic, not only recency-shaped (2026-09-25)', () => {
  // Live failure: "Jev vs Laya" (two decision models the model had never seen)
  // skipped the sweep and decomposed, cold, into six facets of dog food.
  it('gates only on flow-provided facets now', async () => {
    const { researchPipeline } = await import('../../src/pipeline/definitions/research.js');
    const sweep = researchPipeline.stages.find(s => s.name === 'discovery_sweep') as { when: (ctx: unknown) => boolean };
    expect(sweep.when({ params: { topic: 'Jev vs Laya' } })).toBe(true);
    expect(sweep.when({ params: { topic: 'AI news this week' } })).toBe(true);
    expect(sweep.when({ params: { topic: 'Jev vs Laya', _flowFacets: [{ angle: 'a', urls: ['u'] }] } })).toBe(false);
  });

  it('builds "what is this" queries for timeless topics and keeps the news shape for recency ones', () => {
    const now = new Date('2026-09-25T12:00:00Z');
    expect(buildSweepQueries('Jev vs Laya', now, false)).toEqual(['Jev vs Laya', 'what is Jev vs Laya']);
    const recency = buildSweepQueries('AI news this week', now, true);
    expect(recency[0]).toMatch(/news$/);
    expect(recency[1]).toMatch(/announcements September 2026$/);
  });

  it('tells decompose to treat the results as the DEFINITION of unfamiliar names', async () => {
    const { researchPipeline } = await import('../../src/pipeline/definitions/research.js');
    const decompose = researchPipeline.stages.find(s => s.name === 'decompose') as { buildPrompt: (ctx: unknown) => { system: string; user: string } };
    const cold = decompose.buildPrompt({ params: { topic: 'Jev vs Laya', _discoveryDigest: 'Laya is an open-source decision model…', _discoveryRecency: false } });
    expect(cold.system).toMatch(/definition of what the named things ARE/);
    expect(cold.user).toContain('Laya is an open-source decision model');
    const fresh = decompose.buildPrompt({ params: { topic: 'AI news this week', _discoveryDigest: 'x', _discoveryRecency: true } });
    expect(fresh.system).toMatch(/FRESH SEARCH RESULTS/);
  });
});
