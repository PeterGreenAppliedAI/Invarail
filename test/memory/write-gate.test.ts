import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync, mkdirSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FactStore } from '../../src/memory/fact-store.js';
import { consolidateFactsWithLLM } from '../../src/memory/consolidation.js';
import { GraphMemoryStore } from '../../src/memory/graph-store.js';
import { sameFact, matchesRemoval, factWords } from '../../src/memory/fact-similarity.js';
import type { OllamaClient } from '../../src/ollama/client.js';

let ws = '';
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'write-gate-')); });
afterEach(() => rmSync(ws, { recursive: true, force: true }));

const SENDER = 'peter';
const indexTexts = (store: FactStore) => store.loadIndexEntries(SENDER).map(e => e.text);

describe('sameFact — calibrated on the owner\'s index (2026-10-05)', () => {
  it('a reworded identity fact is the same fact', () => {
    expect(sameFact(
      'User works at DevMesh Services as a Machine Learning engineer focusing on AI integration for small businesses',
      'The user works at DevMesh Services as a technical founder and ML engineer focusing on AI integration for small businesses',
    )).toBe(true);
  });
  it('an update of a fact is the same fact (the newer wording should win)', () => {
    expect(sameFact(
      'The user is managing diverticulosis and needs to incorporate a high-fiber diet into their daily meals',
      'The user managing diverticulosis has incorporated a high-fiber diet into their daily meals',
    )).toBe(true);
  });
  it('short facts that share topic words are NOT the same fact', () => {
    expect(sameFact("The user's son does Taekwondo on Tuesdays", "The user's son does swimming on Tuesdays")).toBe(false);
  });
  it('the subject word does not count toward identity', () => {
    expect([...factWords("The user's wife is Nicole")]).toEqual(['wife', 'nicole']);
  });
});

describe('matchesRemoval', () => {
  it('matches the query the way removal did, and a REWORDING of a removed fact', () => {
    const removal = { text: 'wedding ring', facts: ['The user is planning a wedding and looking for an engagement ring for his partner'] };
    expect(matchesRemoval('The user mentioned shopping for a wedding ring', removal)).toBe(true);
    expect(matchesRemoval('The user is planning a wedding and needs help finding an engagement ring for his partner', removal)).toBe(true);
    expect(matchesRemoval('The user is building DevMesh Services', removal)).toBe(false);
  });
});

describe('the write gate (FactStore.writeFact)', () => {
  it('the same fact reworded REPLACES the older entry in the index, keeping its importance', async () => {
    const store = new FactStore(ws);
    await store.writeFact({ text: 'User works at DevMesh Services as a Machine Learning engineer focusing on AI integration for small businesses', category: 'stable', importance: 4 }, SENDER);
    await store.writeFact({ text: 'The user works at DevMesh Services as a technical founder and ML engineer focusing on AI integration for small businesses', category: 'stable', importance: 3 }, SENDER);
    const entries = store.loadIndexEntries(SENDER);
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toMatch(/technical founder/);         // newest wording
    expect(entries[0].importance).toBe(4);                         // never demoted by a rewording
  });

  it('an extraction never overwrites what the owner stated', async () => {
    const store = new FactStore(ws);
    await store.writeFact({ text: 'The user works at DevMesh Services as a technical founder and ML engineer focusing on AI integration', category: 'stable', provenance: 'stated', importance: 4 }, SENDER);
    const out = await store.writeFact({ text: 'User works at DevMesh Services as an ML engineer focusing on AI integration and automation', category: 'stable', provenance: 'observed' }, SENDER);
    expect(out).toBeNull();
    expect(indexTexts(store)).toEqual(['The user works at DevMesh Services as a technical founder and ML engineer focusing on AI integration']);
  });

  it('dedup reads the FULL index, not the capped view: a fact missing from facts.json still blocks its duplicate', async () => {
    const store = new FactStore(ws);
    await store.writeFact({ text: 'The user prefers dark mode in every editor and terminal he uses daily', category: 'stable', importance: 3 }, SENDER);
    store.overwriteFacts([], SENDER);                               // simulate the char-bound view leaving it out
    const out = await store.writeFact({ text: 'The user prefers dark mode in every editor and terminal he uses daily', category: 'stable' }, SENDER);
    expect(out).toBeNull();
    expect(store.loadIndexEntries(SENDER)).toHaveLength(1);
  });
});

