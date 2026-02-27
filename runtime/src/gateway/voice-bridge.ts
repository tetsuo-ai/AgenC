/**
 * Voice bridge — manages per-client xAI Realtime voice sessions.
 *
 * Uses a Chat-Supervisor architecture: xAI Realtime handles conversational
 * audio (VAD, STT, TTS) while complex tasks are delegated to ChatExecutor
 * via a single `execute_with_agent` tool. This gives voice sessions access
 * to the full text-mode pipeline: memory injection, learning context,
 * progress tracking, multi-round tool loops, hooks, and approval gating.
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
import type { ChatExecutor } from "../llm/chat-executor.js";
import type { SessionManager } from "./session.js";
import type { HookDispatcher } from "./hooks.js";
import type { ApprovalEngine } from "./approvals.js";
import type { MemoryBackend } from "../memory/types.js";
import { createGatewayMessage } from "./message.js";
import { createSessionToolHandler } from "./tool-handler-factory.js";

const DEFAULT_MAX_SESSIONS = 10;

/** Max characters for the spoken summary returned to xAI after delegation. */
const MAX_VOICE_SUMMARY_CHARS = 500;

// ============================================================================
// Voice instructions
// ============================================================================

/**
 * Voice conversation rules appended to the system prompt when delegation
 * mode is active. Guides xAI Realtime to keep responses short and delegate
 * complex tasks via `execute_with_agent`.
 */
const VOICE_DELEGATION_PROMPT =
  "\n\n## Voice Conversation Rules\n\n" +
  "You are currently in a VOICE conversation with access to a powerful agent " +
  "that can execute tasks. Follow these rules strictly:\n\n" +
  "RESPONSE LENGTH: Keep spoken responses to 1-3 sentences. Never monologue.\n\n" +
  "DELEGATION: Use the `execute_with_agent` tool for ANY task that involves:\n" +
  "- Writing, editing, or reading code or files\n" +
  "- Running shell commands or scripts\n" +
  "- Web browsing or searching\n" +
  "- Desktop automation (clicking, typing, screenshots)\n" +
  "- Multi-step operations of any kind\n" +
  "- Looking up specific technical information\n\n" +
  "BEFORE DELEGATING: Say a brief phrase like \"Let me do that\" or " +
  "\"Working on it\" so the user knows you heard them.\n\n" +
  "AFTER DELEGATION: Summarize the result in 1-2 spoken sentences. " +
  "Say \"The code is on screen now\" or \"Done\" for code/file results. " +
  "NEVER read code, file contents, or long output aloud.\n\n" +
  "DIRECT RESPONSE (no delegation): Greetings, simple factual questions, " +
  "opinions, clarifying questions, acknowledgments, small talk.\n\n" +
  "DO NOT: Repeat yourself. Over-explain. Use markdown or formatting. " +
  "Read code aloud. Narrate every step. Give unsolicited information.";

/**
 * Conciseness instructions for legacy mode (no ChatExecutor delegation).
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

// ============================================================================
// Delegation tool definition
// ============================================================================

/** Single delegation tool sent to xAI Realtime when ChatExecutor is available. */
const AGENT_DELEGATION_TOOL: VoiceTool = {
  type: "function",
  function: {
    name: "execute_with_agent",
    description:
      "Delegate a task to the agent for execution. Use for code, commands, " +
      "file operations, browsing, or any multi-step operation. Pass a clear " +
      "text description of what the user wants done. Do NOT use for greetings " +
      "or simple factual questions you can answer directly.",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "Clear text description of what the user wants done",
        },
      },
      required: ["task"],
    },
  },
};

// ============================================================================
// Config & types
// ============================================================================

export interface VoiceBridgeConfig {
  /** xAI API key. */
  apiKey: string;
  /** Tools available during voice sessions (used in legacy mode). */
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

  // --- Chat-Supervisor delegation (all optional for backwards compat) ---

  /** ChatExecutor for delegated task execution. Enables delegation mode. */
  chatExecutor?: ChatExecutor;
  /** SessionManager for shared voice/text session history. */
  sessionManager?: SessionManager;
  /** HookDispatcher for tool:before/after and message lifecycle hooks. */
  hooks?: HookDispatcher;
  /** ApprovalEngine for tool gating during delegation. */
  approvalEngine?: ApprovalEngine;
  /** MemoryBackend for persisting voice interactions. */
  memoryBackend?: MemoryBackend;
}

interface ActiveSession {
  client: XaiRealtimeClient;
  send: (response: ControlResponse) => void;
  toolHandler: ToolHandler;
  /** Shared session ID for voice/text history sharing. */
  sessionId: string;
}

// ============================================================================
// VoiceBridge
// ============================================================================

