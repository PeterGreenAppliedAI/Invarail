import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { detectVoice } from '../../src/setup/detect.js';

// A voice server on a port that is in NEITHER default list — like mlx-audio serving TTS on :8000,
// which the doctor reported as absent on every boot until the configured URL was probed (2026-10-01).
let server: Server;
let base = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}'); return; }
    res.writeHead(404); res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));

describe('detectVoice probes the configured server first', () => {
  it('finds a TTS server at the configured URL, even with an endpoint path and a non-default port', async () => {
    const v = await detectVoice('mac', { ttsUrl: `${base}/v1/audio/speech` });
    expect(v.tts.reachable).toBe(true);
    expect(v.tts.url).toBe(base);
  });

  it('the same server can answer for STT too', async () => {
    const v = await detectVoice('mac', { ttsUrl: base, sttUrl: `${base}/v1/audio/transcriptions` });
    expect(v.stt.reachable).toBe(true);
    expect(v.stt.url).toBe(base);
  });

  it('offline skips every probe', async () => {
    const v = await detectVoice('mac', { offline: true, ttsUrl: base });
    expect(v.tts.reachable).toBe(false);
  });
});
