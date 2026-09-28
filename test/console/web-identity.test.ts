import { describe, it, expect } from 'vitest';
import { resolveWebIdentity } from '../../src/security/web-identity.js';
import { loadConfig } from '../../src/config/loader.js';

// F07/F08: anyone holding the token could pick their senderId and become the owner (or a
// stranger). The token is the owner's credential; a claimed id only partitions the session.
describe('web identity', () => {
  const base = loadConfig('/tmp/nonexistent-config.json5');
  const withToken = { ...base, ownerId: 'peter', channels: { ...base.channels, web: { ...(base.channels.web ?? { enabled: true }), token: 'secret' } } } as typeof base;
  const noToken = { ...base, ownerId: 'peter', channels: { ...base.channels, web: { ...(base.channels.web ?? { enabled: true }), token: undefined } } } as typeof base;

  it('with a token, the principal is the owner whatever the caller claims; the claim partitions the session', () => {
    const stranger = resolveWebIdentity({ config: withToken, claimed: 'device-abc123', channelId: 'console', fallback: 'console-user' });
    expect(stranger.senderId).toBe('peter');
    expect(stranger.channelId).toBe('console:device-abc123');
    expect(stranger.by).toBe('token→owner');
    const asOwner = resolveWebIdentity({ config: withToken, claimed: 'peter', channelId: 'console', fallback: 'console-user' });
    expect(asOwner.senderId).toBe('peter'); expect(asOwner.channelId).toBe('console');
    const noClaim = resolveWebIdentity({ config: withToken, claimed: null, channelId: 'web', fallback: 'web-user' });
    expect(noClaim.senderId).toBe('peter'); expect(noClaim.channelId).toBe('web');
  });

  it('without a token (loopback / insecureOpen) the claim stands, else the fallback', () => {
    expect(resolveWebIdentity({ config: noToken, claimed: 'alice', channelId: 'console', fallback: 'console-user' })).toEqual({ senderId: 'alice', channelId: 'console', by: 'claimed' });
    expect(resolveWebIdentity({ config: noToken, claimed: '  ', channelId: 'console', fallback: 'console-user' })).toEqual({ senderId: 'console-user', channelId: 'console', by: 'default' });
  });

  it('a token but no ownerId configured: nothing to become — the claim stands', () => {
    const c = { ...withToken, ownerId: undefined } as typeof base;
    expect(resolveWebIdentity({ config: c, claimed: 'alice', channelId: 'console', fallback: 'console-user' }).senderId).toBe('alice');
  });

  it('no config at all (adapter before deps are wired) behaves like no token', () => {
    expect(resolveWebIdentity({ config: undefined, claimed: 'x', channelId: 'web', fallback: 'web-user' }).senderId).toBe('x');
  });
});
