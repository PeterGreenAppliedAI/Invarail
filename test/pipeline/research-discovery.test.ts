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
