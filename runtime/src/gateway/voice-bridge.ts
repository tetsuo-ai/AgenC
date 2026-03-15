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

import { randomUUID } from "node:crypto";
import { XaiRealtimeClient } from "../voice/realtime/client.js";
import type {
  VoiceSessionConfig,
  VoiceTool,
  XaiVoice,
} from "../voice/realtime/types.js";
import type { ControlResponse } from "./types.js";
import type { Logger } from "../utils/logger.js";
import type { ToolHandler } from "../llm/types.js";
import type { ChatExecutor } from "../llm/chat-executor.js";
import type { SessionManager } from "./session.js";
import type { HookDispatcher } from "./hooks.js";
import type { ApprovalEngine } from "./approvals.js";
import type { MemoryBackend } from "../memory/types.js";
import { createGatewayMessage } from "./message.js";
import { createSessionToolHandler } from "./tool-handler-factory.js";
import { buildChatUsagePayload } from "./chat-usage.js";
import {
  createExecutionTraceEventLogger,
  createProviderTraceEventLogger,
} from "../llm/provider-trace-logger.js";
import type { DelegationToolCompositionResolver } from "./delegation-runtime.js";
import {
  createExecuteWithAgentTool,
  parseExecuteWithAgentInput,
} from "./delegation-tool.js";
import {
  logTraceErrorEvent,
  logTraceEvent,
  summarizeTraceValue,
  summarizeToolResultForTrace,
} from "./daemon-trace.js";
import type { ResolvedTraceLoggingConfig } from "./daemon-trace.js";
import { normalizeToolCallArguments } from "../llm/chat-executor-tool-utils.js";
import { toErrorMessage } from "../utils/async.js";

const DEFAULT_MAX_SESSIONS = 10;

/**
 * Max tool rounds during voice delegation (prevents runaway desktop loops).
 * Desktop-enabled text chat gets 50 rounds (set in daemon.ts), but voice
 * caps at 15 because users can't intervene while the agent is executing.
 */
const MAX_DELEGATION_TOOL_ROUNDS = 15;

// Voice WebSocket message types — mirrors web/src/constants.ts
const VM = {
  AUDIO: "voice.audio",
  TRANSCRIPT: "voice.transcript",
  USER_TRANSCRIPT: "voice.user_transcript",
  SPEECH_STARTED: "voice.speech_started",
  SPEECH_STOPPED: "voice.speech_stopped",
  RESPONSE_DONE: "voice.response_done",
  DELEGATION: "voice.delegation",
  STATE: "voice.state",
  ERROR: "voice.error",
  STARTED: "voice.started",
  STOPPED: "voice.stopped",
} as const;

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
  "You are in a VOICE conversation. Keep responses short and natural.\n\n" +
  "WHEN TO DELEGATE: Use `execute_with_agent` for anything involving code, commands, " +
  "files, browsing, desktop actions, or multi-step work.\n\n" +
  "BEFORE DELEGATING: Say something brief and natural like \"On it\" or " +
  "\"Let me handle that\" — then delegate immediately. Do NOT narrate your plan.\n\n" +
  "AFTER DELEGATION: You will receive a summary of what was done. " +
  "Give the user a brief natural spoken summary of the result. " +
  "Do NOT read code, file paths, or raw output verbatim.\n\n" +
  "DIRECT RESPONSE (no delegation): Greetings, quick questions, opinions, " +
  "clarifications — keep to 1-2 sentences.\n\n" +
  "IMPORTANT: The user may interrupt you at any time. This is normal. " +
  "Do not repeat what you were saying — just listen and respond to the new input.\n\n" +
  "FORBIDDEN: Monologuing. Listing steps. Reading code aloud. Markdown. " +
  "Repeating yourself after being interrupted.";


// ============================================================================
// Delegation tool definition
// ============================================================================

/**
 * Sanitize xAI function call arguments before JSON.parse.
 * xAI sometimes sends Python-style "None" or bare "null" instead of "{}".
 */
function sanitizeXaiArgs(argsJson: string): string {
  if (!argsJson || argsJson === "None" || argsJson === "null") return "{}";
  return argsJson;
}

/** xAI Voice Agent custom tool definition for the shared delegation contract. */
export function createVoiceDelegationTool(): VoiceTool {
  const tool = createExecuteWithAgentTool();
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  };
}

