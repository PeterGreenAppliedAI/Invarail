import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FactStore } from '../../src/memory/fact-store.js';
import { parseFrontMatter } from '../../src/knowledge/okf.js';

describe('FactStore OKF mirror (memory tier: vault + OKF)', () => {
  it('writes a concept per fact with provenance, and removes it on forget — JSONL stays the store of record', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-'));
    const vault = mkdtempSync(join(tmpdir(), 'vault-'));
    const store = new FactStore(ws, undefined, { okf: { vaultPath: vault, owner: 'peter' } });
    const entry = await store.writeFact({ text: 'Deployment freeze starts 2026-09-01', category: 'stable', provenance: 'stated', importance: 4 }, 'peter', 'memory_save');
    expect(entry).not.toBeNull();
    const path = join(vault, 'memory', `${entry!.id}.md`);
    expect(existsSync(path)).toBe(true);
    const { data, body } = parseFrontMatter(readFileSync(path, 'utf-8'));
    expect(data.type).toBe('Fact');
    expect(data.invarail_id).toBe(entry!.id);
    expect(data.verified).toEqual([{ by: 'human:peter', at: entry!.createdAt }]);
    expect(body).toMatch(/2026-09-01/);
    expect(readFileSync(join(vault, 'log.md'), 'utf-8')).toMatch(/\*\*Creation\*\*: Fact \[Deployment freeze/);
    // the flat store's JSONL index still has it (facts.json is rebuilt lazily, not on write)
    const walk = (d: string): string => readdirSync(d, { withFileTypes: true }).map(e => e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.jsonl') ? readFileSync(join(d, e.name), 'utf-8') : '').join('\n');
    expect(walk(ws)).toMatch(entry!.id);

    expect(store.removeFact('deployment freeze', 'peter')).toBe(1);
    expect(existsSync(path)).toBe(false);
    expect(readFileSync(join(vault, 'log.md'), 'utf-8')).toMatch(/\*\*Removal\*\*/);
  });

  it('without the option nothing is mirrored', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-'));
    const store = new FactStore(ws);
    await store.writeFact({ text: 'plain fact', category: 'stable' }, 'peter', 'test');
    expect(readdirSync(ws).includes('vault')).toBe(false);
  });
});
