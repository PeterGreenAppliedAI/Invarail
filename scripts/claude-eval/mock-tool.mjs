#!/usr/bin/env node
// Mock tool executor for the Claude-subagent exhibition run — serves the SAME
// canned observations as scripts/model-eval.ts and logs every call for grading.
// Usage: node mock-tool.mjs <call-log-file> <tool> '<json-params>'
import { appendFileSync } from 'node:fs';

const [, , logFile, tool, paramsRaw] = process.argv;
let params = {};
try { params = JSON.parse(paramsRaw ?? '{}'); } catch { /* log raw below */ }
appendFileSync(logFile, JSON.stringify({ tool, params }) + '\n');

const CLUE_CHAIN = {
  START:      { expectCode: '0000', next: 'LIGHTHOUSE', nextCode: 'R7K2' },
  LIGHTHOUSE: { expectCode: 'R7K2', next: 'ORCHARD',    nextCode: 'M3W9' },
  ORCHARD:    { expectCode: 'M3W9', next: 'MILL',       nextCode: 'T6B4' },
  MILL:       { expectCode: 'T6B4', next: 'HARBOR',     nextCode: 'J8N5' },
  HARBOR:     { expectCode: 'J8N5', next: 'CHAPEL',     nextCode: 'V2F7' },
  CHAPEL:     { expectCode: 'V2F7', next: 'QUARRY',     nextCode: 'L9D3' },
  QUARRY:     { expectCode: 'L9D3', next: 'BRIDGE',     nextCode: 'X4H8' },
  BRIDGE:     { expectCode: 'X4H8', next: 'FINAL',      nextCode: 'P5C6' },
  FINAL:      { expectCode: 'P5C6' },
};

switch (tool) {
  case 'get_weather':
    console.log(JSON.stringify({ city: params.city ?? 'unknown', temp_f: 61, temp_c: 16, conditions: 'cloudy', wind_mph: 8 }));
    break;
  case 'order_lookup':
    console.log(JSON.stringify({ orderId: params.orderId ?? 'unknown', status: 'shipped', carrier: 'UPS', tracking: '1Z999AA10123456784', eta: '2026-08-13', customerEmail: 'dana@example.com', customerName: 'Dana' }));
    break;
  case 'send_email':
    console.log(JSON.stringify({ ok: true, messageId: 'msg-20260811-001' }));
    break;
  case 'web_fetch':
    console.log('Error: HTTP 404 Not Found — the requested URL does not exist on this server.');
    break;
  case 'follow_clue': {
    const clueId = String(params.clueId ?? '').toUpperCase().trim();
    const code = String(params.code ?? '').toUpperCase().trim();
    const clue = CLUE_CHAIN[clueId];
    if (!clue) { console.log(`Error: unknown clue "${clueId}".`); break; }
    if (code !== clue.expectCode) { console.log(`Error: wrong access code for clue ${clueId}. The code comes from the previous clue's result.`); break; }
    if (!clue.next) { console.log(JSON.stringify({ done: true, treasure: 'AZIMUTH', message: 'You found the treasure!' })); break; }
    console.log(JSON.stringify({ clue: clueId, next: clue.next, code: clue.nextCode }));
    break;
  }
  default:
    console.log(`Error: Tool "${tool}" is not available.`);
}
