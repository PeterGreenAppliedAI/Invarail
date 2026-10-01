import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CronStore } from '../../src/cron/store.js';
import { CronService } from '../../src/cron/service.js';
import { createCronAddTool, resolveCronDelivery } from '../../src/tools/cron-add.js';

const DISCORD_DM = '1418392204551430204';   // shape of a Discord DM channel id
const fromDiscord = { channel: 'discord', channelId: DISCORD_DM };

describe('resolveCronDelivery (2026-10-01: a reminder saved with target "dm" never delivered)', () => {
  it('the incident: "dm" from a Discord conversation defaults to that conversation', () => {
    expect(resolveCronDelivery('discord', 'dm', fromDiscord)).toEqual({ channel: 'discord', target: DISCORD_DM, defaulted: true });
  });

  it('every placeholder word defaults the same way', () => {
    for (const word of ['me', 'here', 'DM', 'current', 'owner']) {
      expect(resolveCronDelivery('discord', word, fromDiscord)).toMatchObject({ target: DISCORD_DM, defaulted: true });
    }
  });

  it('leaving channel and target out delivers to the conversation the request came from', () => {
    expect(resolveCronDelivery(undefined, undefined, fromDiscord)).toEqual({ channel: 'discord', target: DISCORD_DM, defaulted: true });
  });

  it('a real id is kept as given', () => {
    expect(resolveCronDelivery('discord', '987654321098765432', fromDiscord)).toEqual({ channel: 'discord', target: '987654321098765432', defaulted: false });
    expect(resolveCronDelivery('telegram', '-1001234567', undefined)).toEqual({ channel: 'telegram', target: '-1001234567', defaulted: false });
  });

  it('refuses rather than saving a job that cannot deliver: bad target and no same-channel conversation', () => {
    const fromWeb = { channel: 'web', channelId: 'e2e' };
    const r = resolveCronDelivery('discord', 'dm', fromWeb);
    expect('error' in r && r.error).toMatch(/"dm" is not a discord id/);
    expect('error' in r && r.error).toMatch(/Leave channel and target out/);
    expect('error' in resolveCronDelivery('discord', undefined, undefined)).toBe(true);
  });

  it('a channel with no id shape accepts any non-placeholder target', () => {
    expect(resolveCronDelivery('web', 'console:abc', undefined)).toEqual({ channel: 'web', target: 'console:abc', defaulted: false });
    expect('error' in resolveCronDelivery('web', 'me', undefined)).toBe(true);
  });
});

describe('cron_add uses the resolved delivery', () => {
  let dir = '';
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  function service() {
    dir = mkdtempSync(join(tmpdir(), 'cron-add-'));
    const store = new CronStore(join(dir, 'cron.json'));
    return { store, svc: new CronService({ store, onTrigger: (async () => undefined) as never, timezone: 'America/New_York' }) };
  }

  it('the incident shape saves a job that delivers to the conversation, and says so', async () => {
    const { store, svc } = service();
    const out = await createCronAddTool(svc).execute(
      { name: 'Laya shadow run stats check', schedule: '0 17 29 9 *', category: 'chat', message: 'check the shadow stats', channel: 'discord', target: 'dm', once: true },
      { agentId: 'main', sessionKey: 's', ...fromDiscord },
    );
    expect(out).toMatch(/delivering to this conversation/);
    expect(store.list(true)[0].delivery).toEqual({ channel: 'discord', target: DISCORD_DM });
    svc.stop?.();
  });

  it('nothing is saved when no deliverable target can be resolved', async () => {
    const { store, svc } = service();
    const out = await createCronAddTool(svc).execute(
      { name: 'x', schedule: '0 9 * * *', category: 'chat', message: 'm', channel: 'discord', target: 'dm' },
      { agentId: 'main', sessionKey: 's', channel: 'web', channelId: 'e2e' },
    );
    expect(out).toMatch(/^Error:/);
    expect(store.list(true)).toHaveLength(0);
    svc.stop?.();
  });
});
