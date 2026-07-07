import { describe, it, expect } from 'vitest';
import { resolvePrincipal, isOwner } from '../../src/identity/principal.js';
import type { LocalClawConfig } from '../../src/config/types.js';

const config = {
  ownerId: '415030165005926401',
  principals: {
    peter: {
      aliases: ['415030165005926401', '6555481980', '13478769461_s.whatsapp.net', 'console-user'],
    },
  },
} as unknown as LocalClawConfig;

describe('resolvePrincipal', () => {
  it('maps every alias to the principal', () => {
    expect(resolvePrincipal('415030165005926401', config)).toBe('peter');
    expect(resolvePrincipal('6555481980', config)).toBe('peter');
    expect(resolvePrincipal('console-user', config)).toBe('peter');
  });

  it('maps the principal name to itself', () => {
    expect(resolvePrincipal('peter', config)).toBe('peter');
  });

  it('passes unmapped ids through unchanged', () => {
    expect(resolvePrincipal('random-stranger', config)).toBe('random-stranger');
    expect(resolvePrincipal(undefined, config)).toBeUndefined();
  });

  it('behaves as identity with no principals configured', () => {
    const bare = { principals: {} } as unknown as LocalClawConfig;
    expect(resolvePrincipal('6555481980', bare)).toBe('6555481980');
  });
});

describe('isOwner', () => {
  it('matches the raw ownerId', () => {
    expect(isOwner('415030165005926401', config)).toBe(true);
  });

  it('matches any alias sharing the owner principal — the Telegram Peter IS the owner', () => {
    expect(isOwner('6555481980', config)).toBe(true);
    expect(isOwner('console-user', config)).toBe(true);
  });

  it('rejects strangers and missing config', () => {
    expect(isOwner('random-stranger', config)).toBe(false);
    expect(isOwner(undefined, config)).toBe(false);
    expect(isOwner('anyone', { principals: {} } as unknown as LocalClawConfig)).toBe(false);
  });
});
