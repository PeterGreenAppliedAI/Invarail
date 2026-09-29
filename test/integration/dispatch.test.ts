import { describe, it, expect, vi } from 'vitest';
import { dispatchMessage } from '../../src/dispatch.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { PipelineRegistry } from '../../src/pipeline/registry.js';
import type { OllamaClient } from '../../src/ollama/client.js';
import type { InvarailConfig } from '../../src/config/types.js';
import { loadConfig } from '../../src/config/loader.js';

function createMockClient(routerCategory: string, specialistAnswer: string): OllamaClient {
  return {
    generate: vi.fn().mockResolvedValue({ response: routerCategory }),
    chat: vi.fn().mockResolvedValue({
      message: { role: 'assistant', content: specialistAnswer, tool_calls: null },
    }),
    listModels: vi.fn().mockResolvedValue([]),
    isAvailable: vi.fn().mockResolvedValue(true),
  } as unknown as OllamaClient;
}

describe('dispatchMessage', () => {
  it('routes to chat category and returns answer', async () => {
    const client = createMockClient('chat', 'Hello! Nice to meet you.');
    const config = loadConfig('/tmp/nonexistent-config.json5');
    const registry = new ToolRegistry();

    const result = await dispatchMessage({
      client,
      registry,
      config,
      message: 'Hey there!',
    });

    expect(result.category).toBe('chat');
    expect(result.answer).toBeTruthy();
    expect(result.iterations).toBeGreaterThanOrEqual(1);
  });

  it('routes to web_search with configured specialist', async () => {
    const client = createMockClient('web_search', 'Here are the latest AI developments...');
    const config = loadConfig('/tmp/nonexistent-config.json5');

    // Add specialist config with tools
    config.specialists.web_search = {
      model: 'test-model',
      maxTokens: 4096,
      temperature: 0.3,
      maxIterations: 5,
      tools: ['web_search'],
    };

    const registry = new ToolRegistry();
    registry.register({
      name: 'web_search',
      description: 'Search',
      parameterDescription: 'query',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Search query' } },
        required: ['query'],
      },
      category: 'web_search',
      execute: async () => 'mock results',
    });

    const result = await dispatchMessage({
      client,
      registry,
      config,
      message: 'Latest AI news',
    });

    expect(result.category).toBe('web_search');
    expect(result.classification.confidence).toBe('model');
  });

  it('falls back to chat when router returns garbage', async () => {
    const client: OllamaClient = {
      generate: vi.fn().mockResolvedValue({ response: 'I think this is a greeting' }),
      chat: vi.fn().mockResolvedValue({
        message: { role: 'assistant', content: 'Hello there!', tool_calls: null },
      }),
      listModels: vi.fn().mockResolvedValue([]),
      isAvailable: vi.fn().mockResolvedValue(true),
    } as unknown as OllamaClient;

    const config = loadConfig('/tmp/nonexistent-config.json5');
    const registry = new ToolRegistry();

    const result = await dispatchMessage({
      client,
      registry,
      config,
      message: 'yo',
    });

    // Should fall back to chat (default) since router output is garbage
    expect(result.category).toBe('chat');
    expect(result.classification.confidence).toBe('fallback');
  });

  it('uses keyword heuristic when router fails', async () => {
    const client: OllamaClient = {
      generate: vi.fn().mockRejectedValue(new Error('model not found')),
      chat: vi.fn().mockResolvedValue({
        message: { role: 'assistant', content: 'Search results...', tool_calls: null },
      }),
      listModels: vi.fn().mockResolvedValue([]),
      isAvailable: vi.fn().mockResolvedValue(true),
    } as unknown as OllamaClient;

    const config = loadConfig('/tmp/nonexistent-config.json5');
    config.specialists.web_search = {
      model: 'test',
      maxTokens: 1024,
      temperature: 0.3,
      maxIterations: 3,
      tools: [],
    };
    const registry = new ToolRegistry();

    const result = await dispatchMessage({
      client,
      registry,
      config,
      message: 'search for the latest news about AI',
    });

    expect(result.category).toBe('web_search');
    expect(result.classification.confidence).toBe('keyword');
  });

  describe('channel security', () => {
    it('blocked category falls back to chat', async () => {
      const client = createMockClient('exec', 'I can help with that');
      const config = loadConfig('/tmp/nonexistent-config.json5');

      // Add security config for whatsapp — exec is not allowed
      config.channels.whatsapp = {
        enabled: true,
        security: {
          allowedCategories: ['chat', 'web_search', 'memory'],
          blockedTools: [],
        },
      };
      config.specialists.exec = {
        model: 'test-model',
        maxTokens: 4096,
        temperature: 0.3,
        maxIterations: 5,
        tools: ['exec'],
      };

      const registry = new ToolRegistry();
      registry.register({
        name: 'exec',
        description: 'Execute command',
        parameterDescription: 'command',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string', description: 'Command' } },
          required: ['command'],
        },
        category: 'exec',
        execute: async () => 'mock exec',
      });

      const result = await dispatchMessage({
        client,
        registry,
        config,
        message: 'run ls',
        sourceContext: { channel: 'whatsapp', channelId: '123' },
      });

      expect(result.category).toBe('chat');
    });

    it('blocked tool stripped from specialist', async () => {
      const client = createMockClient('web_search', 'Here are results');
      const config = loadConfig('/tmp/nonexistent-config.json5');

      config.channels.whatsapp = {
        enabled: true,
        security: {
          allowedCategories: ['chat', 'web_search'],
          blockedTools: ['reason'],
        },
      };
      config.specialists.web_search = {
        model: 'test-model',
        maxTokens: 4096,
        temperature: 0.3,
        maxIterations: 5,
        tools: ['web_search', 'reason'],
      };

      const registry = new ToolRegistry();
      registry.register({
        name: 'web_search',
        description: 'Search',
        parameterDescription: 'query',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: 'Query' } },
          required: ['query'],
        },
        category: 'web_search',
        execute: async () => 'mock results',
      });

      const result = await dispatchMessage({
        client,
        registry,
        config,
        message: 'search for news',
        sourceContext: { channel: 'whatsapp', channelId: '123' },
      });

      // Should still route to web_search (allowed category) but reason tool is stripped
      expect(result.category).toBe('web_search');
    });

    it('all tools stripped degrades to bare chat', async () => {
      const client = createMockClient('web_search', 'Chat fallback response');
      const config = loadConfig('/tmp/nonexistent-config.json5');

      config.channels.whatsapp = {
        enabled: true,
        security: {
          allowedCategories: ['chat', 'web_search'],
          blockedTools: ['web_search'],
        },
      };
      config.specialists.web_search = {
        model: 'test-model',
        maxTokens: 4096,
        temperature: 0.3,
        maxIterations: 5,
        tools: ['web_search'],
      };

      const registry = new ToolRegistry();

      const result = await dispatchMessage({
        client,
        registry,
        config,
        message: 'search for news',
        sourceContext: { channel: 'whatsapp', channelId: '123' },
      });

      // All tools stripped — runs as bare chat
      expect(result.category).toBe('web_search');
      expect(result.iterations).toBe(1);
    });

    it('no security config means unrestricted', async () => {
      const client = createMockClient('exec', 'Command output');
      const config = loadConfig('/tmp/nonexistent-config.json5');

      config.channels.discord = { enabled: true };
      config.specialists.exec = {
        model: 'test-model',
        maxTokens: 4096,
        temperature: 0.3,
        maxIterations: 5,
        tools: ['exec'],
      };

      const registry = new ToolRegistry();
      registry.register({
        name: 'exec',
        description: 'Execute command',
        parameterDescription: 'command',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string', description: 'Command' } },
          required: ['command'],
        },
        category: 'exec',
        execute: async () => 'mock exec',
      });

      const result = await dispatchMessage({
        client,
        registry,
        config,
        message: 'run ls',
        sourceContext: { channel: 'discord', channelId: '456' },
      });

      // No security block — routes normally to exec
      expect(result.category).toBe('exec');
    });
  });

  it('passes history to specialist', async () => {
    const chatFn = vi.fn().mockResolvedValue({
      message: { role: 'assistant', content: 'response', tool_calls: null },
    });

    const client: OllamaClient = {
      generate: vi.fn().mockResolvedValue({ response: 'chat' }),
      chat: chatFn,
      listModels: vi.fn().mockResolvedValue([]),
      isAvailable: vi.fn().mockResolvedValue(true),
    } as unknown as OllamaClient;

    const config = loadConfig('/tmp/nonexistent-config.json5');
    const registry = new ToolRegistry();

    await dispatchMessage({
      client,
      registry,
      config,
      message: 'follow up',
      history: [
        { role: 'user', content: 'previous message' },
        { role: 'assistant', content: 'previous answer' },
      ],
    });

    // Verify chat was called with history messages
    const chatCall = chatFn.mock.calls[0][0];
    expect(chatCall.messages.length).toBeGreaterThan(2);
  });
});

