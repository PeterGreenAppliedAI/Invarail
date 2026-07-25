import { describe, it, expect, vi, beforeEach } from 'vitest';
import { classifyMessage, capForClassification } from '../../src/router/classifier.js';
import type { OllamaClient } from '../../src/ollama/client.js';
import type { RouterConfig } from '../../src/config/types.js';

function createMockClient(response: string): OllamaClient {
  return {
    generate: vi.fn().mockResolvedValue({ response }),
    chat: vi.fn(),
    listModels: vi.fn(),
    isAvailable: vi.fn(),
  } as unknown as OllamaClient;
}

function createFailingClient(): OllamaClient {
  return {
    generate: vi.fn().mockRejectedValue(new Error('timeout')),
    chat: vi.fn(),
    listModels: vi.fn(),
    isAvailable: vi.fn(),
  } as unknown as OllamaClient;
}

const defaultConfig: RouterConfig = {
  model: 'phi4-mini',
  timeout: 2000,
  defaultCategory: 'chat',
  categories: {
    chat: { description: 'Conversation' },
    web_search: { description: 'Web search' },
    memory: { description: 'Memory' },
    exec: { description: 'Exec' },
    cron: { description: 'Cron' },
    message: { description: 'Message' },
    website: { description: 'Website' },
    multi: { description: 'Multi' },
  },
};

describe('classifyMessage', () => {
  it('enforces config.timeout — a hung model call falls back within the budget', async () => {
    // generate never resolves — simulates a dead/hanging gateway where the
    // client's internal retry loop would otherwise stall for ~12s
    const client = {
      generate: vi.fn().mockImplementation(() => new Promise(() => {})),
      chat: vi.fn(),
      listModels: vi.fn(),
      isAvailable: vi.fn(),
    } as unknown as OllamaClient;

    const start = Date.now();
    const result = await classifyMessage(client, { ...defaultConfig, timeout: 100 }, 'What is the latest AI news?');
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(1000); // bounded by timeout, not the client's retries
    expect(result.confidence).not.toBe('model'); // fell through to keyword/fallback
  });

  it('returns model category when valid', async () => {
    const client = createMockClient('web_search');
    const result = await classifyMessage(client, defaultConfig, 'What is the latest AI news?');
    expect(result.category).toBe('web_search');
    expect(result.confidence).toBe('model');
  });

  it('strips whitespace and non-alpha from model output', async () => {
    const client = createMockClient('  web_search\n');
    const result = await classifyMessage(client, defaultConfig, 'search something');
    expect(result.category).toBe('web_search');
    expect(result.confidence).toBe('model');
  });

  it('falls back to keyword heuristics on invalid model output', async () => {
    const client = createMockClient('I think this is a web search request.');
    const result = await classifyMessage(client, defaultConfig, 'search for the latest news');
    expect(result.category).toBe('web_search');
    expect(result.confidence).toBe('keyword');
  });

  it('falls back to keyword heuristics on timeout', async () => {
    const client = createFailingClient();
    const result = await classifyMessage(client, defaultConfig, 'remind me at 5pm');
    expect(result.category).toBe('cron');
    expect(result.confidence).toBe('keyword');
  });

  it('falls back to defaultCategory when no keyword match', async () => {
    const client = createFailingClient();
    const result = await classifyMessage(client, defaultConfig, 'hey how are you');
    expect(result.category).toBe('chat');
    expect(result.confidence).toBe('fallback');
  });

  it('keyword: detects exec patterns', async () => {
    const client = createFailingClient();
    const result = await classifyMessage(client, defaultConfig, 'install numpy with pip');
    expect(result.category).toBe('exec');
    expect(result.confidence).toBe('keyword');
  });

  it('keyword: detects memory patterns', async () => {
    const client = createFailingClient();
    const result = await classifyMessage(client, defaultConfig, 'what did we discuss yesterday');
    expect(result.category).toBe('memory');
    expect(result.confidence).toBe('keyword');
  });

  it('keyword: detects message patterns', async () => {
    const client = createFailingClient();
    const result = await classifyMessage(client, defaultConfig, 'tell the team about the release');
    expect(result.category).toBe('message');
    expect(result.confidence).toBe('keyword');
  });

  it('keyword: detects website patterns', async () => {
    const client = createFailingClient();
    const result = await classifyMessage(client, defaultConfig, 'what homework is due');
    expect(result.category).toBe('website');
    expect(result.confidence).toBe('keyword');
  });

  it('sticky: cron follow-up question stays in cron (July 20 incident)', async () => {
    const client = createMockClient('memory');
    const result = await classifyMessage(client, defaultConfig, 'We did all three or just the one?', 'cron');
    expect(result.category).toBe('cron');
    expect(result.confidence).toBe('sticky');
  });

  it('sticky: "setting up a business" does not trip the config keyword', async () => {
    const client = createMockClient('personal');
    const paste = 'September 15, 2026 — Follow up with Anthony. Context: he proposed presenting my product and setting up a business structure to split revenue. Remind me to prepare before reaching out with a rough structure in mind rather than negotiating from a handshake.';
    const result = await classifyMessage(client, defaultConfig, paste, 'cron');
    expect(result.category).toBe('cron');
    expect(result.confidence).toBe('sticky');
  });

  it('keyword: "settings" still routes to config', async () => {
    const client = createFailingClient();
    const config = { ...defaultConfig, categories: { ...defaultConfig.categories, config: { description: 'Config' } } };
    const result = await classifyMessage(client, config, 'change my notification settings');
    expect(result.category).toBe('config');
    expect(result.confidence).toBe('keyword');
  });
});

describe('capForClassification', () => {
  it('returns short text unchanged', () => {
    expect(capForClassification('turn this into a PDF')).toBe('turn this into a PDF');
  });

  it('caps a huge paste but keeps head AND tail', () => {
    const big = 'HEAD instruction ' + 'x'.repeat(5000) + ' TAIL turn this into a PDF';
    const capped = capForClassification(big, 600);
    expect(capped.length).toBeLessThan(700);
    expect(capped).toContain('HEAD instruction');
    expect(capped).toContain('turn this into a PDF');
  });
});
