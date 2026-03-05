/**
 * Standalone tool helper functions for ChatExecutor.
 *
 * @module
 */

import type { ToolCallRecord } from "./chat-executor-types.js";
import type { LLMRetryPolicyMatrix } from "./policy.js";
import { DEFAULT_LLM_RETRY_POLICY_MATRIX } from "./policy.js";
import type { LLMFailureClass, LLMRetryPolicyRule } from "./policy.js";
import type { LLMRetryPolicyOverrides } from "./chat-executor-types.js";
import {
  HIGH_RISK_TOOLS,
  HIGH_RISK_TOOL_PREFIXES,
  SAFE_TOOL_RETRY_TOOLS,
  SAFE_TOOL_RETRY_PREFIXES,
} from "./chat-executor-constants.js";
import { safeStringify } from "../tools/types.js";

export function didToolCallFail(isError: boolean, result: string): boolean {
  if (isError) return true;
  try {
    const parsed = JSON.parse(result) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return false;
    }
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.error === "string" && obj.error.trim().length > 0) return true;
    if (typeof obj.exitCode === "number" && obj.exitCode !== 0) return true;
  } catch {
    // Non-JSON tool output — treat as non-failure unless isError=true.
  }
  return false;
}

export function parseToolResultObject(
  result: string,
): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(result) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function extractToolFailureText(record: ToolCallRecord): string {
  const parsed = parseToolResultObject(record.result);
  if (!parsed) return record.result;

  const pieces: string[] = [];
  if (typeof parsed.error === "string" && parsed.error.trim().length > 0) {
    pieces.push(parsed.error.trim());
  }
  if (typeof parsed.stderr === "string" && parsed.stderr.trim().length > 0) {
    pieces.push(parsed.stderr.trim());
  }
  if (pieces.length > 0) return pieces.join("\n");
  return record.result;
}

export function resolveRetryPolicyMatrix(
  overrides?: LLMRetryPolicyOverrides,
): LLMRetryPolicyMatrix {
  if (!overrides) return DEFAULT_LLM_RETRY_POLICY_MATRIX;
  const merged = {
    ...DEFAULT_LLM_RETRY_POLICY_MATRIX,
  } as Record<LLMFailureClass, LLMRetryPolicyRule>;
  for (const failureClass of Object.keys(
    DEFAULT_LLM_RETRY_POLICY_MATRIX,
  ) as LLMFailureClass[]) {
    const baseRule = merged[failureClass];
    const patch = overrides[failureClass];
    if (!patch) continue;
    merged[failureClass] = {
      ...baseRule,
      ...patch,
    };
  }
  return merged;
}

export function hasExplicitIdempotencyKey(args: Record<string, unknown>): boolean {
  const value = args.idempotencyKey;
  return typeof value === "string" && value.trim().length > 0;
}

export function isHighRiskToolCall(
  toolName: string,
): boolean {
  if (HIGH_RISK_TOOLS.has(toolName)) return true;
  return HIGH_RISK_TOOL_PREFIXES.some((prefix) => toolName.startsWith(prefix));
}

export function isToolRetrySafe(toolName: string): boolean {
  if (SAFE_TOOL_RETRY_TOOLS.has(toolName)) return true;
  return SAFE_TOOL_RETRY_PREFIXES.some((prefix) => toolName.startsWith(prefix));
}

export function isLikelyToolTransportFailure(
  errorText: string,
): boolean {
  const lower = errorText.toLowerCase();
  return (
    lower.includes("timed out") ||
    lower.includes("timeout") ||
    lower.includes("fetch failed") ||
    lower.includes("connection refused") ||
    lower.includes("econnrefused") ||
    lower.includes("econnreset") ||
    lower.includes("etimedout") ||
    lower.includes("network") ||
    lower.includes("transport") ||
    lower.includes("bridge")
  );
}

export function enrichToolResultMetadata(
  result: string,
  metadata: Record<string, unknown>,
): string {
  const parsed = parseToolResultObject(result);
  if (!parsed) return result;
  return safeStringify({
    ...parsed,
    ...metadata,
  });
}
