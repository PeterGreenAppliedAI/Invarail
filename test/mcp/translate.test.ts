import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { McpManager, capDescription, filterToSchema, translateInputSchema, buildParameterDescription, sanitizeToolName } from '../../src/mcp/manager.js';
import { McpServerConfigSchema } from '../../src/config/schema.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import type { McpServerConfig } from '../../src/config/types.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-server.mjs');

function serverConfig(overrides: Record<string, unknown> = {}): McpServerConfig {
  return McpServerConfigSchema.parse({
    name: 'fake',
    command: process.execPath,
    args: [FIXTURE],
    timeoutMs: 2000,
    ...overrides,
  });
}

describe('sanitizeToolName', () => {
  it('passes clean names through with the server prefix', () => {
    expect(sanitizeToolName('fake_', 'get_info', new Set())).toBe('fake_get_info');
  });

  it('replaces illegal characters (dots, slashes, @) with underscores', () => {
    expect(sanitizeToolName('srv_', 'tools/name@v2.1', new Set())).toBe('srv_tools_name_v2_1');
  });

  it('truncates to 64 chars keeping the prefix', () => {
    const name = sanitizeToolName('myserver_', 'x'.repeat(100), new Set());
    expect(name.length).toBe(64);
    expect(name.startsWith('myserver_')).toBe(true);
  });

  it('dedupes collisions with a numeric suffix', () => {
    const taken = new Set<string>();
    expect(sanitizeToolName('s_', 'do.thing', taken)).toBe('s_do_thing');
    expect(sanitizeToolName('s_', 'do/thing', taken)).toBe('s_do_thing_2');
    expect(sanitizeToolName('s_', 'do@thing', taken)).toBe('s_do_thing_3');
  });

  it('collision suffix still fits inside 64 chars', () => {
    const taken = new Set<string>();
    const first = sanitizeToolName('p_', 'y'.repeat(100), taken);
    const second = sanitizeToolName('p_', 'y'.repeat(100) + 'z', taken);
    expect(second.length).toBeLessThanOrEqual(64);
    expect(second).not.toBe(first);
    expect(second.endsWith('_2')).toBe(true);
  });

  it('never returns an empty name', () => {
    expect(sanitizeToolName('', '///', new Set())).toBe('mcp_tool');
  });
});

describe('capDescription', () => {
  it('leaves short text unchanged and collapses whitespace', () => {
    expect(capDescription('Short  and\n sweet.')).toBe('Short and sweet.');
  });

  it('cuts long text at a sentence boundary', () => {
    const long = `${'First sentence here. '.repeat(30)}`;
    const capped = capDescription(long, 100);
    expect(capped.length).toBeLessThanOrEqual(100);
    expect(capped.endsWith('.')).toBe(true);
  });

  it('falls back to hard cap with ellipsis when no sentence boundary exists', () => {
    const capped = capDescription('x'.repeat(600), 100);
    expect(capped.length).toBeLessThanOrEqual(101);
    expect(capped.endsWith('…')).toBe(true);
  });
});

describe('translateInputSchema', () => {
  it('passes primitives and enums through, marks nested types as JSON', () => {
    const result = translateInputSchema({
      type: 'object',
      properties: {
        detail: { type: 'string', description: 'Level', enum: ['low', 'high'] },
        count: { type: 'number', description: 'How many' },
        options: { type: 'object', description: 'Extra' },
      },
      required: ['detail'],
    })!;
    expect(result.properties.detail.enum).toEqual(['low', 'high']);
    expect(result.properties.count.type).toBe('number');
    expect(result.properties.options.description).toContain('(pass as JSON object)');
    expect(result.required).toEqual(['detail']);
  });

  it('returns undefined for empty schemas (text-mode fallback)', () => {
    expect(translateInputSchema(undefined)).toBeUndefined();
    expect(translateInputSchema({ type: 'object', properties: {} })).toBeUndefined();
  });
});

