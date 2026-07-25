import { describe, it, expect } from 'vitest';
import { capsFor } from '../../src/ollama/model-caps.js';

describe('capsFor', () => {
  it('longest prefix wins (qwen3-embedding beats qwen)', () => {
    expect(capsFor('qwen3-embedding:8b').supportsFormat).toBe(false);
    expect(capsFor('qwen3.6:35b').supportsFormat).toBe(true);
  });

  it('unknown models get conservative parallel-calls default with format on', () => {
    const caps = capsFor('some-brand-new-model:7b');
    expect(caps.supportsFormat).toBe(true);
    expect(caps.parallelToolCalls).toBe(false);
  });

  it('is case-insensitive and knows the foreground model', () => {
    expect(capsFor('DeepSeek-V4-Flash').parallelToolCalls).toBe(true);
    expect(capsFor('gemma4:12b').vision).toBe(true);
  });
});
