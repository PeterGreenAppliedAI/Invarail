import { describe, it, expect } from 'vitest';
import { fitLinesToTokenBudget } from '../../src/memory/extraction-window.js';
import { estimateTokens } from '../../src/context/tokens.js';

const line = (i: number) => `User: turn ${i} ${'word '.repeat(20)}`;

describe('fitLinesToTokenBudget', () => {
  it('keeps everything when it fits', () => {
    const lines = [line(1), line(2), line(3)];
    const total = lines.reduce((n, l) => n + estimateTokens(l), 0);
    expect(fitLinesToTokenBudget(lines, total)).toEqual({ kept: lines, dropped: 0 });
  });

  // Ollama truncates from the front, taking the instructions with it. We drop
  // from the front ourselves so the instructions survive — and the newest turns
  // are the ones incremental capture has not seen yet.
  it('drops the OLDEST lines first and preserves order', () => {
    const lines = [line(1), line(2), line(3), line(4)];
    const two = estimateTokens(line(3)) + estimateTokens(line(4));
    const { kept, dropped } = fitLinesToTokenBudget(lines, two);
    expect(kept).toEqual([line(3), line(4)]);
    expect(dropped).toBe(2);
  });

  it('returns nothing when even the newest line exceeds the budget', () => {
    expect(fitLinesToTokenBudget([line(1)], 1)).toEqual({ kept: [], dropped: 1 });
  });

  it('handles an empty transcript', () => {
    expect(fitLinesToTokenBudget([], 100)).toEqual({ kept: [], dropped: 0 });
  });
});
