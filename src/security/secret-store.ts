import { readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Unified credential store — 0600 JSON profiles keyed `<name>[:account]`.
 * First tenant: MCP OAuth tokens (`mcp-oauth:<server>`). Gmail/Calendar stay
 * on env vars until migrated. Values NEVER leak through status()/logs.
 */
export interface SecretProfile {
  [key: string]: string | number | undefined;
}

const STORE_PATH = 'data/secrets.json';

export class SecretStore {
  constructor(private readonly path: string = STORE_PATH) {}

  private load(): Record<string, SecretProfile> {
    try {
      return JSON.parse(readFileSync(this.path, 'utf-8')) as Record<string, SecretProfile>;
    } catch {
      return {};
    }
  }

  private save(data: Record<string, SecretProfile>): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
    try {
      chmodSync(this.path, 0o600); // rename preserves tmp mode, but belt-and-braces
    } catch { /* non-posix */ }
  }

  get(profile: string): SecretProfile | null {
    return this.load()[profile] ?? null;
  }

  set(profile: string, values: SecretProfile): void {
    const data = this.load();
    data[profile] = { ...data[profile], ...values };
    this.save(data);
    console.log(`[Secrets] Profile "${profile}" updated (${Object.keys(values).length} field(s))`);
  }

  delete(profile: string): boolean {
    const data = this.load();
    if (!(profile in data)) return false;
    delete data[profile];
    this.save(data);
    return true;
  }

  /** Profile names + field names only — never values. Safe to log/display. */
  status(): Array<{ profile: string; fields: string[] }> {
    return Object.entries(this.load()).map(([profile, values]) => ({
      profile,
      fields: Object.keys(values),
    }));
  }
}

export const secrets = new SecretStore();