describe('removed-category tolerance (Invarail trim, 2026-08-10)', () => {
  // Persisted data (old cron jobs, session state, metrics) may still carry
  // category strings whose pipelines/specialists were removed. Dispatch must
  // degrade gracefully — never throw on a historical value.
  it('dispatch with a removed category degrades to bare chat, no throw', async () => {
    const client = createMockClient('chat', 'Handled gracefully.');
    const config = loadConfig('/tmp/nonexistent-config.json5');
    const registry = new ToolRegistry();

    for (const removed of ['analytics', 'document', 'config', 'personal']) {
      const result = await dispatchMessage({
        client,
        registry,
        config,
        message: 'a request shaped for a subsystem that no longer exists',
        overrideCategory: removed,
      });
      expect(result.answer).toBeTruthy();
    }
  });
});

describe('arena dispatch mode (DECISIONS 2026-08-20: the arena duel)', () => {
  function arenaSetup(dispatchMode?: 'arena') {
    const client = createMockClient('multi', 'Task completed via open loop.');
    const config = loadConfig('/tmp/nonexistent-config.json5');
    config.specialists.multi = {
      model: 'test-model',
      maxTokens: 1024,
      temperature: 0.3,
      maxIterations: 5,
      tools: ['read_file'],
      pipeline: 'plan',                       // deliberately still set — arena must beat it
      ...(dispatchMode ? { dispatchMode } : {}),
    } as InvarailConfig['specialists'][string];
    const registry = new ToolRegistry();
    registry.register({
      name: 'read_file',
      description: 'Read a file',
      parameterDescription: 'path',
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'p' } }, required: ['path'] },
      category: 'exec',
      execute: async () => 'file contents',
    });
    const pipelineRegistry = new PipelineRegistry();
    const hasSpy = vi.spyOn(pipelineRegistry, 'has');
    return { client, config, registry, pipelineRegistry, hasSpy };
  }

  it('dispatchMode: arena skips the pipeline even when pipeline is set and registered', async () => {
    const { client, config, registry, pipelineRegistry, hasSpy } = arenaSetup('arena');
    const result = await dispatchMessage({
      client, registry, config, pipelineRegistry,
      message: 'do a multi-step thing',
      overrideCategory: 'multi',
    });
    expect(result.category).toBe('multi');
    expect(result.answer).toContain('open loop');
    expect(hasSpy).not.toHaveBeenCalled();     // the pipeline branch was never consulted
  });

  it('without dispatchMode, the pipeline registry IS consulted (legacy behavior preserved)', async () => {
    const { client, config, registry, pipelineRegistry, hasSpy } = arenaSetup(undefined);
    await dispatchMessage({
      client, registry, config, pipelineRegistry,
      message: 'do a multi-step thing',
      overrideCategory: 'multi',
    });
    expect(hasSpy).toHaveBeenCalledWith('plan'); // proves the arena test's non-consultation is meaningful
  });

  it('schema: dispatchMode parses arena and defaults to absent', async () => {
    const { SpecialistConfigSchema } = await import('../../src/config/schema.js');
    const parsed = SpecialistConfigSchema.parse({ model: 'm', dispatchMode: 'arena' });
    expect(parsed.dispatchMode).toBe('arena');
    expect(SpecialistConfigSchema.parse({ model: 'm' }).dispatchMode).toBeUndefined();
    expect(() => SpecialistConfigSchema.parse({ model: 'm', dispatchMode: 'freeform' })).toThrow();
  });
});