describe('buildParameterDescription', () => {
  it('renders a text description with required markers', () => {
    const text = buildParameterDescription({
      type: 'object',
      properties: { name: { type: 'string', description: 'Thing name' } },
      required: ['name'],
    });
    expect(text).toBe('name (string, required): Thing name');
  });
});

describe('MCP tool translation (against real fixture server)', () => {
  let manager: McpManager;
  afterEach(async () => manager?.stop());

  it('readOnlyHint → silent; mutations → requiresConfirm; trust auto waives', async () => {
    manager = new McpManager([serverConfig()]);
    await manager.start();
    const tools = manager.buildTools();
    expect(tools.find(t => t.name === 'fake_get_info')!.requiresConfirm).toBe(false);
    expect(tools.find(t => t.name === 'fake_mutate_thing')!.requiresConfirm).toBe(true);
    await manager.stop();

    manager = new McpManager([serverConfig({ trust: 'auto' })]);
    await manager.start();
    const trusted = manager.buildTools();
    expect(trusted.find(t => t.name === 'fake_mutate_thing')!.requiresConfirm).toBe(false);
  });

  it('registry metadata confirm set picks up MCP write tools', async () => {
    manager = new McpManager([serverConfig()]);
    await manager.start();
    const registry = new ToolRegistry();
    for (const tool of manager.buildTools()) registry.register(tool);
    const confirmSet = registry.getMetadataConfirmTools();
    expect(confirmSet.has('fake_mutate_thing')).toBe(true);
    expect(confirmSet.has('fake_get_info')).toBe(false);
  });

  it('specialist tool lists expand mcp:<server> tokens to real tool names', async () => {
    manager = new McpManager([serverConfig()]);
    await manager.start();
    const registry = new ToolRegistry();
    for (const tool of manager.buildTools()) registry.register(tool);
    expect(registry.expandToolNames(['mcp:fake'])).toEqual(['fake_get_info', 'fake_mutate_thing']);
    expect(registry.expandToolNames(['reason', 'mcp:fake'])).toEqual(['reason', 'fake_get_info', 'fake_mutate_thing']);
    expect(registry.expandToolNames(['mcp:ghost'])).toEqual([]);
  });

  it('applies allowlist, prefix override, description override, and resultLimit', async () => {
    manager = new McpManager([serverConfig({
      toolAllowlist: ['get_info'],
      toolPrefix: 'blender_',
      toolDescriptions: { get_info: 'Curated short description.' },
      maxResultChars: 8000,
    })]);
    await manager.start();
    const tools = manager.buildTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('blender_get_info');
    expect(tools[0].description).toBe('Curated short description.');
    expect(tools[0].resultLimit).toBe(8000);
  });

  it('caps verbose upstream descriptions at a sentence boundary', async () => {
    manager = new McpManager([serverConfig()]);
    await manager.start();
    const info = manager.buildTools().find(t => t.name === 'fake_get_info')!;
    expect(info.description.length).toBeLessThanOrEqual(500);
    expect(info.description).toContain('Returns scene info.');
  });

  it('saves image content and appends a [FILE:] token', async () => {
    manager = new McpManager([serverConfig()]);
    await manager.start();
    const result = await manager.callTool('fake', 'screenshot', {});
    expect(result).toContain('here is your screenshot');
    expect(result).toMatch(/\[FILE:.*screenshot\.png\]/);
  });
});

describe('filterToSchema', () => {
  it('drops params the schema does not declare (zero-param tool)', () => {
    expect(filterToSchema({ input: '' }, { type: 'object', properties: {} })).toEqual({});
    expect(filterToSchema({ input: 'gather' }, { type: 'object' })).toEqual({});
  });

  it('keeps declared params, drops extras', () => {
    const schema = { type: 'object', properties: { limit: { type: 'number' } } };
    expect(filterToSchema({ limit: 5, input: 'x' }, schema)).toEqual({ limit: 5 });
  });

  it('passes through when tool has no schema', () => {
    expect(filterToSchema({ anything: 1 }, undefined as never)).toEqual({ anything: 1 });
  });
});
