import { describe, it, expect, vi } from 'vitest';
import { dispatchMessage } from '../../src/dispatch.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { loadConfig } from '../../src/config/loader.js';
import type { OllamaClient } from '../../src/ollama/client.js';

const client = (routerCategory: string): OllamaClient => ({
  generate: vi.fn().mockResolvedValue({ response: routerCategory }),
  chat: vi.fn().mockResolvedValue({ message: { role: 'assistant', content: 'ok', tool_calls: null } }),
  listModels: vi.fn().mockResolvedValue([]), isAvailable: vi.fn().mockResolvedValue(true),
} as unknown as OllamaClient);

// F08 (policy half): the console is hosted by the web adapter, so the web channel's security
// governs /console/api/chat unless an operator writes a channels.console entry.
describe('console inherits the web channel policy', () => {
  it('a web allowedCategories restriction applies to a console-channel dispatch', async () => {
    const config = loadConfig('/tmp/nonexistent-config.json5');
    config.channels.web = { enabled: true, security: { allowedCategories: ['chat'] } } as typeof config.channels.web;
    config.specialists.web_search = { model: 'm', maxTokens: 512, temperature: 0.3, maxIterations: 3, tools: ['web_search'] } as typeof config.specialists.web_search;
    const registry = new ToolRegistry();
    registry.register({ name: 'web_search', description: 's', parameterDescription: 'q', parameters: { type: 'object', properties: { query: { type: 'string', description: 'q' } }, required: ['query'] }, category: 'web', execute: async () => 'r' });
    const r = await dispatchMessage({ client: client('web_search'), registry, config, message: 'search for news', sourceContext: { channel: 'console', channelId: 'console' } });
    expect(r.category).toBe('chat');   // blocked category falls back to chat, exactly as it does on `web`
  });

  it('an explicit channels.console entry wins over the inherited web policy', async () => {
    const config = loadConfig('/tmp/nonexistent-config.json5');
    config.channels.web = { enabled: true, security: { allowedCategories: ['chat'] } } as typeof config.channels.web;
    config.channels.console = { enabled: true, security: { allowedCategories: ['chat', 'web_search'] } } as typeof config.channels.web;
    config.specialists.web_search = { model: 'm', maxTokens: 512, temperature: 0.3, maxIterations: 3, tools: ['web_search'] } as typeof config.specialists.web_search;
    const registry = new ToolRegistry();
    registry.register({ name: 'web_search', description: 's', parameterDescription: 'q', parameters: { type: 'object', properties: { query: { type: 'string', description: 'q' } }, required: ['query'] }, category: 'web', execute: async () => 'r' });
    const r = await dispatchMessage({ client: client('web_search'), registry, config, message: 'search for news', sourceContext: { channel: 'console', channelId: 'console' } });
    expect(r.category).toBe('web_search');
  });
});
