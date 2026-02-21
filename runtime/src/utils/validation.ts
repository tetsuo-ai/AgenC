/**
 * Shared validation helpers for accumulate-errors validators.
 *
 * Used by gateway config and message validators. Each check function pushes
 * errors onto a shared array so callers can report all problems at once.
 *
 * @module
 */

// ============================================================================
// Result type
// ============================================================================

/** Outcome of an accumulate-errors validation pass. */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/** Build a {@link ValidationResult} from an error list. */
export function validationResult(errors: string[]): ValidationResult {
  return { valid: errors.length === 0, errors };
}

// ============================================================================
// Field checks
// ============================================================================

/** Push an error if `value` is not a non-empty string. */
export function requireNonEmptyString(
  value: unknown,
  field: string,
  errors: string[],
): void {
  if (typeof value !== "string" || value.length === 0) {
    errors.push(`${field} must be a non-empty string`);
  }
}

/** Push an error if `value` is not a finite number. */
export function requireFiniteNumber(
  value: unknown,
  field: string,
  errors: string[],
): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    errors.push(`${field} must be a finite number`);
  }
}

/** Push an error if `value` is not one of the allowed strings. */
export function requireOneOf(
  value: unknown,
  field: string,
  allowed: ReadonlySet<string>,
  errors: string[],
): void {
  if (typeof value !== "string" || !allowed.has(value)) {
    errors.push(`${field} must be one of: ${[...allowed].join(", ")}`);
  }
}

/** Push an error if `value` is not an integer in [min, max]. */
export function requireIntRange(
  value: unknown,
  field: string,
  min: number,
  max: number,
  errors: string[],
): void {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    errors.push(`${field} must be an integer between ${min} and ${max}`);
  }
}
