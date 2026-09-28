import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractMediaAttachments, defaultArtifactRoots } from '../../src/services/media-extraction.js';

// The [FILE:]/[IMAGE:] token is model-written text. Before 2026-09-27 the extractor read
// whatever path it named (outside review F04): a prompt-injected answer could attach .env.
// Delivery now requires the canonical path to sit under an allowed root (default <cwd>/data).
describe('extractMediaAttachments containment', () => {
  const root = mkdtempSync(join(tmpdir(), 'media-root-'));
  const outside = mkdtempSync(join(tmpdir(), 'media-outside-'));
  mkdirSync(join(root, 'documents'), { recursive: true });
  writeFileSync(join(root, 'documents', 'report.txt'), 'inside');
  writeFileSync(join(outside, 'secret.env'), 'TOKEN=abc');
  symlinkSync(join(outside, 'secret.env'), join(root, 'documents', 'link.txt'));
  const opts = { allowedRoots: [root] };

  it('attaches a file under an allowed root and strips the token', () => {
    const out = extractMediaAttachments(`Here you go [FILE:${join(root, 'documents', 'report.txt')}]`, opts);
    expect(out.attachments.map(a => a.filename)).toEqual(['report.txt']);
    expect(out.attachments[0].data.toString()).toBe('inside');
    expect(out.cleanText).toBe('Here you go');
  });

  it('refuses a path outside every root: nothing attached, token removed', () => {
    const out = extractMediaAttachments(`Attached: [FILE:${join(outside, 'secret.env')}]`, opts);
    expect(out.attachments).toEqual([]);
    expect(out.cleanText).toBe('Attached:');
  });

  it('refuses a symlink inside a root that points outside (canonical path decides)', () => {
    const out = extractMediaAttachments(`[FILE:${join(root, 'documents', 'link.txt')}]`, opts);
    expect(out.attachments).toEqual([]);
  });

  it('refuses traversal spelled through the root', () => {
    const out = extractMediaAttachments(`[IMAGE:${join(root, '..', 'nope.png')}] [FILE:${join(root, 'documents', '..', '..', 'x')}]`, opts);
    expect(out.attachments).toEqual([]);
  });

  it('keeps the token as text when the file simply does not exist (old behavior)', () => {
    const out = extractMediaAttachments(`[FILE:${join(root, 'documents', 'missing.pdf')}]`, opts);
    expect(out.attachments).toEqual([]);
    expect(out.cleanText).toContain('[FILE:');
  });

  it('defaults the root to <cwd>/data', () => {
    const outside = join(mkdtempSync(join(tmpdir(), 'outside-')), 'hosts.txt');
    writeFileSync(outside, 'not an artifact');   // exists, outside every root — on any OS
    const out = extractMediaAttachments(`[FILE:${outside}]`);
    expect(out.attachments).toEqual([]);
    expect(out.cleanText).toBe('');
  });
});

describe('default roots are artifact directories, not the whole data tree (re-review F04)', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'media-cwd-'));
  mkdirSync(join(cwd, 'data', 'media', 'documents'), { recursive: true });
  mkdirSync(join(cwd, 'data', 'workspaces', 'main', 'research', 'slug'), { recursive: true });
  mkdirSync(join(cwd, 'data', 'workspaces', 'main', 'memory'), { recursive: true });
  writeFileSync(join(cwd, 'data', 'secrets.json'), '{"token":"DUMMY"}');
  writeFileSync(join(cwd, 'data', 'media', 'documents', 'r.pdf'), 'pdf');
  writeFileSync(join(cwd, 'data', 'workspaces', 'main', 'research', 'slug', 'chart.png'), 'png');
  writeFileSync(join(cwd, 'data', 'workspaces', 'main', 'memory', 'facts.json'), '[]');
  writeFileSync(join(cwd, 'data', 'workspaces', 'main', 'SOUL.md'), 'persona');
  const opts = { allowedRoots: defaultArtifactRoots(cwd) };

  it('delivers from media and per-workspace artifact dirs', () => {
    const out = extractMediaAttachments(`[FILE:${join(cwd, 'data/media/documents/r.pdf')}] [IMAGE:${join(cwd, 'data/workspaces/main/research/slug/chart.png')}]`, opts);
    expect(out.attachments.map(a => a.filename).sort()).toEqual(['chart.png', 'r.pdf']);
  });
  it('refuses the secret store, memory, and workspace identity files even though they live under data/', () => {
    for (const p of ['data/secrets.json', 'data/workspaces/main/memory/facts.json', 'data/workspaces/main/SOUL.md']) {
      const out = extractMediaAttachments(`[FILE:${join(cwd, p)}]`, opts);
      expect(out.attachments, p).toEqual([]);
      expect(out.cleanText, p).toBe('');
    }
  });
});

describe('artifact roots are the ACTIVE agent\'s (third review F04)', () => {
  it('with an agent, another agent\'s research file is not attachable; data/media still is', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'media-agent-'));
    const mine = join(cwd, 'data', 'workspaces', 'main', 'research'); mkdirSync(mine, { recursive: true });
    const theirs = join(cwd, 'data', 'workspaces', 'other', 'research'); mkdirSync(theirs, { recursive: true });
    const media = join(cwd, 'data', 'media'); mkdirSync(media, { recursive: true });
    writeFileSync(join(mine, 'r.md'), 'mine'); writeFileSync(join(theirs, 'r.md'), 'theirs'); writeFileSync(join(media, 'm.png'), 'png');
    const roots = defaultArtifactRoots(cwd, 'main');
    expect(roots.some(r => r.includes(join('workspaces', 'main', 'research')))).toBe(true);
    expect(roots.some(r => r.includes(join('workspaces', 'other')))).toBe(false);
    const out = extractMediaAttachments(`[FILE:${join(theirs, 'r.md')}] and [FILE:${join(mine, 'r.md')}] and [FILE:${join(media, 'm.png')}]`, { allowedRoots: roots });
    expect(out.attachments.map(a => a.filename).sort()).toEqual(['m.png', 'r.md']);
    // legacy callers (no agent) keep every workspace, as before
    expect(defaultArtifactRoots(cwd).some(r => r.includes(join('workspaces', 'other')))).toBe(true);
  });
});
