import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { InvarailConfig } from '../config/types.js';
import { selfModError } from '../errors.js';
import { logAutonomousAction } from '../metrics.js';
import { pendingActions, type PendingActionStore } from '../security/pending-actions.js';
import { slugify } from '../utils/text.js';
import { runMergeGate, type GateVerdict, type MergeGateOptions } from './merge-gate.js';
import { PiCodingAdapter } from './pi-session.js';
import { SelfModWorktrees } from './self-mod.js';

/**
 * Self-modification flow (Phase B): !improve → Pi session in an isolated worktree → merge
 * gate → pending-action ledger → owner confirm → merge into main → deploy marker → exit(42)
 * → supervisor restarts with health-check + rollback. Every merge is owner-confirmed; the
 * model never sees self_merge; grants can never mint a merge approval.
 */

const SELF_MOD_GUARDRAILS = [
  '',
  'CONTEXT: You are modifying the Invarail codebase (TypeScript, Node 22, ESM) in a git worktree.',
  'RULES:',
  '- Work ONLY in the current directory. Never use absolute paths outside it.',
  '- Follow the existing patterns: error factory in src/errors.ts, Zod-derived types, ESM imports with .js extensions, tools implement InvarailTool.',
  '- Read CLAUDE.md first for architecture and code standards.',
  '- Verify your work: run `npx tsc --noEmit` and the relevant tests with `npx vitest run <path>`.',
  '- COMMIT your changes with git when done (git add + git commit). Uncommitted work does not count.',
  '- A read-only memory_search tool may be available: search prior experience before choosing an approach.',
].join('\n');

export interface SelfModServiceOptions {
  config: InvarailConfig;
  repoRoot?: string;
  worktrees?: SelfModWorktrees;
  adapter?: PiCodingAdapter;
  gateRunner?: (opts: MergeGateOptions) => Promise<GateVerdict>;
  pendingStore?: PendingActionStore;
  /** Called after a successful merge — the orchestrator schedules reply delivery then exit(42) */
  onRestartRequested?: () => void;
  /** Memory integration (Phase C) — absent: memory writes are skipped, everything else works */
  graphMemory?: import('../memory/graph-store.js').GraphMemoryStore;
  experienceStore?: import('../memory/experience-store.js').ExperienceStore;
  /** For the lesson brief + memory_search callback (lessons need embeddings) */
  client?: import('../ollama/client.js').OllamaClient;
  workspacePath?: string;
}

export interface ProposeResult {
  ok: boolean;
  reply: string;
  slug?: string;
  pendingId?: string;
}

export class SelfModService {
  private readonly config: InvarailConfig;
  private readonly repoRoot: string;
  private readonly worktrees: SelfModWorktrees;
  private readonly adapter: PiCodingAdapter;
  private readonly gateRunner: (opts: MergeGateOptions) => Promise<GateVerdict>;
  private readonly pending: PendingActionStore;
  private readonly onRestartRequested?: () => void;
  private readonly graphMemory?: import('../memory/graph-store.js').GraphMemoryStore;
  private readonly experienceStore?: import('../memory/experience-store.js').ExperienceStore;
  private readonly memoryDeps: import('./coding-memory.js').CodingMemoryDeps;
  private busy = false;

  constructor(opts: SelfModServiceOptions) {
    this.config = opts.config;
    this.repoRoot = opts.repoRoot ?? process.cwd();
    this.worktrees = opts.worktrees ?? new SelfModWorktrees(this.repoRoot);
    this.adapter = opts.adapter ?? new PiCodingAdapter({
      ...opts.config.pi,
      timeout: opts.config.selfMod.sessionTimeoutMs ?? opts.config.pi.timeout,
    });
    this.gateRunner = opts.gateRunner ?? runMergeGate;
    this.pending = opts.pendingStore ?? pendingActions;
    this.onRestartRequested = opts.onRestartRequested;
    this.graphMemory = opts.graphMemory;
    this.experienceStore = opts.experienceStore;
    this.memoryDeps = {
      experienceStore: opts.experienceStore,
      graphMemory: opts.graphMemory,
      client: opts.client,
      ownerId: opts.config.ownerId,
      workspacePath: opts.workspacePath,
    };
  }

