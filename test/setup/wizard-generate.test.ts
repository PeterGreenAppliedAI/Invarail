import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildConfig, buildEnv, type WizardState } from '../../src/setup/steps/generate.js';
import { ensureSearxngSecret } from '../../src/setup/steps/services.js';
import { loadConfig } from '../../src/config/loader.js';

// The wizard used to hand-template a config that drifted from the schema (ollama.host,
// no defaultModel, the router model as the voice model). Generation now round-trips
// through the real loader in this test.
const state: WizardState = {
  ollama: { url: 'http://127.0.0.1:11434', models: [] },
  models: { routerModel: 'phi4:latest', specialistModel: 'qwen3:8b', categoryModels: {}, inferenceBackends: [], backgroundModel: 'qwen3:8b' },
  channels: {
    discord: { enabled: false }, telegram: { enabled: false },
    web: { enabled: true, port: 3100, host: '0.0.0.0', token: 'a'.repeat(64) },
    ownerId: 'peter', trustedUsers: {},
  },
  services: {
    webSearch: { enabled: true, provider: 'searxng', baseUrl: 'http://localhost:8080', dailyQueryCeiling: 250 },
    tts: { enabled: true, url: 'http://127.0.0.1:8000' }, stt: { enabled: false },
    vision: { enabled: false }, browser: { enabled: false, headless: true },
    exec: { security: 'docker' }, graphMemory: { enabled: true }, heartbeat: { enabled: false },
    reasoning: { enabled: false }, imageGen: { enabled: false }, pi: { enabled: false },
  },
};

describe('wizard-generated config', () => {
  it('runs the arena fleet-wide and never the retired plan pipeline; a shared router model gets the session context', () => {
    const text = buildConfig(state);
    expect(text).not.toMatch(/pipeline: "plan"/);
    for (const cat of ['web_search', 'memory', 'exec', 'cron', 'task', 'multi']) {
      expect(text, cat).toMatch(new RegExp(`${cat}: \\{[^}]*dispatchMode: "arena"`));
    }
    expect(text).toMatch(/research: \{[^}]*pipeline: "research"/);
    expect(text).toMatch(/research: \{[^}]*"document"/);   // convert_pdf runs through the scoped executor
    expect(text).not.toMatch(/router: \{[^}]*contextSize/);   // dedicated phi4 router: engine default
    const shared: WizardState = { ...state, models: { ...state.models, routerModel: 'qwen3:8b' } };
    expect(buildConfig(shared)).toMatch(/router: \{[^}]*contextSize: 32768/);
    expect(buildConfig(shared)).toMatch(/extractionContextSize: 32768/);
  });

  it('parses through the real loader with defaultModel, an exposed console + token, searxng + ceiling, voice on the foreground model', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wizard-'));
    const path = join(dir, 'invarail.config.json5');
    writeFileSync(path, buildConfig(state));
    process.env.WEB_TOKEN = state.channels.web.token!;
    const c = loadConfig(path);
    expect((c as { defaultModel?: string }).defaultModel).toBe('qwen3:8b');
    expect(c.ollama.url).toBeTruthy();
    expect(c.channels.web).toMatchObject({ enabled: true, host: '0.0.0.0', port: 3100, token: state.channels.web.token });
    expect(c.tools?.web?.search).toMatchObject({ provider: 'searxng', baseUrl: 'http://localhost:8080', dailyQueryCeiling: 250 });
    expect(c.voice.model).toBe('qwen3:8b');
    expect(c.tools?.exec?.security).toBe('docker');
  });

  it('loopback console gets no token line; the env file carries WEB_TOKEN only when exposed', () => {
    const local: WizardState = { ...state, channels: { ...state.channels, web: { enabled: true, port: 3100, host: '127.0.0.1' } } };
    expect(buildConfig(local)).toMatch(/host: "127\.0\.0\.1"/);
    expect(buildConfig(local)).not.toMatch(/WEB_TOKEN/);
    expect(buildEnv(local)).not.toMatch(/WEB_TOKEN/);
    expect(buildEnv(state)).toMatch(/^WEB_TOKEN=a{64}$/m);
  });

  it('a hosted provider writes its API key env var and the same ceiling', () => {
    const hosted: WizardState = { ...state, services: { ...state.services, webSearch: { enabled: true, provider: 'brave', apiKey: 'k', dailyQueryCeiling: 250 } } };
    expect(buildEnv(hosted)).toMatch(/BRAVE_API_KEY=k/);
    expect(buildConfig(hosted)).toMatch(/provider: "brave"/);
    expect(buildConfig(hosted)).toMatch(/dailyQueryCeiling: 250/);
  });
});

describe('ensureSearxngSecret', () => {
  it('replaces the placeholder once and leaves a real key alone', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'sx-')), 'settings.yml');
    writeFileSync(p, 'server:\n  secret_key: "REPLACE-ME"\n');
    expect(ensureSearxngSecret(p)).toBe(true);
    const after = readFileSync(p, 'utf-8');
    expect(after).toMatch(/secret_key: "[0-9a-f]{64}"/);
    expect(ensureSearxngSecret(p)).toBe(false);
  });
});
