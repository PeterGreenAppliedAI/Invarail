import { describe, it, expect } from 'vitest';
import { stripThinkingTags } from '../../src/utils/text.js';

describe('stripThinkingTags — delivery backstop', () => {
  it('strips thinking blocks', () => {
    expect(stripThinkingTags('<think>hmm</think>Hello')).toBe('Hello');
  });

  it('strips residual narrated tool-call markup (live 2026-08-21 shape)', () => {
    const text = 'Sure!\n<tool_call>\n<function=cronjobs_list>\n</function>\n</tool_call>';
    expect(stripThinkingTags(text)).toBe('Sure!');
  });

  it('strips unclosed tool-call markup leaking to end of message', () => {
    expect(stripThinkingTags('On it.\n<tool_call>\n<function=web_search>')).toBe('On it.');
  });

  it('leaves normal prose mentioning tools alone', () => {
    const text = 'You can use cron_list to see your jobs.';
    expect(stripThinkingTags(text)).toBe(text);
  });
});
