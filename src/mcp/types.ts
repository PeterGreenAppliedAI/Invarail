/** The tools slice of the MCP protocol — the only part Invarail speaks. */

export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpToolDefinition {
  name: string;
  description?: string;
  /** JSON Schema for the tool's arguments (MCP servers always send type: "object") */
  inputSchema?: {
    type?: string;
    properties?: Record<string, Record<string, unknown>>;
    required?: string[];
  };
  annotations?: McpToolAnnotations;
}

export interface McpContent {
  type: string; // 'text' | 'image' | 'audio' | 'resource'
  text?: string;
  /** base64 payload for image/audio content */
  data?: string;
  mimeType?: string;
}

export interface McpCallResult {
  content: McpContent[];
  isError?: boolean;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  /** present on notifications/requests FROM the server (ignored in v1) */
  method?: string;
}
