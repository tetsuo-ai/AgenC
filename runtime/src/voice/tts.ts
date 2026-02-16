/**
 * Text-to-speech provider implementations.
 *
 * @module
 */

import type {
  TextToSpeechProvider,
  TTSOptions,
  SynthesisResult,
  VoiceInfo,
} from './types.js';
import { VoiceSynthesisError } from './errors.js';
import { ensureLazyModule } from '../utils/lazy-import.js';

// ============================================================================
// Format → MIME mapping
// ============================================================================

const FORMAT_TO_MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  opus: 'audio/opus',
  flac: 'audio/flac',
};

// ============================================================================
// ElevenLabsProvider
// ============================================================================

const ELEVENLABS_API_BASE = 'https://api.elevenlabs.io/v1';

/** Configuration for the ElevenLabs TTS provider. */
export interface ElevenLabsProviderConfig {
  readonly apiKey: string;
  readonly voice?: string;
  readonly model?: string;
}

/**
 * Text-to-speech provider using the ElevenLabs API.
 *
 * Uses raw `fetch()` — no additional SDK dependency.
 */
export class ElevenLabsProvider implements TextToSpeechProvider {
  readonly name = 'elevenlabs';

  private readonly config: ElevenLabsProviderConfig;

  constructor(config: ElevenLabsProviderConfig) {
    this.config = config;
  }

  async synthesize(text: string, options?: TTSOptions): Promise<SynthesisResult> {
    const voiceId = options?.voice ?? this.config.voice ?? 'Rachel';
    const format = options?.format ?? 'mp3';
    const url = `${ELEVENLABS_API_BASE}/text-to-speech/${voiceId}`;

    const body: Record<string, unknown> = {
      text,
      model_id: this.config.model ?? 'eleven_monolingual_v1',
    };
    if (options?.speed != null) {
      body['voice_settings'] = { stability: 0.5, similarity_boost: 0.5, speed: options.speed };
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'xi-api-key': this.config.apiKey,
          'Content-Type': 'application/json',
          'Accept': FORMAT_TO_MIME[format] ?? 'audio/mpeg',
        },
        body: JSON.stringify(body),
        signal: options?.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new VoiceSynthesisError(this.name, errorText, response.status);
      }

