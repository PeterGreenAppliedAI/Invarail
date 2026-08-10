import { mcpServerError } from '../errors.js';
import type { JsonRpcResponse, McpCallResult, McpToolDefinition } from './types.js';

const PROTOCOL_VERSION = '2025-03-26';

export interface McpHttpClientOptions {
  name: string;
  url: string;
  timeoutMs?: number;
  /** Returns the Authorization bearer token (fresh — caller handles refresh),
   *  or null for unauthenticated servers. */
  getToken?: () => Promise<string | null>;
}

/**
 * Streamable-HTTP MCP transport — same surface as McpStdioClient so
 * McpManager treats both identically. Each request is one POST; the server
 * answers with application/json or an SSE stream (both handled). The
 * Mcp-Session-Id header from initialize is echoed on every later call.
 */
export class McpHttpClient {
  private sessionId: string | null = null;
  private connected = false;
  private requestId = 1;

  constructor(private readonly opts: McpHttpClientOptions) {}

  get serverName(): string {
    return this.opts.name;
  }

  get alive(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    const result = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'invarail', version: '1.0' },
    });
    void result;
    await this.notify('notifications/initialized');
    this.connected = true;
  }

  async listTools(): Promise<McpToolDefinition[]> {
    const result = await this.request('tools/list', {}) as { tools?: McpToolDefinition[]; nextCursor?: string };
    if (result?.nextCursor) {
      console.warn(`[MCP:${this.opts.name}] tools/list returned nextCursor — additional pages ignored`);
    }
    return result?.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const result = await this.request('tools/call', { name, arguments: args }) as McpCallResult;
    return { content: result?.content ?? [], isError: result?.isError };
  }

  close(): void {
    this.connected = false;
    this.sessionId = null;
  }

  private async headers(): Promise<Record<string, string>> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (this.sessionId) h['Mcp-Session-Id'] = this.sessionId;
    const token = await this.opts.getToken?.();
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  }

  private async notify(method: string): Promise<void> {
    try {
      await fetch(this.opts.url, {
        method: 'POST',
        headers: await this.headers(),
        body: JSON.stringify({ jsonrpc: '2.0', method }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 60_000),
      });
    } catch { /* notifications are fire-and-forget */ }
  }

  private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.requestId++;
    let res: Response;
    try {
      res = await fetch(this.opts.url, {
        method: 'POST',
        headers: await this.headers(),
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 60_000),
      });
    } catch (err) {
      this.connected = false;
      throw mcpServerError(this.opts.name, err);
    }

    if (res.status === 401) {
      this.connected = false;
      throw mcpServerError(this.opts.name, new Error('401 unauthorized — run `npx tsx scripts/mcp-oauth-setup.ts ' + this.opts.name + '` to (re)authorize'));
    }
    if (!res.ok) {
      throw mcpServerError(this.opts.name, new Error(`HTTP ${res.status} on ${method}`));
    }

    const newSession = res.headers.get('mcp-session-id');
    if (newSession) this.sessionId = newSession;

    const contentType = res.headers.get('content-type') ?? '';
    const message = contentType.includes('text/event-stream')
      ? this.lastJsonRpcFromSse(await res.text(), id)
      : (await res.json()) as JsonRpcResponse;

    if (!message) throw mcpServerError(this.opts.name, new Error(`empty SSE response on ${method}`));
    if (message.error) throw mcpServerError(this.opts.name, new Error(`${message.error.message} (code ${message.error.code})`));
    return message.result;
  }

  /** Streamable HTTP may deliver progress events before the final response —
   *  take the LAST data: event whose id matches our request. */
  private lastJsonRpcFromSse(body: string, id: number): JsonRpcResponse | null {
    let final: JsonRpcResponse | null = null;
    for (const line of body.split('\n')) {
      if (!line.startsWith('data:')) continue;
      try {
        const parsed = JSON.parse(line.slice(5).trim()) as JsonRpcResponse;
        if (parsed.id === id || parsed.id === String(id)) final = parsed;
      } catch { /* keepalive/comment lines */ }
    }
    return final;
  }
}
