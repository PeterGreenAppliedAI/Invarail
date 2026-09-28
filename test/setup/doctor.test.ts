import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { doctorChecks, ollamaModelsReferenced, formatDoctor } from '../../src/setup/doctor.js';
import type { DetectReport } from '../../src/setup/detect.js';
import type { InvarailConfig } from '../../src/config/types.js';

const base: DetectReport = {
  platform: 'mac',
  node: { version: '22.1.0', ok: true },
  ollama: { url: 'http://127.0.0.1:11434', reachable: true, models: ['qwen3:8b', 'phi4:latest'], modelSizes: { 'qwen3:8b': 5.2e9, 'phi4:latest': 9.1e9 }, install: 'brew install ollama' },
  memory: { totalGb: 16 },
  ollamaBackends: [],
  docker: { found: true, detail: 'server 29' },
  falkordb: { host: 'localhost', port: 6379, reachable: false, start: 'docker compose up -d falkordb' },
  searxng: { baseUrl: 'http://localhost:8080', state: 'unreachable', start: 'docker compose up -d searxng' },
  libreoffice: { found: false, detail: 'soffice not found', install: 'brew install --cask libreoffice' },
  python: { found: true, detail: 'Python 3.12' },
  obsidian: { found: false, detail: 'Obsidian not found', install: 'brew install --cask obsidian' },
  voice: { tts: { reachable: false, install: 'docker run … kokoro' }, stt: { reachable: false, install: 'docker run … whisper' } },
  config: { path: 'invarail.config.json5', present: true },
  env: { present: true },
};
const cfg = (over: Record<string, unknown> = {}) => ({
  ollama: { url: 'http://127.0.0.1:11434' },
  router: { model: 'phi4:latest', categories: {} },
  specialists: { chat: { model: 'qwen3:8b', tools: [] } },
  channels: { web: { enabled: true, host: '127.0.0.1', port: 3100 } },
  memory: {}, inference: {}, verification: { maxCrossChecks: 4 },
  ...over,
} as unknown as InvarailConfig);

