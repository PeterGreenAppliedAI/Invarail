import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import JSON5 from 'json5';
import { InvarailConfigSchema } from './schema.js';
import { configInvalid } from '../errors.js';
import { capsFor } from '../ollama/model-caps.js';
import type { InvarailConfig } from './types.js';

/**
 * Load .env file into process.env (simple key=value parser, no dependency needed).
 */
function loadDotEnv(dir?: string): void {
  const envPath = resolve(dir ?? '.', '.env');
  if (!existsSync(envPath)) return;

  try {
    const text = readFileSync(envPath, 'utf-8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      // Strip surrounding quotes
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    // Non-critical
  }
}

/**
 * Expand ${ENV_VAR} placeholders in string values.
 */
function expandEnvVars(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return obj.replace(/\$\{([^}]+)}/g, (_, key: string) => process.env[key] ?? '');
  }
  if (Array.isArray(obj)) {
    return obj.map(expandEnvVars);
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = expandEnvVars(v);
    }
    return result;
  }
  return obj;
}

/**
 * Remove empty-string values so Zod defaults kick in.
 * e.g. if OLLAMA_URL is not set, url becomes "" — we want the default instead.
 */
function removeEmptyStrings(obj: unknown): unknown {
  if (typeof obj === 'string') return obj === '' ? undefined : obj;
  if (Array.isArray(obj)) return obj.map(removeEmptyStrings);
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      const cleaned = removeEmptyStrings(v);
      if (cleaned !== undefined) {
        result[k] = cleaned;
      }
    }
    return result;
  }
  return obj;
}

// TEMPORARY migration shim (see DECISIONS: removal at v0.2.0 or 60 days after
// rename, whichever first). Fallback fires ONLY when the new config is ABSENT —
// a malformed invarail.config.json5 must fail loudly, never silently load the
// legacy file.
const CONFIG_FILE = 'invarail.config.json5';
// Split literal keeps the mechanical rename sweep from rewriting the LEGACY name
const LEGACY_CONFIG_FILE = 'local' + 'claw.config.json5';

export function loadConfig(filePath?: string): InvarailConfig {
  // Load .env before anything else
  loadDotEnv();

  let path = filePath ?? CONFIG_FILE;
  if (!filePath && !existsSync(CONFIG_FILE) && existsSync(LEGACY_CONFIG_FILE)) {
    console.warn(`[config] DEPRECATED: loading legacy ${LEGACY_CONFIG_FILE} — rename it to ${CONFIG_FILE}; this fallback will be removed`);
    path = LEGACY_CONFIG_FILE;
  }

  let raw: unknown;
  try {
    const text = readFileSync(path, 'utf-8');
    raw = JSON5.parse(text);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.warn(`[config] ${path} not found — run "npm run setup" to generate it`);
      return InvarailConfigSchema.parse({});
    }
    throw configInvalid(`Failed to read ${path}: ${err instanceof Error ? err.message : err}`);
  }

  const expanded = expandEnvVars(raw);
  const cleaned = removeEmptyStrings(expanded);
  const result = InvarailConfigSchema.safeParse(cleaned);

  if (!result.success) {
    const issues = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw configInvalid(issues);
  }

  warnOnSecurityFootguns(result.data);
  warnOnThinkFootguns(result.data);
  return result.data;
}

/**
 * Flag specialist `think` settings the model cannot honor (2026-08 eval:
 * a model may reject the field, or — worse — accept and silently ignore it;
 * gpt-oss:120b combined ignored suppression with `format` into discarded
 * output). Config-time warning beats a runtime 400 or a silent no-op.
 */
function warnOnThinkFootguns(config: InvarailConfig): void {
  for (const [name, spec] of Object.entries(config.specialists)) {
    if (spec.think === undefined) continue;
    const cap = capsFor(spec.model).think;
    if (cap === 'none') {
      console.warn(`[config] specialists.${name}: think is set but ${spec.model} does not support thinking control (Ollama rejects the field) — remove it.`);
    } else if (cap === 'levels' && typeof spec.think === 'boolean') {
      console.warn(`[config] specialists.${name}: ${spec.model} only supports effort levels ('low'|'medium'|'high') — boolean think is silently ignored by the model (and think:false + format triggers a known Ollama output-discard bug). Use an effort string.`);
    }
  }
}

/**
 * Loudly flag security config that silently does nothing (or contradicts
 * itself). These were previously silent no-ops — the doc suite's theme is
 * "never silently degrade", and that applies to the owner's own config too.
 */
function warnOnSecurityFootguns(config: InvarailConfig): void {
  for (const [name, ch] of Object.entries(config.channels)) {
    const sec = ch.security;
    if (!sec) continue;
    if ((sec.restrictedTools?.length || sec.restrictedCategories?.length) && !sec.trustedUsers?.length) {
      console.warn(`[config] channels.${name}: restrictedTools/restrictedCategories are set but trustedUsers is empty — with no trusted list, EVERY user is untrusted and the restrictions apply to everyone (including you). Set trustedUsers if that's not intended.`);
    }
    const conflict = (sec.confirmTools ?? []).filter(t => sec.autoApproveTools?.includes(t));
    if (conflict.length > 0) {
      console.warn(`[config] channels.${name}: [${conflict.join(', ')}] appear in BOTH confirmTools and autoApproveTools — explicit confirmTools wins; the autoApprove entries are ignored.`);
    }
  }
}
