import { describe, expect, it, vi } from 'vitest';
import { buildPriorExperienceBrief, buildMemorySearchCallback, type CodingMemoryDeps } from '../../src/coding/coding-memory.js';
import type { ExperienceStore, ExperienceMatch } from '../../src/memory/experience-store.js';
import type { GraphMemoryStore } from '../../src/memory/graph-store.js';

function match(overrides: Partial<ExperienceMatch>): ExperienceMatch {
  return {
    id: 'x', text: 'For adding tools, followed the factory pattern — worked', taskShape: 's', approach: 'a',
    outcome: 'worked', satisfaction: 1, evidenceCount: 1, model: 'm', createdAt: 'c', lastConfirmed: 'l',
    verified: true, score: 0.8, ...overrides,
  };
}

describe('buildPriorExperienceBrief', () => {
  it('bounded block with outcome + verification markers', async () => {
    const deps: CodingMemoryDeps = {
      experienceStore: {
        searchRelevant: vi.fn(async () => [
          match({ text: 'A'.repeat(300), verified: true }),
          match({ id: 'y', text: 'failed one', outcome: 'failed', verified: false }),
        ]),
      } as unknown as ExperienceStore,
    };
    const brief = await buildPriorExperienceBrief('add a widget', deps);
    expect(brief).toContain('PRIOR EXPERIENCE');
    expect(brief).toContain('[worked, gate-verified]');
    expect(brief).toContain('[failed]');
    expect(brief.split('\n').filter(l => l.startsWith('- ')).length).toBeLessThanOrEqual(4);
    expect(brief).not.toContain('A'.repeat(201)); // per-line cap
  });

  it('empty-safe: no deps → empty string; store failure → empty string', async () => {
    expect(await buildPriorExperienceBrief('x', {})).toBe('');
    const deps: CodingMemoryDeps = {
      experienceStore: { searchRelevant: vi.fn(async () => { throw new Error('down'); }) } as unknown as ExperienceStore,
    };
    expect(await buildPriorExperienceBrief('x', deps)).toBe('');
  });
});

describe('buildMemorySearchCallback', () => {
  it('composes experiences + facts into one-liners', async () => {
    const deps: CodingMemoryDeps = {
      ownerId: 'peter',
      experienceStore: {
        searchRelevant: vi.fn(async () => [match({ text: 'ssrf checks required on fetchers', outcome: 'worked' })]),
      } as unknown as ExperienceStore,
      graphMemory: {
        search: vi.fn(async () => [{ text: 'web_fetch rejects Atom feeds' }]),
      } as unknown as GraphMemoryStore,
    };
    const search = buildMemorySearchCallback(deps);
    const out = await search('web fetch');
    expect(out).toContain('[experience/worked/verified] ssrf checks required');
    expect(out).toContain('[fact] web_fetch rejects Atom feeds');
  });

  it('NEVER throws — failures and empties return the no-results text', async () => {
    const broken: CodingMemoryDeps = {
      ownerId: 'peter',
      experienceStore: { searchRelevant: vi.fn(async () => { throw new Error('falkor down'); }) } as unknown as ExperienceStore,
      graphMemory: { search: vi.fn(async () => { throw new Error('also down'); }) } as unknown as GraphMemoryStore,
    };
    await expect(buildMemorySearchCallback(broken)('q')).resolves.toBe('No relevant prior experience or facts found.');
    await expect(buildMemorySearchCallback({})('q')).resolves.toBe('No relevant prior experience or facts found.');
  });
});
