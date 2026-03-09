/**
 * Shared session-scoped tool handler factory.
 *
 * Extracts the common hook → approval → routing → execution → notify pipeline
 * used by both the daemon (text-mode) and voice-bridge (legacy tool calls).
 *
 * @module
 */

import type { ControlResponse } from './types.js';
import type { ToolHandler } from '../llm/types.js';
import {
  didToolCallFail,
  normalizeToolCallArguments,
} from '../llm/chat-executor-tool-utils.js';
import type { HookDispatcher } from './hooks.js';
import type { ApprovalEngine } from './approvals.js';
import {
  EXECUTE_WITH_AGENT_TOOL_NAME,
} from './delegation-tool.js';
import {
  isSubAgentSessionId,
  type DelegationToolCompositionResolver,
} from './delegation-runtime.js';
import { executeDelegationTool } from "./tool-handler-factory-delegation.js";
import type { PolicyEvaluationScope } from "../policy/types.js";
import type { SessionCredentialBroker } from "../policy/session-credentials.js";

const DESKTOP_GUI_LAUNCH_RE =
  /^\s*(?:sudo\s+)?(?:env\s+[^;]+\s+)?(?:nohup\s+|setsid\s+)?(?:xfce4-terminal|gnome-terminal|xterm|kitty|firefox|chromium|chromium-browser|google-chrome|thunar|nautilus|mousepad|gedit)\b/i;
const DESKTOP_TERMINAL_LAUNCH_RE = /\b(?:xfce4-terminal|gnome-terminal|xterm|kitty)\b/i;
const DESKTOP_BROWSER_LAUNCH_RE = /\b(?:firefox|chromium|chromium-browser|google-chrome)\b/i;
const DESKTOP_FILE_MANAGER_LAUNCH_RE = /\b(?:thunar|nautilus)\b/i;
const DESKTOP_EDITOR_LAUNCH_RE = /\b(?:mousepad|gedit)\b/i;
const COLLAPSE_WHITESPACE_RE = /\s+/g;
const APPROVAL_TASK_PREVIEW_MAX_CHARS = 180;
const DOOM_TOOL_PREFIX = 'mcp.doom.';
const TOOL_NAME_ALIASES: Readonly<Record<string, string>> = {
  "system.makeDir": "system.mkdir",
  "system.listFiles": "system.listDir",
};

function normalizeToolName(name: string): string {
  const alias = TOOL_NAME_ALIASES[name];
  return typeof alias === "string" ? alias : name;
}

function isDoomTool(name: string): boolean {
  return name.startsWith(DOOM_TOOL_PREFIX);
}

function canonicalizeToolFailureResult(
  toolName: string,
  result: string,
): string {
  if (!isDoomTool(toolName) || !didToolCallFail(false, result)) {
    return result;
  }

  try {
    const parsed = JSON.parse(result) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return result;
    }
  } catch {
    // Wrap known Doom plain-text failures below.
  }

  const trimmed = result.trim();
  return JSON.stringify({
    error: trimmed.length > 0 ? trimmed : `Tool "${toolName}" failed`,
  });
}

function normalizeDesktopBashCommand(
  name: string,
  args: Record<string, unknown>,
): string | undefined {
  if (name !== 'desktop.bash') return undefined;
  const command =
    typeof args.command === 'string' ? args.command.trim() : '';
  if (!command) return undefined;
  if (!DESKTOP_GUI_LAUNCH_RE.test(command)) return undefined;
  if (DESKTOP_TERMINAL_LAUNCH_RE.test(command)) return '__gui_terminal__';
  if (DESKTOP_BROWSER_LAUNCH_RE.test(command)) {
    // Browser launches can differ materially by URL/flags; only dedupe exact
    // normalized command strings so recovery launches are not skipped.
    return `__gui_browser__:${command
      .replace(COLLAPSE_WHITESPACE_RE, ' ')
      .toLowerCase()}`;
  }
  if (DESKTOP_FILE_MANAGER_LAUNCH_RE.test(command)) return '__gui_file_manager__';
  if (DESKTOP_EDITOR_LAUNCH_RE.test(command)) return '__gui_editor__';
  return command.replace(COLLAPSE_WHITESPACE_RE, ' ').toLowerCase();
}

function shouldMarkGuiLaunchSeen(result: string): boolean {
  try {
    const parsed = JSON.parse(result) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return false;
    }
    const payload = parsed as { error?: unknown; exitCode?: unknown };
    if (typeof payload.error === 'string' && payload.error.trim().length > 0) {
      return false;
    }
    if (typeof payload.exitCode === 'number' && payload.exitCode !== 0) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function toErrorString(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= 3) return value.slice(0, Math.max(0, maxChars));
  return value.slice(0, maxChars - 3) + "...";
}

