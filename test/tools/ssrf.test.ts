import { describe, it, expect } from 'vitest';
import { isPrivateIpAddress, isBlockedHostname } from '../../src/tools/ssrf.js';

describe('isPrivateIpAddress', () => {
  it('blocks 127.0.0.1 (loopback)', () => {
    expect(isPrivateIpAddress('127.0.0.1')).toBe(true);
  });

  it('blocks 10.x.x.x (private)', () => {
    expect(isPrivateIpAddress('10.0.0.1')).toBe(true);
    expect(isPrivateIpAddress('10.255.255.255')).toBe(true);
  });

  it('blocks 192.168.x.x (private)', () => {
    expect(isPrivateIpAddress('192.168.1.1')).toBe(true);
  });

  it('blocks 172.16-31.x.x (private)', () => {
    expect(isPrivateIpAddress('172.16.0.1')).toBe(true);
    expect(isPrivateIpAddress('172.31.255.255')).toBe(true);
    expect(isPrivateIpAddress('172.15.0.1')).toBe(false);
    expect(isPrivateIpAddress('172.32.0.1')).toBe(false);
  });

  it('blocks 169.254.x.x (link-local)', () => {
    expect(isPrivateIpAddress('169.254.1.1')).toBe(true);
  });

  it('blocks 0.x.x.x', () => {
    expect(isPrivateIpAddress('0.0.0.0')).toBe(true);
  });

  it('blocks CGN range 100.64-127.x.x', () => {
    expect(isPrivateIpAddress('100.64.0.1')).toBe(true);
    expect(isPrivateIpAddress('100.127.255.255')).toBe(true);
    expect(isPrivateIpAddress('100.63.0.1')).toBe(false);
    expect(isPrivateIpAddress('100.128.0.1')).toBe(false);
  });

  it('allows public IPs', () => {
    expect(isPrivateIpAddress('8.8.8.8')).toBe(false);
    expect(isPrivateIpAddress('1.1.1.1')).toBe(false);
    expect(isPrivateIpAddress('142.250.80.46')).toBe(false);
  });

  it('blocks IPv6 loopback', () => {
    expect(isPrivateIpAddress('::1')).toBe(true);
    expect(isPrivateIpAddress('::')).toBe(true);
  });

  it('blocks IPv6 link-local', () => {
    expect(isPrivateIpAddress('fe80::1')).toBe(true);
  });

  it('blocks IPv6 unique local', () => {
    expect(isPrivateIpAddress('fc00::1')).toBe(true);
    expect(isPrivateIpAddress('fd12::1')).toBe(true);
  });

  it('blocks IPv4-mapped IPv6', () => {
    expect(isPrivateIpAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateIpAddress('::ffff:10.0.0.1')).toBe(true);
    expect(isPrivateIpAddress('::ffff:8.8.8.8')).toBe(false);
  });
});

describe('isBlockedHostname', () => {
  it('blocks localhost', () => {
    expect(isBlockedHostname('localhost')).toBe(true);
  });

  it('blocks metadata.google.internal', () => {
    expect(isBlockedHostname('metadata.google.internal')).toBe(true);
  });

  it('blocks .localhost suffix', () => {
    expect(isBlockedHostname('evil.localhost')).toBe(true);
  });

  it('blocks .local suffix', () => {
    expect(isBlockedHostname('myserver.local')).toBe(true);
  });

  it('blocks .internal suffix', () => {
    expect(isBlockedHostname('api.internal')).toBe(true);
  });

  it('allows public hostnames', () => {
    expect(isBlockedHostname('google.com')).toBe(false);
    expect(isBlockedHostname('api.example.com')).toBe(false);
  });
});

describe('IP notation edge cases', () => {
  // Octal/hex IP notation could bypass regex-based checks
  // Node.js URL parser normalizes these differently across versions

  it('blocks standard loopback variations', () => {
    expect(isPrivateIpAddress('127.0.0.1')).toBe(true);
    expect(isPrivateIpAddress('127.0.0.0')).toBe(true);
    expect(isPrivateIpAddress('127.255.255.255')).toBe(true);
  });

  it('blocks 0.0.0.0 (all interfaces)', () => {
    expect(isPrivateIpAddress('0.0.0.0')).toBe(true);
  });

  it('blocks link-local (169.254.x.x)', () => {
    expect(isPrivateIpAddress('169.254.1.1')).toBe(true);
    expect(isPrivateIpAddress('169.254.169.254')).toBe(true); // AWS metadata
  });

  it('blocks CGNAT range (100.64-127.x.x)', () => {
    expect(isPrivateIpAddress('100.64.0.1')).toBe(true);
    expect(isPrivateIpAddress('100.127.255.255')).toBe(true);
    // Just outside CGNAT
    expect(isPrivateIpAddress('100.63.255.255')).toBe(false);
    expect(isPrivateIpAddress('100.128.0.0')).toBe(false);
  });
});

describe('IPv6 with an embedded IPv4 — every spelling (review F11, 2026-09-27)', async () => {
  const { ipv6EmbeddedIpv4, assertPublicUrl } = await import('../../src/tools/ssrf.js');
  it('extracts the IPv4 from mapped and compatible forms', () => {
    expect(ipv6EmbeddedIpv4('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(ipv6EmbeddedIpv4('::ffff:7f00:1')).toBe('127.0.0.1');          // WHATWG canonical form
    expect(ipv6EmbeddedIpv4('0:0:0:0:0:ffff:7f00:1')).toBe('127.0.0.1');
    expect(ipv6EmbeddedIpv4('0000:0000:0000:0000:0000:ffff:c0a8:0101')).toBe('192.168.1.1');
    expect(ipv6EmbeddedIpv4('[::ffff:a00:1]')).toBe('10.0.0.1');
    expect(ipv6EmbeddedIpv4('::7f00:1')).toBe('127.0.0.1');               // IPv4-compatible
    expect(ipv6EmbeddedIpv4('::ffff:808:808')).toBe('8.8.8.8');
  });
  it('leaves ::, ::1 and ordinary IPv6 alone', () => {
    expect(ipv6EmbeddedIpv4('::')).toBeNull();
    expect(ipv6EmbeddedIpv4('::1')).toBeNull();
    expect(ipv6EmbeddedIpv4('2001:db8::1')).toBeNull();
    expect(ipv6EmbeddedIpv4('fe80::1')).toBeNull();
  });
  it('classifies the canonical mapped loopback as private and the mapped public address as public', () => {
    expect(isPrivateIpAddress('::ffff:7f00:1')).toBe(true);
    expect(isPrivateIpAddress('0:0:0:0:0:ffff:c0a8:1')).toBe(true);
    expect(isPrivateIpAddress('::ffff:808:808')).toBe(false);
  });
  it('assertPublicUrl rejects the canonical mapped loopback that the dotted-only regex let through', async () => {
    await expect(assertPublicUrl('http://[::ffff:7f00:1]/')).rejects.toThrow();
    await expect(assertPublicUrl('http://[::ffff:127.0.0.1]/')).rejects.toThrow();
  });
});
