import { describe, it, expect } from 'vitest';
import { checkToolPolicy } from '../../src/security/tool-policy.js';
import type { InvarailConfig } from '../../src/config/types.js';
import type { ToolRegistry } from '../../src/tools/registry.js';

const config = {
  ownerId: 'peter',
  principals: { peter: { aliases: ['discord-1'] } },
  channels: { discord: { enabled: true, security: { trustedUsers: ['peter', 'ally'], ownerOnlyTools: ['exec'], blockedTools: ['image_generate'], restrictedTools: ['write_file'] } } },
  specialists: { chat: { tools: [] }, exec: { tools: ['exec', 'read_file', 'write_file', 'mcp:flows'] } },
} as unknown as InvarailConfig;
const registry = { expandToolNames: (names: string[]) => names.flatMap(n => n === 'mcp:flows' ? ['flows_weekly_gather'] : [n]) } as unknown as ToolRegistry;

describe('checkToolPolicy — one answer for channel + specialist policy', () => {
  it('owner may run an owner-only tool in its specialist', () => {
    expect(checkToolPolicy(config, registry, { tool: 'exec', category: 'exec', channel: 'discord', senderId: 'peter' })).toEqual({ allowed: true });
  });
  it('non-owner is denied an owner-only tool even with a confirmation in hand', () => {
    const v = checkToolPolicy(config, registry, { tool: 'exec', category: 'exec', channel: 'discord', senderId: 'guest' });
    expect(v.allowed).toBe(false);
    expect((v as any).reason).toMatch(/owner-only/);
  });
  it('blocked tools are denied for everyone; restricted tools only for untrusted', () => {
    expect(checkToolPolicy(config, registry, { tool: 'image_generate', channel: 'discord', senderId: 'peter' }).allowed).toBe(false);
    expect(checkToolPolicy(config, registry, { tool: 'write_file', category: 'exec', channel: 'discord', senderId: 'ally' }).allowed).toBe(true);
    expect(checkToolPolicy(config, registry, { tool: 'write_file', category: 'exec', channel: 'discord', senderId: 'stranger' }).allowed).toBe(false);
  });
  it('a tool outside the specialist\'s (expanded) tool set is denied; an MCP-expanded one passes', () => {
    expect(checkToolPolicy(config, registry, { tool: 'send_message', category: 'chat', channel: 'discord', senderId: 'peter' }).allowed).toBe(false);
    expect(checkToolPolicy(config, registry, { tool: 'flows_weekly_gather', category: 'exec', channel: 'discord', senderId: 'peter' }).allowed).toBe(true);
  });
  it('raw channel id counts for owner and trust lists', () => {
    expect(checkToolPolicy(config, registry, { tool: 'exec', category: 'exec', channel: 'discord', senderId: 'peter', rawSenderId: 'discord-1' }).allowed).toBe(true);
  });
});
