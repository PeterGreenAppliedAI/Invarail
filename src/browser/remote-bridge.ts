/**
 * Remote browser bridge — forwards browser tool commands to a connected
 * Chrome extension and waits for results.
 *
 * The browser tool calls `sendAction()` which queues a command and returns
 * a promise. The extension polls `getPendingAction()`, executes it via
 * content script, and calls `resolveAction()` with the result.
 *
 * Same pattern as Docker backend for exec — code controls flow,
 * remote endpoint is a dumb executor.
 */

export interface BrowserAction {
  id: string;
  action: string;
  ref?: string;
  text?: string;
  url?: string;
  direction?: string;
  selector?: string;
}

export interface BrowserActionResult {
  id: string;
  success: boolean;
  result: string;
}

interface PendingAction {
  action: BrowserAction;
  resolve: (result: string) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

const ACTION_TIMEOUT_MS = 30_000;

class RemoteBrowserBridge {
  /** FIFO. A single slot let a second sendAction overwrite the first, whose timeout then
   *  never fired because it was no longer "current" — an agent turn hung forever
   *  (outside review F24, 2026-09-27). Every queued request now settles: result,
   *  timeout, or disconnect. */
  private queue: PendingAction[] = [];
  private connected = false;

  /** Mark extension as connected */
  setConnected(connected: boolean): void {
    this.connected = connected;
    if (!connected) {
      for (const p of this.queue.splice(0)) {
        clearTimeout(p.timeoutId);
        p.reject(new Error('Extension disconnected'));
      }
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** Called by browser tool — queues action and waits for extension to execute it */
  sendAction(action: Omit<BrowserAction, 'id'>): Promise<string> {
    if (!this.connected) {
      return Promise.reject(new Error('No extension connected'));
    }

    const id = `ba_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const fullAction: BrowserAction = { id, ...action };

    return new Promise<string>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        const idx = this.queue.findIndex(p => p.action.id === id);
        if (idx !== -1) {
          this.queue.splice(idx, 1);
          reject(new Error(`Browser action timed out: ${action.action}`));
        }
      }, ACTION_TIMEOUT_MS);

      this.queue.push({ action: fullAction, resolve, reject, timeoutId });
    });
  }

  /** Called by extension polling — the head of the queue, or null */
  getPendingAction(): BrowserAction | null {
    return this.queue[0]?.action ?? null;
  }

  /** Called by extension after executing action */
  resolveAction(result: BrowserActionResult): void {
    const idx = this.queue.findIndex(p => p.action.id === result.id);
    if (idx === -1) return;
    const [p] = this.queue.splice(idx, 1);
    clearTimeout(p.timeoutId);
    if (result.success) p.resolve(result.result);
    else p.reject(new Error(result.result));
  }
}

/** Singleton — shared between browser tool and console API */
export const remoteBridge = new RemoteBrowserBridge();
