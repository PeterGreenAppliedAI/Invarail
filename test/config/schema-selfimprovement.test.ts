import { describe, expect, it } from 'vitest';
import { HeartbeatConfigSchema } from '../../src/config/schema.js';

describe('heartbeat selfImprovement config', () => {
  it('is OPT-IN: defaults to disabled (a new autonomy surface enters the ladder off)', () => {
    const parsed = HeartbeatConfigSchema.parse({ delivery: { target: '123' } });
    expect(parsed.selfImprovement.enabled).toBe(false);
    expect(parsed.selfImprovement.minOccurrences).toBe(3);
    expect(parsed.selfImprovement.cooldownDays).toBe(7);
  });

  it('parses an explicit enable', () => {
    const parsed = HeartbeatConfigSchema.parse({ delivery: { target: '123' }, selfImprovement: { enabled: true, minOccurrences: 5 } });
    expect(parsed.selfImprovement.enabled).toBe(true);
    expect(parsed.selfImprovement.minOccurrences).toBe(5);
  });
});
