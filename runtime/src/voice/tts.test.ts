import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ElevenLabsProvider,
  OpenAITTSProvider,
  EdgeTTSProvider,
} from './tts.js';
import { VoiceSynthesisError } from './errors.js';
import { RuntimeErrorCodes } from '../types/errors.js';

// ============================================================================
// Mock openai (for OpenAITTSProvider)
// ============================================================================

const mockSpeechCreate = vi.fn();

vi.mock('openai', () => {
  return {
    default: class MockOpenAI {
      audio = {
        speech: {
          create: mockSpeechCreate,
        },
      };
    },
  };
});

// ============================================================================
// Mock edge-tts
// ============================================================================

const mockStream = vi.fn();
const mockListVoices = vi.fn();

vi.mock('edge-tts', () => {
  return {
    Communicate: class MockCommunicate {
      constructor(public text: string, public voice: string) {}
      stream = mockStream;
    },
    list_voices: mockListVoices,
  };
});

// ============================================================================
// Mock fetch (for ElevenLabsProvider)
// ============================================================================

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ============================================================================
// ElevenLabsProvider
// ============================================================================

describe('ElevenLabsProvider', () => {
  let provider: ElevenLabsProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ElevenLabsProvider({ apiKey: 'test-key' });
  });

  it('has correct name', () => {
    expect(provider.name).toBe('elevenlabs');
  });

  it('synthesizes text to audio', async () => {
    const audioData = new Uint8Array([10, 20, 30]);
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(audioData.buffer),
    });

    const result = await provider.synthesize('Hello');

    expect(result.audio).toEqual(audioData);
    expect(result.mimeType).toBe('audio/mpeg');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('text-to-speech/Rachel');
    expect(opts.method).toBe('POST');
  });

  it('uses custom voice', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    });

    await provider.synthesize('Hello', { voice: 'Adam' });
    expect(mockFetch.mock.calls[0][0]).toContain('text-to-speech/Adam');
  });

  it('passes speed as voice_settings', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    });

    await provider.synthesize('Hello', { speed: 1.5 });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.voice_settings.speed).toBe(1.5);
  });

  it('wraps HTTP errors in VoiceSynthesisError', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Unauthorized'),
    });

    try {
      await provider.synthesize('Hello');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(VoiceSynthesisError);
      const voiceErr = err as VoiceSynthesisError;
      expect(voiceErr.providerName).toBe('elevenlabs');
      expect(voiceErr.statusCode).toBe(401);
      expect(voiceErr.code).toBe(RuntimeErrorCodes.VOICE_SYNTHESIS_ERROR);
    }
  });

  it('lists voices from API', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        voices: [
          { voice_id: 'v1', name: 'Rachel', labels: { language: 'en', gender: 'female' } },
        ],
      }),
    });

    const voices = await provider.listVoices();
    expect(voices).toHaveLength(1);
    expect(voices[0].id).toBe('v1');
    expect(voices[0].name).toBe('Rachel');
    expect(voices[0].gender).toBe('female');
  });
});

// ============================================================================
// OpenAITTSProvider
// ============================================================================

