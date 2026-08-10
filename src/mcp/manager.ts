import { McpStdioClient } from './client.js';
import { McpHttpClient } from './http-client.js';
import { getAccessToken } from './oauth.js';
import { saveAttachment } from '../services/attachments.js';
import type { McpServerConfig } from '../config/types.js';
import type { McpToolDefinition, McpCallResult } from './types.js';
import type { InvarailTool, ToolParameterSchema } from '../tools/types.js';

const MAX_DESCRIPTION_CHARS = 500;
const MAX_RESPAWN_ATTEMPTS = 3;
const RESPAWN_BACKOFF_MS = 5_000;

const PRIMITIVE_TYPES = new Set(['string', 'number', 'integer', 'boolean']);

/** Both transports expose the same surface — the manager never cares which. */
type McpTransportClient = McpStdioClient | McpHttpClient;

interface ServerState {
  config: McpServerConfig;
  client: McpTransportClient;
  tools: McpToolDefinition[];
  respawnAttempts: number;
  lastRespawnAt: number;
}

/**
 * Owns the lifecycle of configured MCP servers and translates their tools
 * into InvarailTool objects. A failing server never blocks boot (same
 * degrade-not-abort as the plugin loader); a crashed server is lazily
 * respawned on the next call (same pattern as the FalkorDB reconnect).
 */
export class McpManager {
  private servers = new Map<string, ServerState>();

  constructor(private readonly configs: McpServerConfig[]) {}

  async start(): Promise<void> {
    for (const config of this.configs) {
      if (!config.enabled) continue;
      try {
        const state = await this.connectServer(config);
        this.servers.set(config.name, state);
        console.log(`[MCP] Connected "${config.name}" — ${state.tools.length} tool(s)`);
      } catch (err) {
        console.warn(`[MCP] Server "${config.name}" failed to start (skipped):`, err instanceof Error ? err.message : err);
      }
    }
  }

  async stop(): Promise<void> {
    for (const state of this.servers.values()) {
      state.client.close();
    }
    this.servers.clear();
  }

  private async connectServer(config: McpServerConfig): Promise<ServerState> {
    const client: McpTransportClient = config.transport === 'http'
      ? new McpHttpClient({
          name: config.name,
          url: config.url!,
          timeoutMs: config.timeoutMs,
          // Silent refresh only — background paths never open a browser;
          // first-time auth runs via scripts/mcp-oauth-setup.ts
          getToken: config.oauth ? () => getAccessToken(config.name) : undefined,
        })
      : new McpStdioClient({
          name: config.name,
          command: config.command!,
          args: config.args,
          env: config.env,
          cwd: config.cwd,
          timeoutMs: config.timeoutMs,
        });
    await client.connect();
    const tools = await client.listTools();
    return { config, client, tools, respawnAttempts: 0, lastRespawnAt: 0 };
  }

  private async ensureAlive(state: ServerState): Promise<void> {
    if (state.client.alive) return;
    if (state.respawnAttempts >= MAX_RESPAWN_ATTEMPTS) {
      throw new Error(`server "${state.config.name}" is down (${MAX_RESPAWN_ATTEMPTS} respawn attempts failed)`);
    }
    const wait = state.lastRespawnAt + RESPAWN_BACKOFF_MS - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    state.respawnAttempts++;
    state.lastRespawnAt = Date.now();
    console.log(`[MCP] Respawning "${state.config.name}" (attempt ${state.respawnAttempts}/${MAX_RESPAWN_ATTEMPTS})`);
    const fresh = await this.connectServer(state.config);
    state.client = fresh.client;
    state.tools = fresh.tools;
    state.respawnAttempts = 0;
  }

