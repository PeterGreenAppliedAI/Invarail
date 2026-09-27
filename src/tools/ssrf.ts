import { lookup } from 'node:dns/promises';
import { ssrfBlocked } from '../errors.js';

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.google.internal.',
  '169.254.169.254',
]);

const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal'];

/** Only allow http: and https: schemes */
const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

export function isPrivateIpAddress(ip: string): boolean {
  // IPv4 private ranges
  if (/^0\./.test(ip)) return true;
  if (/^10\./.test(ip)) return true;
  if (/^127\./.test(ip)) return true;
  if (/^169\.254\./.test(ip)) return true;
  if (/^192\.168\./.test(ip)) return true;
  // 172.16.0.0 – 172.31.255.255
  const m172 = ip.match(/^172\.(\d+)\./);
  if (m172 && Number(m172[1]) >= 16 && Number(m172[1]) <= 31) return true;
  // CGN: 100.64.0.0 – 100.127.255.255
  const m100 = ip.match(/^100\.(\d+)\./);
  if (m100 && Number(m100[1]) >= 64 && Number(m100[1]) <= 127) return true;

  // IPv6 loopback and private
  const lower = ip.toLowerCase().replace(/^\[|\]$/g, ''); // strip brackets
  if (lower === '::1' || lower === '::') return true;
  if (/^fe80:/i.test(lower)) return true;   // link-local
  if (/^fec0:/i.test(lower)) return true;   // site-local (deprecated)
  if (/^f[cd]/i.test(lower)) return true;   // unique local (fc00::/7)
  if (/^ff/i.test(lower)) return true;      // multicast

  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) addresses, in ANY
  // spelling. WHATWG URL parsing canonicalizes `::ffff:127.0.0.1` to `::ffff:7f00:1`,
  // which a dotted-only regex accepted as public (outside review F11, 2026-09-27).
  const embedded = ipv6EmbeddedIpv4(lower);
  if (embedded) return isPrivateIpAddress(embedded);

  return false;
}

/** If `ip` is an IPv6 address whose low 32 bits carry an IPv4 address under the
 *  ::ffff:0:0/96 (mapped) or ::/96 (compatible) prefix, return that IPv4 in dotted
 *  form — whatever spelling was used (compressed, expanded, hex or dotted tail). */
export function ipv6EmbeddedIpv4(ip: string): string | null {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (!s.includes(':')) return null;
  // A dotted tail becomes two hex groups so the whole thing expands uniformly.
  const dotted = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const q = dotted[1].split('.').map(Number);
    if (q.length !== 4 || q.some(n => n > 255)) return null;
    s = s.slice(0, -dotted[1].length) + ((q[0] << 8) | q[1]).toString(16) + ':' + ((q[2] << 8) | q[3]).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  let groups: string[];
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...Array<string>(missing).fill('0'), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8 || groups.some(g => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  const n = groups.map(g => parseInt(g, 16));
  if (!n.slice(0, 5).every(g => g === 0)) return null;
  if (n[5] !== 0xffff && n[5] !== 0) return null;
  if (n[5] === 0 && n[6] === 0 && n[7] <= 1) return null;   // :: and ::1 are not embedded IPv4
  return `${n[6] >> 8}.${n[6] & 255}.${n[7] >> 8}.${n[7] & 255}`;
}

export function isBlockedHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(lower)) return true;
  return BLOCKED_SUFFIXES.some(suffix => lower.endsWith(suffix));
}

/**
 * Assert that a URL resolves to a public address. Throws ssrfBlocked if not.
 *
 * Checks:
 * 1. Scheme must be http: or https: (blocks file://, ftp://, gopher://, etc.)
 * 2. Hostname must not be blocked
 * 3. Resolved IPs must not be private (IPv4 and IPv6)
 * 4. Handles IPv6 bracket notation [::1]
 */
export async function assertPublicUrl(urlStr: string): Promise<void> {
  let url: URL;
  try {
    // WHATWG URL parser for consistent normalization
    url = new URL(urlStr);
  } catch {
    throw ssrfBlocked(urlStr);
  }

  // Block non-HTTP schemes (file://, ftp://, gopher://, data:, javascript:, etc.)
  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    throw ssrfBlocked(urlStr);
  }

  // Normalize hostname (strip IPv6 brackets, lowercase)
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();

  if (isBlockedHostname(hostname)) {
    throw ssrfBlocked(urlStr);
  }

  // Check if hostname is already an IP (IPv4 or IPv6)
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(':')) {
    if (isPrivateIpAddress(hostname)) {
      throw ssrfBlocked(urlStr);
    }
    return;
  }

  // DNS lookup to check all resolved IPs
  try {
    const result = await lookup(hostname, { all: true });
    const addresses = Array.isArray(result) ? result : [result];
    for (const addr of addresses) {
      if (isPrivateIpAddress(addr.address)) {
        throw ssrfBlocked(urlStr);
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('SSRF blocked')) throw err;
    // DNS failure — block for safety (prevents DNS rebinding attacks)
    throw ssrfBlocked(urlStr);
  }
}

/**
 * Validate a redirect URL against SSRF rules.
 * Call this on each redirect hop to prevent DNS rebinding attacks.
 */
export async function assertPublicRedirect(originalUrl: string, redirectUrl: string): Promise<void> {
  // Parse redirect relative to original
  let resolved: URL;
  try {
    resolved = new URL(redirectUrl, originalUrl);
  } catch {
    throw ssrfBlocked(redirectUrl);
  }
  await assertPublicUrl(resolved.toString());
}
