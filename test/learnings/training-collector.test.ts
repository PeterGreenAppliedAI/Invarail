import { describe, it, expect } from 'vitest';
import { isSyntheticTurn } from '../../src/learnings/training-collector.js';

describe('isSyntheticTurn', () => {
  // The shapes actually found in data/training/router-pairs.jsonl on 2026-09-25.
  it('flags pipeline handoffs, system notices, and attachment stubs', () => {
    for (const s of [
      'Format the AI news stories into a structured document  Context from previous steps: Step 1 (web_search): …',
      '[SYSTEM] The user approved and image_generate has now run: Generated image saved to data/…',
      '[Attached file: /Users/petergreen/LocalClaw/data/uploads/discord_1489814382664876053_message.txt] (message.txt)',
      '[The user attached a PDF: roadmap.pdf. Extracted text below:]\n\n…',
      '[PAGE: https://x.test | Title]\n[PAGE_CONTENT]…',
    ]) expect(isSyntheticTurn(s), s.slice(0, 40)).toBe(true);
  });

  it('keeps real user messages, including ones that merely mention those words', () => {
    for (const s of [
      'What do you know about me',
      'the system prompt looks off, can you check the context from previous steps in that log?',
      'I attached the deck earlier, thoughts?',
      'take a screenshot of google.com',
    ]) expect(isSyntheticTurn(s), s).toBe(false);
  });
});

describe('isTrainingPair — sticky decisions are not labels (2026-09-26)', () => {
  const { isTrainingPair } = await import('../../src/learnings/training-collector.js');
  it('skips a user turn whose category was a sticky carry-over', () => {
    expect(isTrainingPair({ role: 'user', content: 'Eh it’s fine. I have a multi node proxmox cluster.', category: 'memory', routedBy: 'sticky' })).toBe(false);
  });
  it('keeps model, keyword and override decisions', () => {
    for (const routedBy of ['model', 'keyword', 'override']) {
      expect(isTrainingPair({ role: 'user', content: 'what did we discuss yesterday', category: 'memory', routedBy })).toBe(true);
    }
  });
  it('keeps turns recorded before routedBy existed', () => {
    expect(isTrainingPair({ role: 'user', content: 'remind me at 5pm', category: 'cron' })).toBe(true);
  });
});
