import { beforeEach, describe, expect, it, vi } from 'vitest';

const metricsMock = vi.hoisted(() => ({
  logPiSessionEvent: vi.fn(),
  logPiSession: vi.fn(),
}));
vi.mock('../../src/metrics.js', () => metricsMock);

type Listener = (event: Record<string, unknown>) => void;

const sdkMock = vi.hoisted(() => {
  const state: {
    session: FakeSession | null;
    findResult: object | null;
    createOptions: Record<string, unknown> | null;
    setRuntimeApiKey: ReturnType<typeof vi.fn>;
    reload: ReturnType<typeof vi.fn>;
    loaderOptions: Record<string, unknown> | null;
    promptBehavior: (session: FakeSession) => Promise<void>;
  } = {
    session: null,
    findResult: { provider: 'sglang', id: 'qwen3.8-27b' },
    createOptions: null,
    setRuntimeApiKey: vi.fn(),
    reload: vi.fn(async () => undefined),
    loaderOptions: null,
    promptBehavior: async () => undefined,
  };

  class FakeSession {
    sessionId = 'sess-123';
    sessionFile: string | undefined = '/tmp/pi-sessions/sess-123.jsonl';
    agent = { state: { errorMessage: undefined as string | undefined } };
    listeners: Listener[] = [];
    aborted = false;
    disposed = false;
    unsubscribed = false;

    subscribe(listener: Listener): () => void {
      this.listeners.push(listener);
      return () => { this.unsubscribed = true; };
    }
    emit(event: Record<string, unknown>): void {
      for (const l of this.listeners) l(event);
    }
    prompt(_text: string): Promise<void> {
      return state.promptBehavior(this);
    }
    abort(): Promise<void> {
      this.aborted = true;
      return Promise.resolve();
    }
    dispose(): void { this.disposed = true; }
  }

  return { state, FakeSession };
});

vi.mock('@earendil-works/pi-coding-agent', () => ({
  getAgentDir: () => '/fake/.pi/agent',
  AuthStorage: {
    create: () => ({ setRuntimeApiKey: sdkMock.state.setRuntimeApiKey }),
  },
  ModelRegistry: {
    create: () => ({ find: () => sdkMock.state.findResult }),
  },
  SettingsManager: {
    create: () => ({}),
  },
  DefaultResourceLoader: class {
    constructor(options: Record<string, unknown>) { sdkMock.state.loaderOptions = options; }
    reload = sdkMock.state.reload;
  },
  createAgentSession: async (options: Record<string, unknown>) => {
    sdkMock.state.createOptions = options;
    const session = new sdkMock.FakeSession();
    sdkMock.state.session = session;
    return { session, extensionsResult: {} };
  },
}));

const { PiCodingAdapter } = await import('../../src/coding/pi-session.js');
const { PiConfigSchema } = await import('../../src/config/schema.js');
const { InvarailError } = await import('../../src/errors.js');

function makeConfig(overrides: Record<string, unknown> = {}) {
  return PiConfigSchema.parse({ model: 'sglang/qwen3.8-27b', apiKey: 'sglang', ...overrides });
}

beforeEach(() => {
  vi.clearAllMocks();
  sdkMock.state.session = null;
  sdkMock.state.createOptions = null;
  sdkMock.state.loaderOptions = null;
  sdkMock.state.findResult = { provider: 'sglang', id: 'qwen3.8-27b' };
  sdkMock.state.promptBehavior = async () => undefined;
});

