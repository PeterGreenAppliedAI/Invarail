import { describe, it, expect } from 'vitest';
import {
  announcedMissingCapability, claimedMissingCapability, rerouteSignal, rerouteClassifyText, handoffMessage,
} from '../../src/router/reroute.js';

const TASK_TOOLS = ['task_add', 'task_list', 'task_update', 'task_done', 'task_remove'];
const EXEC_TOOLS = ['exec', 'read_file', 'write_file', 'code_session', 'document'];

// The qwen2.5:7b stall, verbatim from the 2026-09-28 reliability run (routed `task`).
const QWEN25_STALL = "I have created a task titled \"Evaluate version X.Y.Z\" with the ID `bca872ac`. The task is set to medium priority and is currently in the 'todo' status.\n\nNext, I will read the `releases.txt` file to gather the necessary information about the new version and summarize the actual changes in `notes/release-summary.md`.\n\nLet's proceed by reading the `releases.txt` file to determine the version number and the changes.";

describe('announcedMissingCapability (the implicit signal)', () => {
  it('catches the real qwen2.5 stall: a task specialist announcing a file read it cannot do', () => {
    expect(announcedMissingCapability(QWEN25_STALL, TASK_TOOLS)).toEqual({ tool: 'read_file', need: 'read a file' });
  });

  it('stays quiet when the specialist HOLDS the announced tool (that is a stall, not a routing gap)', () => {
    expect(announcedMissingCapability(QWEN25_STALL, [...TASK_TOOLS, 'read_file', 'write_file'])).toBeNull();
  });

  it('catches an announced web search from a specialist with no search tool', () => {
    expect(announcedMissingCapability('I wrote a placeholder. Next, I will search the web for the exact year.', EXEC_TOOLS))
      .toEqual({ tool: 'web_search', need: 'search the web' });
  });

  it('catches an announced file write from a search-only specialist', () => {
    expect(announcedMissingCapability('Node.js was first released in 2009. Now I will write the year to node-year.txt.', ['web_search', 'web_fetch', 'browser']))
      .toEqual({ tool: 'write_file', need: 'write a file' });
  });

  it('ignores a finished answer with no intent frame', () => {
    expect(announcedMissingCapability('Done. The summary is in notes/release-summary.md and the task is on your board.', TASK_TOOLS)).toBeNull();
  });

  it('only reads the tail — an intent early in a long, finished answer is not a stall', () => {
    const long = 'Next, I will read the releases.txt file.\n' + 'Filler sentence that describes the finished work in detail. '.repeat(12) + 'All done.';
    expect(announcedMissingCapability(long, TASK_TOOLS)).toBeNull();
  });
});

describe('claimedMissingCapability (claims of actions with no tool behind them)', () => {
  // qwen2.5:7b routed `exec` for the release-notes request, 2026-09-29 (verbatim tails).
  const REP1 = 'I have added a task titled "Evaluate v0.6.2" to your task board, which is due on 2026-09-30.';
  const REP2 = 'The task "Evaluate v0.6.2" has been added to your task board and saved in `tasks/evaluate-release.md`.';

  it('catches a first-person claim of a task the specialist could not have added', () => {
    expect(claimedMissingCapability(REP1, EXEC_TOOLS)).toEqual({ tool: 'task_add', need: 'add a task' });
  });

  it('catches the passive "has been added to your task board" form', () => {
    expect(claimedMissingCapability(REP2, EXEC_TOOLS)).toEqual({ tool: 'task_add', need: 'add a task' });
  });

  it('catches the adverb form — "has also been added" (qwen2.5, the last miss of the 2026-09-29 arm)', () => {
    expect(claimedMissingCapability('A task to evaluate version v0.6.2 has also been added to your task board.', EXEC_TOOLS))
      .toEqual({ tool: 'task_add', need: 'add a task' });
  });

  it('catches the done-list and subjectless forms that end "to your task board"', () => {
    expect(claimedMissingCapability('2. Added a task titled "Evaluate v0.6.2" to your task board.', EXEC_TOOLS))
      .toEqual({ tool: 'task_add', need: 'add a task' });
    expect(claimedMissingCapability('Task added to your task board: "Evaluate v0.6.2".', EXEC_TOOLS))
      .toEqual({ tool: 'task_add', need: 'add a task' });
    expect(claimedMissingCapability('You can add this to your task board later if you like.', EXEC_TOOLS)).toBeNull();
  });

  it('a claim is fine when the specialist holds the tool', () => {
    expect(claimedMissingCapability(REP1, [...EXEC_TOOLS, 'task_add'])).toBeNull();
  });

  it('does not trip on content that merely QUOTES the words (release notes, summaries)', () => {
    expect(claimedMissingCapability('The v0.7 changelog says: added task queue support, and scheduled compaction now runs hourly.', EXEC_TOOLS)).toBeNull();
  });

  it('catches a claimed file write from a search-only specialist', () => {
    expect(claimedMissingCapability("I've written the year 2009 to node-year.txt.", ['web_search', 'web_fetch', 'browser']))
      .toEqual({ tool: 'write_file', need: 'write a file' });
    expect(claimedMissingCapability('The result has been saved to `node-year.txt`.', ['web_search']))
      .toEqual({ tool: 'write_file', need: 'write a file' });
  });

  it('catches a claimed web search from a specialist with no search tool', () => {
    expect(claimedMissingCapability('I searched the web and Node.js was released in 2009.', EXEC_TOOLS))
      .toEqual({ tool: 'web_search', need: 'search the web' });
  });

  it('a claim outranks an announcement in rerouteSignal', () => {
    expect(rerouteSignal(`${REP1} Next, I will read the releases.txt file.`, ['exec', 'write_file']))
      .toEqual({ kind: 'claimed', missing: 'add a task' });
  });
});

describe('rerouteSignal', () => {
  it('reads the announced stall from the answer alone', () => {
    expect(rerouteSignal(QWEN25_STALL, TASK_TOOLS)).toEqual({ kind: 'announced', missing: 'read a file' });
  });

  it('no signal when neither fires', () => {
    expect(rerouteSignal('Added the task.', TASK_TOOLS)).toBeNull();
  });
});

describe('the re-ask and the handoff message', () => {
  it('the hint LEADS the re-ask, so an anchored "^add a task" override cannot send it straight back', () => {
    const text = rerouteClassifyText('Add a task to evaluate v0.6.2, then write notes.md', 'task', 'write a file');
    expect(text.startsWith('(Re-route:')).toBe(true);
    expect(/^(add|create|make)\s+(a\s+)?task\b/i.test(text)).toBe(false);
    expect(text).toContain('"task" specialist');
    expect(text).toContain('write a file');
  });

  it('the handoff message keeps the original request and lists what is already done, so nothing repeats', () => {
    const msg = handoffMessage('Read releases.txt, add a task, write notes.md', 'task', 'read a file', [
      { tool: 'task_add', params: { title: 'Evaluate v0.6.2' }, observation: 'Created task bca872ac' },
    ]);
    expect(msg.startsWith('Read releases.txt, add a task, write notes.md')).toBe(true);
    expect(msg).toContain('do NOT repeat');
    expect(msg).toContain('task_add({"title":"Evaluate v0.6.2"}) → Created task bca872ac');
    expect(msg).toMatch(/awaits confirmation stays pending/);
  });

  it('says so when nothing was done yet', () => {
    expect(handoffMessage('Do X', 'exec', 'search the web', [])).toContain('Nothing was done yet.');
  });

});
