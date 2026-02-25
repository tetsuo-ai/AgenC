/**
 * Shared async utilities and time constants.
 * @module
 */

/** 7 days in milliseconds — common default TTL for caches and checkpoints. */
export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
