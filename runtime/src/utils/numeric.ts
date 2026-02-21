/**
 * Numeric clamping and guard utilities.
 *
 * These helpers are used widely across eval, workflow, and autonomous modules
 * to normalise unreliable numeric values (NaN, Infinity, undefined) into safe
 * bounded ranges before they enter scoring / decision logic.
 *
 * @module
 */

/** Clamp a number to [0, 1]. Non-finite values resolve to 0. */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

/** Clamp an optional ratio to [0, 1], returning `fallback` for undefined / non-finite. */
export function clampRatio(
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

/** Clamp an optional integer to [`min`, ∞), returning `fallback` for undefined / non-finite. */
export function clampInteger(
  value: number | undefined,
  fallback: number,
  min = 1,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.floor(value));
}

/** Return 0 for non-finite or negative values. */
export function nonNegative(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value;
}
