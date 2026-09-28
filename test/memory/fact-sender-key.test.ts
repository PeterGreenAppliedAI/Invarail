import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FactStore } from '../../src/memory/fact-store.js';

// Third review F15: a sender id is a data key, never a path component.
describe('FactStore sender directories', () => {
  it('a plain id keeps its directory; a path-like id is hashed inside the memory root', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-'));
    const store = new FactStore(ws);
    await store.writeFact({ text: 'plain sender fact', category: 'stable' }, '123456789', 'test');
    expect(existsSync(join(ws, 'memory', '123456789'))).toBe(true);
    await store.writeFact({ text: 'escaping sender fact', category: 'stable' }, '../../escaped-facts', 'test');
    expect(existsSync(resolve(ws, '..', 'escaped-facts'))).toBe(false);
    const dirs = readdirSync(join(ws, 'memory'));
    expect(dirs.some(d => d.startsWith('u_'))).toBe(true);
    store.rebuildFacts('../../escaped-facts');   // facts.json is rebuilt lazily, not on write
    expect(store.searchFacts('escaping', '../../escaped-facts').length).toBe(1);   // still readable under its key
  });
});
