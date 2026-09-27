import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { MEASURED, rankForeground, pickUtility, thinkFor, findMeasured, memoryBudgetGb, foregroundTier, contextSizeForTier } from '../../src/setup/measured-models.js';
import type { OllamaModel } from '../../src/ollama/types.js';

const m = (name: string, gb: number): OllamaModel => ({ name, size: gb * 1e9 } as OllamaModel);

describe('MEASURED matches the published eval results', () => {
  const rows = [
    ...JSON.parse(readFileSync('evals/2026-08-local-model-eval/results.json', 'utf-8')).results,
    ...JSON.parse(readFileSync('evals/2026-09-small-tier/results.json', 'utf-8')).results,
    ...JSON.parse(readFileSync('evals/2026-09-small-tier/results-a5000.json', 'utf-8')).results,
  ] as Array<{ model: string; overall: number; dimensionScores: { toolloop: number } }>;
  it('every table row is the best-scoring row for its base model, within rounding', () => {
    for (const t of MEASURED) {
      const tag = t.tag.toLowerCase();
      const mine = rows.filter(r => { const m = r.model.toLowerCase(); return m.startsWith(tag + '@') || m.startsWith(tag + ' '); });
      expect(mine.length, t.tag).toBeGreaterThan(0);
      const best = Math.max(...mine.map(r => r.overall));
      expect(Math.abs(t.overall - best), `${t.tag} overall`).toBeLessThan(0.006);
    }
  });
});

describe('rankForeground', () => {
  const box = [m('qwen2.5-coder:32b', 19.9), m('qwen3.5:9b', 6.6), m('gemma4:12b', 7.6), m('mystery:7b', 4.5), m('phi4-mini', 2.5)];
  it('measured-and-fits first by score, then measured-too-big, then unmeasured that fit', () => {
    const r = rankForeground(box, 12 * 0.85);   // a 12GB card
    expect(r.map(x => x.name)).toEqual(['qwen3.5:9b', 'gemma4:12b', 'qwen2.5-coder:32b', 'mystery:7b', 'phi4-mini']);
    expect(r[2].fits).toBe(false); expect(r[2].label).toMatch(/TOO BIG/);
    expect(r[0].label).toMatch(/measured 92% \(tool 100%\), thinking off · fits/);
  });
  it('a measured-but-poor model lists BELOW an unmeasured one, with its numbers, and phi4 says no tools', () => {
    const r = rankForeground([m('phi4:latest', 9.1), m('mystery:7b', 4.5), m('llama3.1:8b', 4.9), m('qwen3.5:9b', 6.6)], 10.2);
    expect(r.map(x => x.name)).toEqual(['qwen3.5:9b', 'mystery:7b', 'llama3.1:8b', 'phi4:latest']);
    expect(r[2].label).toMatch(/measured 69% \(tool 74%\) — below the 80% floor/);
    expect(r[3].label).toMatch(/NO native tool calling/);
  });
  it('never picks the largest model just because it is largest', () => {
    expect(rankForeground(box, 40)[0].name).toBe('qwen3.5:9b');   // the 32B coder (85%, tool 50%) ranks below both 9B/12B
  });
  it('no budget known → everything "fits", ordering by score only', () => {
    expect(rankForeground(box)[0].name).toBe('qwen3.5:9b');
    expect(rankForeground(box).every(x => x.fits)).toBe(true);
  });
});

describe('foreground tier → prompt profile', () => {
  it('small = the September board or an unmeasured model under 15GB; everything else full', () => {
    expect(foregroundTier('qwen3.5:9b')).toBe('small');
    expect(foregroundTier('gemma4:12b')).toBe('small');
    expect(foregroundTier('qwen2.5:7b')).toBe('small');
    expect(foregroundTier('qwen3.8:27B')).toBe('full');
    expect(foregroundTier('mystery:7b', 4.5)).toBe('small');
    expect(foregroundTier('mystery:70b', 40)).toBe('full');
    expect(foregroundTier('mystery:latest')).toBe('full');   // unknown size: do not assume small
    expect(contextSizeForTier('small')).toBe(16384);
    expect(contextSizeForTier('full')).toBe(32768);
  });
});

describe('utility pick, think, budget', () => {
  it('prefers a measured utility model over the merely smallest', () => {
    expect(pickUtility([m('deepseek-r1:1.5b', 1.1), m('phi4-mini:latest', 2.5), m('phi4:latest', 9.1)])).toBe('phi4:latest');
    expect(pickUtility([m('tiny:1b', 0.8), m('other:3b', 2)])).toBe('tiny:1b');
  });
  it('thinkFor follows the best measured mode', () => {
    expect(thinkFor(findMeasured('qwen3.5:9b'))).toBe(false);
    expect(thinkFor(findMeasured('qwen3.8:27B'))).toBe(true);
    expect(thinkFor(findMeasured('qwen2.5:7b'))).toBeUndefined();
    expect(thinkFor(findMeasured('nope:1b'))).toBeUndefined();
  });
  it('budget is 85% of VRAM with a GPU, else 60% of RAM', () => {
    expect(memoryBudgetGb({ totalGb: 16 })).toBeCloseTo(9.6);
    expect(memoryBudgetGb({ totalGb: 16, gpuVramGb: 12 })).toBeCloseTo(10.2);
  });
});
