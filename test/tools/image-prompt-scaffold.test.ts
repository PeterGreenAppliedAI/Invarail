import { describe, it, expect } from 'vitest';
import { scaffoldArtistic, scaffoldFor3D, applyScaffold } from '../../src/tools/image-prompt-scaffold.js';

describe('scaffoldArtistic', () => {
  it('preserves the model-composed intent and appends a quality tail', () => {
    const out = scaffoldArtistic('a mist-covered mountain village at dawn, watercolor style, muted palette');
    expect(out).toContain('mist-covered mountain village');
    expect(out).toContain('watercolor');
    expect(out).toMatch(/High detail/);
  });

  it('does not double punctuation', () => {
    expect(scaffoldArtistic('a red fox. ')).not.toContain('..');
  });
});

describe('scaffoldFor3D', () => {
  const out = scaffoldFor3D('knight chess piece, ornate');

  it('embeds the subject in the reconstruction grammar', () => {
    expect(out).toContain('knight chess piece');
    expect(out).toContain('centered');
    expect(out).toContain('neutral gray background');
    expect(out).toContain('diffuse');
  });

  it('forbids reconstruction noise: shadows, extra objects, text', () => {
    expect(out).toContain('no shadows');
    expect(out).toContain('no other objects');
    expect(out).toContain('no text');
  });

  it('grammar is fixed regardless of subject', () => {
    const a = scaffoldFor3D('dragon').replace('dragon', 'X');
    const b = scaffoldFor3D('teapot').replace('teapot', 'X');
    expect(a).toBe(b);
  });
});

describe('applyScaffold', () => {
  it('routes modes correctly and defaults to artistic', () => {
    expect(applyScaffold('model3d', 'fox')).toContain('neutral gray background');
    expect(applyScaffold('artistic', 'fox')).not.toContain('neutral gray background');
  });
});
