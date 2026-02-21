import { clone, safeStringify } from "./json.js";

export type TruncationReason =
  | "trimmed_to_minimum"
  | "payload_limit_exceeded"
  | null;

export interface TruncationResult<T> {
  payload: T;
  truncated: boolean;
  reason: TruncationReason;
  originalBytes: number;
  finalBytes: number;
}

export function truncateOutput<T extends Record<string, unknown>>(
  payload: T,
  maxBytes: number,
  trimFn: (value: T) => T,
): TruncationResult<T> {
  const originalJson = safeStringify(payload);
  const originalBytes = Buffer.byteLength(originalJson, "utf8");

  if (originalBytes <= maxBytes) {
    return {
      payload,
      truncated: false,
      reason: null,
      originalBytes,
      finalBytes: originalBytes,
    };
  }

  const trimmed = clone(trimFn(payload));
  const trimmedJson = safeStringify(trimmed);
  const trimmedBytes = Buffer.byteLength(trimmedJson, "utf8");

  if (trimmedBytes <= maxBytes) {
    return {
      payload: trimmed,
      truncated: true,
      reason: "trimmed_to_minimum",
      originalBytes,
      finalBytes: trimmedBytes,
    };
  }

  return {
    payload: trimmed,
    truncated: true,
    reason: "payload_limit_exceeded",
    originalBytes,
    finalBytes: trimmedBytes,
  };
}
