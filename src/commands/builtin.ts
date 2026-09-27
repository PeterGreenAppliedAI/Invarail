/**
 * Built-in slash commands — every `!…` the orchestrator answers deterministically,
 * carved out of `handleMessage` on 2026-09-27 (orchestrator.ts had grown to 2,092
 * lines; both outside reviews named the command chain as the place to cut). This
 * is a behavior-preserving move: the same blocks, in the same order, reading the
 * same members through `CommandHost` instead of `this`. Returns true when the
 * message was a command and has been answered; false when it should proceed to
 * dispatch. The one non-`!` interaction (the "1"/"2" file-choice reply) stays in
 * the orchestrator because it mutates the message and falls through.
 */
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import type { InvarailConfig, FactInput } from '../config/types.js';
import type { InboundMessage } from '../channels/types.js';
import type { ConversationTurn } from '../sessions/types.js';
import type { OllamaClient } from '../ollama/client.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ChannelRegistry } from '../channels/registry.js';
import type { SessionStore } from '../sessions/store.js';
import type { PipelineRegistry } from '../pipeline/registry.js';
import type { ExecutionMetricsStore } from '../metrics/execution-store.js';
import type { SelfModService } from '../coding/self-mod-service.js';
import type { FactStore } from '../memory/fact-store.js';
import type { GraphMemoryStore } from '../memory/graph-store.js';
import type { MemoryCapture, CapturedFact } from '../services/memory-capture.js';
import { dispatchMessage } from '../dispatch.js';
import { logAutonomousAction } from '../metrics.js';
import { pendingActions } from '../security/pending-actions.js';
import { standingGrants } from '../security/grants.js';
import { isOwner } from '../identity/principal.js';
import { listDeadLetters } from '../cron/run-log.js';
import { buildAutonomyReport } from '../metrics/autonomy-report.js';
import { resolveRoute } from '../agents/resolve-route.js';
import { resolveWorkspacePath } from '../agents/scope.js';
import { InvarailError } from '../errors.js';
import { extractMediaAttachments } from '../services/media-extraction.js';
import { stripThinkingTags } from '../utils/text.js';
import { extractTrainingPairs } from '../learnings/training-collector.js';

/** What the command handlers need from the orchestrator — nothing more. */
export interface CommandHost {
  config: InvarailConfig;
  client: OllamaClient;
  toolRegistry: ToolRegistry;
  channelRegistry: ChannelRegistry;
  sessionStore: SessionStore;
  pipelineRegistry: PipelineRegistry;
  executionMetrics: ExecutionMetricsStore;
  selfModService?: SelfModService;
  factStore?: FactStore;
  graphMemory?: GraphMemoryStore;
  memoryCapture?: MemoryCapture;
  steeringQueues: Map<string, InboundMessage[]>;
  cancelRequests: Set<string>;
  pendingPath(workspacePath: string, senderId: string): string;
  heartbeatPendingPath(workspacePath: string, senderId: string): string;
  extractFacts(transcript: ConversationTurn[], recentlyRemoved?: Array<{ text: string; reason: string }>, senderId?: string): Promise<FactInput[]>;
  promoteRecurringLearnings(workspacePath: string): Promise<number>;
  confirmActionsFor(result: { pendingActions?: Array<{ id: string; tool: string }> }): Array<{ command: string; label: string; style?: 'primary' | 'success' | 'danger' }> | undefined;
}

/** The catch-all help line — kept next to the handlers so it cannot drift from them. */
export const COMMAND_HELP = 'Unknown command `%s`. Available:\n`!reset` `!save` `!discard` `!forget <term>` `!heartbeat` `!autonomy` `!grants` `!lessons` `!experiences` `!blender <request>` `!research <topic>` `!improve <change>`';

/**
 * @param trimmed  msg.content, trimmed and lower-cased — the same string the
 *                 orchestrator matched on before the carve-out
 * @returns true when handled (reply sent), false to continue to dispatch
 */
