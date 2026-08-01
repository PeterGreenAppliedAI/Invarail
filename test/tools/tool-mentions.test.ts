import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../src/tools/registry.js';
import type { LocalClawTool } from '../../src/tools/types.js';

function fakeTool(name: string, category: string): LocalClawTool {
  return { name, description: 'x', parameterDescription: 'x', category, execute: async () => 'ok' };
}

function makeRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  r.register(fakeTool('web_search', 'web'));
  r.register(fakeTool('flows_weekly_gather', 'mcp:flows'));
  r.register(fakeTool('document', 'exec'));
  return r;
}

const ALL = ['web_search', 'flows_weekly_gather', 'document'];

describe('findExplicitToolMentions', () => {
  it('matches a plainly named tool', () => {
    const r = makeRegistry();
    expect(r.findExplicitToolMentions('please use web_search for this', ALL)).toEqual(['web_search']);
  });

  it('matches the bare flow name for MCP-prefixed tools', () => {
    const r = makeRegistry();
    expect(r.findExplicitToolMentions('Use the weekly_gather tool to collect AI news', ALL))
      .toEqual(['flows_weekly_gather']);
  });

  it('matches the full prefixed name too', () => {
    const r = makeRegistry();
    expect(r.findExplicitToolMentions('call flows_weekly_gather now', ALL)).toEqual(['flows_weekly_gather']);
  });

  it('is case-insensitive and word-bounded', () => {
    const r = makeRegistry();
    expect(r.findExplicitToolMentions('WEB_SEARCH please', ALL)).toEqual(['web_search']);
    // substring inside a larger identifier must NOT match
    expect(r.findExplicitToolMentions('the myweb_searcher thing', ALL)).toEqual([]);
  });

  it('returns empty when nothing is named', () => {
    const r = makeRegistry();
    expect(r.findExplicitToolMentions('write me a short digest of AI news', ALL)).toEqual([]);
  });

  it('ignores candidates not in the provided allowed list', () => {
    const r = makeRegistry();
    expect(r.findExplicitToolMentions('use weekly_gather', ['web_search'])).toEqual([]);
  });
});
