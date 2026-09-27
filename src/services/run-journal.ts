import { appendFileSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

/**
 * Crash-durable run journal (steward requirement, 2026-08-22 — the dsh comparison's
 * one structural lesson we adopted without adopting event sourcing): every tool-loop
 * step is appended to a journal file AS IT HAPPENS. A run that finishes — cleanly,
 * cancelled, or by thrown error — deletes its journal (the dispatch layer accounts
 * for all of those to the user). The ONLY thing that leaves a journal behind is
 * process death, so at boot, every surviving journal is an interrupted run: the sweep
 * writes a synthetic transcript note into that session so neither the model nor the
 * user experiences a silent vanish.
 */

const JOURNAL_DIR = 'data/run-journal';

export interface RunJournal {
  step(i: number, tool: string, observation: string): void;
  close(): void;
}

const NOOP: RunJournal = { step: () => undefined, close: () => undefined };

function safe(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
}

export function startRunJournal(agentId: string | undefined, sessionKey: string | undefined, userMessage: string, dir = JOURNAL_DIR): RunJournal {
  if (!agentId || !sessionKey) return NOOP;
  try {
    mkdirSync(dir, { recursive: true });
    // Random suffix + exclusive create: the lossy safe() names collided (`channel:a` vs
    // `channel/a`, same millisecond), and closing one run unlinked the other's journal
    // (re-review N05). The sweep reads identity from the start record, not the name.
    const path = join(dir, `${Date.now().toString(36)}-${safe(agentId)}-${safe(sessionKey)}-${randomUUID().slice(0, 8)}.jsonl`);
    appendFileSync(path, JSON.stringify({ type: 'start', ts: new Date().toISOString(), agentId, sessionKey, userMessage: userMessage.slice(0, 200) }) + '\n', { flag: 'ax' });
    return {
      step(i: number, tool: string, observation: string): void {
        try {
          appendFileSync(path, JSON.stringify({ type: 'step', i, tool, observation: observation.slice(0, 150) }) + '\n');
        } catch { /* journal is best-effort — never fail the run */ }
      },
      close(): void {
        try { unlinkSync(path); } catch { /* already gone */ }
      },
    };
  } catch {
    return NOOP;
  }
}

export interface SweepSessionStore {
  appendTurn(agentId: string, sessionKey: string, turn: { role: string; content: string; timestamp: string }): void;
}

/** Boot sweep: every surviving journal is a run killed by process death. Returns count swept. */
export function sweepInterruptedRuns(sessionStore: SweepSessionStore, dir = JOURNAL_DIR): number {
  let files: string[];
  try { files = readdirSync(dir); } catch { return 0; }
  let swept = 0;
  for (const f of files) {
    const path = join(dir, f);
    try {
      const lines = readFileSync(path, 'utf-8').split('\n').filter(Boolean);
      const start = JSON.parse(lines[0]) as { agentId: string; sessionKey: string; userMessage: string };
      const stepCount = lines.length - 1;
      sessionStore.appendTurn(start.agentId, start.sessionKey, {
        role: 'assistant',
        content: `⚠️ A previous run on this session was interrupted by a restart after ${stepCount} tool step(s) (task: "${start.userMessage.slice(0, 120)}"). It did NOT complete — ask me to retry if it still matters.`,
        timestamp: new Date().toISOString(),
      });
      swept++;
      console.log(`[RunJournal] Swept interrupted run: ${start.agentId}:${start.sessionKey} (${stepCount} steps)`);
    } catch (err) {
      console.warn('[RunJournal] Unreadable journal (removing):', f, err instanceof Error ? err.message : err);
    }
    try { unlinkSync(path); } catch { /* best effort */ }
  }
  return swept;
}
