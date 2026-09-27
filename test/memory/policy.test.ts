import { describe, it, expect } from 'vitest';
import { embeddingsEnabled, memoryBackend, wantsGraph, vaultTier, okfEnabled } from '../../src/memory/policy.js';
import { loadConfig } from '../../src/config/loader.js';

describe('memory tier policy', () => {
  const base = loadConfig('/tmp/nonexistent-config.json5');
  const withMem = (memory: Record<string, unknown>, vault?: Record<string, unknown>) => ({ ...base, memory: { ...base.memory, ...memory }, vault: { ...base.vault, ...(vault ?? {}) } });

  it('markdown (the historical default) means auto: graph if it answers, else flat', () => {
    expect(memoryBackend(base)).toBe('auto');
    expect(wantsGraph(base)).toBe(true);
    expect(vaultTier(base)).toBe(false);
  });

  it('flat never wants the graph; vault is flat + the vault; okf needs both vault and the flag', () => {
    expect(wantsGraph(withMem({ backend: 'flat' }))).toBe(false);
    expect(wantsGraph(withMem({ backend: 'graph' }))).toBe(true);
    expect(vaultTier(withMem({ backend: 'vault' }))).toBe(true);
    expect(okfEnabled(withMem({ backend: 'vault' }))).toBe(false);
    expect(okfEnabled(withMem({ backend: 'vault' }, { okf: true }))).toBe(true);
    expect(okfEnabled(withMem({ backend: 'flat' }, { okf: true }))).toBe(false);
  });

  it('"none" disables embeddings, which also disables the graph', () => {
    expect(embeddingsEnabled({ embeddingModel: 'none' })).toBe(false);
    expect(embeddingsEnabled({ embeddingModel: 'qwen3-embedding:4b' })).toBe(true);
    expect(embeddingsEnabled(undefined)).toBe(true);
    expect(wantsGraph(withMem({ backend: 'graph', embeddingModel: 'none' }))).toBe(false);
  });
});
