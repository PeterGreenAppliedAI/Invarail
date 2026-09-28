import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { configInvalid } from '../../errors.js';
import { join, extname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ChannelAdapter,
  ChannelAdapterConfig,
  ChannelStatus,
  InboundMessage,
  MessageTarget,
  MessageContent,
} from '../types.js';
import { channelConnectError, channelSendError } from '../../errors.js';
import type { ConsoleApiDeps } from '../../console/types.js';
import { handleConsoleRequest, originRefused } from '../../console/api.js';
import { resolveWebIdentity } from '../../security/web-identity.js';

// The standalone hold-to-talk page (voice-ui.html) was read here at IMPORT time and never
// served — the console owns voice now — and the read was what made the production bundle
// throw ENOENT on import (F20). Gone; the file stays in src as a reference page.

// Resolve console/dist path relative to project root
const PROJECT_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..', '..');
const CONSOLE_DIST = join(PROJECT_ROOT, 'console', 'dist');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/**
 * Simple HTTP REST API adapter for testing.
 * POST /api/message → dispatch → response
 * Also serves the management console at /console/
 */
export class WebApiAdapter implements ChannelAdapter {
  readonly id = 'web';
  private server: Server | null = null;
  private handler: ((msg: InboundMessage) => Promise<void>) | null = null;
  private currentStatus: ChannelStatus = 'disconnected';
  private pendingResponses = new Map<string, (content: MessageContent) => void>();
  private apiKey: string | undefined;
  private allowedOrigins: string[] = [];
  private consoleDeps: ConsoleApiDeps | null = null;

  /** Inject console API dependencies after orchestrator is fully initialized */
  injectDeps(deps: ConsoleApiDeps): void {
    this.consoleDeps = deps;
    console.log('[Web] Console API deps injected');
  }

  async connect(config: ChannelAdapterConfig): Promise<void> {
    const port = typeof config.port === 'number' ? config.port : 3100;
    const host = typeof config.host === 'string' ? config.host : '0.0.0.0';
    this.apiKey = config.token;
    this.allowedOrigins = Array.isArray(config.allowedOrigins) ? (config.allowedOrigins as string[]) : [];
    this.currentStatus = 'connecting';

    // A token key whose value resolved to '' (unset ${WEB_TOKEN}) LOOKS configured while
    // the API is open — fail loudly instead (re-review, 2026-09-27). And a non-loopback
    // bind with no token at all is refused unless the operator opts in explicitly.
    if (config.token === '') {
      throw configInvalid('channels.web.token resolved to an empty string — set WEB_TOKEN in .env (or remove the token line and bind 127.0.0.1)');
    }
    const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
    if (!this.apiKey && !loopback && config.insecureOpen !== true) {
      throw configInvalid(`channels.web binds ${host} with no token — anyone on the network (or any web page open on it) could act as the owner. Set "token", bind "host: 127.0.0.1", or set "insecureOpen: true" deliberately.`);
    }

    this.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? '';

      // Console API — delegate to console handler
      if (url.startsWith('/console/api/') && this.consoleDeps) {
        const handled = await handleConsoleRequest(req, res, this.consoleDeps, this.apiKey, this.allowedOrigins);
        if (handled) return;
      }

      // Console static files
      if (url.startsWith('/console')) {
        this.serveConsole(req, res);
        return;
      }

      // Redirect root to console
      if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
        res.writeHead(302, { 'Location': '/console' });
        res.end();
        return;
      }

      if (req.method === 'POST' && url.startsWith('/api/voice')) {
        if (originRefused(req, this.allowedOrigins)) { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Cross-origin request refused' })); return; }
        if (!this.checkAuth(req, res)) return;
        await this.handleVoiceMessage(req, res);
      } else if (req.method === 'POST' && url === '/api/message') {
        if (originRefused(req, this.allowedOrigins)) { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Cross-origin request refused' })); return; }
        if (!this.checkAuth(req, res)) return;
        await this.handleHttpMessage(req, res);
      } else if (req.method === 'GET' && url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(port, host, () => {
        this.currentStatus = 'connected';
        console.log(`[Web] API listening on http://${host}:${port}`);
        if (!this.apiKey && host === '0.0.0.0') {
          console.warn('[Web] ⚠️  WARNING: Web API is network-accessible with NO authentication token.');
          console.warn('[Web]    Anyone on your network can send commands via /api/message or /console/api/chat.');
          console.warn('[Web]    Set "token" in your web channel config to require Bearer auth.');
        }
        resolve();
      });
      this.server!.on('error', reject);
    });
  }

