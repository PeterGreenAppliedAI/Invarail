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

describe('think capability (2026-08 eval probe data)', () => {
  it('distinguishes toggle, levels, and none', () => {
    expect(capsFor('qwen3.6:27b').think).toBe('toggle');
    expect(capsFor('muse-glimmer:latest').think).toBe('toggle');
    expect(capsFor('devstral:24b').think).toBe('none');
    expect(capsFor('qwen3-coder:30b').think).toBe('none');
    expect(capsFor('llama4:scout').think).toBe('none');
  });

  it('gpt-oss family is levels — obedience audit showed BOTH sizes ignore think:false', () => {
    expect(capsFor('gpt-oss:120b').think).toBe('levels');
    expect(capsFor('gpt-oss:20b').think).toBe('levels');
  });

  it('longest prefix separates coder/embedding variants from their thinking families', () => {
    expect(capsFor('qwen3-embedding:8b').think).toBe('none');
    expect(capsFor('qwen3.5:27b').think).toBe('toggle');
    expect(capsFor('deepseek-coder:33b').think).toBe('none');
    expect(capsFor('deepseek-v4-flash').think).toBe('toggle');
  });

  it('unprobed models report undefined (unknown), not a guess', () => {
    expect(capsFor('mistral:7b').think).toBeUndefined();
  });
});