describe('forgetting sticks (2026-10-05: a forgotten fact came back reworded nine days later)', () => {
  const RING = 'The user is planning a wedding and looking for an engagement ring for his partner';

  it('a reworded re-extraction of a forgotten fact is refused in code, permanently', async () => {
    const store = new FactStore(ws);
    await store.writeFact({ text: RING, category: 'context' }, SENDER);
    const removed = store.removeFactTexts('engagement ring', SENDER);
    expect(removed).toEqual([RING]);
    store.recordRemoval('engagement ring', 'user_denied', SENDER, removed);

    const again = await store.writeFact({ text: 'The user is planning a wedding and needs help finding an engagement ring for his partner', category: 'context' }, SENDER);
    expect(again).toBeNull();
    expect(store.loadIndexEntries(SENDER)).toHaveLength(0);

    const raw = readFileSync(join(ws, 'memory', SENDER, 'removed.jsonl'), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    expect(raw[0].expiresAt).toBeNull();                            // the owner's forget does not expire
    expect(raw[0].facts).toEqual([RING]);
    expect(store.loadRecentlyRemoved(SENDER)[0].facts).toEqual([RING]);
  });

  it('automatic removals keep the 30-day window', () => {
    const store = new FactStore(ws);
    store.recordRemoval('Dentist appointment on 2026-09-01', 'date_expired', SENDER);
    const raw = JSON.parse(readFileSync(join(ws, 'memory', SENDER, 'removed.jsonl'), 'utf-8').trim());
    expect(typeof raw.expiresAt).toBe('string');
  });

  it('the owner stating it again (via !save) lifts the forget', async () => {
    const store = new FactStore(ws);
    store.recordRemoval('engagement ring', 'user_denied', SENDER, [RING]);
    const stated = await store.writeFact({ text: RING, category: 'context', provenance: 'stated' }, SENDER);
    expect(stated).not.toBeNull();
    expect(store.isSuppressed(RING, SENDER)).toBe(false);
  });

  it('the graph store refuses a forgotten fact before touching the database', async () => {
    const store = new FactStore(ws);
    store.recordRemoval('engagement ring', 'user_denied', SENDER, [RING]);
    const client = { embed: vi.fn(), chat: vi.fn() } as unknown as OllamaClient;
    const graph = new GraphMemoryStore(client, {});
    const connect = vi.spyOn(graph, 'connect');
    graph.setSuppression((t, s) => store.isSuppressed(t, s));
    expect(await graph.addFact({ text: 'The user is planning a wedding and needs help finding an engagement ring for his partner', category: 'context' }, SENDER)).toBeNull();
    expect(connect).not.toHaveBeenCalled();
  });
});

describe('compaction and consolidation edit the INDEX, not just the view', () => {
  /** Old-style pollution: rewordings already sitting in the index (written before the gate). */
  function seed(store: FactStore, rows: Array<{ text: string; importance?: number; provenance?: string; createdAt: string }>) {
    const dir = join(ws, 'memory', SENDER, 'index');
    mkdirSync(dir, { recursive: true });
    rows.forEach((r, i) => appendFileSync(join(dir, '2026-09-01.jsonl'), JSON.stringify({
      id: `f${i}`, text: r.text, category: 'stable', confidence: 0.8, source: 'seed', createdAt: r.createdAt,
      hash: `h${i}`, senderId: SENDER, importance: r.importance ?? 2, ...(r.provenance ? { provenance: r.provenance } : {}),
    }) + '\n'));
    store.rebuildFacts(SENDER);
  }

  it('compactDuplicates collapses each cluster to one entry: strongest provenance, then newest; highest importance', () => {
    const store = new FactStore(ws);
    seed(store, [
      { text: 'User works at DevMesh Services as a Machine Learning engineer focusing on AI integration for small businesses', importance: 4, createdAt: '2026-07-01T00:00:00Z' },
      { text: 'The user works at DevMesh Services as a technical founder and ML engineer focusing on AI integration for small businesses', importance: 3, createdAt: '2026-08-01T00:00:00Z' },
      { text: 'Peter works at DevMesh Services as an ML engineer focusing on AI integration for small businesses in his area', provenance: 'stated', importance: 2, createdAt: '2026-06-01T00:00:00Z' },
      { text: 'The user prefers dark mode in every editor', createdAt: '2026-08-02T00:00:00Z' },
    ]);
    const dry = store.compactDuplicates(SENDER, { dryRun: true });
    expect(dry.removed).toBe(2);
    expect(store.loadIndexEntries(SENDER)).toHaveLength(4);         // dry run writes nothing

    store.compactDuplicates(SENDER);
    const entries = store.loadIndexEntries(SENDER);
    expect(entries).toHaveLength(2);
    const devmesh = entries.find(e => /DevMesh/.test(e.text))!;
    expect(devmesh.provenance).toBe('stated');                      // the owner's version wins
    expect(devmesh.importance).toBe(4);                             // the cluster's highest importance
  });

  it('clusters do not chain: A~B and B~C does not pull C into A\'s cluster (a tech-stack fact was swallowed by a job-title fact)', () => {
    const store = new FactStore(ws);
    const A = 'alphaone bravoone charlieone deltaone echoone foxtrotone golfone hotelone';
    const B = 'alphaone bravoone charlieone deltaone echoone foxtrotone indiaone julietone';
    const C = 'charlieone deltaone echoone foxtrotone indiaone julietone kiloone limaone';
    seed(store, [
      { text: A, createdAt: '2026-07-01T00:00:00Z' },
      { text: B, createdAt: '2026-07-02T00:00:00Z' },
      { text: C, createdAt: '2026-07-03T00:00:00Z' },
    ]);
    expect(sameFact(A, B)).toBe(true);
    expect(sameFact(B, C)).toBe(true);
    expect(sameFact(A, C)).toBe(false);
    const r = store.compactDuplicates(SENDER);
    expect(r.removed).toBe(1);
    expect(indexTexts(store)).toContain(C);
  });

  it('an LLM merge removes both originals from the index — it used to turn two copies into three', async () => {
    const store = new FactStore(ws);
    seed(store, [
      { text: 'The user grew up in a challenging environment marked by trauma and instability', importance: 4, createdAt: '2026-07-01T00:00:00Z' },
      { text: 'The user grew up in a difficult environment marked by trauma and instability during childhood', importance: 4, createdAt: '2026-07-02T00:00:00Z' },
    ]);
    const client = { chat: vi.fn().mockResolvedValue({ message: { content: 'ACTION: MERGE\nMERGED: The user grew up amid trauma and instability, which shaped his resilience' } }) } as unknown as OllamaClient;
    const removed = await consolidateFactsWithLLM(store, client, 'm', SENDER, 0.3);
    expect(removed).toBe(2);
    const entries = store.loadIndexEntries(SENDER);
    expect(entries.map(e => e.text)).toEqual(['The user grew up amid trauma and instability, which shaped his resilience']);
    expect(entries[0].importance).toBe(4);                          // a merge of identity facts stays identity
    store.rebuildFacts(SENDER);
    expect(store.loadFactsJson(SENDER)).toHaveLength(1);            // and the next rebuild does not bring them back
  });

  it('an LLM merge never rewrites a fact the owner stated', async () => {
    const store = new FactStore(ws);
    seed(store, [
      { text: 'The user grew up in a challenging environment marked by trauma and instability', provenance: 'stated', createdAt: '2026-07-01T00:00:00Z' },
      { text: 'The user grew up in a difficult environment marked by trauma and instability during childhood', createdAt: '2026-07-02T00:00:00Z' },
    ]);
    const chat = vi.fn();
    expect(await consolidateFactsWithLLM(store, { chat } as unknown as OllamaClient, 'm', SENDER, 0.3)).toBe(0);
    expect(chat).not.toHaveBeenCalled();
  });
});

describe('char bound: protection covers a fact, not every rewording of it', () => {
  it('older protected rewordings are evicted before unprotected facts', () => {
    const store = new FactStore(ws);
    const dir = join(ws, 'memory', SENDER, 'index');
    mkdirSync(dir, { recursive: true });
    const pad = ' and keeps building tools for local AI agents on his own hardware every single week';
    const rows: string[] = [];
    for (let i = 0; i < 150; i++) rows.push(JSON.stringify({ id: `p${i}`, text: `The user works at DevMesh Services as a technical founder and ML engineer focusing on AI integration${pad}, note ${i}`, category: 'stable', confidence: 0.8, source: 's', createdAt: `2026-07-${String(1 + (i % 28)).padStart(2, '0')}T00:00:${String(i % 60).padStart(2, '0')}Z`, hash: `hp${i}`, senderId: SENDER, importance: 4 }));
    rows.push(JSON.stringify({ id: 'pref', text: 'The user prefers short answers without preamble', category: 'stable', confidence: 0.9, source: 's', createdAt: '2026-08-01T00:00:00Z', hash: 'hpref', senderId: SENDER, importance: 3 }));
    appendFileSync(join(dir, '2026-07-01.jsonl'), rows.join('\n') + '\n');
    store.rebuildFacts(SENDER);
    const view = store.loadFactsJson(SENDER);
    expect(view.some(e => e.id === 'pref')).toBe(true);             // the preference survives the bound
    expect(view.filter(e => /DevMesh/.test(e.text)).length).toBeLessThan(150);              // the bound bit — on the rewordings
    expect(readdirSync(dir)).toHaveLength(1);
  });
});
