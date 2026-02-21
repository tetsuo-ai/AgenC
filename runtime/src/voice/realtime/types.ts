/**
 * xAI Realtime Voice API protocol types.
 *
 * Follows the xAI/OpenAI Realtime API WebSocket protocol for
 * bidirectional voice streaming at wss://api.x.ai/v1/realtime.
 *
 * @module
 */

// ============================================================================
// Voice & Audio Configuration
// ============================================================================

/** Available xAI voice personas. */
export type XaiVoice = "Ara" | "Rex" | "Sal" | "Eve" | "Leo";

/** Supported audio wire formats. */
export type XaiAudioFormat = "pcm16" | "g711_ulaw" | "g711_alaw";

/** Voice Activity Detection (VAD) configuration. */
export interface VadConfig {
  /** VAD type: 'server_vad' for automatic turn detection. */
  readonly type: "server_vad";
  /** Silence threshold (0.0–1.0). Default: 0.5 */
  readonly threshold?: number;
  /** Silence duration (ms) before speech end. Default: 500 */
  readonly silence_duration_ms?: number;
  /** Audio prefix duration (ms) to include before speech start. Default: 300 */
  readonly prefix_padding_ms?: number;
}

/** Tool definition for voice session (same as chat tools). */
export interface VoiceTool {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

// ============================================================================
// Session Configuration
// ============================================================================

/** Configuration sent via session.update event. */
export interface VoiceSessionConfig {
  readonly model?: string;
  readonly voice?: XaiVoice;
  readonly modalities?: ReadonlyArray<"text" | "audio">;
  readonly instructions?: string;
  readonly input_audio_format?: XaiAudioFormat;
  readonly output_audio_format?: XaiAudioFormat;
  readonly turn_detection?: VadConfig | null;
  readonly tools?: readonly VoiceTool[];
  readonly temperature?: number;
}

// ============================================================================
// Client → Server Events
// ============================================================================

export interface SessionUpdateEvent {
  readonly type: "session.update";
  readonly session: VoiceSessionConfig;
}

export interface InputAudioBufferAppendEvent {
  readonly type: "input_audio_buffer.append";
  readonly audio: string; // base64-encoded PCM
}

export interface InputAudioBufferCommitEvent {
  readonly type: "input_audio_buffer.commit";
}

export interface InputAudioBufferClearEvent {
  readonly type: "input_audio_buffer.clear";
}

export interface ResponseCreateEvent {
  readonly type: "response.create";
  readonly response?: {
    readonly modalities?: ReadonlyArray<"text" | "audio">;
  };
}

export interface ResponseCancelEvent {
  readonly type: "response.cancel";
}

export interface ConversationItemCreateEvent {
  readonly type: "conversation.item.create";
  readonly item: {
    readonly type: "function_call_output";
    readonly call_id: string;
    readonly output: string;
  };
}

export type ClientEvent =
  | SessionUpdateEvent
  | InputAudioBufferAppendEvent
  | InputAudioBufferCommitEvent
  | InputAudioBufferClearEvent
  | ResponseCreateEvent
  | ResponseCancelEvent
  | ConversationItemCreateEvent;

// ============================================================================
// Server → Client Events
// ============================================================================

export interface SessionCreatedServerEvent {
  readonly type: "session.created";
  readonly session: Record<string, unknown>;
}

export interface SessionUpdatedServerEvent {
  readonly type: "session.updated";
  readonly session: Record<string, unknown>;
}

export interface ResponseAudioDeltaEvent {
  readonly type: "response.output_audio.delta";
  readonly delta: string; // base64-encoded PCM
  readonly response_id: string;
  readonly item_id: string;
  readonly output_index: number;
  readonly content_index: number;
}

export interface ResponseAudioDoneEvent {
  readonly type: "response.output_audio.done";
  readonly response_id: string;
  readonly item_id: string;
}

export interface ResponseAudioTranscriptDeltaEvent {
  readonly type: "response.output_audio_transcript.delta";
  readonly delta: string;
  readonly response_id: string;
  readonly item_id: string;
}

export interface ResponseAudioTranscriptDoneEvent {
  readonly type: "response.output_audio_transcript.done";
  readonly transcript: string;
  readonly response_id: string;
  readonly item_id: string;
}

export interface ResponseTextDeltaEvent {
  readonly type: "response.text.delta";
  readonly delta: string;
  readonly response_id: string;
}

export interface ResponseTextDoneEvent {
  readonly type: "response.text.done";
  readonly text: string;
  readonly response_id: string;
}

export interface ResponseFunctionCallArgumentsDeltaEvent {
  readonly type: "response.function_call_arguments.delta";
  readonly delta: string;
  readonly call_id: string;
  readonly name: string;
  readonly item_id: string;
}

export interface ResponseFunctionCallArgumentsDoneEvent {
  readonly type: "response.function_call_arguments.done";
  readonly arguments: string;
  readonly call_id: string;
  readonly name: string;
  readonly item_id: string;
}

export interface ResponseDoneEvent {
  readonly type: "response.done";
  readonly response: Record<string, unknown>;
}

export interface InputAudioBufferSpeechStartedEvent {
  readonly type: "input_audio_buffer.speech_started";
  readonly audio_start_ms: number;
  readonly item_id: string;
}

export interface InputAudioBufferSpeechStoppedEvent {
  readonly type: "input_audio_buffer.speech_stopped";
  readonly audio_end_ms: number;
  readonly item_id: string;
}

export interface InputAudioBufferCommittedEvent {
  readonly type: "input_audio_buffer.committed";
  readonly item_id: string;
}

export interface ConversationItemCreatedEvent {
  readonly type: "conversation.item.created";
  readonly item: Record<string, unknown>;
}

export interface ErrorServerEvent {
  readonly type: "error";
  readonly error: {
    readonly type: string;
    readonly code?: string;
    readonly message: string;
  };
}

export interface RateLimitsUpdatedEvent {
  readonly type: "rate_limits.updated";
  readonly rate_limits: ReadonlyArray<{
    readonly name: string;
    readonly limit: number;
    readonly remaining: number;
    readonly reset_seconds: number;
  }>;
}

export type ServerEvent =
  | SessionCreatedServerEvent
  | SessionUpdatedServerEvent
  | ResponseAudioDeltaEvent
  | ResponseAudioDoneEvent
  | ResponseAudioTranscriptDeltaEvent
  | ResponseAudioTranscriptDoneEvent
  | ResponseTextDeltaEvent
  | ResponseTextDoneEvent
  | ResponseFunctionCallArgumentsDeltaEvent
  | ResponseFunctionCallArgumentsDoneEvent
  | ResponseDoneEvent
  | InputAudioBufferSpeechStartedEvent
  | InputAudioBufferSpeechStoppedEvent
  | InputAudioBufferCommittedEvent
  | ConversationItemCreatedEvent
  | ErrorServerEvent
  | RateLimitsUpdatedEvent;

// ============================================================================
// Client Callbacks
// ============================================================================

/** Consumer callbacks for voice session events. */
export interface VoiceSessionCallbacks {
  /** Raw PCM audio chunk from the agent's voice response (decoded from base64). */
  onAudioDelta?: (audio: Uint8Array) => void;
  /** Base64-encoded PCM audio chunk — use instead of onAudioDelta to avoid decode/re-encode overhead. */
  onAudioDeltaBase64?: (base64: string) => void;
  /** Incremental transcript of the agent's voice. */
  onTranscriptDelta?: (text: string) => void;
  /** Full transcript when agent finishes speaking. */
  onTranscriptDone?: (text: string) => void;
  /** Agent wants to call a tool. Return the tool result string. */
  onFunctionCall?: (
    name: string,
    args: string,
    callId: string,
  ) => Promise<string>;
  /** VAD detected speech start. */
  onSpeechStarted?: () => void;
  /** VAD detected speech stop. */
  onSpeechStopped?: () => void;
  /** Session established. */
  onSessionCreated?: () => void;
  /** Response generation finished. */
  onResponseDone?: () => void;
  /** Protocol error from xAI. */
  onError?: (error: { type: string; code?: string; message: string }) => void;
  /** WebSocket connection state change. */
  onConnectionStateChange?: (
    state: "connecting" | "connected" | "disconnected" | "reconnecting",
  ) => void;
}

// ============================================================================
// Client Configuration
// ============================================================================

/** Configuration for XaiRealtimeClient. */
export interface XaiRealtimeClientConfig {
  /** xAI API key. */
  readonly apiKey: string;
  /** WebSocket endpoint. Default: wss://api.x.ai/v1/realtime */
  readonly baseUrl?: string;
  /** Initial session configuration. */
  readonly sessionConfig?: VoiceSessionConfig;
  /** Event callbacks. */
  readonly callbacks?: VoiceSessionCallbacks;
  /** Max reconnect attempts. Default: 5 */
  readonly maxReconnectAttempts?: number;
  /** Optional logger for debug/info output. */
  readonly logger?: {
    debug?(...args: unknown[]): void;
    info?(...args: unknown[]): void;
    warn?(...args: unknown[]): void;
  };
}
