/**
 * Specialist reroute — the third routing lever (DECISIONS 2026-09-29).
 *
 * The router's pick decides a specialist's toolset. When the pick is wrong the specialist
 * does not stop — it improvises with the wrong tools: a `task` specialist with no file
 * tools creates the task and then announces "Next, I will read releases.txt" and stops.
 * The specialist is the only party that discovers the gap, because it finds out while it
 * works — and says so in its answer. This module turns that into ONE bounded re-dispatch.
 *
 * Signals are read from the model's OWN answer after it has worked — nothing is added to the
 * prompt. A `handoff` tool offered to every specialist was built first and measured harmful:
 * one extra tool made qwen3.5:9b emit malformed tool calls on the task board (2/5 vs 5/5) and
 * cost qwen2.5:7b exec accuracy (fib 7/10 vs 10/10). Removed the same night (DECISIONS
 * 2026-09-29).
 *
 * Rules (agreed with Peter before any code):
 *  1. A reroute never widens authority: the re-dispatch re-enters dispatchMessage, so all
 *     six security layers apply to the new category exactly as to a fresh message.
 *  2. The specialist never picks the category. Code reads what is missing; the router is
 *     re-asked with that hint, and code rejects a same-category answer.
 *  3. One reroute per message (`_reRouted`). A second gap ends with an honest reply.
 *  4. Confirm gates are untouched: anything the first specialist queued stays on the
 *     ledger as it was, and the handoff note says so.
 */

/**
 * The implicit signal: the loop ended with the model ANNOUNCING an action whose tool it
 * does not hold ("Next, I will read the releases.txt file", "Let's proceed by writing…").
 * Read from the tail of the model's own answer — a stall announces at the end.
 * Present-tense intent verbs, unlike the engine's past-tense claim map.
 */
const INTENT_TOOLS: Array<{ verb: RegExp; tool: string; need: string }> = [
  { verb: /\b(read(?:ing)?|open(?:ing)?)\b[^!?\n]{0,40}?\.(?:txt|md|csv|json|jsonl|py|js|ts|log|yaml|yml|html|xml|tsv)\b|\bread(?:ing)?\b[^.!?\n]{0,20}\bfile\b/i, tool: 'read_file', need: 'read a file' },
  { verb: /\b(writ(?:e|ing)|sav(?:e|ing)|updat(?:e|ing)|creat(?:e|ing)|append(?:ing)?)\b[^!?\n]{0,60}?(?:\.(?:txt|md|csv|json|jsonl|py|js|ts|log|yaml|yml|html|xml|tsv)\b|\bfile\b)/i, tool: 'write_file', need: 'write a file' },
  { verb: /\b(search(?:ing)?|look(?:ing)? up|googl(?:e|ing))\b[^.!?\n]{0,40}\b(web|online|internet)\b|\bsearch(?:ing)? (?:the web|online)\b/i, tool: 'web_search', need: 'search the web' },
  { verb: /\b(add(?:ing)?|creat(?:e|ing))\b[^.!?\n]{0,30}\b(task|to-?do)s?\b/i, tool: 'task_add', need: 'add a task' },
  { verb: /\bsend(?:ing)?\b[^.!?\n]{0,40}\b(message|dm)\b/i, tool: 'send_message', need: 'send a message' },
  { verb: /\bschedul(?:e|ing)\b/i, tool: 'cron_add', need: 'schedule a job' },
];

// The clause runs to a sentence end — a dot FOLLOWED BY WHITESPACE or the end. A bare dot is
// inside a filename (releases.txt), a version (v0.6.2) or a domain; cutting there hid the very
// filename the verb check needs (the verification splicer's version-number wound, again).
const INTENT_FRAME = /\b(?:next,?\s+i(?:'ll| will)|i(?:'ll| will)(?:\s+now|\s+next)?|let me|let'?s(?:\s+proceed(?:\s+(?:by|to|with))?)?|now i(?:'ll| will)?|i'?m going to|i am going to|i need to)\b((?:[^.!?\n]|[.!?](?=[^\s.!?]))*)/gi;

export function announcedMissingCapability(answer: string, tools: string[]): { tool: string; need: string } | null {
  const tail = answer.trim().slice(-500);
  if (!tail) return null;
  const held = new Set(tools);
  let m: RegExpExecArray | null;
  INTENT_FRAME.lastIndex = 0;
  while ((m = INTENT_FRAME.exec(tail)) !== null) {
    const clause = m[1] ?? '';
    for (const it of INTENT_TOOLS) {
      if (it.verb.test(clause) && !held.has(it.tool)) return { tool: it.tool, need: it.need };
    }
  }
  return null;
}

/**
 * The strongest implicit signal: the answer CLAIMS an action whose tool the specialist does
 * not hold — "I have added a task titled 'Evaluate v0.6.2' to your task board" from an `exec`
 * specialist with no task tools (qwen2.5:7b, 2 of 5 reps, 2026-09-29). The claim is false by
 * construction. Anchored to first person, "has been added to your board", or "added … to your
 * task board" (the done-list and subjectless forms), so a summary that QUOTES "added task
 * queue support" from release notes does not trip it.
 */
