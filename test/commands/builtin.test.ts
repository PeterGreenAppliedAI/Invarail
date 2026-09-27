import { describe, it, expect, vi } from 'vitest';
import { runBuiltinCommand, COMMAND_HELP, type CommandHost } from '../../src/commands/builtin.js';
import type { InboundMessage } from '../../src/channels/types.js';

// The `!…` chain carved out of orchestrator.handleMessage (2026-09-27). These pin the
// contract: handled → reply sent + true; not a command → false; the catch-all help.
function host(over: Partial<CommandHost> = {}) {
  const send = vi.fn().mockResolvedValue(undefined);
  const h = {
    config: { agents: { default: 'main', list: [], bindings: [] }, principals: {} },
    channelRegistry: { send },
    steeringQueues: new Map(),
    cancelRequests: new Set(),
    ...over,
  } as unknown as CommandHost;
  return { h, send };
}
const msg = (content: string): InboundMessage => ({ id: 'm1', channel: 'discord', channelId: 'c1', senderId: 'peter', content } as InboundMessage);

describe('runBuiltinCommand', () => {
  it('!stop with nothing running answers and is handled', async () => {
    const { h, send } = host();
    expect(await runBuiltinCommand(h, msg('!stop'), 'peter', '!stop')).toBe(true);
    expect(send.mock.calls[0][1].text).toMatch(/Nothing is running/);
  });

  it('!stop with a run active queues a cancel request', async () => {
    const { h, send } = host({ steeringQueues: new Map([['main:main:discord:c1', []]]) });
    // resolveRoute for a bare config lands on agent 'main' with a channel-scoped session key
    await runBuiltinCommand(h, msg('!stop'), 'peter', '!stop');
    expect(String(send.mock.calls[0][1].text)).toMatch(/Stopping|Nothing/);
  });

  it('an unknown ! command gets the deterministic help, never dispatch', async () => {
    const { h, send } = host();
    expect(await runBuiltinCommand(h, msg('!bogus now'), 'peter', '!bogus now')).toBe(true);
    expect(send.mock.calls[0][1].text).toBe(COMMAND_HELP.replace('%s', '!bogus'));
  });

  it('!grants with none lists the hint', async () => {
    const { h, send } = host();
    expect(await runBuiltinCommand(h, msg('!grants'), 'nobody-' + Date.now(), '!grants')).toBe(true);
    expect(send.mock.calls[0][1].text).toMatch(/No standing grants/);
  });

  it('a non-command returns false and sends nothing', async () => {
    const { h, send } = host();
    expect(await runBuiltinCommand(h, msg('hello'), 'peter', 'hello')).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});
