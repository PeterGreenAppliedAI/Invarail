import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PendingActionStore, CONFIRMATION_PATTERN, parseConfirmationId } from '../../src/security/pending-actions.js';

let storePath: string;
let store: PendingActionStore;

beforeEach(() => {
  storePath = join(mkdtempSync(join(tmpdir(), 'pending-')), 'pending.json');
  store = new PendingActionStore(storePath);
});

const baseEntry = {
  tool: 'send_message',
  params: { channel: 'discord', text: 'hello' },
  sender: 'user-1',
  channel: 'discord',
  agentId: 'main',
  sessionKey: 'default',
};

describe('PendingActionStore', () => {
  it('records and retrieves the latest action for a sender', () => {
    store.record(baseEntry);
    const second = store.record({ ...baseEntry, params: { channel: 'discord', text: 'second' } });

    const latest = store.latestFor('user-1');
    expect(latest?.id).toBe(second.id);
    expect(latest?.params).toEqual({ channel: 'discord', text: 'second' });
  });

  it('is sender-bound — another sender cannot see or confirm the action', () => {
    store.record(baseEntry);
    expect(store.latestFor('user-2')).toBeNull();
  });

  it('consume is single-use', () => {
    const action = store.record(baseEntry);
    expect(store.consume(action.id)?.id).toBe(action.id);
    expect(store.consume(action.id)).toBeNull();
    expect(store.latestFor('user-1')).toBeNull();
  });

  it('expired entries are pruned and never returned', () => {
    const action = store.record(baseEntry);
    // Rewrite the file with an already-expired timestamp
    const raw = JSON.parse(readFileSync(storePath, 'utf-8'));
    raw[0].expiresAt = new Date(Date.now() - 1000).toISOString();
    writeFileSync(storePath, JSON.stringify(raw));

    expect(store.latestFor('user-1')).toBeNull();
    expect(store.consume(action.id)).toBeNull();
  });

  it('stores exact params — the executed call is the previewed call', () => {
    const params = { to: 'boss@example.com', body: "don't forget the meeting" };
    store.record({ ...baseEntry, tool: 'send_email', params });
    expect(store.latestFor('user-1')?.params).toEqual(params);
  });
});

describe('id-targeted confirmation + channel binding', () => {
  it('findById returns the action only for its own sender', () => {
    const action = store.record(baseEntry);
    expect(store.findById(action.id, 'user-1')?.id).toBe(action.id);
    expect(store.findById(action.id, 'user-2')).toBeNull();
  });

  it('latestFor with channel binding ignores other channels', () => {
    store.record({ ...baseEntry, channel: 'discord' });
    const consoleAction = store.record({ ...baseEntry, channel: 'console' });
    expect(store.latestFor('user-1', 'console')?.id).toBe(consoleAction.id);
    expect(store.latestFor('user-1', 'telegram')).toBeNull();
  });

  it('listFor returns all unexpired actions for a sender', () => {
    store.record(baseEntry);
    store.record({ ...baseEntry, tool: 'cron_add' });
    expect(store.listFor('user-1')).toHaveLength(2);
    expect(store.listFor('user-2')).toHaveLength(0);
  });

  it('parseConfirmationId extracts ids and returns null for bare confirms', () => {
    expect(parseConfirmationId('confirm 3fa2c1b9')).toBe('3fa2c1b9');
    expect(parseConfirmationId('Confirm 3FA2C1B9')).toBe('3fa2c1b9');
    expect(parseConfirmationId('confirm')).toBeNull();
    expect(parseConfirmationId('go ahead')).toBeNull();
  });

  it('latestFor with maxAgeMs ignores old entries — bare "go ahead" cannot fire a stale 12h proposal', () => {
    const action = store.record(baseEntry, 12 * 60 * 60 * 1000);
    // Rewrite createdAt to 30 minutes ago (still unexpired under the 12h TTL)
    const raw = JSON.parse(readFileSync(storePath, 'utf-8'));
    raw[0].createdAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    writeFileSync(storePath, JSON.stringify(raw));

    expect(store.latestFor('user-1', 'discord', 10 * 60 * 1000)).toBeNull(); // bare confirm path
    expect(store.findById(action.id, 'user-1')?.id).toBe(action.id); // id-targeted still works
  });

  it('near-miss pattern catches "confirm 2" but not longer requests', async () => {
    const { CONFIRMATION_NEAR_MISS } = await import('../../src/security/pending-actions.js');
    expect(CONFIRMATION_NEAR_MISS.test('confirm 2')).toBe(true);
    expect(CONFIRMATION_NEAR_MISS.test('confirm 3fa2c1b')).toBe(true);
    expect(CONFIRMATION_NEAR_MISS.test('confirm my flight booking')).toBe(false);
    expect(CONFIRMATION_NEAR_MISS.test('can you confirm the meeting')).toBe(false);
  });
});

describe('CONFIRMATION_PATTERN', () => {
  it('matches bare confirmations', () => {
    for (const msg of ['confirm', 'Confirm!', 'yes do it', 'yes, do it', 'approved', 'go ahead', 'proceed.']) {
      expect(CONFIRMATION_PATTERN.test(msg)).toBe(true);
    }
  });

  it('matches id-targeted confirmations', () => {
    expect(CONFIRMATION_PATTERN.test('confirm 3fa2c1b9')).toBe(true);
    expect(CONFIRMATION_PATTERN.test('confirm abc123')).toBe(true);
  });

  it('does not match confirmations embedded in other requests', () => {
    for (const msg of ['go ahead and delete everything', 'confirm my flight', 'can you proceed with the plan']) {
      expect(CONFIRMATION_PATTERN.test(msg)).toBe(false);
    }
  });
});