      const arrayBuffer = await response.arrayBuffer();
      return {
        audio: new Uint8Array(arrayBuffer),
        mimeType: FORMAT_TO_MIME[format] ?? 'audio/mpeg',
      };
    } catch (err: unknown) {
      if (err instanceof VoiceSynthesisError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new VoiceSynthesisError(this.name, message);
    }
  }

  async listVoices(): Promise<readonly VoiceInfo[]> {
    try {
      const response = await fetch(`${ELEVENLABS_API_BASE}/voices`, {
        headers: { 'xi-api-key': this.config.apiKey },
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new VoiceSynthesisError(this.name, errorText, response.status);
      }

      const data = await response.json() as { voices?: any[] };
      return (data.voices ?? []).map((v: any) => ({
        id: v.voice_id,
        name: v.name,
        language: v.labels?.language ?? 'en',
        gender: v.labels?.gender as VoiceInfo['gender'],
      }));
    } catch (err: unknown) {
      if (err instanceof VoiceSynthesisError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new VoiceSynthesisError(this.name, message);
    }
  }
}

// ============================================================================
// OpenAITTSProvider
// ============================================================================

/** Configuration for the OpenAI TTS provider. */
export interface OpenAITTSProviderConfig {
  readonly apiKey: string;
  readonly voice?: string;
  readonly model?: string;
  readonly baseURL?: string;
}

const DEFAULT_TTS_MODEL = 'tts-1';
const DEFAULT_TTS_VOICE = 'alloy';

/** Static list of OpenAI TTS voices. */
const OPENAI_VOICES: readonly VoiceInfo[] = [
  { id: 'alloy', name: 'Alloy', language: 'en', gender: 'neutral' },
  { id: 'echo', name: 'Echo', language: 'en', gender: 'male' },
  { id: 'fable', name: 'Fable', language: 'en', gender: 'neutral' },
  { id: 'onyx', name: 'Onyx', language: 'en', gender: 'male' },
  { id: 'nova', name: 'Nova', language: 'en', gender: 'female' },
  { id: 'shimmer', name: 'Shimmer', language: 'en', gender: 'female' },
];

/**
 * Text-to-speech provider using the OpenAI TTS API.
 *
 * Lazily loads the `openai` package on first use.
 */
export class OpenAITTSProvider implements TextToSpeechProvider {
  readonly name = 'openai-tts';

  private client: unknown | null = null;
  private readonly config: OpenAITTSProviderConfig;

  constructor(config: OpenAITTSProviderConfig) {
    this.config = config;
  }

  private async ensureClient(): Promise<unknown> {
    if (this.client) return this.client;

    this.client = await ensureLazyModule(
      'openai',
      (msg) => new VoiceSynthesisError(this.name, msg),
      (mod) => {
        const OpenAI = (mod.default ?? mod['OpenAI']) as new (opts: Record<string, unknown>) => unknown;
        return new OpenAI({
          apiKey: this.config.apiKey,
          ...(this.config.baseURL ? { baseURL: this.config.baseURL } : {}),
        });
      },
    );
    return this.client;
  }

  async synthesize(text: string, options?: TTSOptions): Promise<SynthesisResult> {
    const client = await this.ensureClient() as any;
    const voice = options?.voice ?? this.config.voice ?? DEFAULT_TTS_VOICE;
    const format = options?.format ?? 'mp3';

    const params: Record<string, unknown> = {
      model: this.config.model ?? DEFAULT_TTS_MODEL,
      input: text,
      voice,
      response_format: format,
    };
    if (options?.speed != null) params['speed'] = options.speed;

    try {
      const response = await client.audio.speech.create(
        params,
        options?.signal ? { signal: options.signal } : undefined,
      );
      const arrayBuffer = await response.arrayBuffer();
      return {
        audio: new Uint8Array(arrayBuffer),
        mimeType: FORMAT_TO_MIME[format] ?? 'audio/mpeg',
      };
    } catch (err: unknown) {
      if (err instanceof VoiceSynthesisError) throw err;
      const status = (err as any)?.status;
      const message = err instanceof Error ? err.message : String(err);
      throw new VoiceSynthesisError(this.name, message, status);
    }
  }

  async listVoices(): Promise<readonly VoiceInfo[]> {
    return OPENAI_VOICES;
  }
}

// ============================================================================
// EdgeTTSProvider
// ============================================================================

/** Configuration for the Edge TTS provider. */
export interface EdgeTTSProviderConfig {
  readonly voice?: string;
}

const DEFAULT_EDGE_VOICE = 'en-US-AriaNeural';

/**
 * Text-to-speech provider using Microsoft Edge's free TTS service.
 *
 * Lazily loads the `edge-tts` package on first use.
 */
export class EdgeTTSProvider implements TextToSpeechProvider {
  readonly name = 'edge-tts';

  private edgeTts: any | null = null;
  private readonly config: EdgeTTSProviderConfig;

  constructor(config?: EdgeTTSProviderConfig) {
    this.config = config ?? {};
  }

  private async ensureModule(): Promise<any> {
    if (this.edgeTts) return this.edgeTts;

    this.edgeTts = await ensureLazyModule(
      'edge-tts',
      (msg) => new VoiceSynthesisError(this.name, msg),
      (mod) => mod,
    );
    return this.edgeTts;
  }

  async synthesize(text: string, options?: TTSOptions): Promise<SynthesisResult> {
    const mod = await this.ensureModule();
    const Communicate = mod.Communicate ?? mod.default?.Communicate;
    if (!Communicate) {
      throw new VoiceSynthesisError(this.name, 'edge-tts module missing Communicate class');
    }

    const voice = options?.voice ?? this.config.voice ?? DEFAULT_EDGE_VOICE;

    try {
      const communicate = new Communicate(text, voice);
      const chunks: Uint8Array[] = [];

      for await (const chunk of communicate.stream()) {
        if (chunk.type === 'audio' && chunk.data) {
          chunks.push(
            chunk.data instanceof Uint8Array
              ? chunk.data
              : new Uint8Array(chunk.data),
          );
        }
      }

      const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
      const audio = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        audio.set(chunk, offset);
        offset += chunk.length;
      }

      return {
        audio,
        mimeType: 'audio/mpeg',
      };
    } catch (err: unknown) {
      if (err instanceof VoiceSynthesisError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new VoiceSynthesisError(this.name, message);
    }
  }

  async listVoices(): Promise<readonly VoiceInfo[]> {
    const mod = await this.ensureModule();
    const listVoicesFn = mod.list_voices ?? mod.default?.list_voices ?? mod.listVoices;
    if (!listVoicesFn) {
      throw new VoiceSynthesisError(this.name, 'edge-tts module missing list_voices function');
    }

    try {
      const voices = await listVoicesFn();
      return (voices as any[]).map((v: any) => ({
        id: v.ShortName ?? v.short_name ?? v.Name,
        name: v.FriendlyName ?? v.friendly_name ?? v.ShortName ?? v.Name,
        language: v.Locale ?? v.locale ?? 'en-US',
        gender: (v.Gender ?? v.gender)?.toLowerCase() as VoiceInfo['gender'],
      }));
    } catch (err: unknown) {
      if (err instanceof VoiceSynthesisError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new VoiceSynthesisError(this.name, message);
    }
  }
}
