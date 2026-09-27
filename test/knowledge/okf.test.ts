import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFrontMatter, serializeFrontMatter, conceptForFact, writeIndexes, writeIndexesReport, appendLog, checkBundle, ensureFrontMatter, isReservedName, factConceptPath, GENERATED_MARK } from '../../src/knowledge/okf.js';

const vault = () => mkdtempSync(join(tmpdir(), 'okf-'));

describe('OKF front matter', () => {
  it('round-trips the queryable fields, lists, inline maps and a list of maps', () => {
    const text = serializeFrontMatter({
      type: 'Fact', title: 'Deploy freeze: 2026-09-01', description: 'The freeze starts 2026-09-01', tags: ['decision', 'ops'],
      generated: { by: 'invarail/heartbeat', at: '2026-09-27T10:00:00Z' },
      verified: [{ by: 'human:peter', at: '2026-09-27T10:00:00Z' }],
      stale_after: '2026-12-31T00:00:00Z',
    }, 'The freeze starts 2026-09-01.\n');
    const { data, body, hasFrontMatter } = parseFrontMatter(text);
    expect(hasFrontMatter).toBe(true);
    expect(data.type).toBe('Fact');
    expect(data.title).toBe('Deploy freeze: 2026-09-01');
    expect(data.tags).toEqual(['decision', 'ops']);
    expect(data.generated).toEqual({ by: 'invarail/heartbeat', at: '2026-09-27T10:00:00Z' });
    expect(data.verified).toEqual([{ by: 'human:peter', at: '2026-09-27T10:00:00Z' }]);
    expect(data.stale_after).toBe('2026-12-31T00:00:00Z');
    expect(body.trim()).toBe('The freeze starts 2026-09-01.');
  });

  it('tolerates a document with no front matter and one with unknown keys (§11)', () => {
    expect(parseFrontMatter('# Just a note\n\ntext').hasFrontMatter).toBe(false);
    const { data } = parseFrontMatter('---\ntype: Weird Thing\nmystery: 42\n---\nbody');
    expect(data.type).toBe('Weird Thing');
    expect(data.mystery).toBe('42');
  });

  it('reserved names are index.md and log.md only', () => {
    expect(isReservedName('index.md')).toBe(true);
    expect(isReservedName('business/LOG.md')).toBe(true);
    expect(isReservedName('indexes.md')).toBe(false);
  });
});

describe('facts as OKF concepts', () => {
  const base = { id: 'fact_1', text: 'Deployment freeze starts 2026-09-01', category: 'decision', createdAt: '2026-09-27T10:00:00Z', expiresAt: '2026-12-26T10:00:00Z', tags: ['ops'], entities: ['deployment'], importance: 4, confidence: 1, source: 'memory_save' };

  it('a STATED fact is human-verified; an observed one is generated only; inferred is a draft', () => {
    const stated = parseFrontMatter(conceptForFact({ ...base, provenance: 'stated' }, { owner: 'peter' })).data;
    expect(stated.type).toBe('Fact');
    expect(stated.verified).toEqual([{ by: 'human:peter', at: base.createdAt }]);
    expect(stated.generated).toEqual({ by: 'invarail/memory_save', at: base.createdAt });
    expect(stated.status).toBe('stable');
    expect(stated.stale_after).toBe(base.expiresAt);
    expect(stated.tags).toEqual(['decision', 'ops']);
    const observed = parseFrontMatter(conceptForFact({ ...base, provenance: 'observed' }, { owner: 'peter' })).data;
    expect(observed.verified).toBeUndefined();
    expect(parseFrontMatter(conceptForFact({ ...base, provenance: 'inferred' }, {})).data.status).toBe('draft');
  });
});