const FILE_EXT = '(?:txt|md|csv|json|jsonl|py|js|ts|log|yaml|yml|html|xml|tsv)';
const CLAIM_TOOLS: Array<{ claim: RegExp; tool: string; need: string }> = [
  { claim: /\bI(?:'ve| have)?\s+(?:also\s+)?(?:added|created|put)\b[^.!?\n]{0,60}\b(?:task|to-?do)s?\b|\b(?:task|to-?do)s?\b(?:[^.!?\n]|[.!?](?=[^\s.!?])){0,80}\b(?:has|have|was|were)\s+(?:also\s+|now\s+|already\s+)?(?:been\s+)?(?:added|created)\b[^.!?\n]{0,30}\b(?:board|list)\b|\b(?:added|created|put)\b(?:[^.!?\n]|[.!?](?=[^\s.!?])){0,80}?\bto (?:your|the) (?:task board|to-?do list)\b/i, tool: 'task_add', need: 'add a task' },
  { claim: new RegExp(`\\bI(?:'ve| have)?\\s+(?:also\\s+)?(?:written|wrote|saved)\\b[^!?\\n]{0,80}?\\.${FILE_EXT}\\b|\\b(?:has been|was)\\s+(?:written|saved)\\s+(?:to|in|as)\\s+[\`"']?[\\w\\-./]+\\.${FILE_EXT}\\b`, 'i'), tool: 'write_file', need: 'write a file' },
  { claim: /\bI(?:'ve| have)?\s+(?:also\s+)?(?:searched|looked up)\b[^.!?\n]{0,40}\b(?:web|online|internet)\b/i, tool: 'web_search', need: 'search the web' },
  { claim: /\bI(?:'ve| have)?\s+(?:also\s+)?sent\b[^.!?\n]{0,40}\b(?:message|dm)\b/i, tool: 'send_message', need: 'send a message' },
  { claim: /\bI(?:'ve| have)?\s+(?:also\s+)?scheduled\b/i, tool: 'cron_add', need: 'schedule a job' },
];

export function claimedMissingCapability(answer: string, tools: string[]): { tool: string; need: string } | null {
  const held = new Set(tools);
  for (const c of CLAIM_TOOLS) {
    if (!held.has(c.tool) && c.claim.test(answer)) return { tool: c.tool, need: c.need };
  }
  return null;
}

export interface RerouteSignal {
  /** claimed = the answer claims an action it has no tool for; announced = it ends announcing one. */
  kind: 'claimed' | 'announced';
  missing: string;
}

/** Reads the signals from a finished arena run's answer, strongest first: claimed (false by
 *  construction), then announced (the stall). */
export function rerouteSignal(answer: string, tools: string[]): RerouteSignal | null {
  const claimed = claimedMissingCapability(answer, tools);
  if (claimed) return { kind: 'claimed', missing: claimed.need };
  const announced = announcedMissingCapability(answer, tools);
  return announced ? { kind: 'announced', missing: announced.need } : null;
}

/** The text the router is re-asked with. The hint LEADS: the anchored pre-model overrides
 *  ("^add a task" → task) would otherwise match the original request again and send it
 *  straight back to the category that just gave up. */
export function rerouteClassifyText(message: string, fromCategory: string, missing: string): string {
  return `(Re-route: the "${fromCategory}" specialist could not finish this request — it needs to ${missing.replace(/^to\s+/i, '')}, which it has no tool for. Pick the category whose tools cover the WHOLE request.)\n\n${message}`;
}

/**
 * The message the second specialist receives: the ORIGINAL request, then what the first
 * specialist already did (so nothing is repeated — a second task_add would be a duplicate
 * on the owner's board), then anything still waiting on the owner's confirmation.
 */
export function handoffMessage(
  message: string,
  fromCategory: string,
  missing: string,
  steps: Array<{ tool?: string; params?: Record<string, unknown>; observation?: string }> | undefined,
): string {
  const done = (steps ?? [])
    .filter(s => s.tool)
    .map(s => {
      const params = JSON.stringify(s.params ?? {});
      const obs = (s.observation ?? '').replace(/\s+/g, ' ').trim();
      return `- ${s.tool}(${params.length > 160 ? params.slice(0, 160) + '…' : params}) → ${obs.length > 200 ? obs.slice(0, 200) + '…' : obs}`;
    });
  const lines = [
    message,
    '',
    `[Handoff: the "${fromCategory}" specialist started this and stopped because it needs to ${missing.replace(/^to\s+/i, '')}.`,
  ];
  if (done.length > 0) {
    lines.push('Already done — do NOT repeat these; anything that says it awaits confirmation stays pending for the user:');
    lines.push(...done);
  } else {
    lines.push('Nothing was done yet.');
  }
  lines.push('Finish the remaining parts of the request.]');
  return lines.join('\n');
}
