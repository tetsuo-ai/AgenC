import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WhisperAPIProvider, toTranscriptionProvider } from './stt.js';
import { VoiceTranscriptionError } from './errors.js';
import { RuntimeErrorCodes } from '../types/errors.js';

// ============================================================================
// Mock openai
// ============================================================================

const mockCreate = vi.fn();

vi.mock('openai', () => {
  return {
    default: class MockOpenAI {
      audio = {
        transcriptions: {
          create: mockCreate,
        },
      };
    },
  };
});

describe('WhisperAPIProvider', () => {
  let provider: WhisperAPIProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new WhisperAPIProvider({ apiKey: 'test-key' });
  });

  it('has correct name', () => {
    expect(provider.name).toBe('whisper-api');
  });

  it('transcribes audio and returns text', async () => {
    mockCreate.mockResolvedValue({ text: 'Hello world' });

    const audio = new Uint8Array([1, 2, 3]);
    const result = await provider.transcribe(audio);

    expect(result.text).toBe('Hello world');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('parses verbose response with language and duration', async () => {
    mockCreate.mockResolvedValue({
      text: 'Hello',
      language: 'en',
      duration: 2.5,
      segments: [
        { text: 'Hello', start: 0.0, end: 0.5 },
      ],
    });

    const result = await provider.transcribe(new Uint8Array([1]), {
      timestamps: true,
    });

    expect(result.text).toBe('Hello');
    expect(result.language).toBe('en');
    expect(result.durationMs).toBe(2500);
    expect(result.segments).toHaveLength(1);
    expect(result.segments![0].startMs).toBe(0);
    expect(result.segments![0].endMs).toBe(500);
  });

  it('passes language and prompt options', async () => {
    mockCreate.mockResolvedValue({ text: 'Bonjour' });

    await provider.transcribe(new Uint8Array([1]), {
      language: 'fr',
      prompt: 'French audio',
    });

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.language).toBe('fr');
    expect(callArgs.prompt).toBe('French audio');
  });

  it('passes signal for cancellation', async () => {
    mockCreate.mockResolvedValue({ text: 'test' });
    const controller = new AbortController();

    await provider.transcribe(new Uint8Array([1]), {
      signal: controller.signal,
    });

    const secondArg = mockCreate.mock.calls[0][1];
    expect(secondArg).toEqual({ signal: controller.signal });
  });

  it('wraps API errors in VoiceTranscriptionError', async () => {
    const apiError = new Error('Rate limit exceeded');
    (apiError as any).status = 429;
    mockCreate.mockRejectedValue(apiError);

    await expect(provider.transcribe(new Uint8Array([1])))
      .rejects
      .toThrow(VoiceTranscriptionError);

    try {
      await provider.transcribe(new Uint8Array([1]));
    } catch (err) {
      expect(err).toBeInstanceOf(VoiceTranscriptionError);
      const voiceErr = err as VoiceTranscriptionError;
      expect(voiceErr.providerName).toBe('whisper-api');
      expect(voiceErr.statusCode).toBe(429);
      expect(voiceErr.code).toBe(RuntimeErrorCodes.VOICE_TRANSCRIPTION_ERROR);
    }
  });

  it('handles string response', async () => {
    mockCreate.mockResolvedValue('Just text');

    const result = await provider.transcribe(new Uint8Array([1]));
    expect(result.text).toBe('Just text');
  });
});

describe('toTranscriptionProvider', () => {
  it('bridges SpeechToTextProvider to TranscriptionProvider', async () => {
    const mockSTT = {
      name: 'mock-stt',
      transcribe: vi.fn().mockResolvedValue({ text: 'Transcribed text' }),
    };

    const adapter = toTranscriptionProvider(mockSTT);
    const signal = new AbortController().signal;
    const text = await adapter.transcribe(
      new Uint8Array([1, 2]),
      'audio/ogg',
      signal,
    );

    expect(text).toBe('Transcribed text');
    expect(mockSTT.transcribe).toHaveBeenCalledTimes(1);
    const opts = mockSTT.transcribe.mock.calls[0][1];
    expect(opts.signal).toBe(signal);
    expect(opts.format.codec).toBe('ogg');
  });

  it('maps unknown MIME types to ogg', async () => {
    const mockSTT = {
      name: 'mock-stt',
      transcribe: vi.fn().mockResolvedValue({ text: 'ok' }),
    };

    const adapter = toTranscriptionProvider(mockSTT);
    await adapter.transcribe(
      new Uint8Array([1]),
      'audio/x-unknown',
      new AbortController().signal,
    );

    const opts = mockSTT.transcribe.mock.calls[0][1];
    expect(opts.format.codec).toBe('ogg');
  });

  it('maps audio/mpeg to mp3', async () => {
    const mockSTT = {
      name: 'mock-stt',
      transcribe: vi.fn().mockResolvedValue({ text: 'ok' }),
    };

    const adapter = toTranscriptionProvider(mockSTT);
    await adapter.transcribe(
      new Uint8Array([1]),
      'audio/mpeg',
      new AbortController().signal,
    );

    const opts = mockSTT.transcribe.mock.calls[0][1];
    expect(opts.format.codec).toBe('mp3');
  });
});
