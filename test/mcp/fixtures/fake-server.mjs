#!/usr/bin/env node
// Minimal MCP server speaking newline-delimited JSON-RPC 2.0 over stdio.
// Used to integration-test the REAL McpStdioClient against a REAL child process.
// Modes (argv): --crash-after-init  exit(1) right after the handshake
//               --log-noise         print a plain-text line to stdout before responding

import { createInterface } from 'node:readline';

const crashAfterInit = process.argv.includes('--crash-after-init');
const logNoise = process.argv.includes('--log-noise');

const TOOLS = [
  {
    name: 'get_info',
    description: 'Returns scene info. This is a read-only inspection tool with a fairly long description that goes on and on to exercise description capping in the translation layer. It keeps going. And going some more.',
    inputSchema: {
      type: 'object',
      properties: {
        detail: { type: 'string', description: 'Level of detail', enum: ['low', 'high'] },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'mutate_thing',
    description: 'Mutates the thing.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Thing name' },
        count: { type: 'number', description: 'How many' },
        options: { type: 'object', description: 'Extra options' },
      },
      required: ['name'],
    },
  },
];

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  if (req.method === 'initialize') {
    if (logNoise) process.stdout.write('fake-server booting up (plain text noise)\n');
    send({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '0' } } });
    if (crashAfterInit) setTimeout(() => process.exit(1), 50);
    return;
  }
  if (req.method === 'notifications/initialized') return;
  if (req.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: req.id, result: { tools: TOOLS } });
    return;
  }
  if (req.method === 'tools/call') {
    const { name, arguments: args } = req.params;
    if (name === 'slow_op') return; // never answers — exercises the timeout
    if (name === 'boom') {
      send({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: 'thing exploded' }], isError: true } });
      return;
    }
    if (name === 'screenshot') {
      send({ jsonrpc: '2.0', id: req.id, result: { content: [
        { type: 'text', text: 'here is your screenshot' },
        { type: 'image', data: Buffer.from('fakepng').toString('base64'), mimeType: 'image/png' },
      ] } });
      return;
    }
    if (name === 'rpc_error') {
      send({ jsonrpc: '2.0', id: req.id, error: { code: -32602, message: 'bad params' } });
      return;
    }
    send({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: `echo:${JSON.stringify(args)}` }] } });
    return;
  }
  send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: `unknown method ${req.method}` } });
});
