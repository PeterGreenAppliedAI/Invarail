import { describe, it, expect } from 'vitest';
import { classifyMessage } from '../../src/router/classifier.js';
import { RouterConfigSchema, VoiceConfigSchema } from '../../src/config/schema.js';
import type { OllamaClient } from '../../src/ollama/client.js';

describe('utility-model context sizes', () => {
  it('router passes a fixed num_ctx so phi4 loads once, not per caller', async () => {
    let seen: Record<string, unknown> | undefined;
    const client = { generate: async (p: Record<string, unknown>) => { seen = p; return { response: 'research' }; }, chat: async () => ({ message: { content: 'research' } }) } as unknown as OllamaClient;
    const config = RouterConfigSchema.parse({ model: 'phi4:latest', categories: { chat: { description: 'talk' }, research: { description: 'deep research report' } } });
    await classifyMessage(client, config, 'research the EV battery supply chain and write it up');
    expect(config.contextSize).toBe(8192);
    expect((seen?.options as Record<string, unknown>)?.num_ctx).toBe(8192);
  });

  it('voice contextSize is optional and, when set, must be positive', () => {
    expect(VoiceConfigSchema.parse({}).contextSize).toBeUndefined();
    expect(VoiceConfigSchema.parse({ model: 'phi4-mini:latest', contextSize: 8192 }).contextSize).toBe(8192);
    expect(() => VoiceConfigSchema.parse({ contextSize: 0 })).toThrow();
  });
});
