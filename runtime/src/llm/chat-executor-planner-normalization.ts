/**
 * Planner-response normalization helpers for ChatExecutor.
 *
 * Keeps provider-specific planner recovery logic out of the main executor
 * orchestration path.
 *
 * @module
 */

import type { LLMToolCall } from "./types.js";
import type { PlannerParseResult } from "./chat-executor-types.js";
import {
  parsePlannerPlan,
  salvagePlannerToolCallsAsPlan,
  type ExplicitSubagentOrchestrationRequirements,
} from "./chat-executor-planner.js";

export function normalizePlannerResponse(params: {
  readonly content: string;
  readonly toolCalls: readonly LLMToolCall[];
  readonly repairRequirements?: ExplicitSubagentOrchestrationRequirements;
}): PlannerParseResult {
  const parsed = parsePlannerPlan(params.content, params.repairRequirements);
  if (parsed.plan || params.toolCalls.length === 0) {
    return parsed;
  }

  const salvaged = salvagePlannerToolCallsAsPlan(params.toolCalls);
  return {
    plan: salvaged.plan,
    diagnostics: [
      ...parsed.diagnostics,
      ...salvaged.diagnostics,
    ],
  };
}
