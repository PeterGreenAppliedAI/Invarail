import { describe, expect, it, vi } from 'vitest';
import { ExperienceStore, type Experience } from '../../src/memory/experience-store.js';
import type { OllamaClient } from '../../src/ollama/client.js';

/** Fake graph: records queries, returns canned rows per matcher. */
function fakeGraph(responders: Array<{ match: RegExp; rows: unknown[] }> = []) {
  const queries: Array<{ q: string; params?: Record<string, unknown> }> = [];
  return {
    queries,
    query: vi.fn(async (q: string, opts?: { params?: Record<string, unknown> }) => {
      queries.push({ q, params: opts?.params });
      const r = responders.find(x => x.match.test(q));
      return { data: r?.rows ?? [] };
    }),
  };
}

function storeWith(graph: ReturnType<typeof fakeGraph>): ExperienceStore {
  const client = { embed: vi.fn(async () => [[0.1, 0.2, 0.3]]) } as unknown as OllamaClient;
  const store = new ExperienceStore(client);
  (store as unknown as { graph: unknown }).graph = graph;
  (store as unknown as { initialized: boolean }).initialized = true;
  return store;
}

const baseInput = {
  text: 'For adding a tool, followed the factory pattern — worked',
  taskShape: 'add tool',
  approach: 'factory pattern',
  outcome: 'worked' as const,
  satisfaction: 1 as const,
  model: 'qwen3.8-27b',
};

describe('ExperienceStore verified flag', () => {
  it('save() persists verified:true into the CREATE params', async () => {
    const graph = fakeGraph();
    const store = storeWith(graph);
    const res = await store.save({ ...baseInput, verified: true }, 'selfmod:x');
    expect(res?.action).toBe('created');
    const create = graph.queries.find(x => x.q.includes('CREATE (x:Experience'));
    expect(create?.params?.verified).toBe(true);
  });

  it('save() defaults verified to false', async () => {
    const graph = fakeGraph();
    const store = storeWith(graph);
    await store.save(baseInput);
    const create = graph.queries.find(x => x.q.includes('CREATE (x:Experience'));
    expect(create?.params?.verified).toBe(false);
  });
});

describe('searchRelevant evidence gate', () => {
  function knnRows(rows: Array<Partial<Experience> & { score: number }>) {
    return fakeGraph([{ match: /queryNodes\('Experience'/, rows }]);
  }
  const common = { text: 't', taskShape: 's', approach: 'a', outcome: 'worked', satisfaction: 1, model: 'm', createdAt: 'c', lastConfirmed: 'l' };

  it('verified experiences pass at evidence 1; unverified need ≥ 2', async () => {
    const graph = knnRows([
      { ...common, id: 'v1', evidenceCount: 1, verified: true, score: 0.2 },   // sim 0.8 → in
      { ...common, id: 'u1', evidenceCount: 1, verified: false, score: 0.2 },  // unverified ev1 → out
      { ...common, id: 'u2', evidenceCount: 2, verified: false, score: 0.25 }, // unverified ev2 → in
    ]);
    const store = storeWith(graph);
    const out = await store.searchRelevant('query', 5, 0.6);
    expect(out.map(m => m.id)).toEqual(['v1', 'u2']);
  });

  it('floor still rejects regardless of verification', async () => {
    const graph = knnRows([
      { ...common, id: 'far', evidenceCount: 5, verified: true, score: 0.9 },  // sim 0.1 → out
    ]);
    const store = storeWith(graph);
    expect(await store.searchRelevant('query', 5, 0.6)).toEqual([]);
  });
});

describe('idempotency on external identity (commit)', () => {
  it('save() with a commit that already exists returns the existing id, writes nothing', async () => {
    const graph = fakeGraph([{ match: /MATCH \(x:Experience \{commit: \$commit\}\)/, rows: [{ id: 'exp_prior' }] }]);
    const store = storeWith(graph);
    const res = await store.save({ ...baseInput, verified: true, commit: 'deadbeef' });
    expect(res).toEqual({ id: 'exp_prior', action: 'exists' });
    expect(graph.queries.some(x => x.q.includes('CREATE (x:Experience'))).toBe(false);
  });

  it('save() persists the commit for future replay checks', async () => {
    const graph = fakeGraph();
    const store = storeWith(graph);
    await store.save({ ...baseInput, verified: true, commit: 'deadbeef' });
    const create = graph.queries.find(x => x.q.includes('CREATE (x:Experience'));
    expect(create?.params?.commit).toBe('deadbeef');
  });
});

describe('supersedeById', () => {
  it('verified stays TRUE on the failed replacement — verified is epistemic confidence, not success', async () => {
    // A rolled-back merge really happened and the system witnessed it: verified:true, outcome:'failed'.
    const graph = fakeGraph([{ match: /MATCH \(o:Experience \{id: \$oldId\}\) RETURN/, rows: [{ 'o.id': 'exp_old' }] }]);
    const store = storeWith(graph);
    const newId = await store.supersedeById('exp_old', {
      ...baseInput, outcome: 'failed', satisfaction: -1, verified: true, commit: 'deadbeef',
    }, 'selfmod:x');
    expect(newId).toBeTruthy();
    const q = graph.queries.find(x => x.q.includes('SET o.superseded = true'));
    expect(q).toBeTruthy();
    expect(q!.q).toContain('CREATE (n)-[:SUPERSEDES');
    expect(q!.params?.outcome).toBe('failed');
    expect(q!.params?.verified).toBe(true);
    expect(q!.params?.oldId).toBe('exp_old');
  });

  it('preserves the chain explicitly: old.supersededBy and new.supersedesId', async () => {
    const graph = fakeGraph([{ match: /MATCH \(o:Experience \{id: \$oldId\}\) RETURN/, rows: [{ 'o.id': 'exp_old' }] }]);
    const store = storeWith(graph);
    const newId = await store.supersedeById('exp_old', { ...baseInput, outcome: 'failed', satisfaction: -1 });
    const q = graph.queries.find(x => x.q.includes('SET o.superseded = true'))!;
    expect(q.q).toContain('o.supersededBy = $id');
    expect(q.q).toContain('supersedesId: $oldId');
    expect(q.params?.id).toBe(newId);
  });

  it('returns null when the old id does not exist (nothing written)', async () => {
    const graph = fakeGraph(); // lookup returns no rows
    const store = storeWith(graph);
    const res = await store.supersedeById('ghost', { ...baseInput, outcome: 'failed', satisfaction: -1 });
    expect(res).toBeNull();
    expect(graph.queries.some(x => x.q.includes('SUPERSEDES'))).toBe(false);
  });
});
