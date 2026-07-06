export interface ToolContext {
  agentId: string;
  sessionKey: string;
  workspacePath?: string;
  senderId?: string;
  config?: Record<string, unknown>;
  /** Source channel — used by tools that behave differently per channel (e.g., browser remote bridge for extension) */
  channel?: string;
}

/** Structured parameter definition for Ollama tool calling */
export interface ToolParameter {
  type: string;
  description: string;
  enum?: string[];
}

export interface ToolParameterSchema {
  type: 'object';
  properties: Record<string, ToolParameter>;
  required?: string[];
}

/**
 * Autonomy metadata — where a tool sits on the autonomy ladder.
 * The ladder is keyed to reversibility + blast radius, and enforcement is
 * STRUCTURAL: dispatch derives confirm gating from `tier`, the model never
 * decides. Channel config can promote a tool per channel via autoApproveTools
 * (the promotion mechanism — earned with a logAutonomousAction track record).
 */
export interface ToolAutonomy {
  /** 'silent': reversible, internal. 'act_then_notify': low-risk, undoable.
   *  'propose_confirm': irreversible or visible to others — preview + user confirm. */
  tier: 'silent' | 'act_then_notify' | 'propose_confirm';
  reversible: boolean;
  /** Who the action can affect: 'self' (agent workspace), 'owner' (owner's data/devices), 'external' (other people see it) */
  blastRadius: 'self' | 'owner' | 'external';
}

export interface LocalClawTool {
  name: string;
  description: string;
  parameterDescription: string;
  /** Structured parameters for native tool calling. If omitted, falls back to text-based ReAct. */
  parameters?: ToolParameterSchema;
  /** Example usage shown in the system prompt to guide the model. */
  example?: string;
  category: string;
  /** Keywords that indicate when this tool is relevant — used for progressive disclosure to reduce token injection */
  relevanceHints?: string[];
  /** Autonomy ladder position. Tools with tier 'propose_confirm' are confirm-gated
   *  on every channel unless the channel's autoApproveTools promotes them. */
  autonomy?: ToolAutonomy;
  execute: (params: Record<string, unknown>, ctx: ToolContext) => Promise<string>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameterDescription: string;
  parameters?: ToolParameterSchema;
  example?: string;
}

export type ToolExecutor = (
  toolName: string,
  params: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<string>;
