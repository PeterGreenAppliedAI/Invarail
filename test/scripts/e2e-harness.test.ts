import { describe, it, expect } from 'vitest';
import { wilson, passRate } from '../../scripts/e2e/stats.js';
import { redactUrl } from '../../scripts/e2e/redact.js';

describe('e2e harness: Wilson interval', () => {
  it('matches the textbook value for 8/10', () => {
    const { lo, hi } = wilson(8, 10);
    expect(lo).toBeCloseTo(0.4902, 3);
    expect(hi).toBeCloseTo(0.9433, 3);
  });

  it('stays inside [0, 1] and keeps real width at the extremes, where the normal approximation collapses', () => {
    const all = wilson(3, 3);
    expect(all.hi).toBe(1);
    expect(all.lo).toBeGreaterThan(0.3);
    expect(all.lo).toBeLessThan(0.5);                // 3/3 is weak evidence — the interval says so
    const none = wilson(0, 10);
    expect(none.lo).toBe(0);
    expect(none.hi).toBeGreaterThan(0.25);
  });

  it('no attempts means no information', () => {
    expect(wilson(0, 0)).toEqual({ lo: 0, hi: 1 });
    expect(passRate(0, 0)).toBe('—');
  });

  it('formats passes, attempts and the interval', () => {
    expect(passRate(36, 36)).toBe('36/36 (90–100%)');
  });
});

describe('e2e harness: provenance host redaction', () => {
  it('redacts a LAN host but keeps scheme and port', () => {
    expect(redactUrl('http://10.9.8.19:11434')).toBe('http://<host>:11434');
    expect(redactUrl('http://gpu-box.lan:11434/')).toBe('http://<host>:11434');
  });

  it('leaves loopback alone — it locates nothing', () => {
    expect(redactUrl('http://localhost:11434')).toBe('http://localhost:11434');
    expect(redactUrl('http://127.0.0.1:11434')).toBe('http://127.0.0.1:11434');
  });

  it('an unparseable value is redacted whole', () => {
    expect(redactUrl('not a url')).toBe('<host>');
  });
});
