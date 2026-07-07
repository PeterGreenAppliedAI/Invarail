import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../src/tools/registry.js';
import type { LocalClawTool } from '../../src/tools/types.js';

function makeTool(name: string, requiresConfirm?: boolean): LocalClawTool {
  return {
    name,
    description: 'test',
    parameterDescription: 'none',
    category: 'test',
    requiresConfirm,
    execute: async () => 'ok',
  };
}

describe('ToolRegistry requiresConfirm metadata', () => {
  it('collects requiresConfirm tools as the structural confirm default', () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('send_message', true));
    registry.register(makeTool('exec'));
    registry.register(makeTool('web_search', false));

    const confirm = registry.getMetadataConfirmTools();
    expect(confirm.has('send_message')).toBe(true);
    expect(confirm.has('exec')).toBe(false);
    expect(confirm.has('web_search')).toBe(false);
  });

  it('registered production send_message tool asks first', async () => {
    const { createSendMessageTool } = await import('../../src/tools/send-message.js');
    const tool = createSendMessageTool({ send: async () => {} } as any);
    expect(tool.requiresConfirm).toBe(true);
  });
});
