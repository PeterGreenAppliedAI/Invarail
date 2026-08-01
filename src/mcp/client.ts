import { spawn, type ChildProcess } from 'node:child_process';
import { mcpServerError } from '../errors.js';
import type { JsonRpcResponse, McpCallResult, McpToolDefinition } from './types.js';

const PROTOCOL_VERSION = '2025-03-26';
const HANDSHAKE_TIMEOUT_MS = 15_000;

export interface McpClientOptions {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Working directory for the spawned server — servers that resolve their own
   *  relative paths (config, child processes) need their repo root, not ours */
  cwd?: string;
  /** Per-request timeout (tool calls can be slow — Blender renders, etc.) */
  timeoutMs?: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Minimal MCP client: JSON-RPC 2.0 over newline-delimited stdio.
 * Speaks only the tools slice (initialize, tools/list, tools/call) — the
 * oldest, most stable part of the spec. Deliberately not the official SDK:
 * ~250 lines we fully own, our error factory and timeouts throughout.
 */
export class McpStdioClient {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private stdoutBuffer = '';
  private closed = false;

  constructor(private readonly opts: McpClientOptions) {}

  get serverName(): string {
    return this.opts.name;
  }

  get alive(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.closed;
  }

  /** Spawn the server process and complete the MCP handshake. */
  async connect(): Promise<void> {
    this.closed = false;
    const child = spawn(this.opts.command, this.opts.args ?? [], {
      env: { ...process.env, ...this.opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(this.opts.cwd ? { cwd: this.opts.cwd } : {}),
    });
    this.child = child;

    child.stdout!.on('data', (chunk: Buffer) => this.onStdout(chunk));
    child.stderr!.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) console.warn(`[MCP:${this.opts.name}] stderr: ${text.slice(0, 500)}`);
    });
    child.on('error', (err) => this.failAll(mcpServerError(this.opts.name, err)));
    child.on('exit', (code, signal) => {
      if (!this.closed) {
        console.warn(`[MCP:${this.opts.name}] process exited (code=${code}, signal=${signal})`);
      }
      this.failAll(mcpServerError(this.opts.name, new Error(`process exited (code=${code})`)));
      this.child = null;
    });

    await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'localclaw', version: '1.0' },
    }, HANDSHAKE_TIMEOUT_MS);
    this.notify('notifications/initialized');
  }

  async listTools(): Promise<McpToolDefinition[]> {
    const result = await this.request('tools/list', {}) as { tools?: McpToolDefinition[]; nextCursor?: string };
    if (result?.nextCursor) {
      // Pagination deferred until a real server actually pages — log so we notice
      console.warn(`[MCP:${this.opts.name}] tools/list returned nextCursor — additional pages ignored`);
    }
    return result?.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const result = await this.request('tools/call', { name, arguments: args }) as McpCallResult;
    return { content: result?.content ?? [], isError: result?.isError };
  }

  /** Kill the child and reject anything in flight. */
  close(): void {
    this.closed = true;
    this.failAll(mcpServerError(this.opts.name, new Error('client closed')));
    if (this.child) {
      this.child.kill();
      this.child = null;
    }
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    if (!this.child || this.child.exitCode !== null) {
      return Promise.reject(mcpServerError(this.opts.name, new Error('server process not running')));
    }
    const id = this.nextId++;
    const budget = timeoutMs ?? this.opts.timeoutMs ?? 60_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(mcpServerError(this.opts.name, new Error(`"${method}" timed out after ${budget}ms`)));
      }, budget);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  private notify(method: string, params?: Record<string, unknown>): void {
    this.send({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });
  }

  private send(message: Record<string, unknown>): void {
    this.child?.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  private onStdout(chunk: Buffer): void {
    this.stdoutBuffer += chunk.toString();
    let newline: number;
    while ((newline = this.stdoutBuffer.indexOf('\n')) !== -1) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let message: JsonRpcResponse;
      try {
        message = JSON.parse(line);
      } catch {
        // Some servers log plain text to stdout — skip, never crash on it
        console.warn(`[MCP:${this.opts.name}] non-JSON stdout line ignored: ${line.slice(0, 200)}`);
        continue;
      }
      this.onMessage(message);
    }
  }

  private onMessage(message: JsonRpcResponse): void {
    if (message.id === undefined || message.method) return; // server notification/request — ignored in v1
    const entry = this.pending.get(Number(message.id));
    if (!entry) return;
    this.pending.delete(Number(message.id));
    clearTimeout(entry.timer);
    if (message.error) {
      entry.reject(mcpServerError(this.opts.name, new Error(`${message.error.message} (code ${message.error.code})`)));
    } else {
      entry.resolve(message.result);
    }
  }

  private failAll(err: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }
}
