import type { ToolResult } from "../types.js";
import { safeStringify } from "../types.js";

export function toolErrorResult(message: string): ToolResult {
  return { content: safeStringify({ error: message }), isError: true };
}

export function parseBigIntArg(
  value: unknown,
  fieldName: string,
): [bigint, null] | [null, ToolResult] {
  try {
    return [BigInt(value as string), null];
  } catch {
    return [
      null,
      toolErrorResult(`Invalid ${fieldName}: must be a numeric string`),
    ];
  }
}
