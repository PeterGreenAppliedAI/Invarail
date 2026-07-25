#!/usr/bin/env node
// Minimal streamable-HTTP MCP server for integration-testing McpHttpClient.
// Answers initialize (JSON + Mcp-Session-Id header), tools/list (JSON), and
// tools/call: `echo` as plain JSON, `sse_op` as an SSE stream with a progress
// event before the final response. `--require-auth` demands a Bearer token.

import { createServer } from 'node:http';

const requireAuth = process.argv.includes('--require-auth');
const SESSION = 'sess-' + Math.random().toString(36).slice(2, 8);

const TOOLS = [
  { name: 'echo', description: 'Echo args.', inputSchema: { type: 'object', properties: { text: { type: 'string', description: 't' } } }, annotations: { readOnlyHint: true } },
  { name: 'sse_op', description: 'Streams.', inputSchema: { type: 'object', properties: {} } },
];

const server = createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    if (requireAuth && req.headers.authorization !== 'Bearer good-token') {
      res.writeHead(401).end();
      return;
    }
    let rpc;
    try { rpc = JSON.parse(body); } catch { res.writeHead(400).end(); return; }

    if (rpc.method === 'initialize') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': SESSION });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fake-http', version: '0' } } }));
      return;
    }
    if (rpc.method === 'notifications/initialized') {
      res.writeHead(202).end();
      return;
    }
    // Session echo check: post-initialize calls must carry the session id
    if (req.headers['mcp-session-id'] !== SESSION) {
      res.writeHead(400).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32000, message: 'missing session' } }));
      return;
    }
    if (rpc.method === 'tools/list') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { tools: TOOLS } }));
      return;
    }
    if (rpc.method === 'tools/call' && rpc.params.name === 'sse_op') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":50}}\n\n');
      res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: 'streamed done' }] } })}\n\n`);
      res.end();
      return;
    }
    if (rpc.method === 'tools/call') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: `echo:${JSON.stringify(rpc.params.arguments)}` }] } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'unknown method' } }));
  });
});

server.listen(0, '127.0.0.1', () => {
  console.log(`PORT=${server.address().port}`);
});
