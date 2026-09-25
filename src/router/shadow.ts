import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RouterConfig } from '../config/types.js';
import { SystemOneClient } from './systemone-client.js';

/**
 * Router shadow mode — observe a candidate router on real traffic without letting
 * it decide anything.
 *
 * Every classified message is also sent to the System-One server, and the two
 * answers land side by side in a JSONL log plus a one-line console entry. The
 * live decision is never changed, never waited on, never delayed: `observe` is
 * fire-and-forget with a hard timeout, and a dead shadow server costs one warning.
 *
 * What it produces is the number the 78-item eval could not: an agreement rate on
 * the real distribution, per decision source (model / keyword / sticky / override).
 * That is the evidence for — or against — the `router.backend` switch.
 */
export class RouterShadow {
  private readonly client: SystemOneClient;
  private seen = 0;
  private agreed = 0;
  private warnedOnce = false;

  constructor(private readonly config: RouterConfig) {
    this.client = new SystemOneClient(config.shadow.url ?? '', config.shadow.timeoutMs);
  }

  /** The exact option text the checkpoint was trained on: the config descriptions. */
  private categories(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, cat] of Object.entries(this.config.categories)) out[name] = cat.description ?? name;
    return out;
  }

  observe(message: string, decided: string, decidedBy: string): void {
    if (!this.config.shadow.enabled || !this.config.shadow.url) return;
    void this.client.route(message, this.categories()).then(d => {
      if (!d) {
        if (!this.warnedOnce) { this.warnedOnce = true; console.warn('[RouterShadow] shadow server unreachable — will keep trying silently'); }
        return;
      }
      this.warnedOnce = false;
      this.seen++;
      const agree = d.choice === decided;
      if (agree) this.agreed++;
      const top = Object.entries(d.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}:${v.toFixed(2)}`);
      console.log(`[RouterShadow] live=${decided}(${decidedBy}) shadow=${d.choice} conf=${d.confidence.toFixed(2)} ${agree ? 'AGREE' : 'DIFFER'} ${d.ms}ms` + (this.seen % 25 === 0 ? ` | agreement ${this.agreed}/${this.seen}` : ''));
      try {
        mkdirSync(dirname(this.config.shadow.logPath), { recursive: true });
        appendFileSync(this.config.shadow.logPath, JSON.stringify({
          ts: new Date().toISOString(), preview: message.slice(0, 120), decided, decidedBy,
          shadow: d.choice, confidence: Number(d.confidence.toFixed(4)), top, ms: d.ms,
        }) + '\n');
      } catch (err) {
        console.warn('[RouterShadow] log write failed:', err instanceof Error ? err.message : err);
      }
    }).catch(err => console.warn('[RouterShadow] observe failed:', err instanceof Error ? err.message : err));
  }
}

let shadow: RouterShadow | null = null;
let shadowKey = '';

/** One shadow per config identity — the classifier is a free function called with
 *  config each time, so the instance is memoized on the fields that define it. */
export function routerShadowFor(config: RouterConfig): RouterShadow | null {
  if (!config.shadow?.enabled || !config.shadow.url) return null;
  const key = `${config.shadow.url}|${config.shadow.timeoutMs}|${config.shadow.logPath}`;
  if (!shadow || shadowKey !== key) { shadow = new RouterShadow(config); shadowKey = key; }
  return shadow;
}
