import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Daily outbound search ceiling — volume control beside the rate throttle.
 *
 * The per-provider throttle (web-search.ts) controls RATE: one query per ~1.5s. It
 * cannot control VOLUME: a weekly research cron plus ad-hoc use can still send
 * hundreds of queries a day through a self-hosted metasearch, and every one of them
 * spends the host IP's reputation with the engines it fans out to (two days of
 * that earned a DuckDuckGo CAPTCHA flag and Brave/Wikidata suspensions, DECISIONS
 * 2026-08-14). This is the code gate: a ceiling in config, counted per local day,
 * refused with an honest message once reached. 0 = unlimited (the default, so an
 * existing deployment's behavior does not change until its owner sets one).
 */
export class SearchQuota {
  constructor(private readonly path: string, private readonly ceiling: number) {}

  private load(): { date: string; count: number } {
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf-8')) as { date?: string; count?: number };
      return { date: raw.date ?? '', count: raw.count ?? 0 };
    } catch {
      return { date: '', count: 0 };
    }
  }

  private save(state: { date: string; count: number }): boolean {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(state));
      renameSync(tmp, this.path);
      return true;
    } catch (err) {
      console.warn('[SearchQuota] Could not persist:', err instanceof Error ? err.message : err);
      return false;
    }
  }

  static dayKey(now: Date): string {
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }

  /** Queries used so far today. */
  used(now = new Date()): number {
    const s = this.load();
    return s.date === SearchQuota.dayKey(now) ? s.count : 0;
  }

  /** Reserve one query. Refuses (without counting) once today's ceiling is reached. */
  tryConsume(now = new Date()): { ok: true; used: number } | { ok: false; used: number; ceiling: number; reason?: string } {
    const day = SearchQuota.dayKey(now);
    const s = this.load();
    const count = s.date === day ? s.count : 0;
    if (this.ceiling > 0 && count >= this.ceiling) return { ok: false, used: count, ceiling: this.ceiling };
    // A ceiling is a hard limit: a count that could not be written is a count that cannot be
    // trusted, so the query does not go out (unlimited ceilings never persist-gate).
    if (!this.save({ date: day, count: count + 1 }) && this.ceiling > 0) {
      return { ok: false, used: count, ceiling: this.ceiling, reason: 'the daily count could not be persisted' };
    }
    return { ok: true, used: count + 1 };
  }

  get limit(): number { return this.ceiling; }
}

export function quotaRefusal(used: number, ceiling: number): string {
  return `Search paused: today's outbound query ceiling (${ceiling}) is reached (${used} used). It resets at local midnight. `
    + 'This ceiling protects the search host\'s IP reputation with upstream engines; raise tools.web.search.dailyQueryCeiling only if the volume is intended.';
}

export const SEARCH_QUOTA_PATH = 'data/search-quota.json';
export function quotaFileExists(): boolean { return existsSync(SEARCH_QUOTA_PATH); }