describe('bare chat forwards the specialist think flag (live-caught 2026-09-26)', () => {
  // Voice turns on the natively-thinking 27B came back empty: runAsBareChat never sent
  // `think`, so the model reasoned by default and the 100-token voice cap was spent
  // inside the think block. The tool loop and pipelines already forward it; bare chat
  // must too.
  function chatClient() {
    const chatFn = vi.fn().mockResolvedValue({
      message: { role: 'assistant', content: 'spoken reply', tool_calls: null },
    });
    const client = {
      generate: vi.fn().mockResolvedValue({ response: 'chat' }),
      chat: chatFn,
      listModels: vi.fn().mockResolvedValue([]),
      isAvailable: vi.fn().mockResolvedValue(true),
    } as unknown as OllamaClient;
    return { client, chatFn };
  }

  it('think: false on the chat specialist reaches the wire, and survives the voice override', async () => {
    const { client, chatFn } = chatClient();
    const config = loadConfig('/tmp/nonexistent-config.json5');
    config.specialists.chat = { model: 'big-model', maxTokens: 4096, temperature: 1, maxIterations: 1, tools: [], think: false };
    const registry = new ToolRegistry();

    await dispatchMessage({ client, registry, config, message: 'what do you think about the garden plan' });
    expect(chatFn.mock.calls[0][0]).toMatchObject({ model: 'big-model', think: false });

    await dispatchMessage({ client, registry, config, message: 'take care of what exactly', modelOverride: 'voice-model', maxTokensOverride: 100 });
    const voiceCall = chatFn.mock.calls[1][0];
    expect(voiceCall).toMatchObject({ model: 'voice-model', think: false });
    expect(voiceCall.options.num_predict).toBe(100);
  });

  it('no think flag configured → the key is absent (server default, not a forced value)', async () => {
    const { client, chatFn } = chatClient();
    const config = loadConfig('/tmp/nonexistent-config.json5');
    config.specialists.chat = { model: 'big-model', maxTokens: 4096, temperature: 1, maxIterations: 1, tools: [] };
    await dispatchMessage({ client, registry: new ToolRegistry(), config, message: 'what do you think about the garden plan' });
    expect('think' in chatFn.mock.calls[0][0]).toBe(false);
  });
});

