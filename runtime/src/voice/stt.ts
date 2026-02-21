/**
 * Speech-to-text provider implementations.
 *
 * @module
 */

import type {
  SpeechToTextProvider,
  STTOptions,
  TranscriptionResult,
} from "./types.js";
import type { TranscriptionProvider } from "../gateway/media.js";
import { VoiceTranscriptionError } from "./errors.js";
import { ensureLazyModule } from "../utils/lazy-import.js";

// ============================================================================
// MIME → codec mapping
// ============================================================================

const MIME_TO_CODEC: Record<string, string> = {
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/webm": "webm",
  "audio/flac": "flac",
  "audio/opus": "opus",
};

function mimeToExtension(mimeType: string): string {
  const base = mimeType.split(";")[0].trim();
  return MIME_TO_CODEC[base] ?? "ogg";
}

// ============================================================================
// WhisperAPIProvider
// ============================================================================

/** Configuration for the Whisper API provider. */
export interface WhisperAPIProviderConfig {
  readonly apiKey: string;
  readonly model?: string;
  readonly baseURL?: string;
}

const DEFAULT_WHISPER_MODEL = "whisper-1";

/**
 * Speech-to-text provider using the OpenAI Whisper API.
 *
 * Lazily loads the `openai` package on first use.
 */
export class WhisperAPIProvider implements SpeechToTextProvider {
  readonly name = "whisper-api";

  private client: unknown | null = null;
  private readonly config: WhisperAPIProviderConfig;

  constructor(config: WhisperAPIProviderConfig) {
    this.config = config;
  }

  private async ensureClient(): Promise<unknown> {
    if (this.client) return this.client;

    this.client = await ensureLazyModule(
      "openai",
      (msg) => new VoiceTranscriptionError(this.name, msg),
      (mod) => {
        const OpenAI = (mod.default ?? mod["OpenAI"]) as new (
          opts: Record<string, unknown>,
        ) => unknown;
        return new OpenAI({
          apiKey: this.config.apiKey,
          ...(this.config.baseURL ? { baseURL: this.config.baseURL } : {}),
        });
      },
    );
    return this.client;
  }

  async transcribe(
    audio: Buffer | Uint8Array,
    options?: STTOptions,
  ): Promise<TranscriptionResult> {
    const client = (await this.ensureClient()) as any;
    const ext = options?.format?.codec ?? "ogg";
    const filename = `audio.${ext}`;

    // Build a File object from the audio buffer
    const blob = new Blob([audio], { type: `audio/${ext}` });
    const file = new File([blob], filename, { type: `audio/${ext}` });

    const params: Record<string, unknown> = {
      file,
      model: this.config.model ?? DEFAULT_WHISPER_MODEL,
    };
    if (options?.language) params["language"] = options.language;
    if (options?.prompt) params["prompt"] = options.prompt;
    if (options?.timestamps) params["response_format"] = "verbose_json";

    try {
      const response = await client.audio.transcriptions.create(
        params,
        options?.signal ? { signal: options.signal } : undefined,
      );
      return this.parseResponse(response);
    } catch (err: unknown) {
      if (err instanceof VoiceTranscriptionError) throw err;
      const status = (err as any)?.status;
      const message = err instanceof Error ? err.message : String(err);
      throw new VoiceTranscriptionError(this.name, message, status);
    }
  }

  private parseResponse(response: any): TranscriptionResult {
    // Simple response: { text: string }
    if (typeof response === "string") {
      return { text: response };
    }
    const result: TranscriptionResult = {
      text: response.text ?? "",
      language: response.language,
      durationMs:
        response.duration != null
          ? Math.round(response.duration * 1000)
          : undefined,
      segments: response.segments?.map((s: any) => ({
        text: s.text,
        startMs: Math.round(s.start * 1000),
        endMs: Math.round(s.end * 1000),
      })),
    };
    return result;
  }
}

// ============================================================================
// TranscriptionProvider adapter
// ============================================================================

/**
 * Adapts a {@link SpeechToTextProvider} to the {@link TranscriptionProvider}
 * interface used by {@link MediaPipeline}.
 *
 * @example
 * ```typescript
 * const whisper = new WhisperAPIProvider({ apiKey: '...' });
 * pipeline.setTranscriptionProvider(toTranscriptionProvider(whisper));
 * ```
 */
export function toTranscriptionProvider(
  stt: SpeechToTextProvider,
): TranscriptionProvider {
  return {
    async transcribe(
      data: Uint8Array,
      mimeType: string,
      signal: AbortSignal,
    ): Promise<string> {
      const ext = mimeToExtension(mimeType);
      const result = await stt.transcribe(data, {
        format: { codec: ext as any, sampleRate: 16000, channels: 1 },
        signal,
      });
      return result.text;
    },
  };
}
