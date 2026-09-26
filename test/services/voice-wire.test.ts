import { describe, it, expect, vi, afterEach } from 'vitest';
import { TTSService } from '../../src/services/tts.js';
import { STTService } from '../../src/services/stt.js';
import { TTSConfigSchema, STTConfigSchema } from '../../src/config/schema.js';

afterEach(() => vi.unstubAllGlobals());

// The voice servers moved to mlx-audio on 2026-09-25, which resolves models by
// name (an HF repo id). The TTS client had 'tts-1' hardcoded; the STT client
// relied on the server's default response shape, which mlx-audio's is not.
describe('voice clients on the wire', () => {
  it('TTS sends the configured model, not a literal', async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const tts = new TTSService(TTSConfigSchema.parse({ enabled: true, url: 'http://voice.test:8000', model: 'mlx-community/Kokoro-82M-bf16', voice: 'af_bella', format: 'mp3' }));
    const out = await tts.synthesize('hello');
    expect(out?.length).toBe(3);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://voice.test:8000/v1/audio/speech');
    expect(JSON.parse(init.body as string)).toMatchObject({ model: 'mlx-community/Kokoro-82M-bf16', voice: 'af_bella', response_format: 'mp3', input: 'hello' });
  });

  it('TTS model still defaults to tts-1 for OpenAI-shaped servers', () => {
    expect(TTSConfigSchema.parse({}).model).toBe('tts-1');
  });

  it('STT asks for an OpenAI-shaped JSON reply and reads .text', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ text: ' take the garbage out ' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const stt = new STTService(STTConfigSchema.parse({ enabled: true, url: 'http://voice.test:8000', model: 'mlx-community/whisper-large-v3-turbo-asr-fp16', language: 'en' }));
    const text = await stt.transcribe(Buffer.from([0, 1, 2]), 'audio/webm');
    expect(text).toBe('take the garbage out');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://voice.test:8000/v1/audio/transcriptions');
    const form = init.body as FormData;
    expect(form.get('model')).toBe('mlx-community/whisper-large-v3-turbo-asr-fp16');
    expect(form.get('response_format')).toBe('json');
    expect(form.get('language')).toBe('en');
    expect((form.get('file') as File).name).toMatch(/^audio\./);
  });
});
