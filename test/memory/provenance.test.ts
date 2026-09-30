import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { FactStore } from '../../src/memory/fact-store.js';
import { readProvenance } from '../../src/memory/graph-store.js';
import { FactEntrySchema, FactInputSchema } from '../../src/config/schema.js';

const testDir = '/tmp/invarail-test-provenance-' + Date.now();

beforeEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  mkdirSync(testDir, { recursive: true });
});

describe('fact provenance schema', () => {
  it('defaults to observed, never stated, when a writer does not declare', () => {
    expect(FactInputSchema.parse({ text: 'x' }).provenance).toBe('observed');
    expect(
      FactEntrySchema.parse({ id: 'f1', text: 'x', source: 's', createdAt: 'now', hash: 'h' }).provenance,
    ).toBe('observed');
  });

  it('rejects classes outside the enum rather than passing them through', () => {
    expect(() => FactInputSchema.parse({ text: 'x', provenance: 'guessed' })).toThrow();
  });
});

describe('readProvenance', () => {
  it('preserves the two strong-signal classes', () => {
    expect(readProvenance('stated')).toBe('stated');
    expect(readProvenance('inferred')).toBe('inferred');
  });

  // The migration contract: graph nodes written before the field existed return
  // null from Cypher. Coalescing UP to 'stated' would retroactively present every
  // pre-existing autonomous extraction as something Peter confirmed.
  it('coalesces unknown/legacy values DOWN to observed', () => {
    for (const v of [null, undefined, '', 'nonsense', 42, {}]) {
      expect(readProvenance(v)).toBe('observed');
    }
  });
});

describe('FactStore persists provenance', () => {
  it('round-trips a stated fact through the index', async () => {
    const store = new FactStore(testDir);
    const entry = await store.writeFact(
      { text: 'Peter is married to Nicole', category: 'stable', provenance: 'stated' },
      'user1',
      'user/approved',
    );
    expect(entry!.provenance).toBe('stated');

    store.rebuildFacts('user1');
    const loaded = store.loadFactsJson('user1');
    expect(loaded.find(f => f.text.includes('Nicole'))!.provenance).toBe('stated');
  });

  it('a fact written without a declared class reads back as observed', async () => {
    const store = new FactStore(testDir);
    const entry = await store.writeFact({ text: 'Peter prefers terse replies' }, 'user1', 'session/x');
    expect(entry!.provenance).toBe('observed');
  });
});

describe('FactStore.setProvenanceByText', () => {
  it('promotes exactly the named facts and reports the count', async () => {
    const store = new FactStore(testDir);
    await store.writeFact({ text: 'Peter uses a 3060' }, 'user1', 'capture/s1');
    await store.writeFact({ text: 'Peter runs Invarail' }, 'user1', 'capture/s1');

    expect(store.setProvenanceByText(['Peter uses a 3060'], 'user1', 'stated')).toBe(1);
    const facts = store.loadFactsJson('user1');
    expect(facts.find(f => f.text === 'Peter uses a 3060')!.provenance).toBe('stated');
    expect(facts.find(f => f.text === 'Peter runs Invarail')!.provenance).toBe('observed');

    // Already stated — nothing to change.
    expect(store.setProvenanceByText(['Peter uses a 3060'], 'user1', 'stated')).toBe(0);
  });

  it('is a no-op for unknown text and an empty list', async () => {
    const store = new FactStore(testDir);
    await store.writeFact({ text: 'x' }, 'user1', 's');
    expect(store.setProvenanceByText(['not there'], 'user1', 'stated')).toBe(0);
    expect(store.setProvenanceByText([], 'user1', 'stated')).toBe(0);
  });
});
