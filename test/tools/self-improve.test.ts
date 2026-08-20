import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSelfImproveTool } from '../../src/tools/self-improve.js';
import { ProposalHistory } from '../../src/coding/improvement-proposals.js';
import type { SelfModService } from '../../src/coding/self-mod-service.js';
import type { ChannelRegistry } from '../../src/channels/registry.js';
import type { ToolContext } from '../../src/tools/types.js';

describe('self_improve ledger tool', () => {
  let dir: string;
  let history: ProposalHistory;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sip-tool-'));
    history = new ProposalHistory(join(dir, 'h.jsonl'), join(dir, 'c.json'), join(dir, 'm.jsonl'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function makeTool(proposeImpl: () => Promise<{ ok: boolean; reply: string }>) {
    const propose = vi.fn(proposeImpl);
    const send = vi.fn(async () => undefined);
    const tool = createSelfImproveTool({
      service: { propose } as unknown as SelfModService,
      channelRegistry: { send } as unknown as ChannelRegistry,
      history,
    });
    return { tool, propose, send };
  }

  it('is grant-ineligible and confirm-gated by construction', () => {
    const { tool } = makeTool(async () => ({ ok: true, reply: 'r' }));
    expect(tool.requiresConfirm).toBe(true);
    expect((tool as { targetArgs?: string[] }).targetArgs).toBeUndefined();
  });

  it('fires propose with the confirming principal, reports to the recorded delivery target', async () => {
    const { tool, propose, send } = makeTool(async () => ({ ok: true, reply: 'gate passed — confirm abc123' }));
    const out = await tool.execute(
      { spec: 'Fix web_fetch redirect handling.', signature: 'web_fetch:403', notifyChannel: 'discord', notifyTarget: '999' },
      { agentId: 'main', sessionKey: 's', senderId: 'peter-principal' } as ToolContext,
    );
    expect(out).toContain('Started');
    expect(out).toContain('web_fetch');
    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    expect(propose).toHaveBeenCalledWith('Fix web_fetch redirect handling.', 'peter-principal', 'discord');
    expect(send.mock.calls[0][0]).toEqual({ channel: 'discord', channelId: '999' });
    expect(send.mock.calls[0][1]).toEqual({ text: 'gate passed — confirm abc123' });
    expect(history.bySignature().get('web_fetch:403')?.outcome).toBe('confirmed');
  });

  it('propose failure reports the error instead of vanishing', async () => {
    const { tool, send } = makeTool(async () => { throw new Error('worktree exploded'); });
    await tool.execute(
      { spec: 'Fix exec.', signature: 'exec:x', notifyChannel: 'discord', notifyTarget: '999' },
      { agentId: 'main', sessionKey: 's', senderId: 'p' } as ToolContext,
    );
    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    expect(String(send.mock.calls[0][1].text)).toContain('worktree exploded');
  });

  it('missing spec is a plain error, nothing fired', async () => {
    const { tool, propose } = makeTool(async () => ({ ok: true, reply: 'r' }));
    const out = await tool.execute({}, { agentId: 'm', sessionKey: 's' } as ToolContext);
    expect(out).toContain('Error');
    expect(propose).not.toHaveBeenCalled();
  });
});
