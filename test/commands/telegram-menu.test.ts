import { describe, it, expect } from 'vitest';
import { buildTelegramMenu } from '../../src/commands/builtin.js';
import type { InboundMessage } from '../../src/channels/types.js';
import type { Orchestrator } from '../../src/orchestrator.js';
import type { InvarailConfig } from '../../src/config/types.js';

const OWNER = '111';
const NON_OWNER = '222';

// buildTelegramMenu takes the orchestrator only for getToolRegistry(), so a stub is enough.
const stub = (tools: string[]): Orchestrator =>
  ({ getToolRegistry: () => ({ list: () => tools }) }) as unknown as Orchestrator;

const config = {
  ownerId: OWNER,
  principals: {},
  specialists: {
    chat: { tools: ['read_file', 'write_file', 'owner_shell'] },
    exec: { tools: ['run_code'] },
  },
  inference: { backends: [{ url: 'http://192.168.0.5:8080', models: ['qwen'] }] },
  channels: {
    telegram: { enabled: true, security: { ownerOnlyTools: ['owner_shell'] } },
  },
} as unknown as InvarailConfig;

const msg = (senderId: string): InboundMessage =>
  ({ id: 'm1', channel: 'telegram', channelId: 'c1', senderId, content: '/tools' }) as InboundMessage;

// Authz reply from the real registry — the repo rule (CLAUDE.md → Testing) is that auth logic
// ships with tests. buildTelegramMenu answers /tools and /status without a model turn; the owner
// sees the full registry and backend LAN URLs, everyone else must never see them.
describe('buildTelegramMenu authz (owner vs non-owner)', () => {
  it('/tools for the owner lists the Registry line and owner-only tools', async () => {
    const menu = buildTelegramMenu(stub(['read_file', 'write_file', 'run_code', 'owner_shell']), config);
    const out = await menu.tools!(msg(OWNER));
    expect(out).toContain('Registry:');
    expect(out).toContain('owner_shell');
  });

  it('/tools for a non-owner never lists an owner-only tool nor the Registry line', async () => {
    const menu = buildTelegramMenu(stub(['read_file', 'write_file', 'run_code', 'owner_shell']), config);
    const out = await menu.tools!(msg(NON_OWNER));
    expect(out).not.toContain('owner_shell');
    expect(out).not.toContain('Registry:');
    expect(out).toMatch(/owner-only tools hidden/);
  });

  it('/status for the owner includes backend URLs', async () => {
    const menu = buildTelegramMenu(stub(['read_file']), config);
    const out = await menu.status!(msg(OWNER));
    expect(out).toContain('http://192.168.0.5:8080');
  });

  it('/status for a non-owner never leaks a backend URL', async () => {
    const menu = buildTelegramMenu(stub(['read_file']), config);
    const out = await menu.status!(msg(NON_OWNER));
    expect(out).not.toContain('http://');
    expect(out).not.toContain('192.168.0.5');
  });
});