describe('quick-greeting model is config, not a literal (2026-09-26)', () => {
  function chatClient() {
    const chatFn = vi.fn().mockResolvedValue({ message: { role: 'assistant', content: 'hey', tool_calls: null } });
    const client = {
      generate: vi.fn().mockResolvedValue({ response: 'chat' }),
      chat: chatFn,
      listModels: vi.fn().mockResolvedValue([]),
      isAvailable: vi.fn().mockResolvedValue(true),
    } as unknown as OllamaClient;
    return { client, chatFn };
  }

  it('router.quickModel set → a whitelisted greeting goes to that model', async () => {
    const { client, chatFn } = chatClient();
    const config = loadConfig('/tmp/nonexistent-config.json5');
    config.specialists.chat = { model: 'big-model', maxTokens: 4096, temperature: 1, maxIterations: 1, tools: [] };
    config.router.quickModel = 'tiny-model';
    await dispatchMessage({ client, registry: new ToolRegistry(), config, message: 'hello' });
    expect(chatFn.mock.calls[0][0].model).toBe('tiny-model');
  });

  it('router.quickModel unset → the chat specialist answers greetings itself', async () => {
    const { client, chatFn } = chatClient();
    const config = loadConfig('/tmp/nonexistent-config.json5');
    config.specialists.chat = { model: 'big-model', maxTokens: 4096, temperature: 1, maxIterations: 1, tools: [] };
    delete config.router.quickModel;
    await dispatchMessage({ client, registry: new ToolRegistry(), config, message: 'hello' });
    expect(chatFn.mock.calls[0][0].model).toBe('big-model');
  });
});

