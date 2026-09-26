import { describe, it, expect } from 'vitest';
import { voiceWindowStart } from '../../src/dispatch.js';

// 2026-09-26: with the 12-turn window sliding by one exchange per voice turn, every
// turn diverged from the model's cached prefix right after the system head, and on the
// hybrid-attention 27B that is a full cold prefill (measured: slid window 4036ms vs
// append-only 283ms at the same prompt size). The window is now anchored with
// hysteresis: append-only until it holds 2×cap turns, then re-anchor to the last cap.
describe('voiceWindowStart', () => {
  const cap = 12;

  it('first turn of a long session anchors to the last cap turns', () => {
    expect(voiceWindowStart(40, undefined, cap)).toBe(28);
  });

  it('short session anchors at zero', () => {
    expect(voiceWindowStart(6, undefined, cap)).toBe(0);
  });

  it('holds the anchor while the window grows — the append-only stretch', () => {
    let anchor = voiceWindowStart(40, undefined, cap);   // 28
    for (let total = 42; total - anchor <= 2 * cap; total += 2) {
      expect(voiceWindowStart(total, anchor, cap)).toBe(28);
      anchor = voiceWindowStart(total, anchor, cap);
    }
  });

  it('re-anchors to the last cap turns once the window exceeds 2×cap', () => {
    // anchor 28, total 54 → window 26 > 24 → re-anchor to 54 - 12
    expect(voiceWindowStart(54, 28, cap)).toBe(42);
    // and holds again from there
    expect(voiceWindowStart(56, 42, cap)).toBe(42);
  });

  it('a stale anchor after !reset (transcript shrank) re-anchors', () => {
    expect(voiceWindowStart(2, 28, cap)).toBe(0);
  });
});
