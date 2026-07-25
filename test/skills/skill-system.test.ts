import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillStore, type Skill } from '../../src/skills/store.js';
import { findMatchingSkill, findMatchingSkillHybrid } from '../../src/skills/matcher.js';
import { EmbeddingStore } from '../../src/memory/embeddings.js';
import { setEmbeddingStoreForTests, upsertSkillEmbedding, findSkillBySimilarity } from '../../src/skills/semantic.js';
import type { OllamaClient } from '../../src/ollama/client.js';

function makeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    name: 'generate-report-from-web',
    slug: 'generate-report-from-web',
    description: 'Search the web for specific content and compile the results into a report format.',
    created: '2026-04-01',
    lastUsed: '2026-04-13',
    successCount: 5,
    steps: [
      { tool: 'web_search', params: { message: 'find news' }, purpose: 'Get headlines' },
      { tool: 'exec', params: { message: 'make pdf' }, purpose: 'Generate PDF' },
    ],
    notes: [],
    triggers: [],
    ...overrides,
  };
}

/** Deterministic fake embeddings: vector depends on which keyword the text contains. */
function fakeEmbedClient(): OllamaClient {
  return {
    embed: vi.fn().mockImplementation(async (text: string) => {
      const t = text.toLowerCase();
      if (t.includes('report') || t.includes('news')) return [[1, 0, 0.1]];
      if (t.includes('weather')) return [[0.9, 0.1, 0.2]]; // close to report-vector
      return [[0, 1, 0]]; // orthogonal
    }),
  } as unknown as OllamaClient;
}

describe('SkillStore triggers', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'skills-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('round-trips triggers through frontmatter', () => {
    const store = new SkillStore(dir);
    store.save(makeSkill({ triggers: ['find AI news and make a PDF'] }));
    const loaded = store.get('generate-report-from-web')!;
    expect(loaded.triggers).toEqual(['find AI news and make a PDF']);
  });

  it('addTrigger dedupes and caps at 5', () => {
    const store = new SkillStore(dir);
    store.save(makeSkill());
    for (let i = 0; i < 7; i++) store.addTrigger('generate-report-from-web', `request ${i}`);
    store.addTrigger('generate-report-from-web', 'request 6'); // dupe
    const loaded = store.get('generate-report-from-web')!;
    expect(loaded.triggers).toHaveLength(5);
    expect(loaded.triggers[4]).toBe('request 6');
  });

  it('parses legacy skills without triggers as empty array', () => {
    const store = new SkillStore(dir);
    const legacy = makeSkill();
    store.save(legacy);
    // Simulate legacy file: strip the triggers line
    const path = join(dir, 'skills', 'generate-report-from-web.md');
    writeFileSync(path, readFileSync(path, 'utf-8').replace(/^triggers: .*\n/m, ''));
    expect(store.get('generate-report-from-web')!.triggers).toEqual([]);
  });
});

describe('keyword matcher stop-word fix', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'skills-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('matches a generalized description through report/search/create words', () => {
    const store = new SkillStore(dir);
    store.save(makeSkill());
    // Pre-fix these goal keywords were ALL stop-worded away or absent from the
    // generic description — the exact silent-skip failure from the audit
    const match = findMatchingSkill(store, 'search the web and create a report on GPU prices');
    expect(match?.slug).toBe('generate-report-from-web');
  });
});

describe('semantic skill matching', () => {
  let dir: string;
  let embStore: EmbeddingStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'skills-'));
    embStore = new EmbeddingStore(join(dir, 'test-memory.db'));
    setEmbeddingStoreForTests(embStore);
  });
  afterEach(() => {
    setEmbeddingStoreForTests(null);
    rmSync(dir, { recursive: true, force: true });
  });

  it('finds a skill by cosine similarity and survives generalization', async () => {
    const store = new SkillStore(dir);
    const client = fakeEmbedClient();
    store.save(makeSkill());
    await upsertSkillEmbedding(client, store.get('generate-report-from-web')!);

    const match = await findSkillBySimilarity(client, store, 'weather summary document please');
    expect(match?.slug).toBe('generate-report-from-web');
  });

  it('prunes stale embeddings for archived skills', async () => {
    const store = new SkillStore(dir);
    const client = fakeEmbedClient();
    store.save(makeSkill());
    await upsertSkillEmbedding(client, store.get('generate-report-from-web')!);
    store.archive('generate-report-from-web');

    const match = await findSkillBySimilarity(client, store, 'weather report');
    expect(match).toBeNull();
  });

  it('hybrid falls back to keywords when embeddings error', async () => {
    const store = new SkillStore(dir);
    store.save(makeSkill());
    const broken = { embed: vi.fn().mockRejectedValue(new Error('backend down')) } as unknown as OllamaClient;
    const match = await findMatchingSkillHybrid(store, broken, 'search the web and create a report on GPUs');
    expect(match?.slug).toBe('generate-report-from-web');
    expect(match?.method).toBe('keyword');
  });

  it('hybrid reports semantic method when dense match wins', async () => {
    const store = new SkillStore(dir);
    const client = fakeEmbedClient();
    store.save(makeSkill());
    await upsertSkillEmbedding(client, store.get('generate-report-from-web')!);
    const match = await findMatchingSkillHybrid(store, client, 'weather summary document');
    expect(match?.method).toBe('semantic');
  });
});
