import { didToolCallFail } from "../llm/chat-executor-tool-utils.js";
import type { ChatExecutorResult } from "../llm/chat-executor.js";
import type { ToolHandler } from "../llm/types.js";
import { toErrorMessage } from "../utils/async.js";

export async function executeNativeToolCall(
  toolHandler: ToolHandler,
  name: string,
  args: Record<string, unknown>,
): Promise<ChatExecutorResult["toolCalls"][number]> {
  const startedAt = Date.now();
  try {
    const result = await toolHandler(name, args);
    return {
      name,
      args,
      result,
      isError: didToolCallFail(false, result),
      durationMs: Math.max(0, Date.now() - startedAt),
    };
  } catch (error) {
    const result = JSON.stringify({ error: toErrorMessage(error) });
    return {
      name,
      args,
      result,
      isError: true,
      durationMs: Math.max(0, Date.now() - startedAt),
    };
  }
}

export function buildNativeActorResult(
  toolCalls: readonly ChatExecutorResult["toolCalls"][number][],
  content: string,
  model = "runtime-native",
): ChatExecutorResult {
  const durationMs = toolCalls.reduce((total, toolCall) => total + toolCall.durationMs, 0);
  return {
    content,
    provider: "runtime-native",
    model,
    usedFallback: false,
    toolCalls,
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    callUsage: [],
    durationMs,
    compacted: false,
    stopReason: "completed",
  };
}
