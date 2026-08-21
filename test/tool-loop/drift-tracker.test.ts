import { describe, it, expect } from 'vitest';
import { DriftTracker } from '../../src/tool-loop/engine.js';

describe('DriftTracker', () => {
  it('detects repeating tool calls', () => {
    const tracker = new DriftTracker();
    const call = { tool: 'web_search', params: { query: 'test' } };

    expect(tracker.checkDrift('step 1', call)).toBe('none');
    expect(tracker.checkDrift('step 2', call)).toBe('repeating');
  });

  it('does not flag different tool calls as repeating', () => {
    const tracker = new DriftTracker();

    expect(tracker.checkDrift('step 1', { tool: 'web_search', params: { query: 'a' } })).toBe('none');
    expect(tracker.checkDrift('step 2', { tool: 'web_search', params: { query: 'b' } })).toBe('none');
    expect(tracker.checkDrift('step 3', { tool: 'web_fetch', params: { url: 'x' } })).toBe('none');
  });

  it('detects a same-tool streak with varying params (the exec-slicing class)', () => {
    const tracker = new DriftTracker();
    for (let i = 0; i < 4; i++) {
      expect(tracker.checkDrift(`step ${i}`, { tool: 'exec', params: { code: `slice ${i}` } })).toBe('none');
    }
    expect(tracker.checkDrift('step 5', { tool: 'exec', params: { code: 'slice 5' } })).toBe('streak');
  });

  it('a different tool resets the streak', () => {
    const tracker = new DriftTracker();
    for (let i = 0; i < 4; i++) {
      tracker.checkDrift(`step ${i}`, { tool: 'exec', params: { code: `s${i}` } });
    }
    expect(tracker.checkDrift('break', { tool: 'read_file', params: { path: 'x' } })).toBe('none');
    expect(tracker.checkDrift('resume', { tool: 'exec', params: { code: 'again' } })).toBe('none');
  });

  it('detects hedging language', () => {
    const tracker = new DriftTracker();

    tracker.checkDrift('I think this might work');
    tracker.checkDrift('Perhaps I should try a different approach. Maybe the original question was about something else.');
    const result = tracker.checkDrift("I'm not sure, let me try again. I believe this is the right path.");
    expect(result).toBe('hedging');
  });

  it('detects growing responses without progress', () => {
    const tracker = new DriftTracker();

    tracker.checkDrift('a'.repeat(100)); // baseline
    tracker.checkDrift('b'.repeat(100)); // stable
    const result = tracker.checkDrift('c'.repeat(200)); // 2x growth, no tool call
    expect(result).toBe('growing');
  });

  it('does not flag growing when tool calls are happening', () => {
    const tracker = new DriftTracker();

    tracker.checkDrift('a'.repeat(100), { tool: 'search', params: {} });
    tracker.checkDrift('b'.repeat(100), { tool: 'fetch', params: {} });
    const result = tracker.checkDrift('c'.repeat(200), { tool: 'reason', params: {} });
    // Growing check requires no toolCall — this has one, so it shouldn't flag
    expect(result).toBe('none');
  });

  it('returns none for normal progression', () => {
    const tracker = new DriftTracker();

    expect(tracker.checkDrift('Thought: searching', { tool: 'web_search', params: { query: 'AI' } })).toBe('none');
    expect(tracker.checkDrift('Thought: fetching', { tool: 'web_fetch', params: { url: 'http://x.com' } })).toBe('none');
    expect(tracker.checkDrift('Here are the results')).toBe('none');
  });
});
