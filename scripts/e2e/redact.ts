/**
 * Published results carry the run's provenance. The model host is part of it, but a LAN
 * address is not something to publish — results used to be scrubbed by hand before every
 * commit. Loopback stays as it is; any other host becomes `<host>`, keeping scheme and port.
 */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (LOOPBACK.has(u.hostname)) return url;
    return `${u.protocol}//<host>${u.port ? `:${u.port}` : ''}${u.pathname === '/' ? '' : u.pathname}`;
  } catch {
    return '<host>';
  }
}