type DelegationContext = NonNullable<
  ReturnType<NonNullable<DelegationToolCompositionResolver>>
>;
type DelegationSubAgentInfo = ReturnType<
  NonNullable<DelegationContext["subAgentManager"]>["getInfo"]
>;
type DelegationLifecycleEmitter = DelegationContext["lifecycleEmitter"];

function sendDeniedToolResult(params: {
  send: (msg: ControlResponse) => void;
  toolName: string;
  result: string;
  toolCallId: string;
  sessionId: string;
  isSubAgentSession: boolean;
}): void {
  const { send, toolName, result, toolCallId, sessionId, isSubAgentSession } =
    params;
  send({
    type: "tools.result",
    payload: {
      toolName,
      result,
      durationMs: 0,
      isError: true,
      toolCallId,
      ...(isSubAgentSession ? { subagentSessionId: sessionId } : {}),
    },
  });
}

function buildApprovalMessage(params: {
  ruleDescription?: string;
  toolName: string;
  sessionId: string;
  isSubAgentSession: boolean;
  subAgentInfo: DelegationSubAgentInfo | null;
}): string {
  const {
    ruleDescription,
    toolName,
    sessionId,
    isSubAgentSession,
    subAgentInfo,
  } = params;
  const baseMessage = ruleDescription ?? `Approval required for ${toolName}`;
  if (!isSubAgentSession || !subAgentInfo) return baseMessage;
  const taskPreview = truncateText(
    subAgentInfo.task.trim(),
    APPROVAL_TASK_PREVIEW_MAX_CHARS,
  );
  return (
    `${baseMessage}\n` +
    `Parent session: ${subAgentInfo.parentSessionId}\n` +
    `Sub-agent session: ${sessionId}\n` +
    `Delegated task: ${taskPreview}`
  );
}

function sendImmediateToolError(params: {
  send: (msg: ControlResponse) => void;
  toolName: string;
  result: string;
  toolCallId: string;
  sessionId: string;
  isSubAgentSession: boolean;
  onToolEnd: SessionToolHandlerConfig["onToolEnd"];
  hooks?: HookDispatcher;
  args: Record<string, unknown>;
  hookMetadata?: Record<string, unknown>;
}): string {
  const {
    send,
    toolName,
    result,
    toolCallId,
    sessionId,
    isSubAgentSession,
    onToolEnd,
    hooks,
    args,
    hookMetadata,
  } = params;
  sendDeniedToolResult({
    send,
    toolName,
    result,
    toolCallId,
    sessionId,
    isSubAgentSession,
  });
  if (hooks) {
    void hooks.dispatch("tool:after", {
      sessionId,
      toolName,
      args,
      result,
      durationMs: 0,
      toolCallId,
      ...(hookMetadata ? { ...hookMetadata } : {}),
    });
  }
  onToolEnd?.(toolName, result, 0, toolCallId);
  return result;
}

