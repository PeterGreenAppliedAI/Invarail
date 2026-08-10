import { describe, it, expect } from 'vitest';
import { loadConfig } from '../../src/config/loader.js';

// Tier 0 honesty enforcement (INSTALL.md): the starter preset must always
// parse and describe a runnable zero-sidecar setup, no matter what the
// reference build grows into.
describe('starter preset', () => {
  it('parses through the real loader + Zod schema', () => {
    const config = loadConfig('invarail.config.starter.json5');
    expect(config.router.defaultCategory).toBe('chat');
    expect(config.specialists.chat?.model).toBeTruthy();
    expect(config.channels.web?.enabled).toBe(true);
  });

  it('requires nothing external: no tokens, no backends, no tool providers', () => {
    const config = loadConfig('invarail.config.starter.json5');
    expect(config.inference.backends ?? []).toHaveLength(0);
    expect(config.tools).toBeUndefined();
    for (const [name, ch] of Object.entries(config.channels)) {
      if (name === 'web') continue;
      expect((ch as { enabled?: boolean }).enabled ?? false).toBe(false);
    }
  });

  it('uses one model for router and every specialist', () => {
    const config = loadConfig('invarail.config.starter.json5');
    const models = new Set([config.router.model, ...Object.values(config.specialists).map(s => s.model)]);
    expect(models.size).toBe(1);
  });
});
