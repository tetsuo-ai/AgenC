/**
 * Voice support module: STT and TTS provider abstractions.
 *
 * @module
 */

// Types
export type {
  AudioFormat,
  STTOptions,
  TranscriptionSegment,
  TranscriptionResult,
  SpeechToTextProvider,
  TTSOptions,
  SynthesisResult,
  VoiceInfo,
  TextToSpeechProvider,
  STTConfig,
  TTSConfig,
  RealtimeVoiceConfig,
  VoiceConfig,
} from "./types.js";

// Error classes
export { VoiceTranscriptionError, VoiceSynthesisError } from "./errors.js";

// STT providers
export {
  WhisperAPIProvider,
  toTranscriptionProvider,
  type WhisperAPIProviderConfig,
} from "./stt.js";

// TTS providers
export {
  ElevenLabsProvider,
  OpenAITTSProvider,
  EdgeTTSProvider,
  type ElevenLabsProviderConfig,
  type OpenAITTSProviderConfig,
  type EdgeTTSProviderConfig,
} from "./tts.js";

// Realtime voice (xAI Realtime API)
export {
  XaiRealtimeClient,
  VoiceRealtimeError,
  type XaiVoice,
  type XaiAudioFormat,
  type VadConfig,
  type VoiceTool,
  type VoiceSessionConfig,
  type ClientEvent as VoiceClientEvent,
  type ServerEvent as VoiceServerEvent,
  type VoiceSessionCallbacks,
  type XaiRealtimeClientConfig,
} from "./realtime/index.js";