describe('PiCodingAdapter', () => {
  it('runs a session and forwards the five lifecycle events to metrics', async () => {
    sdkMock.state.promptBehavior = async session => {
      session.emit({ type: 'agent_start' });
      session.emit({ type: 'turn_start' });
      session.emit({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: {} });
      session.emit({ type: 'tool_execution_end', toolCallId: 'c1', toolName: 'bash', result: {}, isError: false });
      session.emit({ type: 'tool_execution_start', toolCallId: 'c2', toolName: 'write', args: {} });
      session.emit({ type: 'tool_execution_end', toolCallId: 'c2', toolName: 'write', result: {}, isError: true });
      session.emit({ type: 'turn_end', message: {}, toolResults: [] });
      session.emit({ type: 'agent_end', messages: [], willRetry: false });
    };

    const adapter = new PiCodingAdapter(makeConfig());
    const result = await adapter.runSession({ prompt: 'build it', cwd: '/tmp/builds/demo' });

    expect(result.ok).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.sessionId).toBe('sess-123');
    expect(result.sessionFile).toBe('/tmp/pi-sessions/sess-123.jsonl');
    expect(result.stats).toMatchObject({ turns: 1, toolCalls: 2, toolErrors: 1 });

    const logged = metricsMock.logPiSessionEvent.mock.calls.map(c => c[0].event);
    expect(logged).toEqual(['agent_start', 'turn_start', 'tool_execution_end', 'tool_execution_end', 'turn_end', 'agent_end']);
    // tool_execution_start is tracked for durations but never logged
    expect(logged).not.toContain('tool_execution_start');
    const toolEnd = metricsMock.logPiSessionEvent.mock.calls.find(c => c[0].event === 'tool_execution_end')![0];
    expect(toolEnd.toolName).toBe('bash');
    expect(toolEnd.isError).toBe(false);
    expect(typeof toolEnd.durationMs).toBe('number');

    expect(metricsMock.logPiSession).toHaveBeenCalledTimes(1);
    expect(metricsMock.logPiSession.mock.calls[0][0]).toMatchObject({
      slug: 'demo',
      model: 'sglang/qwen3.8-27b',
      sessionFile: '/tmp/pi-sessions/sess-123.jsonl',
      ok: true,
      timedOut: false,
      turns: 1,
      toolCalls: 2,
      toolErrors: 1,
    });
    expect(sdkMock.state.session!.disposed).toBe(true);
    expect(sdkMock.state.session!.unsubscribed).toBe(true);
  });

  it('replicates the CLI flags: runtime api key, tools allowlist, noContextFiles', async () => {
    const adapter = new PiCodingAdapter(makeConfig({ tools: ['read', 'bash'] }));
    await adapter.runSession({ prompt: 'x', cwd: '/tmp/builds/demo' });

    expect(sdkMock.state.setRuntimeApiKey).toHaveBeenCalledWith('sglang', 'sglang');
    expect(sdkMock.state.createOptions).toMatchObject({ cwd: '/tmp/builds/demo', tools: ['read', 'bash'] });
    expect(sdkMock.state.loaderOptions).toMatchObject({ cwd: '/tmp/builds/demo', noContextFiles: true });
    expect(sdkMock.state.reload).toHaveBeenCalled();
  });

  it('aborts on timeout and reports timedOut', async () => {
    sdkMock.state.promptBehavior = session =>
      new Promise((_, reject) => {
        const orig = session.abort.bind(session);
        session.abort = () => { const p = orig(); reject(new Error('aborted')); return p; };
      });

    const adapter = new PiCodingAdapter(makeConfig({ timeout: 30 }));
    const result = await adapter.runSession({ prompt: 'x', cwd: '/tmp/builds/slow' });

    expect(result.timedOut).toBe(true);
    expect(result.ok).toBe(false);
    expect(sdkMock.state.session!.aborted).toBe(true);
    expect(sdkMock.state.session!.disposed).toBe(true);
    expect(metricsMock.logPiSession.mock.calls[0][0]).toMatchObject({ ok: false, timedOut: true });
  });

  it('captures prompt() rejection as error', async () => {
    sdkMock.state.promptBehavior = async () => { throw new Error('backend unreachable'); };
    const adapter = new PiCodingAdapter(makeConfig());
    const result = await adapter.runSession({ prompt: 'x', cwd: '/tmp/builds/demo' });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('backend unreachable');
  });

  it('surfaces post-acceptance model failures from agent state', async () => {
    sdkMock.state.promptBehavior = async session => {
      session.agent.state.errorMessage = 'stream error: 500';
    };
    const adapter = new PiCodingAdapter(makeConfig());
    const result = await adapter.runSession({ prompt: 'x', cwd: '/tmp/builds/demo' });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('stream error: 500');
  });

  it('throws CONFIG_INVALID when the model is not in the registry', async () => {
    sdkMock.state.findResult = null;
    const adapter = new PiCodingAdapter(makeConfig());
    await expect(adapter.runSession({ prompt: 'x', cwd: '/tmp/b' })).rejects.toSatisfy(
      err => err instanceof InvarailError && err.code === 'CONFIG_INVALID',
    );
  });

  it('throws CONFIG_INVALID on a malformed model ref', async () => {
    const adapter = new PiCodingAdapter(makeConfig({ model: 'no-provider' }));
    await expect(adapter.runSession({ prompt: 'x', cwd: '/tmp/b' })).rejects.toSatisfy(
      err => err instanceof InvarailError && err.code === 'CONFIG_INVALID',
    );
  });
});