describe('scope is checked before confirmation (review F02, 2026-09-27)', () => {
  it('a native call to a confirm-tier tool OUTSIDE the specialist\'s tool set gets the scope denial, not a preview', async () => {
    const registry = new ToolRegistry();
    const dangerous = vi.fn().mockResolvedValue('boom');
    registry.register({
      name: 'send_message', description: 'send', parameterDescription: 'text', category: 'message', requiresConfirm: true,
      parameters: { type: 'object', properties: { text: { type: 'string', description: 't' } }, required: ['text'] },
      execute: dangerous,
    });
    registry.register({
      name: 'read_file', description: 'read', parameterDescription: 'path', category: 'exec',
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'p' } }, required: ['path'] },
      execute: vi.fn().mockResolvedValue('contents'),
    });
    const chatFn = vi.fn()
      .mockResolvedValueOnce({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'send_message', arguments: { text: 'pwned' } } }] } })
      .mockResolvedValue({ message: { role: 'assistant', content: 'done', tool_calls: null } });
    const client = {
      generate: vi.fn().mockResolvedValue({ response: 'exec' }),
      chat: chatFn, listModels: vi.fn().mockResolvedValue([]), isAvailable: vi.fn().mockResolvedValue(true),
    } as unknown as OllamaClient;
    const config = loadConfig('/tmp/nonexistent-config.json5');
    config.specialists.exec = { model: 'm', maxTokens: 512, temperature: 0.1, maxIterations: 3, tools: ['read_file'], dispatchMode: 'arena' } as any;

    await dispatchMessage({ client, registry, config, message: 'run the thing', sourceContext: { channel: 'discord', channelId: 'c', senderId: 'guest' } });

    expect(dangerous).not.toHaveBeenCalled();
    const observations = chatFn.mock.calls.flatMap((c: any[]) => c[0].messages).filter((m: any) => m.role === 'tool').map((m: any) => String(m.content));
    expect(observations.some((o: string) => /not available/i.test(o))).toBe(true);
    expect(observations.some((o: string) => /confirm/i.test(o))).toBe(false);
  });
});

describe('channel filters apply to MCP-expanded tool names (review F09, 2026-09-27)', () => {
  it('blockedTools naming a concrete MCP tool strips it even when the specialist lists the server token', async () => {
    const registry = new ToolRegistry();
    const demoRead = vi.fn().mockResolvedValue('secret contents');
    registry.register({
      name: 'demo_read', description: 'read', parameterDescription: 'path', category: 'mcp:demo',
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'p' } }, required: ['path'] },
      execute: demoRead,
    });
    const chatFn = vi.fn()
      .mockResolvedValueOnce({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'demo_read', arguments: { path: 'x' } } }] } })
      .mockResolvedValue({ message: { role: 'assistant', content: 'done', tool_calls: null } });
    const client = { generate: vi.fn().mockResolvedValue({ response: 'exec' }), chat: chatFn, listModels: vi.fn().mockResolvedValue([]), isAvailable: vi.fn().mockResolvedValue(true) } as unknown as OllamaClient;
    const config = loadConfig('/tmp/nonexistent-config.json5');
    config.specialists.exec = { model: 'm', maxTokens: 512, temperature: 0.1, maxIterations: 3, tools: ['mcp:demo'], dispatchMode: 'arena' } as any;
    config.channels.discord = { enabled: true, security: { blockedTools: ['demo_read'] } } as any;

    await dispatchMessage({ client, registry, config, message: 'read it', sourceContext: { channel: 'discord', channelId: 'c', senderId: 'guest' } });
    expect(demoRead).not.toHaveBeenCalled();
  });
});

