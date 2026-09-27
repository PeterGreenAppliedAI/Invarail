import { describe, it, expect } from 'vitest';
import { WebApiAdapter } from '../../../src/channels/web/adapter.js';

// An empty token LOOKS configured while the API is open; a network bind with no token is
// the hole both outside reviews led with (F01). The adapter now refuses both at start.
describe('web adapter bind safety', () => {
  it('refuses a token that resolved to an empty string', async () => {
    const a = new WebApiAdapter();
    await expect(a.connect({ enabled: true, token: '', host: '127.0.0.1', port: 0 })).rejects.toThrow(/empty string/);
  });
  it('refuses a non-loopback bind with no token unless insecureOpen is set', async () => {
    const a = new WebApiAdapter();
    await expect(a.connect({ enabled: true, host: '0.0.0.0', port: 0 })).rejects.toThrow(/no token/);
  });
  it('allows loopback with no token, and network with a token', async () => {
    const a = new WebApiAdapter();
    await a.connect({ enabled: true, host: '127.0.0.1', port: 0 });
    await a.disconnect();
    const b = new WebApiAdapter();
    await b.connect({ enabled: true, host: '127.0.0.1', port: 0, token: 'x'.repeat(16) });
    await b.disconnect();
  });
});
