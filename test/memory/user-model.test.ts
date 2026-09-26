import { describe, it, expect } from 'vitest';
import { USER_MODEL_FIELDS, pickUserModelFields, renderUserModelSummary } from '../../src/memory/graph-store.js';

// 2026-09-26: the live UserModel node had 41 keys / 9,079 chars. The heartbeat's
// analysis model invents a new field name most cycles (actionPattern, emotionalProfile,
// topicInterworks…), the writer MERGEd every one, and the renderer printed every one —
// on every turn, text and voice, ~2K prompt tokens of it. Writer and renderer now close
// over the four declared fields.
describe('user model closed schema', () => {
  it('declares exactly the four fields the heartbeat prompt asks for', () => {
    expect([...USER_MODEL_FIELDS]).toEqual(['communicationStyle', 'decisionPattern', 'topicInterests', 'frustrationTriggers']);
  });

  it('pick keeps declared fields and drops invented ones, blanks, and non-strings', () => {
    const picked = pickUserModelFields({
      communicationStyle: ' direct ',
      decisionPattern: '',
      topicInterests: 42,
      frustrationTriggers: 'verbose output',
      emotionalProfile: 'calm',
      'm.senderId = "x" //': 'cypher smuggling',
    });
    expect(picked).toEqual({ communicationStyle: 'direct', frustrationTriggers: 'verbose output' });
  });

  it('render prints only declared fields, in declared order, skipping empties and drift', () => {
    const summary = renderUserModelSummary({
      senderId: 'peter',
      updatedAt: '2026-09-26T00:00:00Z',
      topicInterworks: 'drifted key from an old heartbeat',
      frustrationTriggers: 'hallucinated data',
      communicationStyle: 'direct and technical',
      decisionPattern: '',
    });
    expect(summary).toBe('- communication style: direct and technical\n- frustration triggers: hallucinated data');
  });

  it('render returns null when nothing declared is set', () => {
    expect(renderUserModelSummary({ senderId: 'peter', role: 'ml engineer' })).toBeNull();
  });
});
