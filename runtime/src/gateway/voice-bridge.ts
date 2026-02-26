/**
 * Voice bridge — manages per-client xAI Realtime voice sessions.
 *
 * Each WebSocket client that activates voice gets its own XaiRealtimeClient
 * connected to xAI's realtime API. Audio and events are relayed between
 * the browser client and xAI in both directions.
 *
 * @module
 */

import { XaiRealtimeClient } from "../voice/realtime/client.js";
import type {
  VoiceSessionConfig,
  VoiceTool,
  XaiVoice,
} from "../voice/realtime/types.js";
import type { ControlResponse } from "./types.js";
import type { Logger } from "../utils/logger.js";
import type { ToolHandler, LLMTool } from "../llm/types.js";

const DEFAULT_MAX_SESSIONS = 10;

/**
 * Conciseness instructions appended to the voice system prompt.
 * Prevents the agent from monologuing — keeps responses short and
 * conversational, matching how Claude, ChatGPT, and Grok handle voice.
 */
const VOICE_CONCISENESS_PROMPT =
  "\n\n## Voice Conversation Rules\n\n" +
  "You are currently in a VOICE conversation. Follow these rules strictly:\n\n" +
  "RESPONSE LENGTH: Keep responses to 1-2 sentences. Only give longer responses " +
  "when the user explicitly asks for detail or explanation.\n\n" +
  "TONE: Warm, concise, and confident. Speak casually and naturally. " +
  "Use short sentences and simple words.\n\n" +
  "PACING: When using tools, say a brief phrase like \"Let me check that\" " +
  "before the pause. Never narrate every step.\n\n" +
  "DO NOT: Repeat yourself. Over-explain. Provide unsolicited information. " +
  "Use markdown, lists, code blocks, or special formatting. " +
  "Monologue or give long-winded answers.";

export interface VoiceBridgeConfig {
  /** xAI API key. */
  apiKey: string;
  /** Tools available during voice sessions. */
  tools: LLMTool[];
  /** Tool execution handler (fallback when no desktop router). */
  toolHandler: ToolHandler;
  /** Factory that returns a desktop-aware tool handler scoped to a session. */
  desktopRouterFactory?: (sessionId: string) => ToolHandler;
  /** System prompt injected into voice sessions. */
  systemPrompt: string;
  /** Default voice persona. */
  voice?: XaiVoice;
  /** Default model. */
  model?: string;
  /** VAD mode or push-to-talk. Default: 'vad'. */
  mode?: "vad" | "push-to-talk";
  /** VAD silence threshold (0.0–1.0). Default: 0.5. */
  vadThreshold?: number;
  /** Silence duration (ms) before turn ends. Default: 800. */
  vadSilenceDurationMs?: number;
  /** Audio prefix (ms) to include before speech start. Default: 300. */
  vadPrefixPaddingMs?: number;
  /** Max concurrent voice sessions. Default: 10. */
  maxSessions?: number;
  /** Logger. */
  logger?: Logger;
}

interface ActiveSession {
  client: XaiRealtimeClient;
  send: (response: ControlResponse) => void;
  toolHandler: ToolHandler;
}

/**
 * Manages per-client real-time voice sessions bridging browser audio
 * to the xAI Realtime API.
 */
export class VoiceBridge {
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly config: VoiceBridgeConfig;
  private readonly maxSessions: number;
  private readonly logger: Logger | undefined;

  constructor(config: VoiceBridgeConfig) {
    this.config = config;
    this.maxSessions = config.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.logger = config.logger;
  }