describe('specialist reroute (DECISIONS 2026-09-29)', () => {
  const STALL = "I created the task. Next, I will read the releases.txt file and write notes/release-summary.md.";

  /** A task specialist (task tools only) and a multi specialist (files + tasks), both arena.
   *  The router answers `routes` in order; each specialist's model answers from its own script. */
  function setup(opts: { routes: string[]; task: Array<Record<string, unknown>>; multi?: Array<Record<string, unknown>> }) {
    const registry = new ToolRegistry();
    const taskAdd = vi.fn().mockResolvedValue('Created task bca872ac');
    const writeFile = vi.fn().mockResolvedValue('Written to notes/release-summary.md');
    const reg = (name: string, execute: (...a: any[]) => any) => registry.register({
      name, description: name, parameterDescription: 'x', category: 'test',
      parameters: { type: 'object', properties: { title: { type: 'string', description: 't' }, path: { type: 'string', description: 'p' } }, required: [] },
      execute,
    });
    reg('task_add', taskAdd);
    reg('read_file', vi.fn().mockResolvedValue('v0.6.2 — changes'));
    reg('write_file', writeFile);

    const scripts: Record<string, Array<Record<string, unknown>>> = { 'task-m': [...opts.task], 'multi-m': [...(opts.multi ?? [{ content: 'All done.' }])] };
    const seen: Record<string, any[]> = { 'task-m': [], 'multi-m': [] };
    const chat = vi.fn().mockImplementation(async (req: any) => {
      seen[req.model]?.push(req);
      const next = scripts[req.model]?.shift() ?? { content: 'Done.' };
      return { message: { role: 'assistant', content: next.content ?? '', tool_calls: next.tool_calls ?? null } };
    });
    const routes = [...opts.routes];
    const generate = vi.fn().mockImplementation(async () => ({ response: routes.shift() ?? 'chat' }));
    const client = { generate, chat, listModels: vi.fn().mockResolvedValue([]), isAvailable: vi.fn().mockResolvedValue(true) } as unknown as OllamaClient;

    const config = loadConfig('/tmp/nonexistent-config.json5');
    config.router.categories = { chat: { description: 'chat' }, task: { description: 'tasks' }, multi: { description: 'mixed' } } as any;
    config.specialists.task = { model: 'task-m', maxTokens: 512, temperature: 0.1, maxIterations: 4, tools: ['task_add'], dispatchMode: 'arena' } as any;
    config.specialists.multi = { model: 'multi-m', maxTokens: 512, temperature: 0.1, maxIterations: 4, tools: ['read_file', 'write_file', 'task_add'], dispatchMode: 'arena' } as any;
    return { client, config, registry, generate, seen, taskAdd, writeFile };
  }
  const call = (name: string, args: Record<string, unknown>) => ({ content: '', tool_calls: [{ function: { name, arguments: args } }] });
  const toolNames = (req: any) => (req?.tools ?? []).map((t: any) => t.function?.name);

  it('claimed: an answer claiming an action the specialist has no tool for is re-dispatched once, to the router\'s NEW pick, with what was done', async () => {
    // "Add a task…" is routed by the anchored pre-model override, so the router model is asked ONCE — for the re-ask.
    const s = setup({ routes: ['multi'], task: [call('task_add', { title: 'Evaluate v0.6.2' }), { content: "I've added the task and I have written the summary to notes/release-summary.md." }] });
    const result = await dispatchMessage({ client: s.client, registry: s.registry, config: s.config, message: 'Add a task to evaluate v0.6.2 and write notes/release-summary.md' });

    expect(result.category).toBe('multi');
    expect(result.reroutedFrom).toBe('task');
    expect(toolNames(s.seen['task-m'][0])).toEqual(['task_add']);               // nothing added to the prompt
    expect(s.generate).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(s.generate.mock.calls[0])).toContain('Re-route');   // the hint led, so the override did not fire again
    const multiUser = JSON.stringify(s.seen['multi-m'][0].messages);
    expect(multiUser).toContain('do NOT repeat');
    expect(multiUser).toContain('Created task bca872ac');
    expect(s.taskAdd).toHaveBeenCalledTimes(1);
  });

  it('implicit: ending on an announced action whose tool the specialist lacks triggers the same reroute', async () => {
    const s = setup({ routes: ['task', 'multi'], task: [call('task_add', { title: 'Evaluate v0.6.2' }), { content: STALL }] });
    const result = await dispatchMessage({ client: s.client, registry: s.registry, config: s.config, message: 'Read releases.txt, add a task, then write notes/release-summary.md' });
    expect(result.category).toBe('multi');
    expect(result.reroutedFrom).toBe('task');
  });

  it('rule 2: when the router names the same category again, no re-dispatch — an honest note instead', async () => {
    const s = setup({ routes: ['task', 'task'], task: [call('task_add', { title: 'x' }), { content: STALL }] });
    const result = await dispatchMessage({ client: s.client, registry: s.registry, config: s.config, message: 'Read releases.txt, add a task, then write notes/release-summary.md' });
    expect(result.category).toBe('task');
    expect(result.reroutedFrom).toBeUndefined();
    expect(result.answer).toMatch(/no other route was found/);
    expect(s.seen['multi-m']).toHaveLength(0);
  });

  it('rule 3: one reroute per message — a stall in the rerouted specialist does not reroute again', async () => {
    const s = setup({ routes: ['task', 'multi', 'task'], task: [call('task_add', { title: 'x' }), { content: STALL }], multi: [{ content: 'Next, I will search the web for more.' }] });
    const result = await dispatchMessage({ client: s.client, registry: s.registry, config: s.config, message: 'Read releases.txt and add a task' });
    expect(result.category).toBe('multi');
    expect(s.generate).toHaveBeenCalledTimes(2);
  });

  it('rule 1: the re-dispatch re-enters the security path — a channel that does not allow the new category still blocks it', async () => {
    const s = setup({ routes: ['multi'], task: [call('task_add', { title: 'x' }), { content: 'Added it. Now I will write notes.md with the details.' }] });
    s.config.channels.discord = { enabled: true, security: { allowedCategories: ['chat', 'task'] } } as any;
    const result = await dispatchMessage({ client: s.client, registry: s.registry, config: s.config, message: 'Add a task and write notes.md', sourceContext: { channel: 'discord', channelId: 'c', senderId: 'guest' } });
    expect(result.reroutedFrom).toBe('task');
    expect(result.category).toBe('chat');                                      // downgraded by allowedCategories, not multi
    expect(s.writeFile).not.toHaveBeenCalled();
  });

  it('the transcript keeps what the user said, not the handoff note', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { SessionStore } = await import('../../src/sessions/store.js');
    const dir = mkdtempSync(join(tmpdir(), 'reroute-transcript-'));
    try {
      const store = new SessionStore(dir);
      const s = setup({ routes: ['task', 'multi'], task: [call('task_add', { title: 'x' }), { content: STALL }] });
      const original = 'Read releases.txt, add a task, then write notes/release-summary.md';
      await dispatchMessage({ client: s.client, registry: s.registry, config: s.config, message: original, sessionStore: store, agentId: 'main', sessionKey: 'k' });
      const turns = store.loadTranscript('main', 'k');
      expect(turns.filter(t => t.role === 'user').map(t => t.content)).toEqual([original]);
      expect(turns.find(t => t.role === 'user')?.category).toBe('multi');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('never in cron, never for an owner-forced category, never when disabled in config', async () => {
    for (const variant of ['cron', 'forced', 'disabled'] as const) {
      const s = setup({ routes: ['task', 'multi'], task: [call('task_add', { title: 'x' }), { content: STALL }] });
      if (variant === 'disabled') s.config.router.reroute = { enabled: false };
      const result = await dispatchMessage({
        client: s.client, registry: s.registry, config: s.config,
        message: 'Read releases.txt, add a task, then write notes/release-summary.md',
        ...(variant === 'cron' ? { cronMode: true } : {}),
        ...(variant === 'forced' ? { overrideCategory: 'task' } : {}),
      });
      expect(result.reroutedFrom, variant).toBeUndefined();
      expect(s.seen['multi-m'], variant).toHaveLength(0);
    }
  });
});
