import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/config/loader.js';

describe('defaultModel fill (one-line cutover)', () => {
  it('fills specialists/briefing/heartbeat/vision; explicit overrides survive', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
    const p = join(dir, 'c.json5');
    writeFileSync(p, JSON.stringify({
      defaultModel: 'test-model-x',
      specialists: {
        chat: { maxTokens: 1024 },
        special: { model: 'other-model' },
      },
      briefing: {},
      heartbeat: { enabled: false, delivery: { channel: 'web', target: 't' } },
      vision: { enabled: false },
    }));
    const c = loadConfig(p);
    expect(c.specialists.chat.model).toBe('test-model-x');
    expect(c.specialists.special.model).toBe('other-model'); // override wins
    expect(c.briefing?.model).toBe('test-model-x');
    expect(c.heartbeat?.model).toBe('test-model-x');
    expect(c.vision?.model).toBe('test-model-x');
    rmSync(dir, { recursive: true, force: true });
  });

  it('no defaultModel + specialist without model → loud parse error, not silent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
    const p = join(dir, 'c.json5');
    writeFileSync(p, JSON.stringify({ specialists: { chat: { maxTokens: 512 } } }));
    expect(() => loadConfig(p)).toThrow(/model/);
    rmSync(dir, { recursive: true, force: true });
  });
});
