import { describe, it, expect } from 'vitest';
import { mkdtempSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PendingActionStore } from '../../src/security/pending-actions.js';
import { GrantStore } from '../../src/security/grants.js';

// Re-review F19 (2026-09-27): a swallowed save failure let an entry be confirmed twice and a
// grant revocation report success while the grant stayed on disk. Both now fail closed.
describe('ledger and grants fail closed when the write does not land', () => {
  it('consume returns null when the ledger cannot be rewritten, and the entry is still there', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
    const store = new PendingActionStore(join(dir, 'pending.json'));
    const { id } = store.record({ tool: 'send_message', params: {}, sender: 'peter', channel: 'discord', agentId: 'main', sessionKey: 's' } as any);
    chmodSync(dir, 0o500);                       // directory read-only: the tmp+rename cannot land
    try {
      expect(store.consume(id)).toBeNull();
      expect(store.findById(id, 'peter')?.id).toBe(id);
    } finally { chmodSync(dir, 0o700); }
    expect(store.consume(id)?.id).toBe(id);      // writable again → consumed
    expect(store.findById(id, 'peter')).toBeNull();
  });

  it('revoke returns null when the grant file cannot be rewritten, and the grant stays in force', () => {
    const dir = mkdtempSync(join(tmpdir(), 'grants-'));
    const store = new GrantStore(join(dir, 'grants.json'));
    const g = store.record({ tool: 'send_message', target: 'discord:123', principal: 'peter' } as any);
    chmodSync(dir, 0o500);
    try {
      expect(store.revoke(g.id, 'peter')).toBeNull();
      expect(store.findMatch('send_message', 'discord:123', 'peter')?.id).toBe(g.id);
    } finally { chmodSync(dir, 0o700); }
    expect(store.revoke(g.id, 'peter')?.id).toBe(g.id);
  });
});
