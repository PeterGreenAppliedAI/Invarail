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
