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
      { text: 'Peter is married to Alex', category: 'stable', provenance: 'stated' },
      'user1',
      'user/approved',
    );
    expect(entry!.provenance).toBe('stated');

    store.rebuildFacts('user1');
    const loaded = store.loadFactsJson('user1');
    expect(loaded.find(f => f.text.includes('Alex'))!.provenance).toBe('stated');
  });

  it('a fact written without a declared class reads back as observed', async () => {
    const store = new FactStore(testDir);
    const entry = await store.writeFact({ text: 'Peter prefers terse replies' }, 'user1', 'session/x');
    expect(entry!.provenance).toBe('observed');
  });
});
