/** PCM 24kHz, 16-bit signed, mono, little-endian — matching xAI Realtime API format. */
export const VOICE_SAMPLE_RATE = 24_000;

/** Interval (ms) between mic audio chunk flushes. */
export const VOICE_CHUNK_INTERVAL_MS = 100;

// ============================================================================
// WebSocket Message Types
// ============================================================================

// Chat
export const WS_CHAT_MESSAGE = 'chat.message' as const;
export const WS_CHAT_TYPING = 'chat.typing' as const;
export const WS_CHAT_HISTORY = 'chat.history' as const;
export const WS_CHAT_SESSION = 'chat.session' as const;
export const WS_CHAT_RESUMED = 'chat.resumed' as const;
export const WS_CHAT_SESSIONS = 'chat.sessions' as const;
export const WS_CHAT_CANCELLED = 'chat.cancelled' as const;
export const WS_CHAT_CANCEL = 'chat.cancel' as const;
export const WS_CHAT_RESUME = 'chat.resume' as const;

// Tools
export const WS_TOOLS_EXECUTING = 'tools.executing' as const;
export const WS_TOOLS_RESULT = 'tools.result' as const;

// Voice
export const WS_VOICE_START = 'voice.start' as const;
export const WS_VOICE_STOP = 'voice.stop' as const;
export const WS_VOICE_AUDIO = 'voice.audio' as const;
export const WS_VOICE_COMMIT = 'voice.commit' as const;
export const WS_VOICE_STARTED = 'voice.started' as const;
export const WS_VOICE_STOPPED = 'voice.stopped' as const;
export const WS_VOICE_TRANSCRIPT = 'voice.transcript' as const;
export const WS_VOICE_USER_TRANSCRIPT = 'voice.user_transcript' as const;
export const WS_VOICE_SPEECH_STARTED = 'voice.speech_started' as const;
export const WS_VOICE_SPEECH_STOPPED = 'voice.speech_stopped' as const;
export const WS_VOICE_RESPONSE_DONE = 'voice.response_done' as const;
export const WS_VOICE_DELEGATION = 'voice.delegation' as const;
export const WS_VOICE_STATE = 'voice.state' as const;
export const WS_VOICE_ERROR = 'voice.error' as const;
export const WS_VOICE_TOOL_CALL = 'voice.tool_call' as const;

// Desktop
export const WS_DESKTOP_LIST = 'desktop.list' as const;
export const WS_DESKTOP_CREATE = 'desktop.create' as const;
export const WS_DESKTOP_CREATED = 'desktop.created' as const;
export const WS_DESKTOP_DESTROY = 'desktop.destroy' as const;
export const WS_DESKTOP_DESTROYED = 'desktop.destroyed' as const;
export const WS_DESKTOP_ERROR = 'desktop.error' as const;

// Approval
export const WS_APPROVAL_REQUEST = 'approval.request' as const;

// Agent Status
export const WS_AGENT_STATUS = 'agent.status' as const;
