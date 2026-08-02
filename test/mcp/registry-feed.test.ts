import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mapQueriesToLenses, appendGatherSignal, appendExecutionRecord } from '../../src/mcp/registry-feed.js';

describe('mapQueriesToLenses', () => {
  const facets = ['open-source models', 'model releases', 'hardware', 'policy'];

  it('maps queries to the overlapping facet name (stable lens)', () => {
    const lenses = mapQueriesToLenses(
      ['OpenAI Google Anthropic model releases this week', 'AI policy regulation developments 2026'],
      facets,
    );
    expect(lenses).toEqual(['model releases', 'policy']);
  });

  it('falls back to the raw query when nothing overlaps', () => {
    expect(mapQueriesToLenses(['quantum finance disruption'], facets)).toEqual(['quantum finance disruption']);
  });

  it('dedupes lenses when two queries hit the same facet', () => {
    const lenses = mapQueriesToLenses(
      ['new model releases from OpenAI', 'Anthropic model releases update'],
      facets,
    );
    expect(lenses).toEqual(['model releases']);
  });
});

describe('log appenders', () => {
  it('writes a contract-shaped signal record', () => {
    const dir = mkdtempSync(join(tmpdir(), 'regfeed-'));
    const log = join(dir, 'registry-log.jsonl');
    appendGatherSignal(log, 'weekly_gather', ['policy', 'hardware']);
    const rec = JSON.parse(readFileSync(log, 'utf8').trim());
    expect(rec).toMatchObject({ flow: 'weekly_gather', kind: 'signal', source: 'gap_check', lenses: ['policy', 'hardware'] });
    expect(typeof rec.ts).toBe('string');
  });

  it('writes a detection-contract execution record', () => {
    const dir = mkdtempSync(join(tmpdir(), 'regfeed-'));
    const log = join(dir, 'executions.jsonl');
    appendExecutionRecord(log, {
      id: 'x1', task: 'news digest', agent: 'test-model', ts: '2026-08-01T00:00:00Z',
      success: true, tokens: 1234, calls: [{ name: 'web_search', args: { q: 'ai' } }],
    });
    const rec = JSON.parse(readFileSync(log, 'utf8').trim());
    expect(rec.calls[0].name).toBe('web_search');
    expect(rec.success).toBe(true);
  });

  it('append failure is non-fatal', () => {
    expect(() => appendGatherSignal('/nonexistent-dir-xyz/log.jsonl', 'f', ['a'])).not.toThrow();
  });
});
