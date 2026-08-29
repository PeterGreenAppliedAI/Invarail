import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isAutomated, isFastLane, matchesSenders, formatAlert, drainDigest, type FlaggedEmail } from '../../src/services/email-steward.js';

describe('email steward — code gates', () => {
  it('automated senders are filtered before any model call', () => {
    expect(isAutomated('Amazon <no-reply@amazon.com>', undefined)).toBe(true);
    expect(isAutomated('GitHub <notifications@github.com>', undefined)).toBe(true);
    expect(isAutomated('Stripe <receipts@stripe.com>', undefined)).toBe(true);
    expect(isAutomated('Newsletter <newsletter@substack.com>', undefined)).toBe(true);
    // List-Unsubscribe header alone marks bulk mail regardless of sender shape
    expect(isAutomated('Friendly Human <jane@client.com>', '<mailto:unsub@x.com>')).toBe(true);
    expect(isAutomated('Jane Doe <jane@client.com>', undefined)).toBe(false);
  });

  it('fast lane matches watched aliases in To/Cc', () => {
    const cfg = { aliases: ['support@devmesh.tech'], senders: [] };
    expect(isFastLane('Jane <jane@client.com>', 'support@devmesh.tech', cfg)).toBe(true);
    expect(isFastLane('Jane <jane@client.com>', 'Peter <pgreen@devmesh.tech>, support@devmesh.tech', cfg)).toBe(true);
    expect(isFastLane('Jane <jane@client.com>', 'pgreen@devmesh.tech', cfg)).toBe(false);
  });

  it('fast lane matches VIP senders by exact address or bare domain', () => {
    const cfg = { aliases: [], senders: ['boss@bigclient.com', 'client.com'] };
    expect(isFastLane('Boss <boss@bigclient.com>', 'pgreen@devmesh.tech', cfg)).toBe(true);
    expect(isFastLane('Jane <jane@client.com>', 'pgreen@devmesh.tech', cfg)).toBe(true);
    expect(isFastLane('Jane <jane@mail.client.com>', 'pgreen@devmesh.tech', cfg)).toBe(true);
    expect(isFastLane('Rando <rando@other.com>', 'pgreen@devmesh.tech', cfg)).toBe(false);
    // "client.com" must not match a lookalike domain suffix
    expect(isFastLane('Evil <x@notclient.com>', 'pgreen@devmesh.tech', cfg)).toBe(false);
  });

  it('watch-lane senders match by address or domain', () => {
    const senders = ['group-a.example', 'events@list-b.example'];
    expect(matchesSenders('Events <newsletter@group-a.example>', senders)).toBe(true);
    expect(matchesSenders('List <events@list-b.example>', senders)).toBe(true);
    expect(matchesSenders('Rando <spam@group-a.example.evil.com>', senders)).toBe(false);
  });

  it('watched bulk mail would pass despite List-Unsubscribe (lane order beats the filter)', () => {
    // The automated filter WOULD kill this — lane ordering in checkInbox runs
    // watch matching first, which is the whole point for chosen bulk senders.
    expect(isAutomated('Group <newsletter@group-a.example>', '<mailto:unsub@x.example>')).toBe(true);
    expect(matchesSenders('Group <newsletter@group-a.example>', ['group-a.example'])).toBe(true);
  });

  it('alert format: sender, subject, reason, age — never a drafted reply', () => {
    const f: FlaggedEmail = { id: 'x', from: 'Jane Doe <jane@client.com>', subject: 'Change request', date: 'Fri, 29 Aug 2026', reason: 'client asks for scope change', lane: 'fast' };
    const alert = formatAlert(f);
    expect(alert).toContain('Jane Doe');
    expect(alert).toContain('Change request');
    expect(alert).toContain('client asks for scope change');
  });

  it('digest drain empties the pile exactly once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'steward-'));
    const statePath = join(dir, 'seen.json');
    // Seed a digest pile via the state file shape
    writeFileSync(statePath, JSON.stringify({ seenIds: ['a'], digest: [{ id: 'a', from: 'x', subject: 's', date: 'd', reason: 'r', lane: 'judged' }] }));
    expect(drainDigest(statePath)).toHaveLength(1);
    expect(drainDigest(statePath)).toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  });
});