  async callTool(serverName: string, toolName: string, params: Record<string, unknown>): Promise<string> {
    const state = this.servers.get(serverName);
    if (!state) return `Error: MCP server "${serverName}" is not connected.`;
    try {
      await this.ensureAlive(state);
      const result = await state.client.callTool(toolName, params);
      return this.renderResult(serverName, toolName, result);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  }

  /** Map MCP content parts to the string world of Invarail tool results. */
  private renderResult(serverName: string, toolName: string, result: McpCallResult): string {
    const parts: string[] = [];
    const fileTokens: string[] = [];
    for (const item of result.content) {
      if (item.type === 'text' && item.text) {
        parts.push(item.text);
      } else if (item.type === 'image' && item.data) {
        const saved = this.saveImage(serverName, toolName, item.data, item.mimeType ?? 'image/png');
        if (saved) fileTokens.push(`[FILE:${saved}]`);
      } else {
        parts.push(`(unsupported ${item.type} content omitted)`);
      }
    }
    const text = parts.join('\n').trim();
    const body = result.isError
      ? `Error: ${text || 'MCP tool reported an error with no message'}`
      : text || '(no content returned)';
    // [FILE:] tokens ride at the end — engine strips them from the observation
    // and re-appends after the final answer for channel media delivery
    return fileTokens.length ? `${body}\n${fileTokens.join('\n')}` : body;
  }

  private saveImage(serverName: string, toolName: string, base64: string, mimeType: string): string | null {
    try {
      const data = Buffer.from(base64, 'base64');
      const ext = mimeType.split('/')[1]?.split('+')[0] ?? 'png';
      const saved = saveAttachment(
        { filename: `${toolName}.${ext}`, mimeType, size: data.length, data },
        'mcp',
        `${serverName}_${Date.now()}`,
      );
      return saved?.localPath ?? null;
    } catch (err) {
      console.warn(`[MCP:${serverName}] Failed to save image content:`, err instanceof Error ? err.message : err);
      return null;
    }
  }

  /** Translate every connected server's MCP tools into InvarailTool objects. */
  buildTools(): InvarailTool[] {
    const tools: InvarailTool[] = [];
    const taken = new Set<string>();
    for (const state of this.servers.values()) {
      const { config } = state;
      const prefix = config.toolPrefix ?? `${config.name}_`;
      for (const def of state.tools) {
        if (config.toolAllowlist && !config.toolAllowlist.includes(def.name)) continue;
        tools.push(this.translateTool(state, def, prefix, taken));
      }
      if (config.toolAllowlist) {
        const dropped = state.tools.length - state.tools.filter(t => config.toolAllowlist!.includes(t.name)).length;
        if (dropped > 0) console.log(`[MCP] "${config.name}": allowlist dropped ${dropped} tool(s)`);
      }
    }
    return tools;
  }

  private translateTool(state: ServerState, def: McpToolDefinition, prefix: string, taken: Set<string>): InvarailTool {
    const { config } = state;
    const readOnly = def.annotations?.readOnlyHint === true
      || config.readOnlyTools.includes(def.name);
    const description = config.toolDescriptions[def.name]
      ?? capDescription(def.description ?? `MCP tool "${def.name}" from server "${config.name}".`);
    const parameters = translateInputSchema(def.inputSchema);
    const name = sanitizeToolName(prefix, def.name, taken);
    if (name !== `${prefix}${def.name}`) {
      console.log(`[MCP] Tool name sanitized: "${prefix}${def.name}" → "${name}"`);
    }

    return {
      name,
      description,
      parameterDescription: buildParameterDescription(def.inputSchema),
      ...(parameters ? { parameters } : {}),
      // "mcp:<server>" doubles as the expansion token a specialist's tools
      // list can use to include this server's whole toolset
      category: `mcp:${config.name}`,
      // External process executing real actions — confirm-gated unless the
      // server marks it read-only or the owner set trust:'auto' in config
      requiresConfirm: !readOnly && config.trust !== 'auto',
      ...(config.maxResultChars ? { resultLimit: config.maxResultChars } : {}),
      // Small models pad arguments (DeepSeek invented {"input":""} for a
      // zero-param flow, Aug 1) and strict downstreams rightly fail-closed on
      // unknown params — the bridge filters to the declared schema before
      // calling. Accommodation is our layer's job, not the server's.
      execute: (params) => this.callTool(config.name, def.name, filterToSchema(params, def.inputSchema)),
    };
  }
}

/** Drop params the tool's inputSchema doesn't declare. A schema with no
 *  declared properties takes an empty call. Schemaless tools pass through. */
export function filterToSchema(
  params: Record<string, unknown>,
  schema: McpToolDefinition['inputSchema'],
): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') return params;
  const props = (schema as { properties?: Record<string, unknown> }).properties;
  const declared = props && typeof props === 'object' ? Object.keys(props) : [];
  const filtered: Record<string, unknown> = {};
  for (const key of Object.keys(params)) {
    if (declared.includes(key)) filtered[key] = params[key];
  }
  const dropped = Object.keys(params).filter(k => !declared.includes(k));
  if (dropped.length > 0) {
    console.log(`[MCP] Dropped undeclared param(s) [${dropped.join(', ')}] — schema declares [${declared.join(', ') || 'none'}]`);
  }
  return filtered;
}

