/**
 * Tool round budget extension evaluation logic extracted from ChatExecutor.
 *
 * @module
 */

import {
  MAX_ADAPTIVE_TOOL_ROUNDS,
} from "./chat-executor-constants.js";
import type {
  ExecutionContext,
} from "./chat-executor-types.js";
import type {
  ToolRoundProgressSummary,
} from "./chat-executor-tool-utils.js";

// ============================================================================
// Budget extension evaluation
// ============================================================================

export interface ToolRoundBudgetExtensionParams {
  readonly ctx: ExecutionContext;
  readonly currentLimit: number;
  readonly recentRounds: readonly ToolRoundProgressSummary[];
}

export interface ToolRoundBudgetExtensionResult {
  readonly decision:
    | "extended"
    | "ceiling_reached"
    | "no_recent_rounds"
    | "insufficient_recent_progress"
    | "request_time_exhausted"
    | "time_bound_exhausted"
    | "tool_budget_exhausted"
    | "extension_budget_exhausted";
  readonly recentProgressRate: number;
  readonly recentTotalNewSuccessfulSemanticKeys: number;
  readonly recentTotalNewVerificationFailureDiagnosticKeys: number;
  readonly weightedAverageNewSuccessfulSemanticKeys: number;
  readonly latestRoundHadMaterialProgress: boolean;
  readonly newLimit: number;
  readonly extensionRounds: number;
  readonly remainingToolBudget: number;
  readonly remainingRequestMs: number;
  readonly recentAverageRoundMs: number;
  readonly latestRoundNewSuccessfulSemanticKeys: number;
  readonly latestRoundNewVerificationFailureDiagnosticKeys: number;
  readonly extensionReason:
    | "none"
    | "repair_episode"
    | "sustained_progress";
  readonly repairCycleOpen: boolean;
  readonly repairCycleNeedsMutation: boolean;
  readonly repairCycleNeedsVerification: boolean;
}

/**
 * Evaluate whether the tool round budget should be extended based on
 * recent progress.
 *
 * @param params - context, current limit, and recent round summaries
 * @param getRemainingRequestMs - function returning remaining request time
 */