describe('doctor', () => {
  it('lists every Ollama model the config references, skipping backend-served ones', () => {
    const c = cfg({ inference: { backends: [{ url: 'http://x', models: ['glm-5.3-flash'] }] }, specialists: { chat: { model: 'qwen3:8b', tools: [] }, code_gen: { model: 'glm-5.3-flash', tools: [] } } });
    expect(ollamaModelsReferenced(c).sort()).toEqual(['phi4:latest', 'qwen3:8b']);
  });

  it('a missing model is a WARN with the pull command; a present one passes', () => {
    const checks = doctorChecks(base, cfg({ specialists: { chat: { model: 'gemma4:12b', tools: [] } } }));
    const missing = checks.find(c => c.name === 'Model gemma4:12b')!;
    expect(missing.status).toBe('WARN'); expect(missing.fix).toBe('ollama pull gemma4:12b');
    expect(checks.find(c => c.name === 'Model phi4:latest')!.status).toBe('PASS');
  });

  it('missing config and unreachable Ollama are FAILs with fixes', () => {
    const checks = doctorChecks({ ...base, config: { path: 'invarail.config.json5', present: false }, ollama: { ...base.ollama, reachable: false } }, null);
    expect(checks.find(c => c.name === 'Config')).toMatchObject({ status: 'FAIL', fix: expect.stringContaining('npm run setup') });
    expect(checks.find(c => c.name === 'Ollama')).toMatchObject({ status: 'FAIL' });
  });

  it('web console: loopback passes, network+token passes, network without token FAILs, insecureOpen WARNs', () => {
    const w = (web: Record<string, unknown>) => doctorChecks(base, cfg({ channels: { web } })).find(c => c.name === 'Web console')!;
    expect(w({ enabled: true, host: '127.0.0.1' }).status).toBe('PASS');
    expect(w({ enabled: true, host: '0.0.0.0', token: 'x' }).status).toBe('PASS');
    expect(w({ enabled: true, host: '0.0.0.0' }).status).toBe('FAIL');
    expect(w({ enabled: true, host: '0.0.0.0', insecureOpen: true }).status).toBe('WARN');
  });

  it('searxng: json-disabled is a FAIL naming settings.yml; no daily ceiling is a WARN pointing at SEARXNG.md', () => {
    const c = cfg({ tools: { web: { search: { provider: 'searxng', baseUrl: 'http://localhost:8080', dailyQueryCeiling: 0 } } } });
    const checks = doctorChecks({ ...base, searxng: { ...base.searxng, state: 'json-disabled' } }, c);
    expect(checks.find(x => x.name === 'SearXNG')).toMatchObject({ status: 'FAIL', fix: expect.stringContaining('formats') });
    const pacing = checks.find(x => x.name === 'Search pacing')!;
    expect(pacing.status).toBe('WARN'); expect(pacing.detail).toMatch(/up to ~15 queries/); expect(pacing.fix).toMatch(/SEARXNG\.md/);
    const ok = doctorChecks({ ...base, searxng: { ...base.searxng, state: 'ok' } }, cfg({ tools: { web: { search: { provider: 'searxng', baseUrl: 'http://localhost:8080', dailyQueryCeiling: 250 } } } }));
    expect(ok.find(x => x.name === 'Search pacing')!.status).toBe('PASS');
  });

  it('docker exec configured but no docker is a FAIL (it would fall back to the host)', () => {
    const checks = doctorChecks({ ...base, docker: { found: false, detail: 'docker not found', install: 'brew install --cask docker' } }, cfg({ tools: { exec: { security: 'docker' } } }));
    expect(checks.find(c => c.name === 'Docker (exec sandbox)')!.status).toBe('FAIL');
  });

  it('quiet format shows only warnings and failures, with fixes', () => {
    const out = formatDoctor(doctorChecks(base, cfg()), { quiet: true });
    expect(out).not.toMatch(/\[PASS\]/);
    expect(out).toMatch(/\[WARN\] LibreOffice/);
    expect(out).toMatch(/fix: brew install --cask libreoffice/);
  });

  it('memory tier: graph without FalkorDB FAILs, flat/no embedder PASSes, an embedder that cannot sit beside the foreground WARNs', () => {
    const graphDown = doctorChecks(base, cfg({ memory: { backend: 'graph', embeddingModel: 'qwen3-embedding:8b' } })).find(c => c.name === 'Memory tier')!;
    expect(graphDown.status).toBe('FAIL'); expect(graphDown.fix).toMatch(/falkordb/);
    const flat = doctorChecks(base, cfg({ memory: { backend: 'flat', embeddingModel: 'none' } })).find(c => c.name === 'Memory tier')!;
    expect(flat.status).toBe('PASS'); expect(flat.detail).toMatch(/no embedder/);
    const big = { ...base, ollama: { ...base.ollama, models: ['qwen3:8b', 'qwen3-embedding:8b'], modelSizes: { 'qwen3:8b': 5.2e9, 'qwen3-embedding:8b': 10.9e9 } }, memory: { totalGb: 16, gpuVramGb: 8, gpuName: 'RTX 3070' } };
    const fit = doctorChecks(big, cfg({ memory: { backend: 'flat', embeddingModel: 'qwen3-embedding:8b' } })).find(c => c.name === 'Embedding model fits beside the foreground')!;
    expect(fit.status).toBe('WARN'); expect(fit.fix).toMatch(/0\.6b|"none"/);
  });

  it('vault tier: a missing folder WARNs; an OKF bundle is checked for conformance', () => {
    const missing = doctorChecks(base, cfg({ memory: { backend: 'vault', embeddingModel: 'none' }, vault: { path: '/nonexistent/vault', okf: false } })).find(c => c.name === 'Vault folder')!;
    expect(missing.status).toBe('WARN');
    const dir = mkdtempSync(join(tmpdir(), 'vault-doc-'));
    mkdirSync(join(dir, 'notes')); writeFileSync(join(dir, 'notes', 'a.md'), '# no type\n');
    const okf = doctorChecks(base, cfg({ memory: { backend: 'vault', embeddingModel: 'none' }, vault: { path: dir, okf: true } })).find(c => c.name === 'OKF bundle')!;
    expect(okf.status).toBe('WARN'); expect(okf.detail).toMatch(/notes\/a\.md/);
  });

  it('voice: an enabled TTS/STT with no server answering FAILs with the stack named; found servers PASS', () => {
    const off = doctorChecks(base, cfg({ tts: { enabled: true, url: 'http://127.0.0.1:5005' }, stt: { enabled: true, url: 'http://127.0.0.1:8000' } }));
    expect(off.find(c => c.name === 'Text-to-speech (Kokoro)')!.status).toBe('FAIL');
    expect(off.find(c => c.name === 'Speech-to-text (faster-whisper)')!.fix).toMatch(/whisper/);
    const found = { ...base, voice: { tts: { url: 'http://127.0.0.1:8880', reachable: true, install: '' }, stt: { url: 'http://127.0.0.1:8000', reachable: true, install: '' } } };
    expect(doctorChecks(found, cfg({ tts: { enabled: true, url: 'http://127.0.0.1:8880' } })).find(c => c.name === 'Text-to-speech (Kokoro)')!.status).toBe('PASS');
    expect(doctorChecks(base, cfg()).find(c => /Text-to-speech/.test(c.name))).toBeUndefined();   // off = nothing to check
  });

  it('prompt profile: warns when the profile disagrees with the foreground tier, either way', () => {
    // qwen3:8b is unmeasured and 5.2GB → small tier; the fixture config has no promptProfile → full
    const w = doctorChecks(base, cfg()).find(c => c.name === 'Prompt profile')!;
    expect(w.status).toBe('WARN'); expect(w.fix).toMatch(/promptProfile: "small"/);
    expect(doctorChecks(base, cfg({ promptProfile: 'small' })).find(c => c.name === 'Prompt profile')!.status).toBe('PASS');
    const big = { ...base, ollama: { ...base.ollama, models: ['big:70b'], modelSizes: { 'big:70b': 40e9 } } };
    const r = doctorChecks(big, cfg({ promptProfile: 'small', specialists: { chat: { model: 'big:70b', tools: [] } } })).find(c => c.name === 'Prompt profile')!;
    expect(r.status).toBe('WARN'); expect(r.fix).toMatch(/promptProfile: "full"/);
  });

  it('foreground fit: passes within budget, warns with a smaller-model fix when it does not', () => {
    const fits = doctorChecks(base, cfg()).find(c => c.name === 'Foreground model fits')!;
    expect(fits.status).toBe('PASS');   // 5.2GB vs 60% of 16GB
    const tight = doctorChecks({ ...base, memory: { totalGb: 8 } }, cfg()).find(c => c.name === 'Foreground model fits')!;
    expect(tight.status).toBe('WARN'); expect(tight.fix).toMatch(/qwen2\.5:7b/);
    const gpu = doctorChecks({ ...base, memory: { totalGb: 8, gpuVramGb: 12, gpuName: 'RTX 3060' } }, cfg()).find(c => c.name === 'Foreground model fits')!;
    expect(gpu.status).toBe('PASS'); expect(gpu.detail).toMatch(/RTX 3060/);
  });
});

describe('supervisor halt marker (third review N06)', () => {
  it('FAILs with the reason and the recovery steps when the marker exists', async () => {
    const { SUPERVISOR_HALT } = await import('../../src/setup/doctor.js');
    const dir = mkdtempSync(join(tmpdir(), 'halt-'));
    const prev = process.cwd(); process.chdir(dir);
    try {
      mkdirSync('data'); writeFileSync(SUPERVISOR_HALT, JSON.stringify({ reason: 'npm ci failed during rollback', sha: 'abcdef1234567890', at: '2026-09-28T03:00:00Z' }));
      const c = doctorChecks(base, cfg()).find(x => x.name === 'Supervisor halt')!;
      expect(c.status).toBe('FAIL'); expect(c.detail).toMatch(/npm ci failed during rollback/); expect(c.fix).toMatch(/delete data\/supervisor-halt\.json/);
      expect(doctorChecks(base, cfg()).find(x => x.name === 'Supervisor halt' && x.status === 'FAIL')).toBeDefined();
    } finally { process.chdir(prev); }
  });
});