  bootSweep(): void {
    // Rollback detection FIRST — sweep() deletes stale markers, and evidence must be
    // consumed before it's destroyed.
    this.detectRollback().catch(err =>
      console.warn('[SelfMod] Rollback detection failed:', err instanceof Error ? err.message : err));
    try {
      const swept = this.worktrees.sweep();
      if (swept.length) console.log(`[SelfMod] Boot sweep removed: ${swept.join(', ')}`);
    } catch (err) {
      console.warn('[SelfMod] Boot sweep failed:', err instanceof Error ? err.message : err);
    }
  }

  /**
   * A rolled-back merge is an authoritative, system-observed failure. Two evidence paths:
   * deploy-failed.json (the supervisor preserved the marker on rollback — primary), and a
   * live deploy.json whose mergeSha is no longer an ancestor of HEAD (belt, in case the
   * rename failed). The merge's verified 'worked' Experience is superseded by an equally
   * verified 'failed' one — verified is epistemic confidence, and this really happened.
   */
  private async detectRollback(): Promise<void> {
    let marker = this.worktrees.readFailedMarker();
    let fromFailedFile = true;
    if (!marker) {
      const live = this.worktrees.readDeployMarker();
      if (live && !this.isAncestor(live.mergeSha)) {
        marker = live;
        fromFailedFile = false;
      }
    }
    if (!marker) return;

    logAutonomousAction({
      action: 'self_mod_rolled_back', tier: 'propose_confirm', source: 'supervisor',
      reversible: false, outcome: 'failure', detail: marker.slug, resource: marker.mergeSha,
    });
    console.warn(`[SelfMod] Deploy of "${marker.slug}" (${marker.mergeSha.slice(0, 8)}) was ROLLED BACK by the supervisor`);

    if (marker.experienceId && this.experienceStore) {
      const newId = await this.experienceStore.supersedeById(marker.experienceId, {
        text: `Self-mod "${marker.slug}" (${marker.mergeSha.slice(0, 8)}): passed the gate but FAILED deployment — supervisor rolled back to ${marker.prevSha.slice(0, 8)}.`,
        taskShape: `self-mod: ${marker.slug}`,
        approach: 'merged after gate pass; failed post-merge gates or health check',
        outcome: 'failed',
        satisfaction: -1,
        verified: true,           // the rollback was system-observed — this really happened
        commit: marker.mergeSha,
        model: this.config.pi.model,
      }, `selfmod:${marker.slug}`);
      if (newId) console.log(`[SelfMod] Experience ${marker.experienceId} superseded by ${newId} (rollback)`);
    }
    if (fromFailedFile) this.worktrees.clearFailedMarker();
  }

