/**
 * Response post-processing for Concordia bridge.
 *
 * Handles: name prefix stripping, choice fuzzy matching, float parsing,
 * content sanitization, structured intent extraction, and whitespace trimming.
 *
 * @module
 */

import type { ConcordiaActionSpec } from './types.js';
import {
  buildFallbackIntent,
  parseStructuredSimulationResponse,
  type ParsedStructuredResponse,
} from './structured-response.js';

export type StructuredSimulationResponse = ParsedStructuredResponse;

/**
 * Strip the agent name prefix if the LLM included it.
 * Concordia adds "AgentName: " itself — we must return just the action text.
 */
export function stripNamePrefix(response: string, agentName: string): string {
  const trimmed = response.trim();
  const namePatterns = [
    `${agentName}: `,
    `${agentName}:`,
    `${agentName} -- `,
    `${agentName} — `,
    `${agentName} - `,
  ];
  for (const pattern of namePatterns) {
    if (trimmed.startsWith(pattern)) {
      return trimmed.slice(pattern.length).trim();
    }
    if (trimmed.toLowerCase().startsWith(pattern.toLowerCase())) {
      return trimmed.slice(pattern.length).trim();
    }
  }
  return trimmed;
}

/**
 * Strip surrounding quotes from a response.
 */
export function stripQuotes(response: string): string {
  const trimmed = response.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

/**
 * For CHOICE output type, find the closest matching option.
 */
export function fuzzyMatchChoice(
  response: string,
  options: readonly string[],
): string {
  if (options.length === 0) return response;
  const trimmed = response.trim();

  const exact = options.find((option) => option === trimmed);
  if (exact) return exact;

  const lower = trimmed.toLowerCase();
  const caseMatch = options.find((option) => option.toLowerCase() === lower);
  if (caseMatch) return caseMatch;

  const stripped = trimmed.replace(/^\d+\.\s*/, '');
  const strippedMatch = options.find(
    (option) => option.toLowerCase() === stripped.toLowerCase(),
  );
  if (strippedMatch) return strippedMatch;

  for (const option of options) {
    if (
      lower.includes(option.toLowerCase()) ||
      option.toLowerCase().includes(lower)
    ) {
      return option;
    }
  }

  let bestOption = options[0];
  let bestDist = Infinity;
  for (const option of options) {
    const dist = levenshteinDistance(lower, option.toLowerCase());
    if (dist < bestDist) {
      bestDist = dist;
      bestOption = option;
    }
  }
  return bestOption;
}

/**
 * Parse a float response. Returns 0.0 if parsing fails.
 */
export function parseFloatResponse(response: string): string {
  const trimmed = response.trim();
  const match = trimmed.match(/-?\d+\.?\d*/);
  if (match) return match[0];
  return '0.0';
}

export function processStructuredResponse(
  response: string,
  agentName: string,
  actionSpec: ConcordiaActionSpec,
): StructuredSimulationResponse {
  let result = stripNamePrefix(response, agentName);
  result = stripQuotes(result);

  if (actionSpec.output_type === 'choice') {
    const action = fuzzyMatchChoice(result, actionSpec.options);
    return { action, narration: null, intent: buildFallbackIntent(action, actionSpec) };
  }

  if (actionSpec.output_type === 'float') {
    const action = parseFloatResponse(result);
    return { action, narration: null, intent: buildFallbackIntent(action, actionSpec) };
  }

  const parsed = parseStructuredSimulationResponse(result, actionSpec, result);
  if (parsed) {
    return parsed;
  }

  const action = sanitizeFreeformSimulationResponse(result, actionSpec);
  return {
    action,
    narration: actionSpec.tag === 'speech' ? action : null,
    intent: buildFallbackIntent(action, actionSpec),
  };
}

/**
 * Compatibility wrapper used by older code paths/tests that only need the action string.
 */
export function processResponse(
  response: string,
  agentName: string,
  actionSpec: ConcordiaActionSpec,
): string {
  return processStructuredResponse(response, agentName, actionSpec).action;
}

/**
 * Sanitize content for safe storage — escape XML-like tags to prevent
 * prompt injection when memory entries are injected into prompts.
 */
export function sanitizeContent(content: string): string {
  return content.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ============================================================================
// Internal helpers
// ============================================================================

function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array(n + 1).fill(0),
  );

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }

  return dp[m][n];
}

function sanitizeFreeformSimulationResponse(
  response: string,
  _actionSpec: ConcordiaActionSpec,
): string {
  return response.trim();
}
