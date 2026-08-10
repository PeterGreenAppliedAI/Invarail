import type { InvarailConfig, AgentConfig } from '../config/types.js';

export function resolveAgentConfig(agentId: string, config: InvarailConfig): AgentConfig | undefined {
  return config.agents.list.find(a => a.id === agentId);
}

export function resolveWorkspacePath(agentId: string, config: InvarailConfig): string {
  const agent = resolveAgentConfig(agentId, config);
  if (agent?.workspace) {
    return agent.workspace.replace(/^~/, process.env.HOME ?? '/tmp');
  }
  return `data/workspaces/${agentId}`;
}