/**
 * Manages per-client real-time voice sessions bridging browser audio
 * to the xAI Realtime API.
 *
 * When `chatExecutor` is provided in config, operates in delegation mode:
 * xAI Realtime only receives the `execute_with_agent` tool. Complex tasks
 * are routed through ChatExecutor with full context injection.
 *
 * When `chatExecutor` is not provided, falls back to legacy behavior:
 * all tools are passed directly to xAI Realtime.
 */
export class VoiceBridge {
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly config: VoiceBridgeConfig;
  private readonly maxSessions: number;
  private readonly logger: Logger | undefined;

  /** Whether delegation mode is active (ChatExecutor provided). */
  private get delegationEnabled(): boolean {
    return this.config.chatExecutor != null;
  }

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
   *
   * @param clientId - Unique client identifier
   * @param send - Function to send messages to the browser client
   * @param sessionId - Optional shared session ID (for voice/text session sharing)
   */
  async startSession(
    clientId: string,
    send: (response: ControlResponse) => void,
    sessionId?: string,
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

    const effectiveSessionId = sessionId ?? `voice:${clientId}`;

    // Build tool handler — delegation or legacy
    const sessionToolHandler = this.buildSessionToolHandler(
      clientId,
      effectiveSessionId,
      send,
    );

    // In delegation mode, only send the delegation tool to xAI.
    // In legacy mode, send all tools.
    const voiceTools = this.delegationEnabled
      ? [AGENT_DELEGATION_TOOL]
      : this.convertTools(this.config.tools);

    const voiceInstructions =
      this.config.systemPrompt +
      (this.delegationEnabled
        ? VOICE_DELEGATION_PROMPT
        : VOICE_CONCISENESS_PROMPT);

    const sessionConfig: VoiceSessionConfig = {
      model: this.config.model ?? "grok-4-1-fast-reasoning",
      voice: this.config.voice ?? "Ara",
      modalities: ["text", "audio"],
      instructions: voiceInstructions,
      input_audio_format: "pcm16",
      output_audio_format: "pcm16",
      input_audio_transcription: { model: "whisper-1" },
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
          // Record agent transcript in shared session history
          this.recordTranscript(effectiveSessionId, "assistant", text);
        },
        onFunctionCall: async (name, args, _callId) => {
          // Route delegation tool to ChatExecutor
          if (name === "execute_with_agent" && this.delegationEnabled) {
            return this.handleDelegation(
              clientId,
              effectiveSessionId,
              args,
              send,
            );
          }

          // Legacy tool execution path
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
        onInputTranscriptDone: (text) => {
          // Send the user's spoken words as text to the browser
          send({
            type: "voice.user_transcript",
            payload: { text },
          });
          // Record user speech in shared session history
          this.recordTranscript(effectiveSessionId, "user", text);
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

    this.sessions.set(clientId, {
      client,
      send,
      toolHandler: sessionToolHandler,
      sessionId: effectiveSessionId,
    });

    try {
      await client.connect();
      send({ type: "voice.started" });
      this.logger?.info?.(
        `Voice session started for client ${clientId}` +
          (this.delegationEnabled ? " (delegation mode)" : " (legacy mode)"),
      );
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
  // Session tool handler
  // --------------------------------------------------------------------------

  /**
   * Build a session-scoped tool handler that integrates hooks, approval
   * gating, and desktop routing — mirroring the daemon's text-mode handler.
   *
   * Used for legacy (non-delegation) tool calls. In delegation mode,
   * ChatExecutor brings its own tool handler via the daemon's pipeline.
   */
  private buildSessionToolHandler(
    clientId: string,
    sessionId: string,
    send: (response: ControlResponse) => void,
  ): ToolHandler {
    const { hooks, approvalEngine, desktopRouterFactory, toolHandler } =
      this.config;

    return createSessionToolHandler({
      sessionId,
      baseHandler: toolHandler,
      desktopRouterFactory,
      routerId: clientId,
      send,
      hooks,
      approvalEngine,
    });
  }

  // --------------------------------------------------------------------------
  // Delegation handler
  // --------------------------------------------------------------------------

  /**
   * Handle the `execute_with_agent` delegation call. Routes the task
   * through ChatExecutor with full context injection (memory, learning,
   * progress, skills, hooks, tools, multi-round loop).
   *
   * Returns the result text to xAI for spoken summary. Full result is
   * also sent to the browser chat panel via `voice.delegation` messages.
   */
  private async handleDelegation(
    clientId: string,
    sessionId: string,
    argsJson: string,
    send: (response: ControlResponse) => void,
  ): Promise<string> {
    const { chatExecutor, sessionManager, hooks, memoryBackend } = this.config;

    if (!chatExecutor) {
      return JSON.stringify({ error: "Delegation not available" });
    }

    // Parse the task description from xAI's function call
    let task: string;
    try {
      const parsed = JSON.parse(argsJson) as Record<string, unknown>;
      task = typeof parsed.task === "string" ? parsed.task : String(parsed.task);
    } catch {
      return JSON.stringify({ error: "Invalid delegation arguments" });
    }

    if (!task.trim()) {
      return JSON.stringify({ error: "Empty task description" });
    }

    // Notify browser that delegation has started
    send({
      type: "voice.delegation",
      payload: { status: "started", task },
    });

    try {
      // Dispatch message:inbound hook (policy check)
      if (hooks) {
        const inboundResult = await hooks.dispatch("message:inbound", {
          sessionId,
          content: task,
          senderId: clientId,
          channel: "voice",
        });
        if (!inboundResult.completed) {
          send({
            type: "voice.delegation",
            payload: {
              status: "blocked",
              task,
              error: "Message blocked by policy",
            },
          });
          return "Sorry, that request was blocked by the security policy.";
        }
      }

      // Get or create shared session from SessionManager
      const history = sessionManager
        ? sessionManager.getOrCreate({
            channel: "voice",
            senderId: clientId,
            scope: "dm",
            workspaceId: "default",
          }).history
        : [];

      // Create a GatewayMessage for the ChatExecutor pipeline
      const gatewayMsg = createGatewayMessage({
        channel: "voice",
        senderId: clientId,
        senderName: `VoiceClient(${clientId})`,
        sessionId,
        content: task,
        scope: "dm",
      });

      // Stream progress back to the browser during execution
      const onStreamChunk = (chunk: { content: string; done: boolean }) => {
        send({
          type: "voice.delegation",
          payload: { status: "progress", content: chunk.content },
        });
      };

      // Build a session-scoped tool handler with desktop routing, hooks,
      // and approval gating — same as text-mode gets.
      const delegationToolHandler = this.buildSessionToolHandler(
        clientId,
        sessionId,
        send,
      );

      // Execute through the full ChatExecutor pipeline
      const result = await chatExecutor.execute({
        message: gatewayMsg,
        history,
        systemPrompt: this.config.systemPrompt,
        sessionId,
        toolHandler: delegationToolHandler,
        onStreamChunk,
      });

      // Append messages to shared session history
      if (sessionManager) {
        sessionManager.appendMessage(sessionId, {
          role: "user",
          content: task,
        });
        sessionManager.appendMessage(sessionId, {
          role: "assistant",
          content: result.content,
        });
      }

      // Persist to memory backend
      if (memoryBackend) {
        try {
          await memoryBackend.addEntry({
            sessionId,
            role: "user",
            content: task,
          });
          await memoryBackend.addEntry({
            sessionId,
            role: "assistant",
            content: result.content,
          });
        } catch (error) {
          this.logger?.warn?.("Failed to persist voice delegation to memory:", error);
        }
      }

      // Dispatch message:outbound hook
      if (hooks) {
        await hooks.dispatch("message:outbound", {
          sessionId,
          content: result.content,
          provider: result.provider,
          userMessage: task,
          agentResponse: result.content,
        });
      }

      // Send full result to browser (displayed in chat panel)
      send({
        type: "voice.delegation",
        payload: {
          status: "completed",
          task,
          content: result.content,
          toolCalls: result.toolCalls.length,
          provider: result.provider,
          durationMs: result.durationMs,
        },
      });

      if (result.toolCalls.length > 0) {
        this.logger?.info?.(
          `Voice delegation used ${result.toolCalls.length} tool call(s)`,
          {
            tools: result.toolCalls.map((tc) => tc.name),
            provider: result.provider,
          },
        );
      }

      // Return a concise summary for xAI to speak aloud.
      // Truncate long results to keep the spoken summary brief.
      const summary = result.content.length > MAX_VOICE_SUMMARY_CHARS
        ? result.content.slice(0, MAX_VOICE_SUMMARY_CHARS - 3) + "..."
        : result.content;
      return summary;
    } catch (error) {
      const errorMsg = (error as Error).message;
      this.logger?.error?.("Voice delegation error:", error);

      send({
        type: "voice.delegation",
        payload: { status: "error", task, error: errorMsg },
      });

      return `Sorry, I ran into an error: ${errorMsg}`;
    }
  }

  // --------------------------------------------------------------------------
  // Transcript recording
  // --------------------------------------------------------------------------

  /**
   * Record a transcript entry in the shared session history.
   * Non-blocking — catches errors silently to avoid disrupting voice flow.
   */
  private recordTranscript(
    sessionId: string,
    role: "user" | "assistant",
    text: string,
  ): void {
    if (!text.trim() || !this.config.sessionManager) return;

    try {
      this.config.sessionManager.appendMessage(sessionId, {
        role,
        content: text,
      });
    } catch {
      // Non-critical — don't disrupt voice flow
    }
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
