import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleConfirmation } from '../../src/security/confirm-handler.js';
import { PendingActionStore } from '../../src/security/pending-actions.js';
import type { LocalClawConfig } from '../../src/config/types.js';
import type { ToolRegistry } from '../../src/tools/registry.js';

const config = {
  principals: { peter: { aliases: ['discord-1', 'telegram-1'] } },
  agents: { default: 'main', list: [], bindings: [] },
} as unknown as LocalClawConfig;

function makeRegistry(result = 'sent!'): ToolRegistry {
  return {
    createScopedExecutor: () => vi.fn().mockResolvedValue(result),
  } as unknown as ToolRegistry;
}

let store: PendingActionStore;
beforeEach(() => {
  store = new PendingActionStore(join(mkdtempSync(join(tmpdir(), 'confirm-')), 'pending.json'));
});

const baseCtx = {
  channel: 'discord',
  config,
  toolRegistry: makeRegistry(),
  store,
};

function record(overrides: Record<string, unknown> = {}, ttlMs?: number) {
  return store.record({
    tool: 'send_message',
    params: { text: 'hi' },
    sender: 'peter',
    channel: 'discord',
    agentId: 'main',
    sessionKey: 'main:discord:peter',
    ...overrides,
  } as any, ttlMs);
}

describe('handleConfirmation', () => {
  it('ignores non-confirmation messages', async () => {
    const out = await handleConfirmation({ ...baseCtx, store, message: 'what is the weather', senderId: 'discord-1' });
    expect(out.handled).toBe(false);
  });

  it('bare confirm with nothing pending falls through as normal chat', async () => {
    const out = await handleConfirmation({ ...baseCtx, store, message: 'go ahead', senderId: 'discord-1' });
    expect(out.handled).toBe(false);
  });

  it('executes a recent pending action on bare confirm — principal-resolved from any alias', async () => {
    record();
    const out = await handleConfirmation({ ...baseCtx, store, message: 'confirm', senderId: 'telegram-1' });
    expect(out.handled).toBe(true);
    expect(out.reply).toContain('✅ Ran **send_message**');
    expect(store.listFor('peter')).toHaveLength(0); // consumed
  });

  it('id-targeted confirm executes the exact entry', async () => {
    record();
    const second = record({ params: { text: 'second' } });
    const out = await handleConfirmation({ ...baseCtx, store, message: `confirm ${second.id}`, senderId: 'discord-1' });
    expect(out.handled).toBe(true);
    expect(store.listFor('peter')).toHaveLength(1); // the other one remains
  });

  it('near-miss ("confirm 2") gets an error with the open list, never chat fall-through', async () => {
    const entry = record();
    const out = await handleConfirmation({ ...baseCtx, store, message: 'confirm 2', senderId: 'discord-1' });
    expect(out.handled).toBe(true);
    expect(out.reply).toContain("doesn't match");
    expect(out.reply).toContain(entry.id);
    expect(store.listFor('peter')).toHaveLength(1); // nothing consumed
  });

  it('tool failure reports the error and still consumes the entry', async () => {
    record();
    const registry = {
      createScopedExecutor: () => vi.fn().mockRejectedValue(new Error('channel offline')),
    } as unknown as ToolRegistry;
    const out = await handleConfirmation({ ...baseCtx, store, toolRegistry: registry, message: 'confirm', senderId: 'discord-1' });
    expect(out.reply).toContain('❌');
    expect(out.reply).toContain('channel offline');
    expect(store.listFor('peter')).toHaveLength(0);
  });
});