  async disconnect(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }
    this.currentStatus = 'disconnected';
  }

  onMessage(handler: (msg: InboundMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async send(target: MessageTarget, content: MessageContent): Promise<void> {
    const resolve = this.pendingResponses.get(target.replyToId ?? '');
    if (resolve) {
      resolve(content);
      this.pendingResponses.delete(target.replyToId ?? '');
    }
  }

  status(): ChannelStatus {
    return this.currentStatus;
  }

  /** Serve static files from console/dist/ or SPA fallback to index.html */
  private serveConsole(_req: IncomingMessage, res: ServerResponse): void {
    // Strip /console prefix and query string
    let filePath = (_req.url ?? '').split('?')[0].slice('/console'.length);
    if (!filePath || filePath === '/') filePath = '/index.html';

    const fullPath = join(CONSOLE_DIST, filePath);

    // Security: prevent path traversal
    const relPath = relative(CONSOLE_DIST, fullPath);
    if (relPath.startsWith('..') || isAbsolute(relPath)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    try {
      if (existsSync(fullPath) && statSync(fullPath).isFile()) {
        const ext = extname(fullPath);
        const mime = MIME_TYPES[ext] ?? 'application/octet-stream';
        const data = readFileSync(fullPath);
        res.writeHead(200, { 'Content-Type': mime });
        res.end(data);
      } else {
        // SPA fallback — serve index.html for all non-file routes
        const indexPath = join(CONSOLE_DIST, 'index.html');
        if (existsSync(indexPath)) {
          const data = readFileSync(indexPath);
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(data);
        } else {
          res.writeHead(404);
          res.end('Console not built. Run: cd console && npm run build');
        }
      }
    } catch {
      res.writeHead(500);
      res.end('Internal server error');
    }
  }

  /** Return true if auth passes, false if response was sent with 401 */
  private checkAuth(req: IncomingMessage, res: ServerResponse): boolean {
    if (!this.apiKey) return true; // no key configured — open access
    const auth = req.headers['authorization'];
    if (auth === `Bearer ${this.apiKey}`) return true;
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return false;
  }

  private async handleVoiceMessage(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    const audioBuffer = Buffer.concat(chunks);

    if (audioBuffer.length < 1000) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Audio too short' }));
      return;
    }

    const mimeType = req.headers['content-type'] ?? 'audio/webm';
    const msgId = `web-voice-${Date.now()}`;

    // A claimed senderId partitions the session; with a token the principal is the owner (F07/F08).
    const urlObj = new URL(req.url ?? '', `http://${req.headers.host}`);
    const identity = resolveWebIdentity({ config: this.consoleDeps?.config, claimed: urlObj.searchParams.get('senderId'), channelId: 'web', fallback: 'web-user' });
    const senderId = identity.senderId;
    console.log(`[Web] Voice message from ${senderId} (${audioBuffer.length} bytes, ${mimeType})`);

    // SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    // SSE keepalive: send a comment every 15s to prevent browser/proxy timeouts
    const keepalive = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 15_000);

    const responsePromise = new Promise<MessageContent>((resolve) => {
      this.pendingResponses.set(msgId, resolve);
      setTimeout(() => {
        if (this.pendingResponses.has(msgId)) {
          this.pendingResponses.delete(msgId);
          resolve({ text: 'Request timed out' });
        }
      }, 300_000);
    });

    const inbound: InboundMessage = {
      id: msgId,
      channel: 'web',
      content: '',
      senderId,
      channelId: 'web',
      timestamp: new Date(),
      audio: { data: audioBuffer, mimeType },
      onProgress(stage: string, data?: Record<string, unknown>) {
        const payload = { stage, ...data };
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      },
    };

    if (this.handler) {
      this.handler(inbound).catch((err) => {
        console.warn('[Web] Voice handler error:', err instanceof Error ? err.message : err);
      });
    }

    const response = await responsePromise;
    clearInterval(keepalive);

    const donePayload: Record<string, unknown> = {
      stage: 'done',
      response: response.text,
    };
    if (response.audio) {
      donePayload.audio = {
        data: response.audio.data.toString('base64'),
        mimeType: response.audio.mimeType,
      };
    }
    res.write(`data: ${JSON.stringify(donePayload)}\n\n`);
    res.end();
  }

  private async handleHttpMessage(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }

    let parsed: { message: string; senderId?: string };
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    if (!parsed.message) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing "message" field' }));
      return;
    }

    const msgId = `web-${Date.now()}`;

    const responsePromise = new Promise<MessageContent>((resolve) => {
      this.pendingResponses.set(msgId, resolve);
      // Timeout after 2 minutes
      setTimeout(() => {
        if (this.pendingResponses.has(msgId)) {
          this.pendingResponses.delete(msgId);
          resolve({ text: 'Request timed out' });
        }
      }, 300_000);
    });

    const identity = resolveWebIdentity({ config: this.consoleDeps?.config, claimed: parsed.senderId, channelId: 'web', fallback: 'web-user' });
    const inbound: InboundMessage = {
      id: msgId,
      channel: 'web',
      content: parsed.message,
      senderId: identity.senderId,
      channelId: identity.channelId,
      timestamp: new Date(),
    };

    if (this.handler) {
      this.handler(inbound).catch((err) => {
        console.warn('[Web] Message handler error:', err instanceof Error ? err.message : err);
      });
    }

    const response = await responsePromise;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const responseBody: Record<string, unknown> = { response: response.text };
    if (response.audio) {
      responseBody.audio = {
        data: response.audio.data.toString('base64'),
        mimeType: response.audio.mimeType,
      };
    }
    res.end(JSON.stringify(responseBody));
  }
}
