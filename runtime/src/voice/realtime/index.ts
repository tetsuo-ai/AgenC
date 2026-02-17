/**
 * xAI Realtime Voice API client module.
 *
 * @module
 */

// Types
export type {
  XaiVoice,
  XaiAudioFormat,
  VadConfig,
  VoiceTool,
  VoiceSessionConfig,
  ClientEvent,
  ServerEvent,
  VoiceSessionCallbacks,
  XaiRealtimeClientConfig,
} from './types.js';

// Error classes
export { VoiceRealtimeError } from './errors.js';

// Client
export { XaiRealtimeClient } from './client.js';