export async function runBuiltinCommand(host: CommandHost, msg: InboundMessage, principal: string, trimmed: string): Promise<boolean> {
  if (trimmed === '!new' || trimmed === '!reset') {
    const route = resolveRoute(
      { channel: msg.channel, senderId: msg.senderId, guildId: msg.guildId, channelId: msg.channelId },
      host.config,
    );
    const workspacePath = resolveWorkspacePath(route.agentId, host.config);

    // Load transcript BEFORE clearing
    const transcript = host.sessionStore.loadTranscript(route.agentId, route.sessionKey);

    // Preserve training data before clearing
    try { extractTrainingPairs(transcript); } catch { /* best-effort */ }

    host.sessionStore.clearSession(route.agentId, route.sessionKey);

    // Clear frozen workspace snapshot so next dispatch loads fresh context
    const { clearWorkspaceCache, clearCompactionCache } = await import('../dispatch.js');
    clearWorkspaceCache(route.sessionKey);
    clearCompactionCache(route.agentId, route.sessionKey);

    // Extract facts from what incremental capture has NOT already read — the
    // tail is capture-window-sized, so this never re-reads (and overflows on)
    // a whole long session. Everything capture stored during the session comes
    // along so !save can promote it: this is the review gate for those facts.
    const { tail, captured } = host.memoryCapture?.takeSessionTail(route.agentId, route.sessionKey, transcript)
      ?? { tail: transcript, captured: [] as CapturedFact[] };
    let replyText = 'Session cleared. Starting fresh!';
    try {
      const facts = await host.extractFacts(tail, undefined, principal);
      if (facts.length > 0 || captured.length > 0) {
        const userMemDir = join(workspacePath, 'memory', principal);
        mkdirSync(userMemDir, { recursive: true });
        const pending = {
          extractedAt: new Date().toISOString(),
          channel: msg.channel,
          channelId: msg.channelId,
          senderId: principal,
          facts,
          captured,
        };
        writeFileSync(host.pendingPath(workspacePath, principal), JSON.stringify(pending, null, 2));
        const parts: string[] = ['Session cleared.'];
        if (facts.length > 0) {
          const factList = facts.map((f, i) => `${i + 1}. [${f.category}] ${f.text} (conf: ${f.confidence})`).join('\n');
          parts.push(`I noticed some things worth remembering:\n\n${factList}`);
        }
        if (captured.length > 0) {
          const capturedList = captured.map((c, i) => `${i + 1}. ${c.text}`).join('\n');
          parts.push(`Captured during this session (currently unconfirmed):\n\n${capturedList}`);
        }
        parts.push('Reply **!save** to keep these as things you told me, or **!discard** to skip (captured ones stay, marked unconfirmed).');
        replyText = parts.join('\n\n');
      }
    } catch (err) {
      console.warn('[Orchestrator] Fact extraction failed:', err instanceof Error ? err.message : err);
    }

    await host.channelRegistry.send(
      { channel: msg.channel, channelId: msg.channelId!, replyToId: msg.id },
      { text: replyText },
    ).catch((err) => {
      console.warn('[Orchestrator] Failed to send session-reset reply:', err instanceof Error ? err.message : err);
    });
    return true;
  }

  if (trimmed === '!save') {
    const route = resolveRoute(
      { channel: msg.channel, senderId: msg.senderId, guildId: msg.guildId, channelId: msg.channelId },
      host.config,
    );
    const workspacePath = resolveWorkspacePath(route.agentId, host.config);
    const pendingFile = host.pendingPath(workspacePath, principal);

    let replyText: string;
    try {
      const raw = readFileSync(pendingFile, 'utf-8');
      const pending = JSON.parse(raw) as { facts: FactInput[]; senderId?: string; captured?: CapturedFact[] };
      const senderId = pending.senderId ?? principal;
      const captured = pending.captured ?? [];

      // !save is the ONLY path where a human reads the extracted facts and
      // confirms them, so it is the only one that may claim 'stated'. Every
      // other writer leaves the conservative 'observed' default.
      const facts: FactInput[] = pending.facts.map(f => ({ ...f, provenance: 'stated' as const }));

      // Write through FactStore (flat) + GraphMemory (graph)
      if (host.factStore) {
        await host.factStore.writeFactsBatch(facts, senderId, 'user/approved');
        host.factStore.rebuildFacts(senderId);
      }
      if (host.graphMemory) {
        for (const fact of facts) {
          try {
            await host.graphMemory.addFact(fact, senderId, route.sessionKey);
          } catch (err) {
            console.warn(`[Facts] Graph write failed for "${fact.text.slice(0, 50)}":`, err instanceof Error ? err.message : err);
          }
        }
      }

      // Promote what capture stored during the session: the owner has now read
      // the list, so observed → stated. Graph by id, flat store by text (it mints
      // its own ids). Best-effort per fact — a miss leaves it 'observed', never
      // wrongly 'stated'.
      let promoted = 0;
      if (captured.length > 0) {
        if (host.graphMemory) {
          for (const c of captured) {
            if (!c.id) continue;
            try {
              if (await host.graphMemory.setProvenance(c.id, 'stated')) promoted++;
            } catch (err) {
              console.warn(`[Facts] Promote failed for "${c.text.slice(0, 50)}":`, err instanceof Error ? err.message : err);
            }
          }
        }
        if (host.factStore) {
          try { host.factStore.setProvenanceByText(captured.map(c => c.text), senderId, 'stated'); }
          catch (err) { console.warn('[Facts] Flat-store promote failed:', err instanceof Error ? err.message : err); }
        }
        console.log(`[Facts] Promoted ${promoted}/${captured.length} captured fact(s) to stated`);
      }

      // Clean up pending
      unlinkSync(pendingFile);
      const n = pending.facts.length;
      replyText = `Saved ${n} fact${n === 1 ? '' : 's'} to memory.` + (captured.length > 0 ? ` Confirmed ${captured.length} captured during the session.` : '');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        replyText = 'Nothing pending to save.';
      } else {
        console.warn('[Orchestrator] Failed to save facts:', err instanceof Error ? err.message : err);
        replyText = 'Failed to save facts. Try again?';
      }
    }

    await host.channelRegistry.send(
      { channel: msg.channel, channelId: msg.channelId!, replyToId: msg.id },
      { text: replyText },
    ).catch((err) => {
      console.warn('[Orchestrator] Failed to send save reply:', err instanceof Error ? err.message : err);
    });
    return true;
  }

  if (trimmed === '!discard') {
    const route = resolveRoute(
      { channel: msg.channel, senderId: msg.senderId, guildId: msg.guildId, channelId: msg.channelId },
      host.config,
    );
    const workspacePath = resolveWorkspacePath(route.agentId, host.config);
    const pendingFile = host.pendingPath(workspacePath, principal);

    let replyText: string;
    try {
      unlinkSync(pendingFile);
      replyText = 'Discarded. Nothing saved.';
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        replyText = 'Nothing pending to discard.';
      } else {
        console.warn('[Orchestrator] Failed to discard pending:', err instanceof Error ? err.message : err);
        replyText = 'Failed to discard. Try again?';
      }
    }

    await host.channelRegistry.send(
      { channel: msg.channel, channelId: msg.channelId!, replyToId: msg.id },
      { text: replyText },
    ).catch((err) => {
      console.warn('[Orchestrator] Failed to send discard reply:', err instanceof Error ? err.message : err);
    });
    return true;
  }

  if (trimmed === '!cleanup') {
    const route = resolveRoute(
      { channel: msg.channel, senderId: msg.senderId, guildId: msg.guildId, channelId: msg.channelId },
      host.config,
    );
    const workspacePath = resolveWorkspacePath(route.agentId, host.config);

    const cleanupTool = host.toolRegistry.get('memory_cleanup');
    if (!cleanupTool) {
      await host.channelRegistry.send(
        { channel: msg.channel, channelId: msg.channelId!, replyToId: msg.id },
        { text: 'Memory cleanup tool not available.' },
      ).catch((err) => { console.warn('[Orchestrator] Send failed:', err instanceof Error ? err.message : err); });
      return true;
    }

    try {
      const result = await cleanupTool.execute({}, {
        agentId: route.agentId,
        sessionKey: route.sessionKey,
        workspacePath,
        senderId: principal,
      });
      await host.channelRegistry.send(
        { channel: msg.channel, channelId: msg.channelId!, replyToId: msg.id },
        { text: result },
      ).catch((err) => {
        console.warn('[Orchestrator] Failed to send cleanup reply:', err instanceof Error ? err.message : err);
      });
    } catch (err) {
      console.warn('[Orchestrator] Cleanup failed:', err instanceof Error ? err.message : err);
      await host.channelRegistry.send(
        { channel: msg.channel, channelId: msg.channelId!, replyToId: msg.id },
        { text: 'Memory cleanup failed. Try again later.' },
      ).catch((err) => { console.warn('[Orchestrator] Send failed:', err instanceof Error ? err.message : err); });
    }
    return true;
  }

  if (trimmed.startsWith('!heartbeat')) {
    const route = resolveRoute(
      { channel: msg.channel, senderId: msg.senderId, guildId: msg.guildId, channelId: msg.channelId },
      host.config,
    );
    const workspacePath = resolveWorkspacePath(route.agentId, host.config);
    const reviewFile = host.heartbeatPendingPath(workspacePath, principal);

    let replyText: string;
    try {
      const raw = readFileSync(reviewFile, 'utf-8');
      const pending = JSON.parse(raw) as {
        type: string;
        facts: Array<{ id: string; text: string; category: string }>;
        senderId: string;
      };

      const args = msg.content.trim().slice('!heartbeat'.length).trim().toLowerCase();

      if (args === 'yes' || args === 'confirm') {
        for (const f of pending.facts) {
          host.factStore?.boostConfidence(f.id, pending.senderId);
          logAutonomousAction({ action: 'fact_review', tier: 'propose_confirm', source: 'heartbeat', reversible: true, outcome: 'confirmed', detail: f.text.slice(0, 80) });
        }
        host.factStore?.rebuildFacts(pending.senderId);
        unlinkSync(reviewFile);
        replyText = `Confirmed ${pending.facts.length} fact(s). Confidence boosted.`;

      } else if (args.startsWith('no')) {
        const numMatch = args.match(/no\s+(\d+)/);
        const isNoAll = /^no\s+all$/.test(args);

        // Blast-radius guard (July 30 incident): bare "no" removed all 46
        // accumulated candidates when the report displayed 2. Mass removal
        // beyond a glanceable set requires seeing the list + "no all".
        const MASS_REMOVAL_THRESHOLD = 5;
        if (!numMatch && !isNoAll && pending.facts.length > MASS_REMOVAL_THRESHOLD) {
          const listing = pending.facts
            .map((f, i) => `${i + 1}. \`${f.category}\` — ${f.text.slice(0, 80)}`)
            .join('\n');
          replyText = `⚠️ ${pending.facts.length} facts are pending review — bare \`no\` would remove ALL of them. Nothing was removed.\n${listing}\n↳ **!heartbeat no <number>** for one · **!heartbeat no all** to really remove all ${pending.facts.length} · **!heartbeat yes** to keep everything`;
        } else {
          const toRemove = numMatch
            ? [pending.facts[parseInt(numMatch[1]) - 1]].filter(Boolean)
            : pending.facts;

          for (const f of toRemove) {
            host.factStore?.removeFact(f.text.slice(0, 40), pending.senderId);
            host.factStore?.recordRemoval(f.text, 'user_denied', pending.senderId);
            // Flat/graph must not diverge — the graph kept "removed" facts
            // alive (and injectable) until this sync landed
            await host.graphMemory?.removeFact(f.text.slice(0, 60), pending.senderId).catch(() => 0);
            logAutonomousAction({ action: 'fact_review', tier: 'propose_confirm', source: 'heartbeat', reversible: false, outcome: 'rejected', detail: f.text.slice(0, 80) });
          }
          host.factStore?.rebuildFacts(pending.senderId);

          if (numMatch && toRemove.length < pending.facts.length) {
            pending.facts = pending.facts.filter(f => !toRemove.includes(f));
            writeFileSync(reviewFile, JSON.stringify(pending, null, 2));
            // Positions shift after removal — show the CURRENT numbering so a
            // follow-up "!heartbeat no N" targets what the user is looking at
            const renumbered = pending.facts
              .map((f, i) => `${i + 1}. \`${f.category}\` — ${f.text.slice(0, 80)}`)
              .join('\n');
            replyText = `Removed "${toRemove[0]?.text.slice(0, 60)}". Still pending (numbers updated):\n${renumbered}`;
          } else {
            unlinkSync(reviewFile);
            replyText = `Removed ${toRemove.length} fact(s) from memory. They won't come back.`;
          }
        }

      } else if (args === '' || args === 'list') {
        // Visibility: the full actionable set, numbered — what any command acts on
        const listing = pending.facts
          .map((f, i) => `${i + 1}. \`${f.category}\` — ${f.text.slice(0, 80)}`)
          .join('\n');
        replyText = `🕰️ **${pending.facts.length} fact(s) pending review:**\n${listing}\n↳ **!heartbeat yes** keep all · **!heartbeat no <number>** remove one · **!heartbeat no all** remove all`;
      } else {
        replyText = 'Usage: **!heartbeat** (list pending), **!heartbeat yes** (keep all), **!heartbeat no 2** (remove #2), **!heartbeat no all** (remove all).';
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        replyText = 'No pending memory review. Wait for the next heartbeat.';
      } else {
        console.warn('[Orchestrator] Heartbeat review failed:', err instanceof Error ? err.message : err);
        replyText = 'Failed to process review. Try again.';
      }
    }

    await host.channelRegistry.send(
      { channel: msg.channel, channelId: msg.channelId!, replyToId: msg.id },
      { text: replyText },
    ).catch(err => {
      console.warn('[Orchestrator] Failed to send heartbeat review reply:', err instanceof Error ? err.message : err);
    });
    return true;
  }

  if (trimmed === '!promote') {
    const route = resolveRoute(
      { channel: msg.channel, senderId: msg.senderId, guildId: msg.guildId, channelId: msg.channelId },
      host.config,
    );
    const workspacePath = resolveWorkspacePath(route.agentId, host.config);

    const promoted = await host.promoteRecurringLearnings(workspacePath);
    const replyText = promoted > 0
      ? `Promoted ${promoted} recurring error patterns to LEARNINGS.md.`
      : 'No recurring patterns found to promote (need 3+ occurrences of the same error).';

    await host.channelRegistry.send(
      { channel: msg.channel, channelId: msg.channelId!, replyToId: msg.id },
      { text: replyText },
    ).catch((err) => {
      console.warn('[Orchestrator] Failed to send promote reply:', err instanceof Error ? err.message : err);
    });
    return true;
  }

  if (trimmed.startsWith('!autonomy')) {
    const args = trimmed.slice('!autonomy'.length).trim();
    const sinceDays = /^\d+$/.test(args) ? parseInt(args) : 30;
    const openProposals = pendingActions.listFor(principal);
    let replyText = buildAutonomyReport(undefined, sinceDays);
    if (openProposals.length > 0) {
      const openList = openProposals
        .map(p => `- \`${p.id}\` **${p.tool}** ${JSON.stringify(p.params).slice(0, 80)}`)
        .join('\n');
      replyText += `\n\n⏳ **Open proposals** (reply \`confirm <id>\`):\n${openList}`;
    }
    const deadLetters = listDeadLetters(5);
    if (deadLetters.length > 0) {
      replyText += `\n\n💀 **Recent background failures** (data/unrouted.jsonl):\n${deadLetters.map(d => `- ${d.at.slice(0, 16)} [${d.source}] ${d.detail}: ${d.error.slice(0, 80)}`).join('\n')}`;
    }
    await host.channelRegistry.send(
      { channel: msg.channel, channelId: msg.channelId!, replyToId: msg.id },
      { text: replyText },
    ).catch((err) => {
      console.warn('[Orchestrator] Failed to send autonomy report:', err instanceof Error ? err.message : err);
    });
    return true;
  }

  if (trimmed.startsWith('!improve')) {
    // Owner-only, and silently so — the command does not exist for anyone else.
    if (!isOwner(msg.senderId, host.config)) return true;
    const args = trimmed.slice('!improve'.length).trim();
    const target = { channel: msg.channel, channelId: msg.channelId!, replyToId: msg.id };
    let replyText: string;
    if (!host.selfModService) {
      replyText = 'Self-modification is disabled — set `selfMod.enabled: true` in config.';
    } else if (args === '' || args === 'status') {
      replyText = (args === '' ? 'Usage: `!improve <what to change>` · `!improve status` · `!improve retry` · `!improve abandon`\n' : '') + host.selfModService.status();
    } else if (args === 'abandon') {
      replyText = host.selfModService.abandon();
    } else if (args === 'retry') {
      replyText = '🔧 Re-gating the kept worktree against current main — rebase + gate results will follow.';
      void host.selfModService.retry(principal, msg.channel)
        .then(res => host.channelRegistry.send(target, { text: res.reply }))
        .catch(err => host.channelRegistry.send(target, { text: `Retry failed: ${err instanceof Error ? err.message : String(err)}` }))
        .catch(err => console.warn('[Orchestrator] Failed to send retry result:', err instanceof Error ? err.message : err));
    } else {
      replyText = `🔧 Self-mod session starting: "${args.slice(0, 120)}" — Pi builds in an isolated worktree; gate results and a confirm request will follow.`;
      void host.selfModService.propose(args, principal, msg.channel)
        .then(res => host.channelRegistry.send(target, { text: res.reply }))
        .catch(err => host.channelRegistry.send(target, { text: `Self-mod failed: ${err instanceof Error ? err.message : String(err)}` }))
        .catch(err => console.warn('[Orchestrator] Failed to send self-mod result:', err instanceof Error ? err.message : err));
    }
    await host.channelRegistry.send(target, { text: replyText }).catch((err) => {
      console.warn('[Orchestrator] Failed to send improve reply:', err instanceof Error ? err.message : err);
    });
    return true;
  }

  if (trimmed.startsWith('!grants')) {
    const args = trimmed.slice('!grants'.length).trim();
    let replyText: string;
    const revokeMatch = args.match(/^revoke\s+([a-f0-9]{6,12})$/i);
    if (revokeMatch) {
      const revoked = standingGrants.revoke(revokeMatch[1].toLowerCase(), principal);
      replyText = revoked
        ? `🔒 Revoked standing grant: **${revoked.tool}** → \`${revoked.target}\` — it will ask for confirmation again.`
        : `No grant with id \`${revokeMatch[1]}\` found for you.`;
    } else {
      const grants = standingGrants.listFor(principal);
      replyText = grants.length > 0
        ? `🔓 **Standing grants** (auto-approved tool→target pairs):\n${grants.map(g => `- \`${g.id}\` **${g.tool}** → \`${g.target}\` (since ${g.createdAt.split('T')[0]})`).join('\n')}\n\nRevoke with \`!grants revoke <id>\`.`
        : 'No standing grants. Reply `always <id>` to a confirmation preview to create one for that exact tool→target.';
    }
    await host.channelRegistry.send(
      { channel: msg.channel, channelId: msg.channelId!, replyToId: msg.id },
      { text: replyText },
    ).catch((err) => {
      console.warn('[Orchestrator] Failed to send grants reply:', err instanceof Error ? err.message : err);
    });
    return true;
  }

  if (/^!experiences?\b/.test(trimmed)) {
    const args = trimmed.replace(/^!experiences?\s*/, '').trim();
    const { sharedExperienceStore, experienceStoreConfigFrom } = await import('../memory/experience-store.js');
    const store = sharedExperienceStore(host.client, experienceStoreConfigFrom(host.config.memory));
    let replyText: string;
    const dropMatch = args.match(/^drop\s+(\S+)$/i);
    if (dropMatch) {
      const id = dropMatch[1];
      replyText = (await store.archive(id))
        ? `🗑️ Archived experience \`${id}\` — it will no longer be injected.`
        : `No experience with id \`${id}\`.`;
      if (replyText.startsWith('🗑️')) {
        logAutonomousAction({ action: 'experience_dropped', tier: 'propose_confirm', source: 'user_command', reversible: false, outcome: 'confirmed', detail: id });
      }
    } else {
      const experiences = await store.list();
      replyText = experiences.length > 0
        ? `🧭 **Experiences** (advisory only — inject at evidence ≥ 2):\n${experiences.slice(0, 20).map(x =>
            `- \`${x.id}\` (${x.evidenceCount}x${x.evidenceCount >= 2 ? ', LIVE' : ''}, ${x.satisfaction > 0 ? '👍' : x.satisfaction < 0 ? '👎' : '·'}, ${x.model}) — ${x.text.slice(0, 100)}`,
          ).join('\n')}\n\nDrop one with \`!experiences drop <id>\`.`
        : 'No experiences recorded yet — the heartbeat writes them when user signals (reactions, denials, corrections) pair with completed work.';
    }
    await host.channelRegistry.send(
      { channel: msg.channel, channelId: msg.channelId!, replyToId: msg.id },
      { text: replyText },
    ).catch((err) => {
      console.warn('[Orchestrator] Failed to send experiences reply:', err instanceof Error ? err.message : err);
    });
    return true;
  }

  if (trimmed.startsWith('!lessons')) {
    const args = trimmed.slice('!lessons'.length).trim();
    const route = resolveRoute(
      { channel: msg.channel, senderId: msg.senderId, guildId: msg.guildId, channelId: msg.channelId },
      host.config,
    );
    const workspacePath = resolveWorkspacePath(route.agentId, host.config);
    const { LessonStore, LESSON_EVIDENCE_FLOOR } = await import('../learnings/lesson-store.js');
    const { deleteLessonEmbedding } = await import('../learnings/lesson-semantic.js');
    const lessonStore = new LessonStore(workspacePath);
    let replyText: string;
    const dropMatch = args.match(/^drop\s+([a-z0-9-]+)$/i);
    if (dropMatch) {
      const slug = dropMatch[1].toLowerCase();
      if (lessonStore.archive(slug)) {
        deleteLessonEmbedding(slug);
        logAutonomousAction({ action: 'lesson_dropped', tier: 'propose_confirm', source: 'user_command', reversible: false, outcome: 'confirmed', detail: slug });
        replyText = `🗑️ Dropped lesson \`${slug}\` — it will no longer steer anything.`;
      } else {
        replyText = `No lesson named \`${slug}\`.`;
      }
    } else {
      const lessons = lessonStore.list();
      replyText = lessons.length > 0
        ? `📚 **Lessons** (steer at evidence ≥ ${LESSON_EVIDENCE_FLOOR}):\n${lessons.map(l =>
            `- \`${l.slug}\` (${l.evidenceCount}x${l.evidenceCount >= LESSON_EVIDENCE_FLOOR ? ', LIVE' : ''}${l.tool ? `, tool: ${l.tool}` : ''}, ${l.model}) — ${l.description.slice(0, 100)}`,
          ).join('\n')}\n\nDrop one with \`!lessons drop <slug>\`.`
        : 'No lessons recorded yet — the heartbeat writes them when failure patterns recur.';
    }
    await host.channelRegistry.send(
      { channel: msg.channel, channelId: msg.channelId!, replyToId: msg.id },
      { text: replyText },
    ).catch((err) => {
      console.warn('[Orchestrator] Failed to send lessons reply:', err instanceof Error ? err.message : err);
    });
    return true;
  }

  if (trimmed.startsWith('!forget')) {
    const query = msg.content.trim().slice('!forget'.length).trim();
    if (!query || query.length < 3) {
      await host.channelRegistry.send(
        { channel: msg.channel, channelId: msg.channelId!, replyToId: msg.id },
        { text: 'Usage: **!forget <search term>** — removes facts containing that text.' },
      ).catch(() => {});
      return true;
    }

    let removed = 0;
    // Graph memory
    if (host.graphMemory) {
      try { removed += await host.graphMemory.removeFact(query, principal); } catch { /* best-effort */ }
    }
    // Flat store
    if (host.factStore) {
      removed += host.factStore.removeFact(query, principal);
      host.factStore.recordRemoval(query, 'user_denied', principal);
    }

    const replyText = removed > 0
      ? `Removed ${removed} fact(s) matching "${query}" from memory.`
      : `No facts found matching "${query}". Try a different search term.`;

    await host.channelRegistry.send(
      { channel: msg.channel, channelId: msg.channelId!, replyToId: msg.id },
      { text: replyText },
    ).catch(() => {});
    return true;
  }

  // Explicit surface selection — router bypassed entirely. Born Aug 6: the
  // router sent blender traffic to exec (shell), memory, and image in one
  // evening; a dedicated surface deserves deterministic entry.
  if (trimmed.startsWith('!blender')) {
    const request = msg.content.trim().slice('!blender'.length).trim();
    if (!request) {
      await host.channelRegistry.send(
        { channel: msg.channel, channelId: msg.channelId!, replyToId: msg.id },
        { text: 'Usage: `!blender <request>`\n\nExamples:\n`!blender what is in my scene?`\n`!blender add a 20mm cube named base_plate`\nReads run instantly; scene changes ask for confirmation.' },
      ).catch(() => {});
      return true;
    }

    const route = resolveRoute(
      { channel: msg.channel, senderId: msg.senderId, guildId: msg.guildId, channelId: msg.channelId },
      host.config,
    );
    try {
      const result = await dispatchMessage({
        client: host.client,
        registry: host.toolRegistry,
        config: host.config,
        message: request,
        agentId: route.agentId,
        // Dedicated persistent session: every !blender turn shares one
        // transcript ("add a cube" ... "now make it taller" remembers),
        // isolated from the main chat session. Confirm continuations
        // return here too — the ledger records the sessionKey.
        sessionKey: `${route.sessionKey}:blender`,
        sessionStore: host.sessionStore,
        overrideCategory: 'blender',
        pipelineRegistry: host.pipelineRegistry,
        executionMetrics: host.executionMetrics,
        sourceContext: {
          channel: msg.channel,
          channelId: msg.channelId ?? '',
          guildId: msg.guildId,
          senderId: msg.senderId,
        },
        factStore: host.factStore,
      });
      await host.channelRegistry.send(
        { channel: msg.channel, channelId: msg.channelId!, replyToId: msg.id },
        { text: stripThinkingTags(result.answer), actions: host.confirmActionsFor(result) },
      );
    } catch (err) {
      const wrapped = err instanceof InvarailError ? err : new InvarailError('TOOL_EXECUTION_ERROR', 'Blender dispatch failed', err);
      console.error(`[Orchestrator] Blender command failed: ${wrapped.code}: ${wrapped.message}`);
      await host.channelRegistry.send(
        { channel: msg.channel, channelId: msg.channelId!, replyToId: msg.id },
        { text: `Blender request failed: ${wrapped.message}` },
      ).catch(() => {});
    }
    return true;
  }

  if (trimmed.startsWith('!research')) {
    const topic = msg.content.trim().slice('!research'.length).trim();

    if (!topic) {
      await host.channelRegistry.send(
        { channel: msg.channel, channelId: msg.channelId!, replyToId: msg.id },
        { text: 'Usage: `!research <topic>`\n\nExample: `!research AI regulation trends in 2026`\nProduces a researched PDF report.' },
      );
      return true;
    }

    const slug = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
    const route = resolveRoute(
      { channel: msg.channel, senderId: msg.senderId, guildId: msg.guildId, channelId: msg.channelId },
      host.config,
    );

    // Send progress indicator
    await host.channelRegistry.send(
      { channel: msg.channel, channelId: msg.channelId!, replyToId: msg.id },
      { text: `🔬 Researching: **${topic}**\nThis may take a few minutes...` },
    ).catch((err) => { console.warn('[Orchestrator] Send failed:', err instanceof Error ? err.message : err); });

    try {
      const today = new Date().toISOString().split('T')[0];
      const enhancedMessage = `[RESEARCH PIPELINE]\nTopic: ${topic}\nOutput slug: ${slug}\nCurrent date: ${today}\n\nProduce a thorough researched PDF report on this topic using the most recent data available (search for ${new Date().getFullYear()} data first).`;

      const result = await dispatchMessage({
        client: host.client,
        registry: host.toolRegistry,
        config: host.config,
        message: enhancedMessage,
        agentId: route.agentId,
        sessionKey: route.sessionKey,
        sessionStore: host.sessionStore,
        overrideCategory: 'research',
        pipelineRegistry: host.pipelineRegistry,
          executionMetrics: host.executionMetrics,
        sourceContext: {
          channel: msg.channel,
          channelId: msg.channelId ?? '',
          guildId: msg.guildId,
          senderId: msg.senderId,
        },
        factStore: host.factStore,
      });

      console.log(`[Orchestrator] Research complete: ${result.category} (${result.iterations} steps)`);

      // Check if a deck was generated
      const deckPath = `research/${slug}.html`;
      const workspacePath = resolveWorkspacePath(route.agentId, host.config);
      const fullDeckPath = join(workspacePath, deckPath);
      const deckExists = existsSync(fullDeckPath);

      // [FILE:] tokens must become ATTACHMENTS here like every other delivery path —
      // this handler sent result.answer raw, so a finished research PDF arrived in
      // Discord as the literal text "[FILE:data/media/documents/....pdf]" and the
      // report was never delivered (live-caught 2026-09-19).
      const media = extractMediaAttachments(result.answer);
      let response = media.cleanText || result.answer;
      if (deckExists) {
        response += `\n\n📊 **View your deck:** /console/api/files/${deckPath}`;
      }

      await host.channelRegistry.send(
        { channel: msg.channel, channelId: msg.channelId!, guildId: msg.guildId },
        { text: response, attachments: media.attachments.length > 0 ? media.attachments : undefined },
      );
    } catch (err) {
      const wrapped = err instanceof InvarailError ? err : new InvarailError('TOOL_EXECUTION_ERROR', 'Research pipeline failed', err);
      console.error(`[Orchestrator] Research failed: ${wrapped.code}: ${wrapped.message}`);
      await host.channelRegistry.send(
        { channel: msg.channel, channelId: msg.channelId!, guildId: msg.guildId },
        { text: `Research failed: ${wrapped.message}` },
      ).catch((err) => { console.warn('[Orchestrator] Send failed:', err instanceof Error ? err.message : err); });
    }
    return true;
  }

  // !stop — session-scoped cancellation of an in-flight tool loop. MUST live in the
  // command layer: the unknown-command catchall below eats every unrecognized "!"
  // before dispatch-side interception could see it (live-caught 2026-08-26: "!stop"
  // → "Unknown command" while a run was active — the steering-branch handler was dead code).
  if (trimmed === '!stop') {
    const route = resolveRoute(
      { channel: msg.channel, senderId: msg.senderId, guildId: msg.guildId, channelId: msg.channelId },
      host.config,
    );
    const steeringKey = `${route.agentId}:${route.sessionKey}`;
    const active = host.steeringQueues.has(steeringKey);
    if (active) host.cancelRequests.add(steeringKey);
    await host.channelRegistry.send(
      { channel: msg.channel, channelId: msg.channelId!, replyToId: msg.id },
      { text: active ? '🛑 Stopping the running task — it will halt at the next step boundary.' : 'Nothing is running on this session. (Note: pipeline runs — e.g. research — cannot be stopped mid-stage.)' },
    ).catch(() => {});
    return true;
  }

  // Unknown-command catchall: a "!" prefix is command INTENT — it must never
  // fall through to the router and get a model-improvised answer ("!experience"
  // got a hallucinated capability tour, Aug 10). Deterministic help instead.
  if (trimmed.startsWith('!') && !/^![12]\b/.test(trimmed)) {
    await host.channelRegistry.send(
      { channel: msg.channel, channelId: msg.channelId!, replyToId: msg.id },
      { text: COMMAND_HELP.replace('%s', trimmed.split(/\s/)[0]) },
    ).catch(() => {});
    return true;
  }

  return false;
}
