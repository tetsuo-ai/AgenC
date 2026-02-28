import type { LLMMessage } from "./types.js";
import { LLMMessageValidationError } from "./errors.js";

const MAX_TOOL_IDS_IN_ERROR = 8;

export type ToolTurnValidationCode =
  | "assistant_tool_call_id_missing"
  | "assistant_tool_call_id_duplicate"
  | "assistant_tool_calls_started_before_results"
  | "tool_message_missing_tool_call_id"
  | "tool_result_without_assistant_call"
  | "tool_result_unknown_id"
  | "tool_result_duplicate"
  | "tool_result_missing";

export interface ToolTurnValidationIssue {
  readonly code: ToolTurnValidationCode;
  readonly index: number | null;
  readonly reason: string;
}

export interface ToolTurnValidationOptions {
  readonly providerName?: string;
}

function summarizeToolIds(ids: Iterable<string>): string {
  const all = Array.from(ids);
  if (all.length <= MAX_TOOL_IDS_IN_ERROR) {
    return all.join(", ");
  }
  const head = all.slice(0, MAX_TOOL_IDS_IN_ERROR).join(", ");
  return `${head} ... (+${all.length - MAX_TOOL_IDS_IN_ERROR} more)`;
}

function makeIssue(
  code: ToolTurnValidationCode,
  index: number | null,
  reason: string,
): ToolTurnValidationIssue {
  return { code, index, reason };
}

/**
 * Inspect messages and return the first tool-turn protocol violation, if any.
 */
export function findToolTurnValidationIssue(
  messages: readonly LLMMessage[],
): ToolTurnValidationIssue | null {
  let pendingToolCallIds: Set<string> | null = null;
  let pendingAssistantIndex = -1;
  const issuedToolCallIds = new Set<string>();
  const resolvedToolCallIds = new Set<string>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
      if (pendingToolCallIds && pendingToolCallIds.size > 0) {
        return makeIssue(
          "assistant_tool_calls_started_before_results",
          i,
          `new assistant tool_calls started before resolving all prior tool results from message[${pendingAssistantIndex}]`,
        );
      }

      const ids = new Set<string>();
      for (const toolCall of msg.toolCalls) {
        const id = toolCall.id?.trim();
        if (!id) {
          return makeIssue(
            "assistant_tool_call_id_missing",
            i,
            "assistant tool_calls contains an empty id",
          );
        }

        if (ids.has(id) || issuedToolCallIds.has(id)) {
          return makeIssue(
            "assistant_tool_call_id_duplicate",
            i,
            `assistant tool_calls contains duplicate id \"${id}\"`,
          );
        }

        ids.add(id);
        issuedToolCallIds.add(id);
      }

      pendingToolCallIds = ids;
      pendingAssistantIndex = i;
      continue;
    }

    if (msg.role === "tool") {
      const toolCallId = msg.toolCallId?.trim();
      if (!toolCallId) {
        return makeIssue(
          "tool_message_missing_tool_call_id",
          i,
          "tool message is missing toolCallId",
        );
      }

      if (resolvedToolCallIds.has(toolCallId)) {
        return makeIssue(
          "tool_result_duplicate",
          i,
          `tool message duplicates result for toolCallId \"${toolCallId}\"`,
        );
      }

      if (!pendingToolCallIds || pendingToolCallIds.size === 0) {
        return makeIssue(
          "tool_result_without_assistant_call",
          i,
          `tool message references \"${toolCallId}\" without a preceding assistant tool_calls message`,
        );
      }

      if (!pendingToolCallIds.has(toolCallId)) {
        return makeIssue(
          "tool_result_unknown_id",
          i,
          `tool message references unknown toolCallId \"${toolCallId}\" (expected one of: ${summarizeToolIds(pendingToolCallIds)})`,
        );
      }

      pendingToolCallIds.delete(toolCallId);
      resolvedToolCallIds.add(toolCallId);
      continue;
    }

    if (pendingToolCallIds && pendingToolCallIds.size > 0) {
      return makeIssue(
        "tool_result_missing",
        i,
        `missing tool result message(s) for toolCallId(s): ${summarizeToolIds(pendingToolCallIds)}. Tool results must immediately follow assistant tool_calls.`,
      );
    }
  }

  if (pendingToolCallIds && pendingToolCallIds.size > 0) {
    return makeIssue(
      "tool_result_missing",
      null,
      `missing tool result message(s) for toolCallId(s): ${summarizeToolIds(pendingToolCallIds)}.`,
    );
  }

  return null;
}

/**
 * Validate tool-turn ordering for outbound provider calls.
 * Throws a local 400-class error when sequence is malformed.
 */
export function validateToolTurnSequence(
  messages: readonly LLMMessage[],
  options?: ToolTurnValidationOptions,
): void {
  const issue = findToolTurnValidationIssue(messages);
  if (!issue) return;

  throw new LLMMessageValidationError(options?.providerName ?? "llm", {
    validationCode: issue.code,
    messageIndex: issue.index,
    reason: issue.reason,
  });
}
