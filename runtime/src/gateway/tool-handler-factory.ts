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
import type { HookDispatcher } from './hooks.js';
import type { ApprovalEngine } from './approvals.js';

// ============================================================================
// Config
// ============================================================================

export interface SessionToolHandlerConfig {
  /** Session ID for hook context and approval scoping. */
  sessionId: string;
  /** Base tool handler (from ToolRegistry). */
  baseHandler: ToolHandler;
  /** Optional factory that returns a desktop-aware handler per router ID. */
  desktopRouterFactory?: (routerId: string) => ToolHandler;
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
  } = config;
  let toolCallSeq = 0;
  const nextToolCallId = (): string =>
    `tool-${Date.now().toString(36)}-${++toolCallSeq}`;

  return async (name: string, args: Record<string, unknown>): Promise<string> => {
    const toolCallId = nextToolCallId();

    // 1. Hook: tool:before (policy gate, progress tracking, etc.)
    if (hooks) {
      const beforeResult = await hooks.dispatch('tool:before', {
        sessionId,
        toolName: name,
        args,
      });
      if (!beforeResult.completed) {
        // Bug fix: do NOT send tools.executing when hook blocks — the tool
        // never started executing, so the client shouldn't show a tool card.
        return JSON.stringify({ error: `Tool "${name}" blocked by hook` });
      }
    }

    // 2. Notify caller: tool execution starting
    onToolStart?.(name, args, toolCallId);

    // 3. Send tools.executing to client
    send({
      type: 'tools.executing',
      payload: { toolName: name, args, toolCallId },
    });

    // 4. Approval gate
    if (approvalEngine) {
      const rule = approvalEngine.requiresApproval(name, args);
      if (rule && !approvalEngine.isToolElevated(sessionId, name)) {
        const request = approvalEngine.createRequest(
          name,
          args,
          sessionId,
          rule.description ?? `Approval required for ${name}`,
          rule,
        );
        send({
          type: 'approval.request',
          payload: {
            requestId: request.id,
            action: name,
            details: args,
            message: request.message,
          },
        });
        const response = await approvalEngine.requestApproval(request);
        if (response.disposition === 'no') {
          const err = JSON.stringify({ error: `Tool "${name}" denied by user` });
          send({
            type: 'tools.result',
            payload: { toolName: name, result: err, durationMs: 0, isError: true, toolCallId },
          });
          onToolEnd?.(name, err, 0, toolCallId);
          return err;
        }
        if (response.disposition === 'always') {
          approvalEngine.elevate(sessionId, name);
        }
      }
    }

    // 5. Select handler: desktop-aware router or base
    const activeHandler = desktopRouterFactory
      ? desktopRouterFactory(routerId)
      : baseHandler;

    // 6. Execute and time
    const start = Date.now();
    const result = await activeHandler(name, args);
    const durationMs = Date.now() - start;

    // 7. Send tools.result to client
    send({
      type: 'tools.result',
      payload: { toolName: name, result, durationMs, toolCallId },
    });

    // 8. Hook: tool:after (progress tracking)
    if (hooks) {
      await hooks.dispatch('tool:after', {
        sessionId,
        toolName: name,
        args,
        result,
        durationMs,
      });
    }

    // 9. Notify caller: tool execution finished
    onToolEnd?.(name, result, durationMs, toolCallId);

    return result;
  };
}
