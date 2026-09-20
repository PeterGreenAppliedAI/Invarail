import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/config/loader.js';
import { experienceStoreConfigFrom } from '../../src/memory/experience-store.js';

/**
 * Config-not-code: the embedding model and its vector width were hardcoded in four
 * source files, so swapping embedders meant editing TypeScript (2026-09-19). These
 * pin them to config and guard the silent-mismatch failure mode.
 */
describe('embedding model is configuration, not code', () => {
  function load(memory: Record<string, unknown>) {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
    const p = join(dir, 'c.json5');
    writeFileSync(p, JSON.stringify({ defaultModel: 'm', specialists: { chat: {} }, memory }));
    const c = loadConfig(p);
    rmSync(dir, { recursive: true, force: true });
    return c;
  }

  it('defaults preserve the 8B/4096 pairing that existing vectors were built with', () => {
    const c = load({});
    expect(c.memory?.embeddingModel).toBe('qwen3-embedding:8b');
    expect(c.memory?.embeddingDims).toBe(4096);
  });

  it('a smaller embedder is a config change — no source edit', () => {
    const c = load({ embeddingModel: 'qwen3-embedding:4b', embeddingDims: 2560 });
    expect(c.memory?.embeddingModel).toBe('qwen3-embedding:4b');
    expect(c.memory?.embeddingDims).toBe(2560);
  });

  it('experience store inherits the SAME embedder as the graph — one vector space', () => {
    const cfg = experienceStoreConfigFrom({
      falkordb: { host: 'h', port: 1, graphName: 'g' },
      embeddingModel: 'qwen3-embedding:4b',
      embeddingDims: 2560,
    });
    expect(cfg).toMatchObject({ host: 'h', graphName: 'g', embeddingModel: 'qwen3-embedding:4b', embeddingDims: 2560 });
  });

  it('missing memory config yields undefined rather than a wrong-width default', () => {
    const cfg = experienceStoreConfigFrom(undefined);
    expect(cfg.embeddingModel).toBeUndefined();
    expect(cfg.embeddingDims).toBeUndefined();
  });
});