  /** Number of active voice sessions. */
  get activeSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Start a voice session for a client.
   *
   * Creates an XaiRealtimeClient, connects to xAI, and wires callbacks
   * to forward events to the browser via the `send` function.
   */
  async startSession(
    clientId: string,
    send: (response: ControlResponse) => void,
  ): Promise<void> {
    // Clean up any existing session for this client
    if (this.sessions.has(clientId)) {
      await this.stopSession(clientId);
    }

    if (this.sessions.size >= this.maxSessions) {
      send({
        type: "voice.error",
        payload: { message: "Maximum concurrent voice sessions reached" },
      });
      return;
    }

    // Create a session-scoped tool handler that routes desktop.* calls
    const sessionToolHandler = this.config.desktopRouterFactory
      ? this.config.desktopRouterFactory(clientId)
      : this.config.toolHandler;

    const voiceTools = this.convertTools(this.config.tools);

    const voiceInstructions =
      this.config.systemPrompt +
      VOICE_CONCISENESS_PROMPT;

    const sessionConfig: VoiceSessionConfig = {
      model: this.config.model ?? "grok-4-1-fast-reasoning",
      voice: this.config.voice ?? "Ara",
      modalities: ["text", "audio"],
      instructions: voiceInstructions,
      input_audio_format: "pcm16",
      output_audio_format: "pcm16",
      turn_detection:
        this.config.mode === "push-to-talk"
          ? null
          : {
              type: "server_vad",
              threshold: this.config.vadThreshold ?? 0.5,
              silence_duration_ms: this.config.vadSilenceDurationMs ?? 800,
              prefix_padding_ms: this.config.vadPrefixPaddingMs ?? 300,
            },
      tools: voiceTools,
    };

    const client = new XaiRealtimeClient({
      apiKey: this.config.apiKey,
      sessionConfig,
      logger: this.logger,
      callbacks: {
        onAudioDeltaBase64: (base64) => {
          send({
            type: "voice.audio",
            payload: { audio: base64 },
          });
        },
        onTranscriptDelta: (text) => {
          send({
            type: "voice.transcript",
            payload: { delta: text, done: false },
          });
        },
        onTranscriptDone: (text) => {
          send({
            type: "voice.transcript",
            payload: { text, done: true },
          });
        },
        onFunctionCall: async (name, args, _callId) => {
          // Notify browser that a tool is executing
          send({
            type: "voice.tool_call",
            payload: { toolName: name, status: "executing" },
          });

          try {
            const parsed = JSON.parse(args) as Record<string, unknown>;
            const resultStr = await sessionToolHandler(name, parsed);

            send({
              type: "voice.tool_call",
              payload: {
                toolName: name,
                status: "completed",
                result: resultStr,
              },
            });

            return resultStr;
          } catch (err) {
            const errorMsg = (err as Error).message;
            send({
              type: "voice.tool_call",
              payload: { toolName: name, status: "error", error: errorMsg },
            });
            return JSON.stringify({ error: errorMsg });
          }
        },
        onSpeechStarted: () => {
          send({ type: "voice.speech_started" });
        },
        onSpeechStopped: () => {
          send({ type: "voice.speech_stopped" });
        },
        onResponseDone: () => {
          send({ type: "voice.response_done" });
        },
        onError: (error) => {
          this.logger?.warn?.("Voice session error:", error);
          send({
            type: "voice.error",
            payload: { message: error.message, code: error.code },
          });
        },
        onConnectionStateChange: (state) => {
          send({
            type: "voice.state",
            payload: { connectionState: state },
          });
        },
      },
    });

    this.sessions.set(clientId, { client, send, toolHandler: sessionToolHandler });

    try {
      await client.connect();
      send({ type: "voice.started" });
      this.logger?.info?.(`Voice session started for client ${clientId}`);
    } catch (err) {
      this.sessions.delete(clientId);
      send({
        type: "voice.error",
        payload: { message: (err as Error).message },
      });
    }
  }

  /** Forward audio data from the browser to the xAI session. */
  sendAudio(clientId: string, base64Audio: string): void {
    const session = this.sessions.get(clientId);
    if (!session) return;

    // Pass base64 directly — avoids unnecessary decode/re-encode cycle
    session.client.sendAudioBase64(base64Audio);
  }

  /** Commit the audio buffer (push-to-talk mode). */
  commitAudio(clientId: string): void {
    const session = this.sessions.get(clientId);
    if (!session) return;
    session.client.commitAudio();
  }

  /** Stop a specific client's voice session. */
  async stopSession(clientId: string): Promise<void> {
    const session = this.sessions.get(clientId);
    if (!session) return;

    session.client.close();
    this.sessions.delete(clientId);
    session.send({ type: "voice.stopped" });
    this.logger?.info?.(`Voice session stopped for client ${clientId}`);
  }

  /** Stop all active voice sessions (for shutdown). */
  async stopAll(): Promise<void> {
    const clientIds = Array.from(this.sessions.keys());
    for (const clientId of clientIds) {
      await this.stopSession(clientId);
    }
  }

  /** Check if a client has an active voice session. */
  hasSession(clientId: string): boolean {
    return this.sessions.has(clientId);
  }

  // --------------------------------------------------------------------------
  // Internal
  // --------------------------------------------------------------------------

  /** Convert LLMTool[] to VoiceTool[] for xAI session config. */
  private convertTools(tools: LLMTool[]): VoiceTool[] {
    return tools
      .filter((t) => t.type === "function" && t.function)
      .map((t) => ({
        type: "function" as const,
        function: {
          name: t.function!.name,
          description: t.function!.description,
          parameters: t.function!.parameters as Record<string, unknown>,
        },
      }));
  }
}
