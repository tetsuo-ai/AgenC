import type { ToolResult } from "../types.js";
import { safeStringify } from "../types.js";

export interface StructuredHandleErrorDetails {
  readonly [key: string]: unknown;
}

export type StructuredHandleErrorKind =
  | "validation"
  | "not_found"
  | "idempotency_conflict"
  | "label_conflict"
  | "blocked"
  | "permission_denied"
  | "environment_unavailable"
  | "start_failed"
  | "stop_failed"
  | "timeout"
  | "internal";

export interface StructuredHandleResourceEnvelope {
  readonly cpu?: number;
  readonly memoryMb?: number;
  readonly diskMb?: number;
  readonly network?: "enabled" | "disabled";
  readonly wallClockMs?: number;
  readonly sandboxAffinity?: string;
  readonly environmentClass?: string;
  readonly enforcement?: "none" | "best_effort";
}

export interface NormalizedHandleIdentity {
  readonly label?: string;
  readonly idempotencyKey?: string;
}

function inferHandleErrorKind(code: string): StructuredHandleErrorKind {
  if (code.endsWith(".not_found")) return "not_found";
  if (code.includes(".invalid_")) {
    return "validation";
  }
  if (code.endsWith(".idempotency_conflict")) return "idempotency_conflict";
  if (code.endsWith(".label_conflict")) return "label_conflict";
  if (
    code.endsWith(".domain_blocked") ||
    code.endsWith(".url_blocked") ||
    code.endsWith(".health_url_blocked")
  ) {
    return "permission_denied";
  }
  if (code.endsWith(".launch_failed")) return "environment_unavailable";
  if (code.endsWith(".start_failed")) return "start_failed";
  if (code.endsWith(".stop_failed")) return "stop_failed";
  if (code.endsWith(".timeout")) return "timeout";
  return "internal";
}

export function handleErrorResult(
  family: string,
  code: string,
  message: string,
  retryable = false,
  details?: StructuredHandleErrorDetails,
  operation?: string,
  kind?: StructuredHandleErrorKind,
): ToolResult {
  return {
    content: safeStringify({
      error: {
        family,
        code,
        kind: kind ?? inferHandleErrorKind(code),
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

export function normalizeResourceEnvelope(
  family: string,
  value: unknown,
  operation = "start",
): StructuredHandleResourceEnvelope | ToolResult | undefined {
  if (value === undefined) {
    return undefined;
  }
  const obj = asObject(value);
  if (!obj) {
    return handleErrorResult(
      family,
      `${family}.invalid_resource_envelope`,
      "resourceEnvelope must be an object when provided",
      false,
      undefined,
      operation,
      "validation",
    );
  }
  const cpu = asFiniteNumber(obj.cpu);
  const memoryMb = asPositiveInt(obj.memoryMb);
  const diskMb = asPositiveInt(obj.diskMb);
  const wallClockMs = asPositiveInt(obj.wallClockMs);
  const network =
    obj.network === "enabled" || obj.network === "disabled"
      ? obj.network
      : undefined;
  const sandboxAffinity = asTrimmedString(obj.sandboxAffinity);
  const environmentClass = asTrimmedString(obj.environmentClass);
  const enforcement =
    obj.enforcement === "none" || obj.enforcement === "best_effort"
      ? obj.enforcement
      : undefined;

  if (obj.cpu !== undefined && (cpu === undefined || cpu <= 0)) {
    return handleErrorResult(
      family,
      `${family}.invalid_resource_envelope`,
      "resourceEnvelope.cpu must be a positive number when provided",
      false,
      undefined,
      operation,
      "validation",
    );
  }
  if (
    obj.network !== undefined &&
    network === undefined
  ) {
    return handleErrorResult(
      family,
      `${family}.invalid_resource_envelope`,
      'resourceEnvelope.network must be "enabled" or "disabled"',
      false,
      undefined,
      operation,
      "validation",
    );
  }
  if (
    obj.enforcement !== undefined &&
    enforcement === undefined
  ) {
    return handleErrorResult(
      family,
      `${family}.invalid_resource_envelope`,
      'resourceEnvelope.enforcement must be "none" or "best_effort"',
      false,
      undefined,
      operation,
      "validation",
    );
  }

  return {
    ...(cpu !== undefined ? { cpu } : {}),
    ...(memoryMb !== undefined ? { memoryMb } : {}),
    ...(diskMb !== undefined ? { diskMb } : {}),
    ...(network !== undefined ? { network } : {}),
    ...(wallClockMs !== undefined ? { wallClockMs } : {}),
    ...(sandboxAffinity ? { sandboxAffinity } : {}),
    ...(environmentClass ? { environmentClass } : {}),
    enforcement: enforcement ?? "best_effort",
  };
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