  private isAncestor(sha: string): boolean {
    const r = spawnSync('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], { cwd: this.repoRoot, timeout: 30_000 });
    return r.status === 0;
  }

  status(): string {
    const active = this.worktrees.getState().active;
    if (!active) return 'No active self-mod worktree.';
    return `Active self-mod: **${active.slug}** (branch \`${active.branch}\`, since ${active.createdAt.slice(0, 16)})${this.busy ? ' — session running' : ' — awaiting confirm or `!improve abandon`'}`;
  }

  abandon(): string {
    const active = this.worktrees.getState().active;
    if (!active) return 'Nothing to abandon.';
    if (this.busy) return 'A session is still running — wait for it to finish first.';
    this.worktrees.remove();
    logAutonomousAction({
      action: 'self_mod_abandon', tier: 'propose_confirm', source: 'user_command',
      reversible: true, outcome: 'confirmed', detail: active.slug,
    });
    return `Abandoned self-mod **${active.slug}** — worktree and branch removed.`;
  }

  /** The full propose flow. Long-running (a Pi session + full gate) — callers should run it
   *  in the background and deliver the returned reply when done. `principal` must be the
   *  RESOLVED principal (the ledger's confirm path matches on it). */
  async propose(spec: string, principal: string, channel: string): Promise<ProposeResult> {
    if (!this.config.selfMod.enabled) return { ok: false, reply: 'Self-modification is disabled (`selfMod.enabled`).' };
    if (!this.config.pi.enabled) return { ok: false, reply: 'Pi is disabled (`pi.enabled`) — self-modification needs the coding substrate.' };
    if (this.busy) return { ok: false, reply: 'A self-mod session is already running — one change at a time.' };

    const slug = slugify(spec).slice(0, 40);
    this.busy = true;
    try {
      const active = this.worktrees.create(slug, spec);
      console.log(`[SelfMod] Worktree ${active.worktreePath} (base ${active.baseSha.slice(0, 8)})`);

      const { buildPriorExperienceBrief, buildMemorySearchCallback } = await import('./coding-memory.js');
      const brief = await buildPriorExperienceBrief(spec, this.memoryDeps).catch(() => '');
      const session = await this.adapter.runSession({
        prompt: spec + brief + '\n' + SELF_MOD_GUARDRAILS,
        cwd: active.worktreePath,
        label: `self-mod:${slug}`,
        taskCategory: 'self_mod',
        memorySearch: buildMemorySearchCallback(this.memoryDeps),
      });
      this.worktrees.updateActive({ sessionId: session.sessionId, sessionFile: session.sessionFile });

      // Safety net: the gate diffs committed history — auto-commit anything Pi left dirty.
      this.autoCommitLeftovers(active.worktreePath, slug);

      const gate = await this.gateRunner({
        worktreePath: active.worktreePath,
        baseSha: active.baseSha,
        protectedPathsExtra: this.config.selfMod.protectedPathsExtra,
        timeoutMs: this.config.selfMod.gateTimeoutMs,
      });
      this.persistVerdict(slug, gate);

      if (!session.ok && gate.touchedFiles.length === 0) {
        this.worktrees.remove();
        return { ok: false, reply: `Self-mod **${slug}** failed: Pi session ${session.timedOut ? 'timed out' : 'errored'} (${session.error ?? 'unknown'}) and produced no changes. Worktree removed.` };
      }
      if (!gate.pass) {
        const failing = gate.checks.find(c => !c.pass)?.name ?? 'no-changes';
        logAutonomousAction({
          action: 'self_mod_gate_failed', tier: 'propose_confirm', source: 'user_command',
          reversible: true, outcome: 'failure', detail: `${slug}: ${failing}`,
        });
        return {
          ok: false, slug,
          reply: `Self-mod **${slug}**: gate FAILED — not proposing a merge.\n${this.gateSummary(gate)}\nWorktree kept for inspection: \`${active.worktreePath}\`\nDiscard with \`!improve abandon\`.`,
        };
      }

      const action = this.pending.record({
        tool: 'self_merge',
        params: { slug, branch: active.branch, baseSha: active.baseSha, headSha: gate.headSha },
        sender: principal,
        channel,
        agentId: 'main',
        sessionKey: `selfmod:${slug}`,
        category: 'code',
      });
      logAutonomousAction({
        action: 'self_mod_proposed', tier: 'propose_confirm', source: 'user_command',
        reversible: true, outcome: 'proposed', detail: slug, resource: active.branch,
      });
      const diffStat = this.git(['diff', '--stat', `${active.baseSha}...HEAD`], active.worktreePath);
      return {
        ok: true, slug, pendingId: action.id,
        reply: [
          `🔧 Self-mod **${slug}** ready.`,
          this.gateSummary(gate),
          '```', diffStat.split('\n').slice(-12).join('\n'), '```',
          gate.tier === 3 ? '⚠️ **TIER 3 — touches protected paths:** ' + gate.protectedTouched.join(', ') : '',
          gate.gateConfigTampered ? '🚨 **Diff modifies gate/build config — review with extra care.**' : '',
          `Reply \`confirm ${action.id}\` to merge + restart, \`deny ${action.id}\` to reject, or \`!improve abandon\`.`,
        ].filter(Boolean).join('\n'),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Log server-side too — the channel reply can be lost (e.g. consumed HTTP response)
      // and a silent propose failure is undiagnosable from the outside.
      console.warn(`[SelfMod] propose "${slug}" failed:`, msg);
      return { ok: false, reply: `Self-mod failed: ${msg.slice(0, 400)}` };
    } finally {
      this.busy = false;
    }
  }

  /** Executed ONLY via the pending-action ledger's confirm path (self_merge tool). */
  async executeMerge(params: Record<string, unknown>): Promise<string> {
    const slug = String(params.slug ?? '');
    const branch = String(params.branch ?? '');
    const headSha = String(params.headSha ?? '');
    const active = this.worktrees.getState().active;
    if (!active || active.slug !== slug) {
      throw selfModError(`no active worktree for "${slug}" — was it abandoned?`);
    }
    // The branch must be exactly what the gate judged — any post-gate commit voids the verdict.
    const currentHead = this.git(['rev-parse', 'HEAD'], active.worktreePath);
    if (currentHead !== headSha) {
      throw selfModError(`branch ${branch} changed after the gate ran (${currentHead.slice(0, 8)} != ${headSha.slice(0, 8)}) — re-run !improve`);
    }
    const verdict = this.readVerdict(slug);
    if (!verdict?.pass) {
      throw selfModError(`no passing gate verdict on record for "${slug}"`);
    }

    this.worktrees.checkpointIfDirty();
    const prevSha = this.git(['rev-parse', 'HEAD']);
    try {
      this.git(['merge', '--no-ff', '-m', `self-mod: ${slug}`, branch]);
    } catch (err) {
      try { this.git(['merge', '--abort']); } catch { /* no merge in progress */ }
      throw selfModError(`merge of ${branch} failed (conflict with main?) — worktree kept`, err);
    }
    const mergeSha = this.git(['rev-parse', 'HEAD']);

    // The gate/confirm event IS the memory verified event — write it now, awaited, BEFORE the
    // restart callback (a write racing exit(42) dies mid-flight). Best-effort: memory being
    // down must never block a deploy. Idempotent on mergeSha (crash replay finds the node).
    const experienceId = await this.recordVerifiedExperience(active, mergeSha, verdict).catch(err => {
      console.warn('[SelfMod] Verified-experience write failed (deploy continues):', err instanceof Error ? err.message : err);
      return undefined;
    });

    this.worktrees.writeDeployMarker({
      prevSha, mergeSha, slug, ts: new Date().toISOString(),
      ...(experienceId ? { experienceId } : {}),
    });
    this.worktrees.remove();
    logAutonomousAction({
      action: 'self_mod_merged', tier: 'propose_confirm', source: 'user_command',
      reversible: false, outcome: 'confirmed', approval: 'confirmed', detail: slug,
      resource: experienceId ? `${mergeSha}|exp:${experienceId}` : mergeSha,
    });
    console.log(`[SelfMod] Merged ${branch} → main (${prevSha.slice(0, 8)} → ${mergeSha.slice(0, 8)}); requesting supervised restart`);
    this.onRestartRequested?.();
    return `Merged **${slug}** into main (${mergeSha.slice(0, 8)}). Restarting under the supervisor — gates re-run, health-checked, auto-rollback to ${prevSha.slice(0, 8)} on failure.`;
  }

  /**
   * The success write: a (:Turn source:'pi') for provenance + a verified Experience.
   * Everything here is CODE-BUILT (spec, touched files, gate stats) — never model
   * self-assessment. Returns the experienceId for the deploy marker.
   */
  private async recordVerifiedExperience(
    active: import('./self-mod.js').ActiveWorktree,
    mergeSha: string,
    verdict: GateVerdict,
  ): Promise<string | undefined> {
    if (!this.experienceStore) return undefined;
    const slug = active.slug;
    const spec = active.spec ?? slug;
    const ownerId = this.config.ownerId ?? 'owner';
    const sessionKey = `selfmod:${slug}`;
    const files = verdict.touchedFiles.slice(0, 6).join(', ');
    const summary = `Self-mod "${spec.slice(0, 160)}": merged as ${mergeSha.slice(0, 8)} — ${verdict.touchedFiles.length} files (${files}), gate tier ${verdict.tier}, checks ${verdict.checks.map(c => c.name).join('+')} passed.`;

    // Turn FIRST — experience provenance links to the most recent Turn for the sessionKey.
    // A crash-replay duplicate Turn is cosmetic; the Experience is idempotent on commit.
    if (this.graphMemory) {
      await this.graphMemory.addTurn(summary, 'pi', ownerId, sessionKey, {
        source: 'pi',
        model: this.config.pi.model,
        commit: mergeSha,
        jsonlPath: active.sessionFile ?? '',
      }).catch(err => console.warn('[SelfMod] Turn write failed:', err instanceof Error ? err.message : err));
    }

    const saved = await this.experienceStore.save({
      text: summary,
      taskShape: `self-mod: ${spec.slice(0, 120)}`,
      approach: `touched ${files || 'no files'}; gate tier ${verdict.tier}`,
      outcome: 'worked',
      satisfaction: 1,          // owner confirm = explicit approval signal
      verified: true,           // the merge gate witnessed this — epistemic confidence, not praise
      commit: mergeSha,
      model: this.config.pi.model,
    }, sessionKey);
    return saved?.id;
  }

  private autoCommitLeftovers(worktreePath: string, slug: string): void {
    const status = this.git(['status', '--porcelain'], worktreePath);
    if (!status.trim()) return;
    // node_modules is a copied arena artifact, never content — exclude it defensively
    // (the gate's forbidden-files check backstops Pi committing it directly).
    this.git(['add', '-A', '--', ':(exclude)node_modules'], worktreePath);
    try {
      this.git(['commit', '-q', '-m', `self-mod: ${slug} (auto-commit of uncommitted session output)`], worktreePath);
    } catch { /* nothing staged (e.g. only ignored files) */ }
  }

  private verdictPath(slug: string): string {
    return join(this.repoRoot, 'data', 'self-mod', `gate-${slug}.json`);
  }

  private persistVerdict(slug: string, verdict: GateVerdict): void {
    mkdirSync(join(this.repoRoot, 'data', 'self-mod'), { recursive: true });
    writeFileSync(this.verdictPath(slug), JSON.stringify(verdict, null, 2));
  }

  private readVerdict(slug: string): GateVerdict | null {
    try {
      return JSON.parse(readFileSync(this.verdictPath(slug), 'utf-8')) as GateVerdict;
    } catch {
      return null;
    }
  }

  private gateSummary(gate: GateVerdict): string {
    const checks = gate.checks.map(c => `${c.pass ? '✅' : '❌'} ${c.name} (${(c.durationMs / 1000).toFixed(0)}s)`).join(' · ');
    return `Gate: ${gate.pass ? 'PASS' : 'FAIL'} — tier ${gate.tier}, ${gate.touchedFiles.length} files. ${checks}`;
  }

  private git(args: string[], cwd?: string): string {
    const r = spawnSync('git', args, { cwd: cwd ?? this.repoRoot, encoding: 'utf-8', timeout: 60_000 });
    if (r.status !== 0) {
      throw selfModError(`git ${args[0]} failed: ${(r.stderr || r.stdout || '').trim().slice(0, 300)}`);
    }
    return r.stdout.trim();
  }
}