/**
 * The OpenAI-compatible path enforces tool names matching [A-Za-z0-9_-]{1,64}
 * — MCP servers can use dots/slashes/anything and unsanitized names break
 * tool-calling on the vLLM route. Sanitize, truncate KEEPING the prefix
 * (server identity must survive so channel security stays name-addressable),
 * and dedupe collisions with a numeric suffix.
 */
export function sanitizeToolName(prefix: string, toolName: string, taken: Set<string>): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/_{2,}/g, '_').replace(/^_+|_+$/g, '');
  const cleanPrefix = clean(prefix);
  const base = cleanPrefix ? `${cleanPrefix}_${clean(toolName)}` : clean(toolName);
  let name = base.slice(0, 64) || 'mcp_tool';
  let suffix = 2;
  while (taken.has(name)) {
    const tag = `_${suffix++}`;
    name = `${base.slice(0, 64 - tag.length)}${tag}`;
  }
  taken.add(name);
  return name;
}

/** Cap verbose frontier-model-oriented descriptions at a sentence boundary for 7-30B models. */
export function capDescription(text: string, max = MAX_DESCRIPTION_CHARS): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const head = clean.slice(0, max);
  const lastSentence = Math.max(head.lastIndexOf('. '), head.lastIndexOf('.\n'), head.lastIndexOf('! '), head.lastIndexOf('? '));
  return lastSentence > max * 0.4 ? head.slice(0, lastSentence + 1) : `${head.trimEnd()}…`;
}

/** MCP inputSchema (JSON Schema) → ToolParameterSchema. Primitives pass through;
 *  nested objects/arrays keep their type with a JSON hint in the description. */
export function translateInputSchema(schema: McpToolDefinition['inputSchema']): ToolParameterSchema | undefined {
  if (!schema?.properties || Object.keys(schema.properties).length === 0) return undefined;
  const properties: ToolParameterSchema['properties'] = {};
  for (const [name, raw] of Object.entries(schema.properties)) {
    const type = typeof raw.type === 'string' ? raw.type : 'string';
    const description = typeof raw.description === 'string' ? capDescription(raw.description, 200) : '';
    properties[name] = {
      type,
      description: PRIMITIVE_TYPES.has(type) ? description : `${description} (pass as JSON ${type})`.trim(),
      ...(Array.isArray(raw.enum) ? { enum: raw.enum.map(String) } : {}),
    };
  }
  return {
    type: 'object',
    properties,
    ...(schema.required?.length ? { required: schema.required } : {}),
  };
}

/** Text rendering of the schema for toolStyle:'text' models. */
export function buildParameterDescription(schema: McpToolDefinition['inputSchema']): string {
  if (!schema?.properties || Object.keys(schema.properties).length === 0) return 'No parameters.';
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties)
    .map(([name, raw]) => {
      const type = typeof raw.type === 'string' ? raw.type : 'string';
      const desc = typeof raw.description === 'string' ? capDescription(raw.description, 150) : '';
      return `${name} (${type}${required.has(name) ? ', required' : ''}): ${desc}`;
    })
    .join(' | ');
}