describe('OpenAITTSProvider', () => {
  let provider: OpenAITTSProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new OpenAITTSProvider({ apiKey: 'test-key' });
  });

  it('has correct name', () => {
    expect(provider.name).toBe('openai-tts');
  });

  it('synthesizes text to audio', async () => {
    const audioData = new Uint8Array([1, 2, 3]);
    mockSpeechCreate.mockResolvedValue({
      arrayBuffer: () => Promise.resolve(audioData.buffer),
    });

    const result = await provider.synthesize('Hello');

    expect(result.audio).toEqual(audioData);
    expect(result.mimeType).toBe('audio/mpeg');
    expect(mockSpeechCreate).toHaveBeenCalledTimes(1);
    const params = mockSpeechCreate.mock.calls[0][0];
    expect(params.input).toBe('Hello');
    expect(params.voice).toBe('alloy');
    expect(params.model).toBe('tts-1');
  });

  it('passes voice and speed options', async () => {
    mockSpeechCreate.mockResolvedValue({
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    });

    await provider.synthesize('Hello', { voice: 'nova', speed: 1.5 });
    const params = mockSpeechCreate.mock.calls[0][0];
    expect(params.voice).toBe('nova');
    expect(params.speed).toBe(1.5);
  });

  it('passes format option', async () => {
    mockSpeechCreate.mockResolvedValue({
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    });

    const result = await provider.synthesize('Hello', { format: 'opus' });
    const params = mockSpeechCreate.mock.calls[0][0];
    expect(params.response_format).toBe('opus');
    expect(result.mimeType).toBe('audio/opus');
  });

  it('passes signal for cancellation', async () => {
    mockSpeechCreate.mockResolvedValue({
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    });
    const controller = new AbortController();

    await provider.synthesize('Hello', { signal: controller.signal });
    const secondArg = mockSpeechCreate.mock.calls[0][1];
    expect(secondArg).toEqual({ signal: controller.signal });
  });

  it('wraps errors in VoiceSynthesisError', async () => {
    const apiError = new Error('Server error');
    (apiError as any).status = 500;
    mockSpeechCreate.mockRejectedValue(apiError);

    try {
      await provider.synthesize('Hello');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(VoiceSynthesisError);
      const voiceErr = err as VoiceSynthesisError;
      expect(voiceErr.providerName).toBe('openai-tts');
      expect(voiceErr.statusCode).toBe(500);
    }
  });

  it('returns static voice list', async () => {
    const voices = await provider.listVoices();
    expect(voices.length).toBe(6);
    expect(voices.map(v => v.id)).toContain('alloy');
    expect(voices.map(v => v.id)).toContain('nova');
  });
});

// ============================================================================
// EdgeTTSProvider
// ============================================================================

describe('EdgeTTSProvider', () => {
  let provider: EdgeTTSProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new EdgeTTSProvider();
  });

  it('has correct name', () => {
    expect(provider.name).toBe('edge-tts');
  });

  it('synthesizes text by streaming chunks', async () => {
    const chunk1 = new Uint8Array([1, 2, 3]);
    const chunk2 = new Uint8Array([4, 5]);

    mockStream.mockReturnValue(
      (async function* () {
        yield { type: 'audio', data: chunk1 };
        yield { type: 'audio', data: chunk2 };
        yield { type: 'metadata', data: null };
      })(),
    );

    const result = await provider.synthesize('Hello');

    expect(result.audio).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    expect(result.mimeType).toBe('audio/mpeg');
  });

  it('uses custom voice', async () => {
    mockStream.mockReturnValue(
      (async function* () {
        yield { type: 'audio', data: new Uint8Array([1]) };
      })(),
    );

    const customProvider = new EdgeTTSProvider({ voice: 'en-GB-SoniaNeural' });
    await customProvider.synthesize('Hello');
    // Verifying no error — voice is passed to Communicate constructor
  });

  it('wraps errors in VoiceSynthesisError', async () => {
    mockStream.mockReturnValue(
      (async function* () {
        throw new Error('Connection failed');
      })(),
    );

    try {
      await provider.synthesize('Hello');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(VoiceSynthesisError);
      const voiceErr = err as VoiceSynthesisError;
      expect(voiceErr.providerName).toBe('edge-tts');
      expect(voiceErr.code).toBe(RuntimeErrorCodes.VOICE_SYNTHESIS_ERROR);
    }
  });

  it('lists voices from edge-tts module', async () => {
    mockListVoices.mockResolvedValue([
      { ShortName: 'en-US-AriaNeural', FriendlyName: 'Aria', Locale: 'en-US', Gender: 'Female' },
      { ShortName: 'en-US-GuyNeural', FriendlyName: 'Guy', Locale: 'en-US', Gender: 'Male' },
    ]);

    const voices = await provider.listVoices();
    expect(voices).toHaveLength(2);
    expect(voices[0].id).toBe('en-US-AriaNeural');
    expect(voices[0].name).toBe('Aria');
    expect(voices[0].language).toBe('en-US');
    expect(voices[0].gender).toBe('female');
  });
});
