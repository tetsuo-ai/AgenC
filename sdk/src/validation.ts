/**
 * Security validation utilities for AgenC SDK
 */

import * as path from 'path';

/**
 * Validates a circuit path to prevent path traversal and command injection.
 *
 * This is a security-critical function that prevents:
 * - Path traversal attacks (../)
 * - Absolute path injection
 * - Shell metacharacter injection
 *
 * @param circuitPath - The circuit path to validate
 * @throws Error if the path is invalid
 */
export function validateCircuitPath(circuitPath: string): void {
  // Disallow empty paths
  if (!circuitPath || circuitPath.trim().length === 0) {
    throw new Error('Security: Circuit path cannot be empty');
  }

  // Length limit to prevent abuse
  if (circuitPath.length > 512) {
    throw new Error('Security: Circuit path exceeds maximum length (512 characters)');
  }

  // Disallow absolute paths
  if (path.isAbsolute(circuitPath)) {
    throw new Error('Security: Absolute circuit paths are not allowed');
  }
  // Normalize and check for traversal attempts
  const normalized = path.normalize(circuitPath);
  if (normalized.startsWith('..') || normalized.includes('../')) {
    throw new Error('Security: Path traversal in circuit path is not allowed');
  }
  // Check for shell metacharacters that could enable command injection
  const dangerousChars = /[;&|`$(){}[\]<>!]/;
  if (dangerousChars.test(circuitPath)) {
    throw new Error('Security: Circuit path contains disallowed characters');
  }
}
