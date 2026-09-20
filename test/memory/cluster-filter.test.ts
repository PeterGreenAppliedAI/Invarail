import { describe, it, expect } from 'vitest';
import { filterDegenerateClusters, type ClusterCandidate } from '../../src/memory/graph-store.js';

const c = (entity: string, n: number, importance = 3): ClusterCandidate => ({
  entity,
  facts: Array.from({ length: n }, (_, i) => `${entity} fact ${i}`),
  importance,
});

describe('filterDegenerateClusters', () => {
  // The shape actually measured on the live graph before this existed.
  it('drops the owner hub and the corpus stopword, keeps real themes', () => {
    const clusters = [c('Peter Green', 12), c('AI', 5), c('LocalClaw', 2), c('Router', 2)];
    const kept = filterDegenerateClusters(clusters, 24, { ownerNames: ['peter', 'Peter Green'] });
    expect(kept.map(k => k.entity)).toEqual(['AI', 'LocalClaw', 'Router']);
  });

  it('drops an entity attached to more than half the corpus', () => {
    const kept = filterDegenerateClusters([c('AI', 7), c('Blender', 2)], 12);
    expect(kept.map(k => k.entity)).toEqual(['Blender']);
  });

  it('keeps an entity exactly at the threshold — only above it is degenerate', () => {
    const kept = filterDegenerateClusters([c('AI', 6)], 12);
    expect(kept).toHaveLength(1);
  });

  it('matches owner names case- and whitespace-insensitively', () => {
    const kept = filterDegenerateClusters([c('  peter   green ', 2)], 100, { ownerNames: ['Peter Green'] });
    expect(kept).toHaveLength(0);
  });

  // Guard against the rule eating everything on a young graph: with 4 facts,
  // any 2-fact entity is already 50%+ and every cluster would vanish.
  it('does not apply the frequency rule below the minimum corpus size', () => {
    const kept = filterDegenerateClusters([c('Blender', 3), c('Invarail', 2)], 4);
    expect(kept).toHaveLength(2);
  });

  it('still applies the owner rule on a young graph', () => {
    const kept = filterDegenerateClusters([c('Peter Green', 3)], 4, { ownerNames: ['Peter Green'] });
    expect(kept).toHaveLength(0);
  });

  it('is a no-op with no owner names and a flat distribution', () => {
    const clusters = [c('A', 2), c('B', 2), c('C', 2)];
    expect(filterDegenerateClusters(clusters, 20)).toHaveLength(3);
  });

  it('tolerates an empty corpus without dividing by zero', () => {
    expect(filterDegenerateClusters([c('A', 2)], 0)).toHaveLength(1);
  });
});
