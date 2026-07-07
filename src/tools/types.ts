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
  /** The one autonomy bit: does this tool ask the user first? True = confirm-gated
   *  on every channel (preview → pending-action ledger → "confirm") unless the
   *  channel's autoApproveTools promotes it. Default false. Rule of thumb: anything
   *  irreversible AND visible to other people asks first. Enforcement is structural
   *  (code gate in dispatch), never model judgment. */
  requiresConfirm?: boolean;
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
