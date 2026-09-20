import { describe, it, expect } from 'vitest';
import { renderPrimingFacts } from '../../src/dispatch.js';

describe('renderPrimingFacts', () => {
  // The day-one state: provenance is new, nothing has been through !save yet,
  // so every fact is 'observed'. Marking here would hedge ALL of memory.
  it('marks nothing when every fact is the same class', () => {
    const { lines, note } = renderPrimingFacts([
      { text: 'Peter uses a 3060', provenance: 'observed' },
      { text: 'Peter runs Invarail', provenance: 'observed' },
    ]);
    expect(lines).toEqual(['- Peter uses a 3060', '- Peter runs Invarail']);
    expect(note).toBe('');
  });

  it('marks nothing when everything is stated', () => {
    const { lines, note } = renderPrimingFacts([{ text: 'Wife is Alex', provenance: 'stated' }]);
    expect(lines).toEqual(['- Wife is Alex']);
    expect(note).toBe('');
  });

  it('marks the weak classes once the set is mixed, leaving stated bare', () => {
    const { lines, note } = renderPrimingFacts([
      { text: 'Wife is Alex', provenance: 'stated' },
      { text: 'Peter prefers terse replies', provenance: 'observed' },
      { text: 'Peter works late', provenance: 'inferred' },
    ]);
    expect(lines).toEqual([
      '- Wife is Alex',
      '- Peter prefers terse replies [observed, unconfirmed]',
      '- Peter works late [inferred]',
    ]);
    expect(note).toContain('ask rather than assert');
  });

  it('handles an empty set', () => {
    expect(renderPrimingFacts([])).toEqual({ lines: [], note: '' });
  });
});