describe('index.md / log.md / conformance', () => {
  it('writes an index per domain and at the root from front matter, skipping reserved files', () => {
    const v = vault();
    mkdirSync(join(v, 'business'), { recursive: true });
    writeFileSync(join(v, 'business', 'onboarding.md'), serializeFrontMatter({ type: 'Playbook', title: 'Client onboarding', description: 'Kickoff doc and a shared channel in week one.' }, '# Client onboarding\n'));
    writeFileSync(join(v, 'business', 'plain.md'), '# Plain note\n\nno front matter\n');
    const written = writeIndexes(v, { title: 'Test vault' });
    expect(written).toHaveLength(2);
    const domain = readFileSync(join(v, 'business', 'index.md'), 'utf-8');
    expect(domain).toMatch(/\* \[Client onboarding\]\(onboarding\.md\) - Kickoff doc/);
    expect(domain).toMatch(/\* \[plain\]\(plain\.md\)/);   // no description, still listed
    expect(domain).not.toMatch(/index\.md/);
    const root = readFileSync(join(v, 'index.md'), 'utf-8');
    expect(root).toMatch(/okf_version: 0\.2/);
    expect(root).toMatch(/\* \[business\/\]\(business\/index\.md\) - 2 concept\(s\)/);
  });

  it('an existing Obsidian vault: nested notes are listed, nothing is cleared, and a person\'s own index.md / log.md is left alone', () => {
    const v = vault();
    mkdirSync(join(v, 'projects', 'invarail', 'ideas'), { recursive: true });
    mkdirSync(join(v, '.obsidian'));
    writeFileSync(join(v, '.obsidian', 'app.json'), '{}');
    writeFileSync(join(v, 'projects', 'invarail', 'roadmap.md'), '# Roadmap\n\nplain Obsidian note, no front matter\n');
    writeFileSync(join(v, 'projects', 'invarail', 'ideas', 'okf.md'), '---\ntype: Idea\ntitle: Adopt OKF\ndescription: front matter as the interface\n---\n');
    writeFileSync(join(v, 'projects', 'index.md'), '# My own projects index\n\nhand-written, keep me\n');
    writeFileSync(join(v, 'log.md'), '# My journal\n\nmine\n');
    const { written, skipped } = writeIndexesReport(v);
    expect(skipped).toEqual([join(v, 'projects', 'index.md')]);
    expect(readFileSync(join(v, 'projects', 'index.md'), 'utf-8')).toMatch(/hand-written, keep me/);
    expect(readFileSync(join(v, 'projects', 'invarail', 'index.md'), 'utf-8')).toMatch(/\* \[ideas\/\]\(ideas\/index\.md\) - 1 concept\(s\)/);
    expect(readFileSync(join(v, 'projects', 'invarail', 'index.md'), 'utf-8')).toMatch(/\* \[roadmap\]\(roadmap\.md\)/);   // no front matter, still listed as-is
    expect(readFileSync(join(v, 'projects', 'invarail', 'ideas', 'index.md'), 'utf-8')).toMatch(/\[Adopt OKF\]\(okf\.md\) - front matter as the interface/);
    expect(readFileSync(join(v, 'index.md'), 'utf-8')).toMatch(/\* \[projects\/\]\(projects\/index\.md\) - 2 concept\(s\)/);
    expect(written.every(p => readFileSync(p, 'utf-8').includes(GENERATED_MARK))).toBe(true);
    expect(readFileSync(join(v, 'projects', 'invarail', 'roadmap.md'), 'utf-8')).toBe('# Roadmap\n\nplain Obsidian note, no front matter\n');   // untouched
    appendLog(v, [{ kind: 'Creation', text: 'x' }]);
    expect(readFileSync(join(v, 'log.md'), 'utf-8')).toBe('# My journal\n\nmine\n');   // theirs, untouched
    // running again overwrites only what is ours
    const again = writeIndexesReport(v);
    expect(again.skipped).toEqual(skipped);
  });

  it('log.md is newest-first under ISO date headings and merges a same-day entry', () => {
    const v = vault();
    appendLog(v, [{ kind: 'Creation', text: 'first' }], new Date('2026-09-26T12:00:00Z'));
    appendLog(v, [{ kind: 'Update', text: 'second' }], new Date('2026-09-27T12:00:00Z'));
    appendLog(v, [{ kind: 'Removal', text: 'third' }], new Date('2026-09-27T13:00:00Z'));
    const log = readFileSync(join(v, 'log.md'), 'utf-8');
    expect(log.indexOf('## 2026-09-27')).toBeLessThan(log.indexOf('## 2026-09-26'));
    expect(log.match(/## 2026-09-27/g)).toHaveLength(1);
    expect(log).toMatch(/\*\*Removal\*\*: third/);
    expect(log).toMatch(/\*\*Creation\*\*: first/);
  });

  it('checkBundle reports notes without a type; ensureFrontMatter fixes them without touching the body', () => {
    const v = vault();
    mkdirSync(join(v, 'coding'));
    writeFileSync(join(v, 'coding', 'rubric.md'), '# Rubric\n\nNine gates.\n');
    writeFileSync(join(v, 'coding', 'ok.md'), '---\ntype: Note\n---\nfine\n');
    writeFileSync(join(v, 'coding', 'index.md'), '# coding\n');
    expect(checkBundle(v)).toEqual([{ file: 'coding/rubric.md', issue: 'no front matter' }]);
    expect(ensureFrontMatter(join(v, 'coding', 'rubric.md'), { type: 'Note' })).toBe(true);
    const fixed = readFileSync(join(v, 'coding', 'rubric.md'), 'utf-8');
    expect(fixed).toMatch(/^---\ntype: Note\ntitle: Rubric\n---\n/);
    expect(fixed).toMatch(/Nine gates\./);
    expect(checkBundle(v)).toEqual([]);
    expect(ensureFrontMatter(join(v, 'coding', 'ok.md'), { type: 'Note' })).toBe(false);
  });

  it('factConceptPath lives under the memory domain', () => {
    expect(factConceptPath('/v', 'fact_1')).toBe('/v/memory/fact_1.md');
    expect(existsSync('/v')).toBe(false);
  });
});