export function evaluateToolRoundBudgetExtension(
  params: ToolRoundBudgetExtensionParams,
  getRemainingRequestMs: (ctx: ExecutionContext) => number,
): ToolRoundBudgetExtensionResult {
  const remainingToolBudget = Math.max(
    0,
    params.ctx.effectiveToolBudget - params.ctx.allToolCalls.length,
  );
  const effectiveRoundCeiling = Math.min(
    MAX_ADAPTIVE_TOOL_ROUNDS,
    params.ctx.effectiveToolBudget,
  );
  if (params.currentLimit >= effectiveRoundCeiling) {
    return {
      decision: "ceiling_reached",
      recentProgressRate: 0,
      recentTotalNewSuccessfulSemanticKeys: 0,
      recentTotalNewVerificationFailureDiagnosticKeys: 0,
      weightedAverageNewSuccessfulSemanticKeys: 0,
      latestRoundHadMaterialProgress: false,
      newLimit: params.currentLimit,
      extensionRounds: 0,
      remainingToolBudget,
      remainingRequestMs: 0,
      recentAverageRoundMs: 0,
      latestRoundNewSuccessfulSemanticKeys: 0,
      latestRoundNewVerificationFailureDiagnosticKeys: 0,
      extensionReason: "none",
      repairCycleOpen: false,
      repairCycleNeedsMutation: false,
      repairCycleNeedsVerification: false,
    };
  }
  const latestRound = params.recentRounds[params.recentRounds.length - 1];
  if (!latestRound) {
    return {
      decision: "no_recent_rounds",
      recentProgressRate: 0,
      recentTotalNewSuccessfulSemanticKeys: 0,
      recentTotalNewVerificationFailureDiagnosticKeys: 0,
      weightedAverageNewSuccessfulSemanticKeys: 0,
      latestRoundHadMaterialProgress: false,
      newLimit: params.currentLimit,
      extensionRounds: 0,
      remainingToolBudget,
      remainingRequestMs: 0,
      recentAverageRoundMs: 0,
      latestRoundNewSuccessfulSemanticKeys: 0,
      latestRoundNewVerificationFailureDiagnosticKeys: 0,
      extensionReason: "none",
      repairCycleOpen: false,
      repairCycleNeedsMutation: false,
      repairCycleNeedsVerification: false,
    };
  }
  const recentProgressRounds = params.recentRounds.filter((round) =>
    round.hadMaterialProgress
  ).length;
  const recentProgressRate =
    recentProgressRounds / Math.max(1, params.recentRounds.length);
  const recentTotalNewSuccessfulSemanticKeys = params.recentRounds.reduce(
    (sum, round) => sum + round.newSuccessfulSemanticKeys,
    0,
  );
  const recentTotalNewVerificationFailureDiagnosticKeys = params.recentRounds
    .reduce(
      (sum, round) => sum + round.newVerificationFailureDiagnosticKeys,
      0,
    );
  const weightedAverageNewSuccessfulSemanticKeys = params.recentRounds.reduce(
    (sum, round, index) => sum + round.newSuccessfulSemanticKeys * (index + 1),
    0,
  ) /
    params.recentRounds.reduce(
      (sum, _round, index) => sum + index + 1,
      0,
    );
  let latestVerificationFailureRoundIndex = -1;
  for (let index = params.recentRounds.length - 1; index >= 0; index--) {
    if (params.recentRounds[index]?.newVerificationFailureDiagnosticKeys > 0) {
      latestVerificationFailureRoundIndex = index;
      break;
    }
  }
  let latestMutationRoundIndex = -1;
  if (latestVerificationFailureRoundIndex >= 0) {
    for (
      let index = latestVerificationFailureRoundIndex + 1;
      index < params.recentRounds.length;
      index++
    ) {
      if (params.recentRounds[index]?.hadSuccessfulMutation) {
        latestMutationRoundIndex = index;
      }
    }
  }
  const repairCycleNeedsMutation =
    latestVerificationFailureRoundIndex >= 0 && latestMutationRoundIndex < 0;
  const repairCycleNeedsVerification =
    latestVerificationFailureRoundIndex >= 0 &&
    (
      latestMutationRoundIndex < 0 ||
      !params.recentRounds
        .slice(latestMutationRoundIndex + 1)
        .some((round) => round.hadVerificationCall)
    );
  const repairCycleOpen =
    repairCycleNeedsMutation || repairCycleNeedsVerification;
  const repairCycleExtensionRounds =
    (repairCycleNeedsMutation ? 1 : 0) +
    (repairCycleNeedsVerification ? 1 : 0);
  // Historical progress can size an extension, but absent an open repair cycle
  // only the latest round can authorize additional rounds.
  const extendForSustainedProgress =
    latestRound.newSuccessfulSemanticKeys > 0 &&
    recentTotalNewSuccessfulSemanticKeys > 0;
  if (!extendForSustainedProgress && !repairCycleOpen) {
    return {
      decision: "insufficient_recent_progress",
      recentProgressRate,
      recentTotalNewSuccessfulSemanticKeys,
      recentTotalNewVerificationFailureDiagnosticKeys,
      weightedAverageNewSuccessfulSemanticKeys,
      latestRoundHadMaterialProgress: latestRound.hadMaterialProgress,
      newLimit: params.currentLimit,
      extensionRounds: 0,
      remainingToolBudget,
      remainingRequestMs: getRemainingRequestMs(params.ctx),
      recentAverageRoundMs: 0,
      latestRoundNewSuccessfulSemanticKeys:
        latestRound.newSuccessfulSemanticKeys,
      latestRoundNewVerificationFailureDiagnosticKeys:
        latestRound.newVerificationFailureDiagnosticKeys,
      extensionReason: "none",
      repairCycleOpen,
      repairCycleNeedsMutation,
      repairCycleNeedsVerification,
    };
  }
  const remainingRequestMs = getRemainingRequestMs(params.ctx);
  if (remainingRequestMs <= 0) {
    return {
      decision: "request_time_exhausted",
      recentProgressRate,
      recentTotalNewSuccessfulSemanticKeys,
      recentTotalNewVerificationFailureDiagnosticKeys,
      weightedAverageNewSuccessfulSemanticKeys,
      latestRoundHadMaterialProgress: latestRound.hadMaterialProgress,
      newLimit: params.currentLimit,
      extensionRounds: 0,
      remainingToolBudget,
      remainingRequestMs,
      recentAverageRoundMs: 0,
      latestRoundNewSuccessfulSemanticKeys:
        latestRound.newSuccessfulSemanticKeys,
      latestRoundNewVerificationFailureDiagnosticKeys:
        latestRound.newVerificationFailureDiagnosticKeys,
      extensionReason: "none",
      repairCycleOpen,
      repairCycleNeedsMutation,
      repairCycleNeedsVerification,
    };
  }
  const recentAverageRoundMs = Math.max(
    1_000,
    Math.round(
      params.recentRounds.reduce((sum, round) => sum + round.durationMs, 0) /
        params.recentRounds.length,
    ),
  );
  const timeBoundExtension = Math.floor(remainingRequestMs / recentAverageRoundMs);
  if (timeBoundExtension <= 0) {
    return {
      decision: "time_bound_exhausted",
      recentProgressRate,
      recentTotalNewSuccessfulSemanticKeys,
      recentTotalNewVerificationFailureDiagnosticKeys,
      weightedAverageNewSuccessfulSemanticKeys,
      latestRoundHadMaterialProgress: latestRound.hadMaterialProgress,
      newLimit: params.currentLimit,
      extensionRounds: 0,
      remainingToolBudget,
      remainingRequestMs,
      recentAverageRoundMs,
      latestRoundNewSuccessfulSemanticKeys:
        latestRound.newSuccessfulSemanticKeys,
      latestRoundNewVerificationFailureDiagnosticKeys:
        latestRound.newVerificationFailureDiagnosticKeys,
      extensionReason: "none",
      repairCycleOpen,
      repairCycleNeedsMutation,
      repairCycleNeedsVerification,
    };
  }
  const expectedMarginalRounds = repairCycleOpen
    ? repairCycleExtensionRounds
    : Math.max(
      latestRound.newSuccessfulSemanticKeys,
      Math.ceil(weightedAverageNewSuccessfulSemanticKeys),
    );
  if (remainingToolBudget <= 0) {
    return {
      decision: "tool_budget_exhausted",
      recentProgressRate,
      recentTotalNewSuccessfulSemanticKeys,
      recentTotalNewVerificationFailureDiagnosticKeys,
      weightedAverageNewSuccessfulSemanticKeys,
      latestRoundHadMaterialProgress: latestRound.hadMaterialProgress,
      newLimit: params.currentLimit,
      extensionRounds: 0,
      remainingToolBudget,
      remainingRequestMs,
      recentAverageRoundMs,
      latestRoundNewSuccessfulSemanticKeys:
        latestRound.newSuccessfulSemanticKeys,
      latestRoundNewVerificationFailureDiagnosticKeys:
        latestRound.newVerificationFailureDiagnosticKeys,
      extensionReason: "none",
      repairCycleOpen,
      repairCycleNeedsMutation,
      repairCycleNeedsVerification,
    };
  }
  const extensionRounds = Math.min(
    expectedMarginalRounds,
    timeBoundExtension,
    effectiveRoundCeiling - params.currentLimit,
    remainingToolBudget,
  );
  if (extensionRounds <= 0) {
    return {
      decision: "extension_budget_exhausted",
      recentProgressRate,
      recentTotalNewSuccessfulSemanticKeys,
      recentTotalNewVerificationFailureDiagnosticKeys,
      weightedAverageNewSuccessfulSemanticKeys,
      latestRoundHadMaterialProgress: latestRound.hadMaterialProgress,
      newLimit: params.currentLimit,
      extensionRounds: 0,
      remainingToolBudget,
      remainingRequestMs,
      recentAverageRoundMs,
      latestRoundNewSuccessfulSemanticKeys:
        latestRound.newSuccessfulSemanticKeys,
      latestRoundNewVerificationFailureDiagnosticKeys:
        latestRound.newVerificationFailureDiagnosticKeys,
      extensionReason: "none",
      repairCycleOpen,
      repairCycleNeedsMutation,
      repairCycleNeedsVerification,
    };
  }
  return {
    decision: "extended",
    recentProgressRate,
    recentTotalNewSuccessfulSemanticKeys,
    recentTotalNewVerificationFailureDiagnosticKeys,
    weightedAverageNewSuccessfulSemanticKeys,
    latestRoundHadMaterialProgress: latestRound.hadMaterialProgress,
    newLimit: params.currentLimit + extensionRounds,
    extensionRounds,
    remainingToolBudget,
    remainingRequestMs,
    recentAverageRoundMs,
    latestRoundNewSuccessfulSemanticKeys:
      latestRound.newSuccessfulSemanticKeys,
    latestRoundNewVerificationFailureDiagnosticKeys:
      latestRound.newVerificationFailureDiagnosticKeys,
    extensionReason: repairCycleOpen
      ? "repair_episode"
      : "sustained_progress",
    repairCycleOpen,
    repairCycleNeedsMutation,
    repairCycleNeedsVerification,
  };
}