async function runApprovalGate(params: {
  approvalEngine: ApprovalEngine | undefined;
  name: string;
  args: Record<string, unknown>;
  sessionId: string;
  parentSessionId: string | undefined;
  isSubAgentSession: boolean;
  subAgentInfo: DelegationSubAgentInfo | null;
  lifecycleEmitter: DelegationLifecycleEmitter;
  send: (msg: ControlResponse) => void;
  onToolEnd: SessionToolHandlerConfig["onToolEnd"];
  toolCallId: string;
}): Promise<string | null> {
  const {
    approvalEngine,
    name,
    args,
    sessionId,
    parentSessionId,
    isSubAgentSession,
    subAgentInfo,
    lifecycleEmitter,
    send,
    onToolEnd,
    toolCallId,
  } = params;
  if (!approvalEngine) {
    return null;
  }

  const rule = approvalEngine.requiresApproval(name, args);
  if (!rule || approvalEngine.isToolElevated(sessionId, name)) {
    return null;
  }

  if (approvalEngine.isToolDenied(sessionId, name, parentSessionId)) {
    const err = JSON.stringify({
      error:
        `Tool "${name}" blocked because this action was denied earlier in the request tree`,
    });
    sendDeniedToolResult({
      send,
      toolName: name,
      result: err,
      toolCallId,
      sessionId,
      isSubAgentSession,
    });
    if (isSubAgentSession && lifecycleEmitter) {
      lifecycleEmitter.emit({
        type: "subagents.failed",
        timestamp: Date.now(),
        sessionId,
        subagentSessionId: sessionId,
        ...(parentSessionId ? { parentSessionId } : {}),
        toolName: name,
        payload: {
          stage: "approval",
          reason: "denied_previously",
          toolCallId,
        },
      });
    }
    onToolEnd?.(name, err, 0, toolCallId);
    return err;
  }

  const approvalMessage = buildApprovalMessage({
    ruleDescription: rule.description,
    toolName: name,
    sessionId,
    isSubAgentSession,
    subAgentInfo,
  });
  const request = approvalEngine.createRequest(
    name,
    args,
    sessionId,
    approvalMessage,
    rule,
    {
      ...(parentSessionId ? { parentSessionId } : {}),
      ...(isSubAgentSession ? { subagentSessionId: sessionId } : {}),
    },
  );
  send({
    type: "approval.request",
    payload: {
      requestId: request.id,
      action: name,
      details: args,
      message: request.message,
      deadlineAt: request.deadlineAt,
      ...(request.slaMs !== undefined ? { slaMs: request.slaMs } : {}),
      ...(request.escalateAt !== undefined
        ? { escalateAt: request.escalateAt }
        : {}),
      allowDelegatedResolution: request.allowDelegatedResolution,
      ...(request.approverGroup
        ? { approverGroup: request.approverGroup }
        : {}),
      ...(request.requiredApproverRoles &&
      request.requiredApproverRoles.length > 0
        ? { requiredApproverRoles: request.requiredApproverRoles }
        : {}),
      ...(request.parentSessionId
        ? { parentSessionId: request.parentSessionId }
        : {}),
      ...(request.subagentSessionId
        ? { subagentSessionId: request.subagentSessionId }
        : {}),
    },
  });

  const response = await approvalEngine.requestApproval(request);
  if (response.disposition === "no") {
    const err = JSON.stringify({ error: `Tool "${name}" denied by user` });
    sendDeniedToolResult({
      send,
      toolName: name,
      result: err,
      toolCallId,
      sessionId,
      isSubAgentSession,
    });
    if (isSubAgentSession && lifecycleEmitter) {
      lifecycleEmitter.emit({
        type: "subagents.failed",
        timestamp: Date.now(),
        sessionId,
        subagentSessionId: sessionId,
        toolName: name,
        payload: {
          stage: "approval",
          reason: "denied",
          toolCallId,
        },
      });
    }
    onToolEnd?.(name, err, 0, toolCallId);
    return err;
  }

  if (response.disposition === "always") {
    approvalEngine.elevate(sessionId, name);
  }
  return null;
}

// ============================================================================
// Config
// ============================================================================

