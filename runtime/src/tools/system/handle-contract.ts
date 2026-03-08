import type { ToolResult } from "../types.js";
import { safeStringify } from "../types.js";

export interface StructuredHandleErrorDetails {
  readonly [key: string]: unknown;
}

export interface NormalizedHandleIdentity {
  readonly label?: string;
  readonly idempotencyKey?: string;
}

export function handleErrorResult(
  family: string,
  code: string,
  message: string,
  retryable = false,
  details?: StructuredHandleErrorDetails,
  operation?: string,
): ToolResult {
  return {
    content: safeStringify({
      error: {
        family,
        code,
        message,
        retryable,
        ...(operation ? { operation } : {}),
        ...(details ? { details } : {}),
      },
    }),
    isError: true,
  };
}

export function handleOkResult(value: unknown): ToolResult {
  return { content: safeStringify(value) };
}

export function isToolResult(value: unknown): value is ToolResult {
  return Boolean(
    value &&
      typeof value === "object" &&
      "content" in (value as Record<string, unknown>),
  );
}

export function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asPositiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

export function normalizeHandleIdentity(
  _family: string,
  labelValue: unknown,
  idempotencyKeyValue: unknown,
) : NormalizedHandleIdentity {
  return {
    label: asTrimmedString(labelValue),
    idempotencyKey: asTrimmedString(idempotencyKeyValue),
  };
}
