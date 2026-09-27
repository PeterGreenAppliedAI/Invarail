import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchMessage } from '../../src/dispatch.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { loadConfig } from '../../src/config/loader.js';
import { bootstrapWorkspace } from '../../src/agents/workspace.js';
import type { OllamaClient } from '../../src/ollama/client.js';

/** Bare chat under each profile: what workspace files reach the system prompt. */
async function systemPromptFor(profile: 'full' | 'small', contextLevel?: 'full'): Promise<string> {
  const ws = mkdtempSync(join(tmpdir(), 'profile-'));
  bootstrapWorkspace(ws, 'Test');
  writeFileSync(join(ws, 'TOOLS.md'), '# TOOLS.md\n\nTOOLS_MARKER ' + 'x'.repeat(6000));
  writeFileSync(join(ws, 'USER.md'), '# USER.md\n\nUSER_MARKER likes brevity.');
  const seen: Array<{ role: string; content: string }> = [];
  const client = {
    generate: vi.fn().mockResolvedValue({ response: 'chat' }),
    chat: vi.fn().mockImplementation(async (p: { messages: Array<{ role: string; content: string }> }) => { seen.push(...p.messages); return { message: { role: 'assistant', content: 'hi', tool_calls: null } }; }),
    listModels: vi.fn().mockResolvedValue([]), isAvailable: vi.fn().mockResolvedValue(true),
  } as unknown as OllamaClient;
  const config = loadConfig('/tmp/nonexistent-config.json5');
  config.promptProfile = profile;
  config.agents = { default: 'main', list: [{ id: 'main', name: 'Test', workspace: ws }], bindings: [] } as typeof config.agents;
  config.specialists.chat = { model: 'm', maxTokens: 512, temperature: 0.5, maxIterations: 1, tools: [], ...(contextLevel ? { contextLevel } : {}) } as typeof config.specialists.chat;
  await dispatchMessage({ client, registry: new ToolRegistry(), config, message: 'hello', agentId: 'main', sessionKey: `s-${profile}-${contextLevel ?? ''}` });
  return seen.filter(m => m.role === 'system').map(m => m.content).join('\n');
}

describe('promptProfile', () => {
  it('full: bare chat carries TOOLS.md and USER.md', async () => {
    const sys = await systemPromptFor('full');
    expect(sys).toMatch(/TOOLS_MARKER/);
    expect(sys).toMatch(/USER_MARKER/);
  });

  it('small: bare chat gets the minimal set (SOUL/IDENTITY/LEARNINGS) — no TOOLS.md, no USER.md', async () => {
    const sys = await systemPromptFor('small');
    expect(sys).toMatch(/SOUL\.md/);
    expect(sys).not.toMatch(/TOOLS_MARKER/);
    expect(sys).not.toMatch(/USER_MARKER/);
  });

  it('small: a specialist that says contextLevel: full still gets the full set', async () => {
    const sys = await systemPromptFor('small', 'full');
    expect(sys).toMatch(/TOOLS_MARKER/);
  });

  it('defaults to full', () => {
    expect(loadConfig('/tmp/nonexistent-config.json5').promptProfile).toBe('full');
  });
});
