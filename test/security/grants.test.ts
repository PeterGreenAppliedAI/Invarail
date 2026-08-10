import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrantStore, grantTargetFor, resolveGrantApproval } from '../../src/security/grants.js';
import type { InvarailTool } from '../../src/tools/types.js';

function tool(overrides: Partial<InvarailTool> = {}): InvarailTool {
  return {
    name: 'send_message',
    description: '',
    parameterDescription: '',
    category: 'message',
    targetArgs: ['channel', 'channelId'],
    execute: async () => 'ok',
    ...overrides,
  };
}

describe('grantTargetFor', () => {
  it('joins targetArgs values in order', () => {
    expect(grantTargetFor(tool(), { channel: 'discord', channelId: '123', text: 'hi' })).toBe('discord:123');
  });

  it('fail-closed: missing/empty target params → null', () => {
    expect(grantTargetFor(tool(), { channel: 'discord', text: 'hi' })).toBeNull();
    expect(grantTargetFor(tool(), { channel: 'discord', channelId: '', text: 'hi' })).toBeNull();
    expect(grantTargetFor(tool(), { channel: 'discord', channelId: 42, text: 'hi' })).toBeNull();
  });

  it('fail-closed: tools without targetArgs (exec) are never grant-eligible', () => {
    expect(grantTargetFor(tool({ name: 'exec', targetArgs: undefined }), { command: 'rm -rf /' })).toBeNull();
    expect(grantTargetFor(undefined, { anything: 'x' })).toBeNull();
  });
});

describe('GrantStore', () => {
  let dir: string;
  let store: GrantStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'grants-'));
    store = new GrantStore(join(dir, 'grants.json'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const entry = { tool: 'send_message', target: 'discord:123', principal: 'peter', channel: 'discord', source: 'confirm' as const };

  it('records and matches exactly (tool+target+principal)', () => {
    store.record(entry);
    expect(store.findMatch('send_message', 'discord:123', 'peter')).not.toBeNull();
    expect(store.findMatch('send_message', 'discord:999', 'peter')).toBeNull();
    expect(store.findMatch('send_message', 'discord:123', 'stranger')).toBeNull();
    expect(store.findMatch('exec', 'discord:123', 'peter')).toBeNull();
  });

  it('is idempotent for the same tool+target+principal', () => {
    const a = store.record(entry);
    const b = store.record(entry);
    expect(b.id).toBe(a.id);
    expect(store.listFor('peter')).toHaveLength(1);
  });

  it('revoke is principal-bound and removes the grant', () => {
    const g = store.record(entry);
    expect(store.revoke(g.id, 'stranger')).toBeNull();
    expect(store.revoke(g.id, 'peter')).not.toBeNull();
    expect(store.findMatch('send_message', 'discord:123', 'peter')).toBeNull();
  });

  it('survives reload from disk', () => {
    store.record(entry);
    const reopened = new GrantStore(join(dir, 'grants.json'));
    expect(reopened.findMatch('send_message', 'discord:123', 'peter')).not.toBeNull();
  });
});

describe('resolveGrantApproval', () => {
  let dir: string;
  let store: GrantStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'grants-'));
    store = new GrantStore(join(dir, 'grants.json'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const params = { channel: 'discord', channelId: '123', text: 'hi' };

  it('standing grant approves the exact target only', () => {
    store.record({ tool: 'send_message', target: 'discord:123', principal: 'peter', channel: 'discord', source: 'confirm' });
    expect(resolveGrantApproval(tool(), params, 'peter', undefined, store)).toBe('standing');
    expect(resolveGrantApproval(tool(), { ...params, channelId: '999' }, 'peter', undefined, store)).toBeNull();
    expect(resolveGrantApproval(tool(), params, 'stranger', undefined, store)).toBeNull();
  });

  it('reply-origin approves sends back to the originating conversation', () => {
    expect(resolveGrantApproval(tool(), params, 'peter', { channel: 'discord', channelId: '123' }, store)).toBe('reply_origin');
    expect(resolveGrantApproval(tool(), params, 'peter', { channel: 'discord', channelId: '456' }, store)).toBeNull();
    expect(resolveGrantApproval(tool(), params, 'peter', { channel: 'telegram', channelId: '123' }, store)).toBeNull();
  });

  it('grant-ineligible tools never auto-approve, even with grants on file', () => {
    store.record({ tool: 'exec', target: 'whatever', principal: 'peter', channel: 'discord', source: 'confirm' });
    const exec = tool({ name: 'exec', targetArgs: undefined });
    expect(resolveGrantApproval(exec, { command: 'ls' }, 'peter', { channel: 'discord', channelId: '123' }, store)).toBeNull();
  });
});
