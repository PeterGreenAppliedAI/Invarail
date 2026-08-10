/**
 * Heartbeat service — periodic maintenance, fact review, memory reasoning, task management.
 * Extracted from orchestrator.ts for single-responsibility and testability.
 */
import { writeFileSync, readFileSync, existsSync, readdirSync, statSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { InvarailConfig, FactInput, FactEntry } from '../config/types.js';
import type { OllamaClient } from '../ollama/client.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ChannelRegistry } from '../channels/registry.js';
import type { SessionStore } from '../sessions/store.js';
import type { FactStore } from '../memory/fact-store.js';
import type { GraphMemoryStore } from '../memory/graph-store.js';
import type { TaskStore } from '../tasks/store.js';
import type { EmbeddingStore } from '../memory/embeddings.js';
import type { CronService } from '../cron/service.js';
import { resolveWorkspacePath } from '../agents/scope.js';
import { enrichTasks, getAutoActions, filterForModel, formatTaskBoard } from '../temporal/urgency.js';
import { InvarailError } from '../errors.js';
import { logAutonomousAction } from '../metrics.js';
import { resolvePrincipal } from '../identity/principal.js';

export interface HeartbeatDeps {
  config: InvarailConfig;
  client: OllamaClient;
  toolRegistry: ToolRegistry;
  channelRegistry: ChannelRegistry;
  sessionStore: SessionStore;
  factStore?: FactStore;
  graphMemory?: GraphMemoryStore;
  taskStore?: TaskStore;
  cronService?: CronService;
  /** Vault reindex target — shared EmbeddingStore from tool registration */
  embeddingStore?: EmbeddingStore;
  /** Extract facts from a transcript — delegates to the orchestrator's extraction logic */
  extractFacts: (
    transcript: any[],
    recentlyRemoved?: any,
    senderId?: string,
  ) => Promise<FactInput[]>;
  /** Review transcripts for auto-extraction */
  reviewTranscripts: (workspacePath: string, agentId: string) => Promise<FactInput[]>;
  /** Promote recurring error patterns to LEARNINGS.md */
  promoteRecurringLearnings: (workspacePath: string) => Promise<number>;
  /** Delete old media files */
  cleanupOldMedia: () => number;
  /** Get path for heartbeat pending review files */
  heartbeatPendingPath: (workspacePath: string, senderId: string) => string;
}

/** Max stale-fact nominations shown per heartbeat — the positional !heartbeat
 *  interface is only usable at this scale. */
const MAX_STALE_PROPOSALS = 3;
/** Unanswered proposals expire back to normal memory — the pending set must
 *  never outgrow what a report can display (July 30: it hit 46). Peter's rule:
 *  "there is never a reason to surface that many facts for removal at the same
 *  time" — the cap IS one report's worth, so commands can only ever act on
 *  what the user is looking at. */
const PENDING_PROPOSAL_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PENDING_REVIEW_FACTS = 5;
/** If the model nominates more than this, its staleness judgment is broken for
 *  this cycle (July 10: it nominated 40 — half the user's memory — after a
 *  migration made the diff look huge). Distrust the ENTIRE batch. */
const STALE_BATCH_DISTRUST_THRESHOLD = 8;
/** A fact the user KEPT (or that was proposed and ignored) is not re-nominated
 *  within this window — same asked-once principle as prep questions. */
const STALE_REPROPOSE_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

function staleProposalLogPath(pendingPath: string): string {
  return join(dirname(pendingPath), 'stale-proposed.json');
}

/**
 * Route LLM-flagged stale facts into the pending !heartbeat review file instead
 * of deleting them directly. Returns the proposals with their 1-based positions
 * in the merged pending file (the positions "!heartbeat no N" indexes into).
 *
 * Guards (all code, July 10 incident): oversize batches are distrusted wholly;
 * at most MAX_STALE_PROPOSALS surface per cycle; each fact is proposed at most
 * once per cooldown window regardless of the user's answer.
 */
export function proposeStaleFactsForReview(
  staleTexts: string[],
  factStore: FactStore,
  senderId: string,
  pendingPath: string,
): Array<{ index: number; text: string; category: string }> {
  // Sanity guard: a model claiming a large fraction of memory is stale is a
  // model failure, not a memory failure — never turn it into user homework
  if (staleTexts.length > STALE_BATCH_DISTRUST_THRESHOLD) {
    console.warn(`[Heartbeat] Model nominated ${staleTexts.length} stale facts — batch distrusted, none proposed`);
    logAutonomousAction({ action: 'stale_batch_distrusted', tier: 'propose_confirm', source: 'heartbeat', reversible: true, outcome: 'rejected', detail: `${staleTexts.length} nominations` });
    return [];
  }

  const allFacts = factStore.loadFactsJson(senderId);

  // Propose-once cooldown ledger
  const logPath = staleProposalLogPath(pendingPath);
  let proposedLog: Record<string, string> = {};
  try { proposedLog = JSON.parse(readFileSync(logPath, 'utf-8')); } catch { /* fresh */ }
  const cutoff = Date.now() - STALE_REPROPOSE_COOLDOWN_MS;

  // Resolve model-provided text to actual stored facts (exact, then fuzzy prefix)
  const matched = staleTexts
    .map(stale => {
      const needle = stale.slice(0, 40).toLowerCase();
      return allFacts.find(f =>
        f.text === stale || f.text.toLowerCase().includes(needle) || stale.toLowerCase().includes(f.text.slice(0, 40).toLowerCase()));
    })
    .filter((f): f is NonNullable<typeof f> => !!f)
    .filter(f => {
      const last = proposedLog[f.id];
      return !last || new Date(last).getTime() < cutoff;
    })
    .slice(0, MAX_STALE_PROPOSALS);
  if (matched.length === 0) return [];

  // Merge into the pending review file (create if absent)
  let pending: { type: string; createdAt: string; senderId: string; facts: Array<{ id: string; text: string; category: string; proposedAt?: string }> };
  try {
    pending = JSON.parse(readFileSync(pendingPath, 'utf-8'));
  } catch {
    pending = { type: 'heartbeat_review', createdAt: new Date().toISOString(), senderId, facts: [] };
  }

  // The July 30 incident: per-cycle caps held, but unanswered proposals
  // ACCUMULATED across cycles to 46 while each report displayed only the
  // newest few — then a bare "!heartbeat no" acted on all of them. Two
  // structural guards: unanswered proposals EXPIRE back to normal memory
  // after 7 days (the cooldown ledger stops instant re-proposal), and the
  // file is hard-capped — the pending set stays reviewable at a glance.
  const proposalCutoff = Date.now() - PENDING_PROPOSAL_EXPIRY_MS;
  const before = pending.facts.length;
  pending.facts = pending.facts.filter(f =>
    new Date(f.proposedAt ?? pending.createdAt).getTime() >= proposalCutoff);
  if (pending.facts.length < before) {
    console.log(`[Heartbeat] ${before - pending.facts.length} unanswered proposal(s) expired back to memory (7d)`);
  }

  const proposals: Array<{ index: number; text: string; category: string }> = [];
  for (const fact of matched) {
    let idx = pending.facts.findIndex(f => f.id === fact.id);
    if (idx === -1) {
      if (pending.facts.length >= MAX_PENDING_REVIEW_FACTS) {
        console.log(`[Heartbeat] Pending review at cap (${MAX_PENDING_REVIEW_FACTS}) — deferring "${fact.text.slice(0, 50)}"`);
        continue;
      }
      pending.facts.push({ id: fact.id, text: fact.text, category: fact.category, proposedAt: new Date().toISOString() });
      idx = pending.facts.length - 1;
    }
    proposals.push({ index: idx + 1, text: fact.text, category: fact.category });
    proposedLog[fact.id] = new Date().toISOString();
    console.log(`[Heartbeat] Proposed stale fact for review: "${fact.text.slice(0, 60)}"`);
    logAutonomousAction({ action: 'stale_fact_proposed', tier: 'propose_confirm', source: 'heartbeat', reversible: true, outcome: 'proposed', detail: fact.text.slice(0, 80) });
  }
  writeFileSync(pendingPath, JSON.stringify(pending, null, 2));
  try { writeFileSync(logPath, JSON.stringify(proposedLog, null, 2)); } catch { /* best-effort */ }
  return proposals;
}

export async function runHeartbeat(deps: HeartbeatDeps): Promise<void> {
  const { config, client, factStore, graphMemory, taskStore, cronService, channelRegistry, toolRegistry } = deps;
  const hb = config.heartbeat;
  if (!hb) return;
  const heartbeatModel = hb.model;

  console.log('[Heartbeat] Running...');

  try {
    const workspacePath = resolveWorkspacePath(config.agents.default, config);

    // Review recent session transcripts and extract facts
    const extractedFacts = await deps.reviewTranscripts(workspacePath, config.agents.default);
    if (extractedFacts.length > 0) {
      console.log(`[Heartbeat] Committed ${extractedFacts.length} facts from transcript review`);
    }

    // Promote recurring error patterns to LEARNINGS.md
    const promoted = await deps.promoteRecurringLearnings(workspacePath);
    if (promoted > 0) {
      console.log(`[Heartbeat] Promoted ${promoted} learnings from error patterns`);
    }

    // Synthesize boundary lessons from code-detected failure evidence.
    // Lessons auto-save at evidence:1 but only steer dispatches at evidence≥2
    // (recurrence is the code gate) — see src/learnings/lesson-synthesis.ts.
    let lessonSummary = '';
    if (config.memory?.lessons?.enabled !== false) {
      try {
        const { synthesizeLessons } = await import('../learnings/lesson-synthesis.js');
        const lessons = await synthesizeLessons({
          client,
          model: config.memory?.extractionModel ?? config.router.model,
          workspacePath,
        });
        if (lessons.newLessons.length > 0 || lessons.reinforced.length > 0) {
          lessonSummary = `📚 **Lessons**: ${lessons.newLessons.length} new${lessons.newLessons.length ? ` (${lessons.newLessons.join(', ')})` : ''}, ${lessons.reinforced.length} reinforced`;
          console.log(`[Heartbeat] ${lessonSummary}`);
        }
        const lessonCount = new (await import('../learnings/lesson-store.js')).LessonStore(workspacePath).list().length;
        if (lessonCount > 30) {
          console.warn(`[Heartbeat] Lesson catalog at ${lessonCount} — consider pruning via !lessons`);
        }
      } catch (err) {
        console.warn('[Heartbeat] Lesson synthesis failed:', err instanceof Error ? err.message : err);
      }
    }

    // Reindex the document vault — mtime/hash driven, so an unchanged vault
    // costs a directory walk and nothing else
    if (deps.embeddingStore) {
      try {
        const { reindexVault } = await import('../knowledge/vault.js');
        const report = await reindexVault(config.vault.path, deps.embeddingStore, client);
        if (report.indexed.length > 0 || report.removed.length > 0) {
          console.log(`[Heartbeat] Vault: ${report.indexed.length} indexed, ${report.removed.length} removed, ${report.unchanged} unchanged`);
        }
      } catch (err) {
        console.warn('[Heartbeat] Vault reindex failed:', err instanceof Error ? err.message : err);
      }
    }

    // Curate skills — archive stale, flag duplicates
    try {
      const { SkillStore } = await import('../skills/store.js');
      const skillStore = new SkillStore(workspacePath);
      const allSkills = skillStore.listAll();
      const now = Date.now();
      const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
      let archived = 0;

      for (const skill of allSkills) {
        const lastUsedMs = new Date(skill.lastUsed || skill.created).getTime();
        if (now - lastUsedMs > THIRTY_DAYS && skill.successCount < 2) {
          skillStore.archive(skill.slug);
          archived++;
        }
      }
      if (archived > 0) console.log(`[Heartbeat] Archived ${archived} stale skill(s)`);
    } catch (err) {
      console.warn('[Heartbeat] Skill curation failed:', err instanceof Error ? err.message : err);
    }

    // Clean up old generated media files
    const cleaned = deps.cleanupOldMedia();
    if (cleaned > 0) {
      console.log(`[Heartbeat] Cleaned up ${cleaned} old media files`);
    }

    // --- Memory decay ---
    // Memory ops key on the principal — the delivery target is a channel alias
    const senderId = resolvePrincipal(hb.delivery.target, config);
    if (graphMemory && senderId) {
      try {
        const decay = await graphMemory.applyDecay(senderId);
        if (decay.removed > 0 || decay.reviewCandidates.length > 0) {
          console.log(`[Heartbeat] Memory decay: ${decay.removed} removed, ${decay.reviewCandidates.length} review candidates`);
        }
      } catch (err) {
        console.warn('[Heartbeat] Memory decay failed:', err instanceof Error ? err.message : err);
      }
    }

    // --- Intelligent memory management ---

    // Auto-cancel overdue tasks + remove duplicates
    if (taskStore) {
      try {
        const allTasks = taskStore.list();
        const now = new Date();
        now.setHours(0, 0, 0, 0);
        const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

        const overdue = allTasks.filter(t =>
          t.status === 'todo' && t.dueDate &&
          (now.getTime() - new Date(t.dueDate).getTime()) > SEVEN_DAYS,
        );
        for (const task of overdue) {
          taskStore.update(task.id, { status: 'cancelled' });
          console.log(`[Heartbeat] Auto-cancelled overdue task: "${task.title}" (due: ${task.dueDate})`);
          logAutonomousAction({ action: 'task_auto_cancel', tier: 'silent', source: 'heartbeat', reversible: true, outcome: 'success', detail: task.title });
        }

        const seen = new Map<string, string>();
        for (const task of allTasks) {
          if (task.status !== 'todo' && task.status !== 'in_progress') continue;
          const key = task.title.toLowerCase().replace(/[^a-z0-9]/g, '');
          if (seen.has(key)) {
            taskStore.update(task.id, { status: 'cancelled' });
            console.log(`[Heartbeat] Removed duplicate task: "${task.title}" (duplicate of ${seen.get(key)})`);
            logAutonomousAction({ action: 'task_dedup_cancel', tier: 'silent', source: 'heartbeat', reversible: true, outcome: 'success', detail: task.title });
          } else {
            seen.set(key, task.id);
          }
        }
      } catch (err) {
        console.warn('[Heartbeat] Task cleanup failed:', err instanceof Error ? err.message : err);
      }
    }

    // Auto-expire stale date-referenced facts
    if (factStore && senderId) {
      const expired = factStore.expireStaleDateFacts(senderId);
      if (expired.length > 0) {
        for (const e of expired) {
          factStore.recordRemoval(e.text, 'date_expired', senderId);
        }
        console.log(`[Heartbeat] Auto-expired ${expired.length} stale date-referenced fact(s)`);
      }
    }

    // Select facts for user review — waking hours only, AND throttled. The heartbeat runs every
    // ~2h, but surfacing "still accurate? !heartbeat yes/no" that often is review fatigue (the user
    // was answering it 6-7×/day). Gate the prompt to at most once per memory.reviewIntervalHours
    // (default 24h) via a persisted marker, and never stack a new batch on one not yet answered.
    const localHour = parseInt(new Date().toLocaleString('en-US', { timeZone: config.timezone, hour: 'numeric', hour12: false }));
    const isWakingHours = localHour >= 8 && localHour <= 22;
    let reviewCandidates: FactEntry[] = [];
    if (factStore && senderId && isWakingHours) {
      const pendingPath = deps.heartbeatPendingPath(workspacePath, senderId);
      const markerPath = join(dirname(pendingPath), 'heartbeat-review-marker.json');
      const intervalMs = (config.memory?.reviewIntervalHours ?? 24) * 3_600_000;
      let lastSurfacedAt = 0;
      try { lastSurfacedAt = new Date((JSON.parse(readFileSync(markerPath, 'utf-8')) as { surfacedAt: string }).surfacedAt).getTime() || 0; } catch { /* no prior review */ }
      const due = Date.now() - lastSurfacedAt >= intervalMs;
      const unanswered = existsSync(pendingPath);
      if (due && !unanswered) {
        reviewCandidates = factStore.selectReviewCandidates(senderId, 3);
        if (reviewCandidates.length > 0) {
          const pendingReview = {
            type: 'heartbeat_review',
            createdAt: new Date().toISOString(),
            senderId,
            facts: reviewCandidates.map(f => ({ id: f.id, text: f.text, category: f.category })),
          };
          writeFileSync(pendingPath, JSON.stringify(pendingReview, null, 2));
          writeFileSync(markerPath, JSON.stringify({ surfacedAt: new Date().toISOString() }));
        }
      }
    }

    // Maintenance tasks
    const executor = toolRegistry.createExecutor();
    const toolCtx = { agentId: config.agents.default, sessionKey: 'heartbeat', workspacePath, senderId: resolvePrincipal(hb.delivery.target, config) };

    try {
      const cleanupResult = await executor('memory_cleanup', {}, toolCtx);
      if (cleanupResult && !cleanupResult.includes('0 substring') && !cleanupResult.includes('No duplicates')) {
        console.log(`[Heartbeat] Memory cleanup: ${cleanupResult.slice(0, 100)}`);
      }
    } catch { /* best-effort */ }

    // --- Fact diff + LLM reasoning ---
    let memorySection = '';
    // Stale facts the LLM flagged — proposed for user review, never auto-deleted.
    // Autonomy principle: memory deletion is destructive-ish and model-judged, so
    // it stays at propose-and-confirm (the !heartbeat yes/no flow), not silent.
    let staleProposals: Array<{ index: number; text: string; category: string }> = [];
    if (factStore && senderId) {
      const diff = factStore.diffFacts(senderId);
      const recentlyRemoved = factStore.loadRecentlyRemoved(senderId);
      const now = new Date();

      const formatFact = (f: FactEntry) => {
        const age = Math.floor((now.getTime() - new Date(f.createdAt).getTime()) / (1000 * 60 * 60 * 24));
        const expiry = f.expiresAt ? `expires in ${Math.max(0, Math.floor((new Date(f.expiresAt).getTime() - now.getTime()) / (1000 * 60 * 60 * 24)))}d` : 'no expiry';
        return `- [${f.category}] "${f.text}" (conf: ${f.confidence}, age: ${age}d, ${expiry})`;
      };

      if (diff.newFacts.length === 0 && diff.removedHashes.length === 0 && diff.snapshotAge !== null) {
        memorySection = `Memory stable — ${diff.unchangedFacts.length} facts, no changes since last review.`;
        factStore.saveSnapshot(senderId);
        console.log('[Heartbeat] No fact changes — skipping LLM reasoning');
      } else {
        const snapshotAgeHours = diff.snapshotAge ? Math.round(diff.snapshotAge / (1000 * 60 * 60)) : null;
        const diffPrompt = [
          `You are reviewing the user's stored memory. Today is ${now.toLocaleDateString('en-US', { dateStyle: 'full' })}.`,
          snapshotAgeHours !== null ? `Last review was ${snapshotAgeHours} hours ago.` : 'This is the first memory review.',
          '',
          diff.newFacts.length > 0 ? `## New facts (${diff.newFacts.length})\n${diff.newFacts.map(formatFact).join('\n')}` : '',
          diff.unchangedFacts.length > 0 ? `## Unchanged facts (${diff.unchangedFacts.length})\n${diff.unchangedFacts.map(formatFact).join('\n')}` : '',
          diff.removedHashes.length > 0 ? `## Removed since last review: ${diff.removedHashes.length} fact(s)` : '',
          recentlyRemoved.length > 0 ? `## User explicitly removed\n${recentlyRemoved.map(r => `- "${r.text}" (reason: ${r.reason})`).join('\n')}` : '',
          '',
          'Reason about these facts:',
          '1. Are any facts likely stale or outdated based on the current date?',
          '2. Do any facts connect to each other in a meaningful way?',
          '3. Are any new facts contradicting existing ones?',
          '4. What is the most important thing to know about this user right now?',
          '',
          'Respond with JSON:',
          '{"observations": "2-3 bullet points, each one line max.", "stale_facts": ["exact text of stale facts"], "connections": "one sentence linking related facts, or empty string"}',
          'Return ONLY the JSON, no markdown fences.',
        ].filter(Boolean).join('\n');

        try {
          const response = await client.chat({
            model: heartbeatModel,
            messages: [{ role: 'user', content: diffPrompt }],
            options: { temperature: 0.3, num_predict: 8192 },
          });

          const raw = (response.message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
          try {
            const jsonMatch = raw.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[0]);
              memorySection = parsed.observations ?? '';

              if (Array.isArray(parsed.stale_facts) && parsed.stale_facts.length > 0) {
                staleProposals = proposeStaleFactsForReview(
                  parsed.stale_facts.filter((s: unknown): s is string => typeof s === 'string' && s.length > 5),
                  factStore,
                  senderId,
                  deps.heartbeatPendingPath(workspacePath, senderId),
                );
              }

              if (parsed.connections) {
                memorySection += `\n${parsed.connections}`;
              }
            } else {
              memorySection = raw.slice(0, 300);
            }
          } catch {
            memorySection = raw.slice(0, 300);
          }

          factStore.saveSnapshot(senderId);
          console.log(`[Heartbeat] Memory reasoning complete (${memorySection.length} chars)`);
        } catch (err) {
          console.warn('[Heartbeat] Memory reasoning failed:', err instanceof Error ? err.message : err);
        }
      }
    }

    // --- Task board ---
    const heartbeatTasks = cronService?.listByType('heartbeat') ?? [];
    const now2 = new Date();
    let taskSection = '';
    if (taskStore) {
      const allTasks = taskStore.list();
      const activeTasks = allTasks.filter(t => t.status === 'todo' || t.status === 'in_progress');

      if (activeTasks.length === 0) {
        taskSection = 'No active tasks.';
      } else {
        const enriched = enrichTasks(activeTasks, now2);
        const actions = getAutoActions(enriched);

        for (const t of actions.complete) {
          taskStore.update(t.id, { status: 'done' });
          console.log(`[Heartbeat] Auto-completed past event: "${t.title}"`);
          logAutonomousAction({ action: 'task_auto_complete', tier: 'act_then_notify', source: 'heartbeat', reversible: true, outcome: 'success', detail: t.title });
        }
        for (const t of actions.cancel) {
          taskStore.update(t.id, { status: 'cancelled' });
          console.log(`[Heartbeat] Auto-cancelled stale task: "${t.title}"`);
          logAutonomousAction({ action: 'task_auto_cancel', tier: 'act_then_notify', source: 'heartbeat', reversible: true, outcome: 'success', detail: t.title });
        }

        const forModel = filterForModel(enriched);

        if (forModel.length === 0) {
          taskSection = 'No tasks need attention right now.';
          if (actions.complete.length > 0 || actions.cancel.length > 0) {
            const parts: string[] = [];
            if (actions.complete.length > 0) parts.push(`Auto-completed: ${actions.complete.map(t => `"${t.title}"`).join(', ')}`);
            if (actions.cancel.length > 0) parts.push(`Auto-cancelled: ${actions.cancel.map(t => `"${t.title}"`).join(', ')}`);
            taskSection += `\n${parts.join('\n')}`;
          }
        } else {
          const taskBoard = formatTaskBoard(forModel);

          try {
            const taskResponse = await client.chat({
              model: heartbeatModel,
              messages: [{ role: 'user', content: [
                'Summarize these pre-analyzed tasks in 2-3 concise bullet points.',
                'Urgency labels are AUTHORITATIVE — do not override or reinterpret them.',
                'Do NOT add your own urgency assessments. Just describe what needs attention.',
                '', taskBoard, '',
                'Respond with ONLY JSON: {"summary": "bullet points"}',
              ].join('\n') }],
              options: { temperature: 0.3, num_predict: 8192 },
            });

            const taskRaw = (taskResponse.message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
            const taskJsonMatch = taskRaw.match(/\{[\s\S]*\}/);
            if (taskJsonMatch) {
              const parsed = JSON.parse(taskJsonMatch[0]);
              taskSection = parsed.summary || taskBoard;
            } else {
              taskSection = taskBoard;
            }
          } catch (err) {
            console.warn('[Heartbeat] Task summary failed, using deterministic output:', err instanceof Error ? err.message : err);
            taskSection = taskBoard;
          }

          if (actions.complete.length > 0 || actions.cancel.length > 0) {
            const parts: string[] = [];
            if (actions.complete.length > 0) parts.push(`Auto-completed: ${actions.complete.map(t => `"${t.title}"`).join(', ')}`);
            if (actions.cancel.length > 0) parts.push(`Auto-cancelled: ${actions.cancel.map(t => `"${t.title}"`).join(', ')}`);
            taskSection += `\n${parts.join('\n')}`;
          }
        }
      }
    }

    // Update user behavioral model
    if (graphMemory && senderId) {
      try {
        const recentTurns = await graphMemory.searchTurns('', senderId, 20);
        if (recentTurns.length >= 5) {
          const turnSummary = recentTurns.slice(0, 10).map(t => `${t.role}: ${t.text.slice(0, 100)}`).join('\n');

          const modelResponse = await client.chat({
            model: heartbeatModel,
            messages: [{
              role: 'user',
              content: `You are analyzing a user's behavior from their recent conversations. Read the interactions below and fill in SPECIFIC observations about this person.

Recent interactions:
${turnSummary}

Based on these interactions, describe this specific user. Example output:
{"communicationStyle":"direct and technical, prefers concise answers","decisionPattern":"data-driven, asks for verification before committing","topicInterests":"AI agents, local inference, podcast content, business automation","frustrationTriggers":"hallucinated data, wrong routing, verbose output"}

Now write YOUR analysis of THIS user. Return ONLY the JSON object with your specific observations, not generic descriptions. /no_think`,
            }],
            options: { temperature: 0.3, num_predict: 1024 },
          });

          const modelRaw = (modelResponse.message?.content ?? '').trim();
          const modelMatch = modelRaw.match(/\{[\s\S]*\}/);
          if (modelMatch) {
            let jsonStr = modelMatch[0];
            let parsed: Record<string, unknown>;
            try {
              parsed = JSON.parse(jsonStr);
            } catch {
              const start = modelRaw.indexOf('{');
              if (start !== -1) {
                let depth = 0;
                for (let ci = start; ci < modelRaw.length; ci++) {
                  if (modelRaw[ci] === '{') depth++;
                  else if (modelRaw[ci] === '}') depth--;
                  if (depth === 0) { jsonStr = modelRaw.slice(start, ci + 1); break; }
                }
              }
              parsed = JSON.parse(jsonStr);
            }
            const updates: Record<string, string> = {};
            for (const [k, v] of Object.entries(parsed)) {
              if (typeof v === 'string' && v.length > 0) updates[k] = v;
            }
            if (Object.keys(updates).length > 0) {
              await graphMemory.updateUserModel(senderId, updates);
            }
          }
        }
      } catch (err) {
        console.warn('[Heartbeat] User model update failed:', err instanceof Error ? err.message : err);
      }
    }

    // Update lastRunAt
    if (cronService) {
      for (const task of heartbeatTasks) {
        cronService.updateLastRun(task.id);
      }
    }

    // --- Build and deliver report ---
    if (hb.delivery.target) {
      const reportParts = ['📋 **Heartbeat Report**'];

      if (taskSection) {
        const formatted = taskSection.split('\n').filter((l: string) => l.trim()).map((l: string) => l.startsWith('-') || l.startsWith('•') ? l : `- ${l}`).join('\n');
        reportParts.push(`📌 **Tasks**\n${formatted}`);
      }

      if (memorySection) {
        const memLines = memorySection.split('\n').filter((l: string) => l.trim());
        const formatted = memLines.map((l: string) => `> ${l}`).join('\n');
        reportParts.push(`🧠 **Memory**\n${formatted}`);
      }

      if (lessonSummary) {
        reportParts.push(lessonSummary);
      }

      let reportText = reportParts.join('\n\n');

      if (reviewCandidates.length > 0) {
        const reviewSection = reviewCandidates
          .map((f, i) => `${i + 1}. \`${f.category}\` — ${f.text}`)
          .join('\n');
        const reviewHint = reviewCandidates.length > 1
          ? `↳ **!heartbeat yes** confirm all · **!heartbeat no** remove all · **!heartbeat no 2** remove one`
          : `↳ **!heartbeat yes** confirm · **!heartbeat no** remove`;
        reportText += `\n\n❓ **Memory check** — still accurate?\n${reviewSection}\n${reviewHint}`;
      }

      if (staleProposals.length > 0) {
        const staleSection = staleProposals
          .map(p => `${p.index}. \`${p.category}\` — ${p.text}`)
          .join('\n');
        // Consent honesty (July 30): commands act on the WHOLE pending set, so
        // the report must say how big that set is — never show 2 and act on 46
        let totalPending = staleProposals.length;
        try {
          const pf = JSON.parse(readFileSync(deps.heartbeatPendingPath(workspacePath, senderId!), 'utf-8')) as { facts: unknown[] };
          totalPending = pf.facts.length;
        } catch { /* file may be freshly consumed */ }
        const backlogNote = totalPending > staleProposals.length
          ? `\n(${totalPending} total awaiting review — **!heartbeat** to list them all)`
          : '';
        reportText += `\n\n🕰️ **Possibly outdated** — I think these are stale, but they stay until you say so:\n${staleSection}${backlogNote}\n↳ **!heartbeat no ${staleProposals[0].index}** to remove · **!heartbeat yes** to keep everything`;
      }

      await channelRegistry.send(
        { channel: hb.delivery.channel, channelId: hb.delivery.target },
        { text: reportText },
      );
    }

    // Update lastRunAt (duplicate call matches original)
    if (cronService) {
      for (const task of heartbeatTasks) {
        cronService.updateLastRun(task.id);
      }
    }
  } catch (err) {
    const wrapped = err instanceof InvarailError ? err : new InvarailError('TOOL_EXECUTION_ERROR', 'Heartbeat failed', err);
    console.error(`[Heartbeat] ${wrapped.code}: ${wrapped.message}`);
  }
}
