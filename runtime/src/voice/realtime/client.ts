/**
 * xAI Realtime Voice WebSocket client.
 *
 * Connects to wss://api.x.ai/v1/realtime and manages bidirectional
 * audio streaming, tool calling, and automatic reconnection.
 *
 * The `ws` package is lazy-loaded (same pattern as Gateway).
 *
 * @module
 */

import type {
  ClientEvent,
  ServerEvent,
  VoiceSessionConfig,
  VoiceSessionCallbacks,
  XaiRealtimeClientConfig,
} from "./types.js";
import { VoiceRealtimeError } from "./errors.js";
import { uint8ToBase64, base64ToUint8 } from "../../utils/encoding.js";

const DEFAULT_BASE_URL = "wss://api.x.ai/v1/realtime";
const MAX_RECONNECT_ATTEMPTS = 5;
const BASE_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 16_000;

type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting";

/**
 * WebSocket client for xAI's real-time voice API.
 *
 * Usage:
 * ```ts
 * const client = new XaiRealtimeClient({
 *   apiKey: 'xai-...',
 *   sessionConfig: { voice: 'Ara', model: 'grok-4-1-fast-reasoning' },
 *   callbacks: {
 *     onAudioDelta: (pcm) => playback.enqueue(pcm),
 *     onTranscriptDone: (text) => console.log('Agent:', text),
 *     onFunctionCall: async (name, args) => toolHandler(name, JSON.parse(args)),
 *   },
 * });
 * await client.connect();
 * client.sendAudio(pcmChunk);
 * ```
 */
export class XaiRealtimeClient {
  private ws: unknown | null = null;
  private _state: ConnectionState = "disconnected";
  private reconnectAttempts = 0;
  /** Serializes function calls so only one executes at a time. */
  private _fnCallChain: Promise<void> = Promise.resolve();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly sessionConfig: VoiceSessionConfig | undefined;
  private readonly callbacks: VoiceSessionCallbacks;
  private readonly maxReconnectAttempts: number;
  private readonly logger: XaiRealtimeClientConfig["logger"];

  constructor(config: XaiRealtimeClientConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.sessionConfig = config.sessionConfig;
    this.callbacks = config.callbacks ?? {};
    this.maxReconnectAttempts =
      config.maxReconnectAttempts ?? MAX_RECONNECT_ATTEMPTS;
    this.logger = config.logger;
  }

  /** Current connection state. */
  get state(): ConnectionState {
    return this._state;
  }

  /**
   * Open a WebSocket connection to the xAI Realtime API.
   * Sends session.update with the initial config after connect.
   */
  async connect(): Promise<void> {
    if (this._state === "connected" || this._state === "connecting") return;

    this.intentionalClose = false;
    this.setState(this.reconnectAttempts > 0 ? "reconnecting" : "connecting");

    const WebSocket = await this.loadWebSocket();
    const ws = new WebSocket(this.baseUrl, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
    });