/** Single delegation tool sent to xAI Realtime when ChatExecutor is available. */
const AGENT_DELEGATION_TOOL: VoiceTool = createVoiceDelegationTool();

// ============================================================================
// Config & types
// ============================================================================

export interface VoiceBridgeConfig {
  /** xAI API key. */
  apiKey: string;
  /** Tool execution handler (fallback when no desktop router). */
  toolHandler: ToolHandler;
  /** Tool names visible to the voice session for delegation scoping. */
  availableToolNames?: readonly string[];
  /** Factory that returns a desktop-aware tool handler scoped to a session. */
  desktopRouterFactory?: (
    sessionId: string,
    allowedToolNames?: readonly string[],
  ) => ToolHandler;
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

  // --- Chat-Supervisor delegation ---

  /** Resolve the current ChatExecutor for delegated task execution. */
  getChatExecutor: () => ChatExecutor | null | undefined;
  /** SessionManager for shared voice/text session history. */
  sessionManager?: SessionManager;
  /** HookDispatcher for tool:before/after and message lifecycle hooks. */
  hooks?: HookDispatcher;
  /** ApprovalEngine for tool gating during delegation. */
  approvalEngine?: ApprovalEngine;
  /** MemoryBackend for persisting voice interactions. */
  memoryBackend?: MemoryBackend;
  /** Session token budget (for reporting usage to the browser). */
  sessionTokenBudget?: number;
  /** Model context window used for context-usage display in the web UI. */
  contextWindowTokens?: number;
  /** Live delegation runtime dependencies used by tool-handler composition. */
  delegation?: DelegationToolCompositionResolver;
  /** Emit raw provider payload traces when daemon trace logging enables it. */
  traceProviderPayloads?: boolean;
  /** Full trace logging controls shared with the daemon's traced webchat path. */
  traceConfig?: ResolvedTraceLoggingConfig;
}

interface ActiveSession {
  client: XaiRealtimeClient;
  send: (response: ControlResponse) => void;
  toolHandler: ToolHandler;
  /** Shared session ID for browser/ChatExecutor communication. */
  sessionId: string;
  /** Derived session ID in SessionManager (hashed key from getOrCreate). */
  managedSessionId: string;
  /** Abort controller for the active delegation, if any. */
  delegationAbort: AbortController | null;
  /** Active trace for the current spoken turn. */
  currentTraceId: string | null;
  /** True once the current turn has been delegated into ChatExecutor. */
  currentTurnDelegated: boolean;
}

// ============================================================================
// VoiceBridge
// ============================================================================

