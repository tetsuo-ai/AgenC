/**
 * Voice provider type definitions for STT and TTS integration.
 *
 * @module
 */

// ============================================================================
// Audio Format
// ============================================================================

/** Describes the format of an audio buffer. */
export interface AudioFormat {
  readonly codec: "opus" | "mp3" | "wav" | "ogg" | "webm" | "flac";
  readonly sampleRate: number;
  readonly channels: number;
}

// ============================================================================
// Speech-to-Text
// ============================================================================

/** Options for speech-to-text transcription. */
export interface STTOptions {
  readonly language?: string;
  readonly prompt?: string;
  readonly format?: AudioFormat;
  readonly timestamps?: boolean;
  readonly signal?: AbortSignal;
}

/** A segment of a transcription with timing information. */
export interface TranscriptionSegment {
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
}

/** Result from a speech-to-text transcription. */
export interface TranscriptionResult {
  readonly text: string;
  readonly language?: string;
  readonly durationMs?: number;
  readonly segments?: readonly TranscriptionSegment[];
}

/** Provider that converts audio data to text. */
export interface SpeechToTextProvider {
  readonly name: string;
  transcribe(
    audio: Buffer | Uint8Array,
    options?: STTOptions,
  ): Promise<TranscriptionResult>;
}

// ============================================================================
// Text-to-Speech
// ============================================================================

/** Options for text-to-speech synthesis. */
export interface TTSOptions {
  readonly voice?: string;
  readonly speed?: number;
  readonly format?: "mp3" | "wav" | "opus" | "flac";
  readonly signal?: AbortSignal;
}

/** Result from a text-to-speech synthesis. */
export interface SynthesisResult {
  readonly audio: Uint8Array;
  readonly mimeType: string;
  readonly durationSeconds?: number;
}

/** Information about an available voice. */
export interface VoiceInfo {
  readonly id: string;
  readonly name: string;
  readonly language: string;
  readonly gender?: "male" | "female" | "neutral";
}

/** Provider that converts text to speech audio. */
export interface TextToSpeechProvider {
  readonly name: string;
  synthesize(text: string, options?: TTSOptions): Promise<SynthesisResult>;
  listVoices(): Promise<readonly VoiceInfo[]>;
}

// ============================================================================
// Voice Configuration
// ============================================================================

/** STT provider configuration. */
export interface STTConfig {
  readonly provider: "whisper-api";
  readonly apiKey: string;
  readonly model?: string;
  readonly baseURL?: string;
}

/** TTS provider configuration. */
export interface TTSConfig {
  readonly provider: "elevenlabs" | "openai-tts" | "edge-tts";
  readonly apiKey?: string;
  readonly voice?: string;
  readonly model?: string;
}

/** xAI Realtime voice provider configuration. */
export interface RealtimeVoiceConfig {
  readonly provider: "xai-realtime";
  readonly apiKey: string;
  readonly voice?: "Ara" | "Rex" | "Sal" | "Eve" | "Leo";
  readonly model?: string;
}

/** Combined voice configuration. */
export interface VoiceConfig {
  readonly stt?: STTConfig;
  readonly tts?: TTSConfig;
  readonly autoTts?: boolean;
  readonly realtime?: RealtimeVoiceConfig;
}