export interface SessionToolHandlerConfig {
  /** Session ID for hook context and approval scoping. */
  sessionId: string;
  /** Base tool handler (from ToolRegistry). */
  baseHandler: ToolHandler;
  /** Optional factory that returns a desktop-aware handler per router ID. */
  desktopRouterFactory?: (
    routerId: string,
    allowedToolNames?: readonly string[],
  ) => ToolHandler;
  /** ID used for desktop routing (clientId for voice, sessionId for daemon). */
  routerId: string;
  /** Send a message to the connected client. */
  send: (msg: ControlResponse) => void;
  /** Hook dispatcher for tool:before/after lifecycle. */
  hooks?: HookDispatcher;
  /** Approval engine for tool gating. */
  approvalEngine?: ApprovalEngine;
  /** Called when tool execution starts (before hooks). */
  onToolStart?: (
    toolName: string,
    args: Record<string, unknown>,
    toolCallId: string,
  ) => void;
  /** Called when tool execution finishes (after hooks). */
  onToolEnd?: (
    toolName: string,
    result: string,
    durationMs: number,
    toolCallId: string,
  ) => void;
  /** Optional resolver for live delegation runtime dependencies. */
  delegation?: DelegationToolCompositionResolver;
  /** Tool names visible to this session for child delegation scoping. */
  availableToolNames?: readonly string[];
  /** Extra metadata attached to tool hook payloads for this handler. */
  hookMetadata?: Record<string, unknown>;
  /** Optional session credential broker for structured secret injection. */
  credentialBroker?: SessionCredentialBroker;
  /** Optional callback resolving the policy scope for this session. */
  resolvePolicyScope?: () => PolicyEvaluationScope | undefined;
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a session-scoped tool handler that integrates hooks, approval gating,
 * desktop routing, and WebSocket notifications.
 *
 * Flow:
 * 1. `tool:before` hook — if blocked, return error (NO WS messages sent)
 * 2. `onToolStart` callback
 * 3. Send `tools.executing` to client
 * 4. Approval gate — if denied, send `tools.result` (isError), call `onToolEnd`, return
 * 5. Select handler via desktop router or base handler
 * 6. Execute and time it
 * 7. Send `tools.result` to client
 * 8. `tool:after` hook
 * 9. `onToolEnd` callback
 */
export function createSessionToolHandler(config: SessionToolHandlerConfig): ToolHandler {
  const {
    sessionId,
    baseHandler,
    desktopRouterFactory,
    routerId,
    send,
    hooks,
    approvalEngine,
    onToolStart,
    onToolEnd,
    delegation,
    availableToolNames,
    hookMetadata,
    credentialBroker,
    resolvePolicyScope,
  } = config;
  let toolCallSeq = 0;
  // Per-message duplicate guard to avoid opening the same GUI app twice when
  // the model emits repeated desktop.bash launch calls in one turn.
  const seenGuiLaunches = new Set<string>();
  const nextToolCallId = (): string =>
    `tool-${Date.now().toString(36)}-${++toolCallSeq}`;

  return async (name: string, args: Record<string, unknown>): Promise<string> => {
    const toolName = normalizeToolName(name);
    const normalizedArgs = normalizeToolCallArguments(toolName, args);
    const delegationContext = delegation?.();
    const subAgentManager = delegationContext?.subAgentManager ?? null;
    const policyEngine = delegationContext?.policyEngine ?? null;
    const verifier = delegationContext?.verifier ?? null;
    const lifecycleEmitter = delegationContext?.lifecycleEmitter ?? null;
    const isSubAgentSession = isSubAgentSessionId(sessionId);
    const subAgentInfo = isSubAgentSession
      ? subAgentManager?.getInfo(sessionId) ?? null
      : null;
    const parentSessionId = subAgentInfo?.parentSessionId;
    const policyScope = resolvePolicyScope?.();
    const credentialPreparation = credentialBroker?.prepare({
      sessionId,
      toolName,
      args: normalizedArgs,
      scope: policyScope,
    });
    if (credentialPreparation && !credentialPreparation.ok) {
      return JSON.stringify({ error: credentialPreparation.error });
    }
    const credentialPrepared = credentialPreparation?.prepared;
    const enrichedHookMetadata = {
      ...(hookMetadata ? { ...hookMetadata } : {}),
      ...(credentialPrepared
        ? { credentialPreview: credentialPrepared.preview }
        : {}),
    };

    const launchKey = normalizeDesktopBashCommand(toolName, args);
    if (launchKey) {
      if (seenGuiLaunches.has(launchKey)) {
        return JSON.stringify({
          stdout: '',
          stderr: '',
          exitCode: 0,
          backgrounded: true,
          skippedDuplicate: true,
        });
      }
    }

    const toolCallId = nextToolCallId();

    if (
      lifecycleEmitter &&
      policyEngine &&
      !isSubAgentSession &&
      policyEngine.isDelegationTool(toolName)
    ) {
      lifecycleEmitter.emit({
        type: 'subagents.planned',
        timestamp: Date.now(),
        sessionId,
        toolName: name,
        payload: {
          decisionThreshold: policyEngine.snapshot().spawnDecisionThreshold,
        },
      });
    }

    if (policyEngine) {
      const decision = policyEngine.evaluate({
        sessionId,
        toolName,
        args: normalizedArgs,
        isSubAgentSession,
      });
      if (!decision.allowed) {
        const err = JSON.stringify({
          error: decision.reason ?? `Tool "${toolName}" blocked by delegation policy`,
        });
        if (isSubAgentSession && lifecycleEmitter) {
          lifecycleEmitter.emit({
            type: 'subagents.failed',
            timestamp: Date.now(),
            sessionId,
            subagentSessionId: sessionId,
            toolName,
            payload: {
              stage: 'policy',
              reason: decision.reason,
            },
          });
        }
        return err;
      }
    }

    // 1. Hook: tool:before (policy gate, progress tracking, etc.)
    if (hooks) {
      const beforeResult = await hooks.dispatch('tool:before', {
        sessionId,
        toolName,
        args: normalizedArgs,
        ...(enrichedHookMetadata ? { ...enrichedHookMetadata } : {}),
      });
      if (!beforeResult.completed) {
        // Bug fix: do NOT send tools.executing when hook blocks — the tool
        // never started executing, so the client shouldn't show a tool card.
        const hookReason =
          typeof beforeResult.payload.reason === "string" &&
          beforeResult.payload.reason.trim().length > 0
            ? beforeResult.payload.reason.trim()
            : `Tool "${toolName}" blocked by hook`;
        if (isSubAgentSession && lifecycleEmitter) {
          lifecycleEmitter.emit({
            type: 'subagents.failed',
            timestamp: Date.now(),
            sessionId,
            subagentSessionId: sessionId,
            toolName,
            payload: { stage: 'hook_before', reason: hookReason },
          });
        }
        return JSON.stringify({ error: hookReason });
      }
    }

    // 2. Notify caller: tool execution starting
    onToolStart?.(toolName, normalizedArgs, toolCallId);

    if (isSubAgentSession && lifecycleEmitter) {
      lifecycleEmitter.emit({
        type: 'subagents.tool.executing',
        timestamp: Date.now(),
        sessionId,
        subagentSessionId: sessionId,
        toolName,
        payload: { args: normalizedArgs, toolCallId },
      });
    }

    // 3. Send tools.executing to client
    send({
      type: 'tools.executing',
      payload: {
        toolName,
        args: normalizedArgs,
        toolCallId,
        ...(isSubAgentSession ? { subagentSessionId: sessionId } : {}),
      },
    });

    // 4. Approval gate
    const approvalError = await runApprovalGate({
      approvalEngine,
      name: toolName,
      args: normalizedArgs,
      sessionId,
      parentSessionId,
      isSubAgentSession,
      subAgentInfo,
      lifecycleEmitter,
      send,
      onToolEnd,
      toolCallId,
    });
    if (approvalError) {
      return approvalError;
    }

    let executionArgs = normalizedArgs;
    if (credentialBroker && credentialPrepared) {
      const injectionResult = credentialBroker.inject({
        prepared: credentialPrepared,
        args: normalizedArgs,
        scope: policyScope,
      });
      if (!injectionResult.ok) {
        return sendImmediateToolError({
          send,
          toolName,
          result: JSON.stringify({ error: injectionResult.error }),
          toolCallId,
          sessionId,
          isSubAgentSession,
          onToolEnd,
          hooks,
          args: normalizedArgs,
          hookMetadata: enrichedHookMetadata,
        });
      }
      executionArgs = injectionResult.args;
    }

    // 5. Select handler: delegation executor or desktop-aware/base handler
    const routedHandler = desktopRouterFactory
      ? desktopRouterFactory(routerId, availableToolNames)
      : baseHandler;
    const activeHandler: ToolHandler = toolName === EXECUTE_WITH_AGENT_TOOL_NAME
      ? async (_toolName, toolArgs) =>
        executeDelegationTool({
          toolArgs,
          name: toolName,
          sessionId,
          toolCallId,
          subAgentManager,
          lifecycleEmitter,
          verifier,
          availableToolNames,
        })
      : routedHandler;

    // 6. Execute and time
    const start = Date.now();
    let result: string;
    try {
      result = await activeHandler(toolName, executionArgs);
    } catch (error) {
      if (isSubAgentSession && lifecycleEmitter) {
        lifecycleEmitter.emit({
          type: 'subagents.failed',
          timestamp: Date.now(),
          sessionId,
          subagentSessionId: sessionId,
          toolName,
          payload: {
            stage: 'execution',
            error: toErrorString(error),
            toolCallId,
          },
        });
      }
      throw error;
    }
    const durationMs = Date.now() - start;
    result = canonicalizeToolFailureResult(toolName, result);

    if (launchKey && shouldMarkGuiLaunchSeen(result)) {
      seenGuiLaunches.add(launchKey);
    }

    // 7. Send tools.result to client
    send({
      type: 'tools.result',
      payload: {
        toolName,
        result,
        durationMs,
        toolCallId,
        ...(isSubAgentSession ? { subagentSessionId: sessionId } : {}),
      },
    });

    if (isSubAgentSession && lifecycleEmitter) {
      lifecycleEmitter.emit({
        type: 'subagents.tool.result',
        timestamp: Date.now(),
        sessionId,
        subagentSessionId: sessionId,
        toolName,
        payload: {
          result,
          durationMs,
          toolCallId,
          verifyRequested: verifier?.shouldVerifySubAgentResult() ?? false,
        },
      });
    }

    // 8. Hook: tool:after (progress tracking)
    if (hooks) {
      await hooks.dispatch('tool:after', {
        sessionId,
        toolName,
        args: normalizedArgs,
        result,
        durationMs,
        toolCallId,
        ...(enrichedHookMetadata ? { ...enrichedHookMetadata } : {}),
      });
    }

    // 9. Notify caller: tool execution finished
    onToolEnd?.(toolName, result, durationMs, toolCallId);

    return result;
  };
}
