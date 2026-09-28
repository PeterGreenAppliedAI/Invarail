import { describe, it, expect } from 'vitest';
import { corsOriginFor } from '../../src/console/api.js';

// Was Access-Control-Allow-Origin: * for every origin (outside review F01, 2026-09-27).
describe('corsOriginFor', () => {
  it('echoes the Chrome extension origin without configuration', () => {
    expect(corsOriginFor('chrome-extension://abcdefgh', [])).toBe('chrome-extension://abcdefgh');
  });
  it('echoes an origin only when it is listed exactly', () => {
    expect(corsOriginFor('http://10.9.8.50:3100', ['http://10.9.8.50:3100'])).toBe('http://10.9.8.50:3100');
    expect(corsOriginFor('http://evil.example', ['http://10.9.8.50:3100'])).toBeNull();
    expect(corsOriginFor('http://10.9.8.50:3100', [])).toBeNull();
  });
  it('no Origin header → no CORS headers (same-origin console needs none)', () => {
    expect(corsOriginFor(undefined, ['http://x'])).toBeNull();
  });
});

import { originRefused } from '../../src/console/api.js';
import type { IncomingMessage } from 'node:http';

// Third review T02: withholding CORS headers never stopped the request from being processed.
describe('originRefused — cross-site mutations are refused before the body is read', () => {
  const req = (method: string, headers: Record<string, string>) => ({ method, headers } as unknown as IncomingMessage);
  it('a POST from an unlisted origin is refused; GET never is', () => {
    expect(originRefused(req('POST', { origin: 'https://attacker.example', host: '127.0.0.1:3100' }), [])).toBe(true);
    expect(originRefused(req('DELETE', { origin: 'https://attacker.example', host: '127.0.0.1:3100' }), [])).toBe(true);
    expect(originRefused(req('GET', { origin: 'https://attacker.example', host: '127.0.0.1:3100' }), [])).toBe(false);
  });
  it('same-origin (the console UI), a listed origin, the extension, and no Origin at all all pass', () => {
    expect(originRefused(req('POST', { origin: 'http://127.0.0.1:3100', host: '127.0.0.1:3100' }), [])).toBe(false);
    expect(originRefused(req('POST', { origin: 'http://10.9.8.50:3100', host: '10.9.8.50:3100' }), [])).toBe(false);
    expect(originRefused(req('POST', { origin: 'https://phone.example', host: '10.9.8.50:3100' }), ['https://phone.example'])).toBe(false);
    expect(originRefused(req('POST', { origin: 'chrome-extension://abc', host: '127.0.0.1:3100' }), [])).toBe(false);
    expect(originRefused(req('POST', { host: '127.0.0.1:3100' }), [])).toBe(false);
  });
  it('an unparsable Origin is refused', () => {
    expect(originRefused(req('POST', { origin: 'not a url', host: '127.0.0.1:3100' }), [])).toBe(true);
  });
});