    return new Promise<void>((resolve, reject) => {
      ws.onopen = () => {
        this.ws = ws;
        this.reconnectAttempts = 0;
        this.setState("connected");
        this.logger?.info?.("xAI Realtime connected");

        // Send initial session config
        if (this.sessionConfig) {
          this.sendEvent({
            type: "session.update",
            session: this.sessionConfig,
          });
        }

        resolve();
      };

      ws.onmessage = (event: { data: string }) => {
        this.handleServerEvent(event.data);
      };

      ws.onerror = (event: { message?: string }) => {
        const msg = event.message ?? "WebSocket error";
        if (this._state === "connecting") {
          reject(new VoiceRealtimeError(`Connection failed: ${msg}`));
        }
      };

      ws.onclose = () => {
        this.ws = null;
        if (!this.intentionalClose) {
          this.logger?.debug?.(
            "xAI Realtime disconnected unexpectedly, scheduling reconnect",
          );
          this.setState("disconnected");
          this.scheduleReconnect();
        } else {
          this.setState("disconnected");
        }
      };
    });
  }

  /** Update the voice session configuration (voice, tools, instructions, etc). */
  updateSession(config: VoiceSessionConfig): void {
    this.sendEvent({ type: "session.update", session: config });
  }

  /** Stream raw PCM audio to the server. */
  sendAudio(pcm: Uint8Array): void {
    const base64 = uint8ToBase64(pcm);
    this.sendEvent({ type: "input_audio_buffer.append", audio: base64 });
  }

  /** Stream pre-encoded base64 PCM audio to the server (avoids re-encoding). */
  sendAudioBase64(base64: string): void {
    this.sendEvent({ type: "input_audio_buffer.append", audio: base64 });
  }

  /** Commit the audio buffer (for push-to-talk mode). */
  commitAudio(): void {
    this.sendEvent({ type: "input_audio_buffer.commit" });
  }

  /** Clear the pending audio buffer. */
  clearAudio(): void {
    this.sendEvent({ type: "input_audio_buffer.clear" });
  }

  /** Explicitly request the model to generate a response. */
  requestResponse(): void {
    this.sendEvent({ type: "response.create" });
  }

  /** Cancel an in-progress response. */
  cancelResponse(): void {
    this.sendEvent({ type: "response.cancel" });
  }

  /**
   * Inject conversation history items into the session.
   * Each item is sent as a `conversation.item.create` event with
   * `type: "message"` — restores context on reconnect.
   */
  injectConversationHistory(
    messages: ReadonlyArray<{ role: "user" | "assistant"; content: string }>,
  ): void {
    for (const msg of messages) {
      const contentType = msg.role === "assistant" ? "text" : "input_text";
      this.sendEvent({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: msg.role,
          content: [{ type: contentType, text: msg.content }],
        },
      });
    }
  }

  /** Gracefully close the WebSocket connection. */
  close(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      (this.ws as { close(): void }).close();
      this.ws = null;
    }
    this.setState("disconnected");
  }

  // --------------------------------------------------------------------------
  // Internal
  // --------------------------------------------------------------------------

  private sendEvent(event: ClientEvent): boolean {
    if (!this.ws) {
      return false;
    }
    (this.ws as { send(data: string): void }).send(JSON.stringify(event));
    return true;
  }

  private handleServerEvent(raw: string): void {
    let event: ServerEvent;
    try {
      event = JSON.parse(raw) as ServerEvent;
    } catch {
      this.logger?.warn?.("Failed to parse xAI Realtime event");
      return;
    }

    this.logger?.debug?.("xAI event:", event.type);

    switch (event.type) {
      case "session.created":
        this.callbacks.onSessionCreated?.();
        break;

      case "response.output_audio.delta": {
        // Prefer base64 callback to avoid unnecessary decode/re-encode
        if (this.callbacks.onAudioDeltaBase64) {
          this.callbacks.onAudioDeltaBase64(event.delta);
        } else if (this.callbacks.onAudioDelta) {
          this.callbacks.onAudioDelta(base64ToUint8(event.delta));
        }
        break;
      }

      case "response.output_audio_transcript.delta":
        this.callbacks.onTranscriptDelta?.(event.delta);
        break;

      case "response.output_audio_transcript.done":
        this.callbacks.onTranscriptDone?.(event.transcript);
        break;

      case "response.function_call_arguments.done":
        if (this.callbacks.onFunctionCall) {
          this.logger?.debug?.("Tool call:", event.name);
          this._fnCallChain = this._fnCallChain.then(
            () => this.handleFunctionCall(event.name, event.arguments, event.call_id),
          ).catch(() => {/* error already handled in handleFunctionCall */});
        }
        break;

      case "conversation.item.input_audio_transcription.completed":
        if (event.transcript) {
          this.callbacks.onInputTranscriptDone?.(event.transcript);
        }
        break;

      case "conversation.item.input_audio_transcription.failed":
        this.logger?.debug?.(
          "Input audio transcription failed:",
          event.error?.message,
        );
        break;

      case "input_audio_buffer.speech_started":
        this.callbacks.onSpeechStarted?.();
        break;

      case "input_audio_buffer.speech_stopped":
        this.callbacks.onSpeechStopped?.();
        break;

      case "response.done":
        this.callbacks.onResponseDone?.();
        break;

      case "error":
        this.logger?.warn?.(
          "xAI Realtime error:",
          event.error.type,
          event.error.message,
        );
        this.callbacks.onError?.(event.error);
        break;

      // Ignore other event types (session.updated, rate_limits.updated, etc.)
      default:
        break;
    }
  }

  private async handleFunctionCall(
    name: string,
    args: string,
    callId: string,
  ): Promise<void> {
    if (!this.callbacks.onFunctionCall) return;

    try {
      const result = await this.callbacks.onFunctionCall(name, args, callId);

      // Send tool result back
      this.sendEvent({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callId,
          output: result,
        },
      });

      // Request the model to continue with the tool result
      this.sendEvent({ type: "response.create" });
    } catch (err) {
      // Send error as tool output so the model can recover
      this.sendEvent({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify({ error: (err as Error).message }),
        },
      });
      this.sendEvent({ type: "response.create" });
    }
  }

  private scheduleReconnect(): void {
    if (this.intentionalClose) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.callbacks.onError?.({
        type: "reconnect_failed",
        message: `Max reconnect attempts (${this.maxReconnectAttempts}) reached`,
      });
      return;
    }

    const delay = Math.min(
      BASE_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempts),
      MAX_RECONNECT_DELAY_MS,
    );
    this.reconnectAttempts++;
    this.logger?.debug?.(
      `Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => {
        // connect() rejects on failure; scheduleReconnect will be called via onclose
      });
    }, delay);
  }

  private setState(state: ConnectionState): void {
    if (this._state === state) return;
    this._state = state;
    this.callbacks.onConnectionStateChange?.(state);
  }

  private async loadWebSocket(): Promise<
    new (
      url: string,
      opts?: Record<string, unknown>,
    ) => {
      onopen: (() => void) | null;
      onmessage: ((event: { data: string }) => void) | null;
      onerror: ((event: { message?: string }) => void) | null;
      onclose: (() => void) | null;
      send(data: string): void;
      close(): void;
    }
  > {
    try {
      const mod = await import("ws");
      return (mod.default ?? mod.WebSocket ?? mod) as any;
    } catch {
      throw new VoiceRealtimeError(
        'The "ws" package is required for XaiRealtimeClient. Install it: npm install ws',
      );
    }
  }
}
