import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../src/tools/registry.js';
import type { LocalClawTool } from '../../src/tools/types.js';

function makeTool(name: string, autonomy?: LocalClawTool['autonomy']): LocalClawTool {
  return {
    name,
    description: 'test',
    parameterDescription: 'none',
    category: 'test',
    autonomy,
    execute: async () => 'ok',
  };
}

describe('ToolRegistry autonomy metadata', () => {
  it('collects propose_confirm tools as the structural confirm default', () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('send_message', { tier: 'propose_confirm', reversible: false, blastRadius: 'external' }));
    registry.register(makeTool('exec', { tier: 'act_then_notify', reversible: false, blastRadius: 'owner' }));
    registry.register(makeTool('web_search')); // no metadata

    const confirm = registry.getMetadataConfirmTools();
    expect(confirm.has('send_message')).toBe(true);
    expect(confirm.has('exec')).toBe(false);
    expect(confirm.has('web_search')).toBe(false);
  });

  it('registered production send_message tool declares propose_confirm', async () => {
    const { createSendMessageTool } = await import('../../src/tools/send-message.js');
    const tool = createSendMessageTool({ send: async () => {} } as any);
    expect(tool.autonomy?.tier).toBe('propose_confirm');
    expect(tool.autonomy?.blastRadius).toBe('external');
  });
});
