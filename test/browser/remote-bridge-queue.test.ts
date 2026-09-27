import { describe, it, expect, vi, afterEach } from 'vitest';
import { remoteBridge } from '../../src/browser/remote-bridge.js';

afterEach(() => { vi.useRealTimers(); remoteBridge.setConnected(false); });

// Outside review F24 (2026-09-27): a single pending slot; a second sendAction overwrote the
// first, whose timeout then never fired — the agent turn hung forever.
describe('remote bridge queues actions and settles every one', () => {
  it('two overlapping actions: the first is served first, the second after; nothing is lost', async () => {
    remoteBridge.setConnected(true);
    const p1 = remoteBridge.sendAction({ action: 'navigate', url: 'https://a.example' });
    const p2 = remoteBridge.sendAction({ action: 'snapshot' });
    const head = remoteBridge.getPendingAction()!;
    expect(head.action).toBe('navigate');
    remoteBridge.resolveAction({ id: head.id, success: true, result: 'navigated' });
    expect(await p1).toBe('navigated');
    const next = remoteBridge.getPendingAction()!;
    expect(next.action).toBe('snapshot');
    remoteBridge.resolveAction({ id: next.id, success: true, result: 'snap' });
    expect(await p2).toBe('snap');
    expect(remoteBridge.getPendingAction()).toBeNull();
  });

  it('a queued action that is never served rejects on its own timeout', async () => {
    vi.useFakeTimers();
    remoteBridge.setConnected(true);
    const p1 = remoteBridge.sendAction({ action: 'navigate', url: 'https://a.example' });
    const p2 = remoteBridge.sendAction({ action: 'snapshot' });
    const rejected = vi.fn(); p2.catch(rejected); p1.catch(() => undefined);
    vi.advanceTimersByTime(31_000);
    await Promise.resolve();
    expect(rejected).toHaveBeenCalled();
    expect(remoteBridge.getPendingAction()).toBeNull();
  });

  it('disconnect rejects everything queued', async () => {
    remoteBridge.setConnected(true);
    const p = remoteBridge.sendAction({ action: 'snapshot' });
    remoteBridge.setConnected(false);
    await expect(p).rejects.toThrow(/disconnected/);
  });
});