/**
 * Manages per-client real-time voice sessions bridging browser audio
 * to the xAI Realtime API.
 *
 * Uses Chat-Supervisor delegation: xAI Realtime only receives the
 * `execute_with_agent` tool. Complex tasks are routed through
 * ChatExecutor with full context injection (memory, learning,
 * progress, skills, hooks, tools, multi-round loop).
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
        type: VM.ERROR,
        payload: { message: "Maximum concurrent voice sessions reached" },
      });
      return;
    }

    const effectiveSessionId = sessionId ?? `voice:${clientId}`;

    // Build tool handler for delegation
    const sessionToolHandler = this.buildSessionToolHandler(
      effectiveSessionId,
      send,
    );

    // Resolve the SessionManager's canonical session ID for this webchat client.
    // This keeps voice transcripts and delegated tool calls aligned with the
    // text session history.
    const managedSessionId =
      this.config.sessionManager?.getOrCreate({
        channel: "webchat",
        senderId: clientId,
        scope: "dm",
        workspaceId: "default",
      }).id ?? effectiveSessionId;

    // Load memory context from persistent backend (cross-session awareness).
    // Pull last 15 entries to give the voice model meaningful context about
    // what the user has been working on across sessions.
    let memoryContext = "";
    if (this.config.memoryBackend) {
      try {
        const recentEntries = await this.config.memoryBackend.getThread(
          effectiveSessionId,
          15,
        );
        if (recentEntries.length > 0) {
          const summaries = recentEntries
            .filter((e) => e.content.trim())
            .map((e) => `- ${e.role}: ${e.content.slice(0, 300)}`)
            .join("\n");
          if (summaries) {
            memoryContext =
              "\n\n## Session Context\n" +
              "Prior conversation context (use this to maintain continuity):\n" +
              summaries;
          }
        }
      } catch {
        // Non-critical — voice still works without memory
      }
    }

    const voiceInstructions =
      this.config.systemPrompt + memoryContext + VOICE_DELEGATION_PROMPT;

    const sessionConfig: VoiceSessionConfig = {
      model: this.config.model ?? "grok-4-1-fast-reasoning",
      voice: this.config.voice ?? "Ara",
      modalities: ["text", "audio"],
      instructions: voiceInstructions,
      audio: {
        input: { format: { type: "audio/pcm", rate: 24000 } },
        output: { format: { type: "audio/pcm", rate: 24000 } },
      },
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
      tools: [AGENT_DELEGATION_TOOL],
    };

    const client = new XaiRealtimeClient({
      apiKey: this.config.apiKey,
      sessionConfig,
      logger: this.logger,
      callbacks: this.buildClientCallbacks(
        clientId,
        effectiveSessionId,
        send,
      ),
    });

    this.sessions.set(clientId, {
      client,
      send,
      toolHandler: sessionToolHandler,
      sessionId: effectiveSessionId,
      managedSessionId,
      delegationAbort: null,
      currentTraceId: null,
      currentTurnDelegated: false,
    });

    try {
      await client.connect();

      // Inject session history so xAI has context on reconnect
      this.injectSessionContext(client, managedSessionId);

      send({ type: VM.STARTED });
      this.logger?.info?.(
        `Voice session started for client ${clientId} (delegation mode)`,
      );
    } catch (err) {
      this.sessions.delete(clientId);
      send({
        type: VM.ERROR,
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

    session.delegationAbort?.abort();
    session.client.close();
    this.sessions.delete(clientId);
    session.send({ type: VM.STOPPED });
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
   * Used by ChatExecutor during delegation for tool execution.
   */
  private buildSessionToolHandler(
    sessionId: string,
    send: (response: ControlResponse) => void,
  ): ToolHandler {
    const { hooks, approvalEngine, desktopRouterFactory, toolHandler } =
      this.config;

    const baseHandler = createSessionToolHandler({
      sessionId,
      baseHandler: toolHandler,
      availableToolNames: this.config.availableToolNames,
      desktopRouterFactory,
      // Keep desktop routing aligned with chat slash commands/history by using
      // the shared web session id (not raw client id aliases).
      routerId: sessionId,
      send,
      hooks,
      approvalEngine,
      delegation: this.config.delegation,
    });

    return this.buildTracedToolHandler(sessionId, baseHandler);
  }

  private buildTracedToolHandler(
    sessionId: string,
    baseHandler: ToolHandler,
  ): ToolHandler {
    const traceConfig = this.config.traceConfig;
    if (!traceConfig?.enabled) return baseHandler;

    return async (name, args) => {
      const normalizedArgs = normalizeToolCallArguments(name, args);
      const traceId = this.ensureTraceIdForSession(sessionId);

      this.logTrace(
        "voice.tool.call",
        {
          traceId,
          sessionId,
          tool: name,
          ...(traceConfig.includeToolArgs
            ? { args: summarizeTraceValue(normalizedArgs, traceConfig.maxChars) }
            : {}),
        },
        traceId,
      );

      const startedAt = Date.now();
      try {
        const result = await baseHandler(name, normalizedArgs);
        this.logTrace(
          "voice.tool.result",
          {
            traceId,
            sessionId,
            tool: name,
            durationMs: Date.now() - startedAt,
            ...(traceConfig.includeToolResults
              ? {
                  result: summarizeToolResultForTrace(
                    result,
                    traceConfig.maxChars,
                  ),
                }
              : {}),
          },
          traceId,
        );
        return result;
      } catch (error) {
        this.logTraceError(
          "voice.tool.error",
          {
            traceId,
            sessionId,
            tool: name,
            durationMs: Date.now() - startedAt,
            error: toErrorMessage(error),
          },
          traceId,
        );
        throw error;
      }
    };
  }

  // --------------------------------------------------------------------------
  // Client callbacks
  // --------------------------------------------------------------------------

  /** Build the XaiRealtimeClient callback set for a session. */
  private buildClientCallbacks(
    clientId: string,
    sessionId: string,
    send: (response: ControlResponse) => void,
  ) {
    return {
      onAudioDeltaBase64: (base64: string) => {
        send({ type: VM.AUDIO, payload: { audio: base64 } });
      },
      onTranscriptDelta: (text: string) => {
        send({ type: VM.TRANSCRIPT, payload: { delta: text, done: false } });
      },
      onTranscriptDone: (text: string) => {
        send({ type: VM.TRANSCRIPT, payload: { text, done: true } });
        this.recordTranscript(clientId, "assistant", text);
        if (text.trim()) {
          const session = this.sessions.get(clientId);
          const traceId = this.ensureTraceId(clientId, sessionId);
          this.logTrace(
            session?.currentTurnDelegated === true
              ? "voice.assistant.transcript"
              : "voice.chat.response",
            {
              traceId,
              sessionId,
              clientId,
              content: text,
            },
            traceId,
          );
        }
      },
      onFunctionCall: async (name: string, args: string, _callId: string) => {
        if (name === "execute_with_agent") {
          return this.handleDelegation(clientId, sessionId, args, send);
        }
        // xAI hallucinated a tool not in the schema
        this.logger?.warn?.(
          `Voice session called unknown tool "${name}" — only execute_with_agent available`,
        );
        return JSON.stringify({
          error: `Unknown tool "${name}". Use execute_with_agent to delegate tasks.`,
        });
      },
      onInputTranscriptDone: (text: string) => {
        send({ type: VM.USER_TRANSCRIPT, payload: { text } });
        this.recordTranscript(clientId, "user", text);
        if (text.trim()) {
          const traceId = this.ensureTraceId(clientId, sessionId);
          this.logTrace(
            "voice.inbound",
            {
              traceId,
              sessionId,
              clientId,
              content: text,
            },
            traceId,
          );
        }
      },
      onSpeechStarted: () => {
        this.beginTurnTrace(clientId, sessionId);
        send({ type: VM.SPEECH_STARTED });
        const session = this.sessions.get(clientId);
        if (session) {
          // Cancel any in-progress xAI response so the agent shuts up
          // immediately when the user starts talking — even mid-sentence.
          session.client.cancelResponse();
          // During active delegation, also clear buffered audio to prevent
          // frustrated utterances from queuing as new delegation tasks.
          if (session.delegationAbort) {
            session.client.clearAudio();
          }
        }
      },
      onSpeechStopped: () => { send({ type: VM.SPEECH_STOPPED }); },
      onResponseDone: () => {
        send({ type: VM.RESPONSE_DONE });
        this.resetTurnTrace(clientId);
      },
      onError: (error: { message: string; code?: string }) => {
        this.logger?.warn?.("Voice session error:", error);
        const traceId = this.ensureTraceId(clientId, sessionId);
        this.logTraceError(
          "voice.chat.error",
          {
            traceId,
            sessionId,
            clientId,
            error: error.message,
            ...(error.code ? { code: error.code } : {}),
          },
          traceId,
        );
        send({ type: VM.ERROR, payload: { message: error.message, code: error.code } });
      },
      onConnectionStateChange: (state: string) => {
        send({ type: VM.STATE, payload: { connectionState: state } });
      },
    };
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
    const task = this.parseDelegationTask(argsJson);
    if (typeof task !== "string") return task.error;

    const session = this.sessions.get(clientId);
    const traceId = this.ensureTraceId(clientId, sessionId);
    if (session) session.currentTurnDelegated = true;
    send({ type: VM.DELEGATION, payload: { status: "started", task } });
    this.logTrace(
      "voice.delegation.started",
      {
        traceId,
        sessionId,
        clientId,
        task,
      },
      traceId,
    );

    // Cancel any stale delegation and set up abort for this one
    session?.delegationAbort?.abort();
    const abortController = new AbortController();
    if (session) session.delegationAbort = abortController;

    try {
      // Policy check via message:inbound hook
      const blocked = await this.dispatchPolicyCheck(
        clientId,
        sessionId,
        task,
        send,
        traceId,
      );
      if (blocked) return blocked;

      // Session history
      const managedSessionId = session?.managedSessionId ?? sessionId;
      const history = this.config.sessionManager
        ? this.config.sessionManager.get(managedSessionId)?.history ??
          this.config.sessionManager.getOrCreate({
            channel: "webchat",
            senderId: clientId,
            scope: "dm",
            workspaceId: "default",
          }).history
        : [];

      const gatewayMsg = createGatewayMessage({
        channel: "voice",
        senderId: clientId,
        senderName: `VoiceClient(${clientId})`,
        sessionId,
        content: task,
        scope: "dm",
      });

      // Tool handler sends tools.executing/tools.result to browser (renders
      // as tool cards in the chat panel). We DON'T wrap with extra delegation
      // progress messages — the tool cards ARE the progress UI.
      const delegationToolHandler = this.buildSessionToolHandler(sessionId, send);

      const chatExecutor = this.requireChatExecutor();
      const providerTrace =
        this.config.traceProviderPayloads === true && this.logger
          ? {
            includeProviderPayloads: true as const,
            onProviderTraceEvent: createProviderTraceEventLogger({
              logger: this.logger,
              traceLabel: "voice.provider",
              traceId,
              sessionId,
              staticFields: {
                clientId,
                phase: "delegation",
              },
            }),
            onExecutionTraceEvent: createExecutionTraceEventLogger({
              logger: this.logger,
              traceLabel: "voice.executor",
              traceId,
              sessionId,
              staticFields: {
                clientId,
                phase: "delegation",
              },
            }),
          }
          : undefined;
      const result = await chatExecutor.execute({
        message: gatewayMsg,
        history,
        systemPrompt: this.config.systemPrompt,
        sessionId,
        toolHandler: delegationToolHandler,
        // No onStreamChunk — streaming LLM text to the voice overlay floods
        // it with hundreds of words the user can't read. Tool cards in the
        // chat panel provide progress instead.
        maxToolRounds: MAX_DELEGATION_TOOL_ROUNDS,
        signal: abortController.signal,
        ...(providerTrace ? { trace: providerTrace } : {}),
      });

      // Persist results to session history and memory
      this.persistDelegationResult(
        sessionId,
        managedSessionId,
        task,
        result.content,
      );

      // Dispatch outbound hook
      if (this.config.hooks) {
        await this.config.hooks.dispatch("message:outbound", {
          sessionId,
          content: result.content,
          provider: result.provider,
          userMessage: task,
          agentResponse: result.content,
        });
      }

      // Send full result to browser chat panel
      send({
        type: VM.DELEGATION,
        payload: {
          status: "completed",
          task,
          content: result.content,
          toolCalls: result.toolCalls.length,
          provider: result.provider,
          durationMs: result.durationMs,
        },
      });
      this.logTrace(
        "voice.chat.response",
        {
          traceId,
          sessionId,
          clientId,
          content: result.content,
          responseSource: "delegation",
          provider: result.provider,
          durationMs: result.durationMs,
          toolCalls: result.toolCalls.length,
        },
        traceId,
      );

      // Send cumulative token usage to browser chat panel
      send({
        type: "chat.usage",
        payload: buildChatUsagePayload({
          totalTokens: chatExecutor.getSessionTokenUsage(sessionId),
          sessionTokenBudget: this.config.sessionTokenBudget ?? 0,
          compacted: result.compacted ?? false,
          contextWindowTokens: this.config.contextWindowTokens,
          callUsage: result.callUsage,
        }),
      });

      if (result.toolCalls.length > 0) {
        this.logger?.info?.(
          `Voice delegation used ${result.toolCalls.length} tool call(s)`,
          { tools: result.toolCalls.map((tc: { name: string }) => tc.name), provider: result.provider },
        );
      }

      // Return a truncated summary so xAI can speak something useful.
      // Full result is already in the browser chat panel via voice.delegation.
      return this.buildSpokenSummary(result.content, result.toolCalls.length);
    } catch (error) {
      const errorMsg = (error as Error).message;
      this.logger?.error?.("Voice delegation error:", error);
      this.logTraceError(
        "voice.delegation.error",
        {
          traceId,
          sessionId,
          clientId,
          task,
          error: errorMsg,
        },
        traceId,
      );
      send({ type: VM.DELEGATION, payload: { status: "error", task, error: errorMsg } });
      return `Sorry, I ran into an error: ${errorMsg}`;
    } finally {
      // Clear abort controller only if it's still ours (not replaced by a newer delegation)
      if (session?.delegationAbort === abortController) {
        session.delegationAbort = null;
      }
    }
  }

  // --------------------------------------------------------------------------
  // Delegation helpers
  // --------------------------------------------------------------------------

  /** Parse and validate the task description from xAI's function call JSON. */
  private parseDelegationTask(argsJson: string): string | { error: string } {
    let parsedArgs: Record<string, unknown>;
    try {
      parsedArgs = JSON.parse(
        sanitizeXaiArgs(argsJson),
      ) as Record<string, unknown>;
    } catch {
      return { error: JSON.stringify({ error: "Invalid delegation arguments" }) };
    }

    const parsed = parseExecuteWithAgentInput(parsedArgs);
    if (!parsed.ok) {
      return { error: JSON.stringify({ error: parsed.error }) };
    }
    return parsed.value.task;
  }

  /**
   * Build a brief spoken summary from the delegation result.
   * Gives xAI enough context to speak a natural one-liner without
   * reading the entire output (code, file contents, etc.) aloud.
   */
  private buildSpokenSummary(content: string, toolCallCount: number): string {
    const MAX_SUMMARY_CHARS = 300;
    const trimmed = content.trim();

    // Short results can be returned directly — xAI will speak them naturally.
    if (trimmed.length <= MAX_SUMMARY_CHARS) {
      return (
        `Task completed. Here is the result:\n\n${trimmed}\n\n` +
        "Give the user a brief spoken summary. Do NOT read code or long output verbatim."
      );
    }

    // For long results, extract the first meaningful chunk and let xAI
    // summarize. Strip markdown fences/headers which sound bad spoken aloud.
    const firstChunk = trimmed
      .replace(/^```[\s\S]*?```/m, "")
      .replace(/^#+\s+/gm, "")
      .slice(0, MAX_SUMMARY_CHARS)
      .trim();
    const suffix = toolCallCount > 0
      ? ` (used ${toolCallCount} tool${toolCallCount === 1 ? "" : "s"})`
      : "";

    return (
      `Task completed${suffix}. Summary of the result:\n\n${firstChunk}...\n\n` +
      "The full output is in the chat panel. Give a brief one-sentence spoken summary. " +
      "Do NOT read code, file paths, or raw output aloud."
    );
  }

  private requireChatExecutor(): ChatExecutor {
    const chatExecutor = this.config.getChatExecutor();
    if (!chatExecutor) {
      throw new Error("Voice delegation unavailable — no LLM provider configured");
    }
    return chatExecutor;
  }

  /** Run policy check via message:inbound hook. Returns spoken error if blocked, null if OK. */
  private async dispatchPolicyCheck(
    clientId: string,
    sessionId: string,
    task: string,
    send: (response: ControlResponse) => void,
    traceId?: string,
  ): Promise<string | null> {
    const { hooks } = this.config;
    if (!hooks) return null;

    const result = await hooks.dispatch("message:inbound", {
      sessionId,
      content: task,
      senderId: clientId,
      channel: "voice",
    });
    if (!result.completed) {
      const reason =
        typeof result.payload.reason === "string" &&
        result.payload.reason.trim().length > 0
          ? result.payload.reason.trim()
          : "Message blocked by policy";
      send({
        type: VM.DELEGATION,
        payload: { status: "blocked", task, error: reason },
      });
      this.logTraceError(
        "voice.delegation.blocked",
        {
          traceId: traceId ?? this.ensureTraceId(clientId, sessionId),
          sessionId,
          clientId,
          task,
          error: reason,
          stopReason: "policy_blocked",
        },
        traceId,
      );
      return reason;
    }
    return null;
  }

  /** Persist delegation messages to session history and memory backend. */
  private persistDelegationResult(
    sessionId: string,
    managedSessionId: string,
    task: string,
    content: string,
  ): void {
    const { sessionManager, memoryBackend } = this.config;

    if (sessionManager) {
      sessionManager.appendMessage(managedSessionId, { role: "user", content: task });
      sessionManager.appendMessage(managedSessionId, {
        role: "assistant",
        content,
      });
    }

    if (memoryBackend) {
      // Fire-and-forget — don't block the response
      // Use effectiveSessionId for memory backend (cross-session persistence)
      Promise.all([
        memoryBackend.addEntry({ sessionId, role: "user", content: task }),
        memoryBackend.addEntry({ sessionId, role: "assistant", content }),
      ]).catch((error) => {
        this.logger?.warn?.("Failed to persist voice delegation to memory:", error);
      });
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
    clientId: string,
    role: "user" | "assistant",
    text: string,
  ): void {
    if (!text.trim() || !this.config.sessionManager) return;
    const session = this.sessions.get(clientId);
    if (!session) return;

    try {
      this.config.sessionManager.appendMessage(session.managedSessionId, {
        role,
        content: text,
      });
    } catch {
      // Non-critical — don't disrupt voice flow
    }
  }

  // --------------------------------------------------------------------------
  // Session context injection
  // --------------------------------------------------------------------------

  /**
   * Inject session history into the xAI Realtime session so the voice
   * model has conversation context from prior interactions.
   */
  private injectSessionContext(
    client: XaiRealtimeClient,
    managedSessionId: string,
  ): void {
    const { sessionManager } = this.config;
    if (!sessionManager) return;

    const storedSession = sessionManager.get(managedSessionId);
    if (!storedSession) return;

    const history = storedSession.history;
    if (history.length === 0) return;

    // Filter to user/assistant text messages, cap at last 40.
    // Voice sessions need enough context to maintain conversation coherence
    // across delegation results and prior exchanges.
    const MAX_HISTORY_ITEMS = 40;
    const MAX_CONTENT_CHARS = 500;
    const eligible = history.filter(
      (m) =>
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        (m.content as string).trim(),
    );
    // Truncate long messages (code output, etc.) to keep injection bounded
    const recent = eligible.slice(-MAX_HISTORY_ITEMS).map((m) => {
      const text = (m.content as string).trim();
      return {
        ...m,
        content: text.length > MAX_CONTENT_CHARS
          ? text.slice(0, MAX_CONTENT_CHARS) + "..."
          : text,
      };
    });

    if (recent.length > 0) {
      client.injectConversationHistory(
        recent.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content as string,
        })),
      );
      this.logger?.debug?.(
        `Injected ${recent.length} history items into voice session`,
      );
    }
  }

  private beginTurnTrace(clientId: string, sessionId: string): string {
    const traceId = this.createVoiceTurnTraceId(sessionId);
    const session = this.sessions.get(clientId);
    if (session) {
      session.currentTraceId = traceId;
      session.currentTurnDelegated = false;
    }
    return traceId;
  }

  private ensureTraceId(clientId: string, sessionId: string): string {
    const session = this.sessions.get(clientId);
    if (session?.currentTraceId) return session.currentTraceId;
    return this.beginTurnTrace(clientId, sessionId);
  }

  private ensureTraceIdForSession(sessionId: string): string {
    for (const session of this.sessions.values()) {
      if (session.sessionId !== sessionId) continue;
      if (!session.currentTraceId) {
        session.currentTraceId = this.createVoiceTurnTraceId(sessionId);
      }
      return session.currentTraceId;
    }
    return this.createVoiceTurnTraceId(sessionId);
  }

  private resetTurnTrace(clientId: string): void {
    const session = this.sessions.get(clientId);
    if (!session) return;
    session.currentTraceId = null;
    session.currentTurnDelegated = false;
  }

  private createVoiceTurnTraceId(sessionId: string): string {
    return `${sessionId}:voice:${Date.now().toString(36)}:${randomUUID().slice(0, 8)}`;
  }

  private logTrace(
    eventName: string,
    payload: Record<string, unknown>,
    traceId?: string,
  ): void {
    const traceConfig = this.config.traceConfig;
    if (!traceConfig?.enabled || !this.logger) return;
    logTraceEvent(
      this.logger,
      eventName,
      {
        ...payload,
        ...(traceId ? { traceId } : {}),
      },
      traceConfig.maxChars,
    );
  }

  private logTraceError(
    eventName: string,
    payload: Record<string, unknown>,
    traceId?: string,
  ): void {
    const traceConfig = this.config.traceConfig;
    if (!traceConfig?.enabled || !this.logger) return;
    logTraceErrorEvent(
      this.logger,
      eventName,
      {
        ...payload,
        ...(traceId ? { traceId } : {}),
      },
      traceConfig.maxChars,
    );
  }
}
