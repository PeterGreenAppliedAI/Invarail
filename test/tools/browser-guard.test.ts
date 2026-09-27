import { describe, it, expect } from 'vitest';
import { browserUrlBlockReason, createBrowserTool } from '../../src/tools/browser.js';
import type { BrowserConfig } from '../../src/config/types.js';

// The browser tool was the one fetcher with no SSRF guard (outside review, 2026-09-27).
const cfg = (allowedPrivateHosts: string[] = []): BrowserConfig => ({ enabled: true, headless: true, allowedPrivateHosts } as BrowserConfig);

describe('browser SSRF guard', () => {
  it('blocks loopback, LAN and the canonical mapped-IPv6 loopback', async () => {
    for (const url of ['http://127.0.0.1:11434/api/ps', 'http://10.9.8.19:11434/', 'http://[::ffff:7f00:1]/', 'http://192.168.77.221/']) {
      expect(await browserUrlBlockReason(url, cfg()), url).toMatch(/blocked/);
    }
  });
  it('allows a public IP literal and an explicitly allowed private host', async () => {
    expect(await browserUrlBlockReason('http://93.184.216.34/', cfg())).toBeNull();
    expect(await browserUrlBlockReason('http://10.9.8.19:11434/', cfg(['10.9.8.19']))).toBeNull();
    expect(await browserUrlBlockReason('http://proxmox.local/', cfg(['proxmox.local']))).toBeNull();
  });
  it('rejects non-http schemes and garbage', async () => {
    expect(await browserUrlBlockReason('file:///etc/passwd', cfg())).toMatch(/blocked/);
    expect(await browserUrlBlockReason('not a url', cfg())).toMatch(/invalid URL/);
  });
  it('the tool refuses a blocked navigate before launching anything', async () => {
    const tool = createBrowserTool(cfg());
    const out = await tool.execute({ action: 'navigate', url: 'http://127.0.0.1:3100/console/' }, { agentId: 'main', sessionKey: 's', workspacePath: '/tmp', channel: 'discord' } as any);
    expect(out).toMatch(/navigation blocked/);
  });
});
