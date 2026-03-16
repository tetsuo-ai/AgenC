/**
 * Planner execution pipeline extracted from ChatExecutor.executePlannerPath.
 *
 * @module
 */

import type { PromptBudgetSection } from "./prompt-budget.js";
import type {
  Pipeline,
  PipelineResult,
} from "../workflow/pipeline.js";
import type { HostToolingProfile } from "../gateway/host-tooling.js";
import type { ResolvedDelegationDecisionConfig } from "./delegation-decision.js";
import {
  computePlannerGraphDepth,
  isPipelineStopReasonHint,
  buildPlannerSynthesisMessages,
  buildPlannerSynthesisFallbackContent,
  ensureSubagentProvenanceCitations,
  resolveDelegationBanditArm,
  assessAndRecordDelegationDecision,
  mapPlannerStepsToPipelineSteps,
  validateSalvagedPlannerToolPlan,
  buildPlannerMessages,
  buildPlannerExecutionContext,
  buildPlannerVerificationRequirementsFailureMessage,
  buildPlannerVerificationRequirementsRefinementHint,
  validatePlannerGraph,
  validatePlannerVerificationRequirements,
  validatePlannerStepContracts,
  extractPlannerVerificationCommandRequirements,
  extractPlannerVerificationRequirements,
  extractExplicitDeterministicToolRequirements,
  extractExplicitSubagentOrchestrationRequirements,
  validateExplicitDeterministicToolRequirements,
  validateExplicitSubagentOrchestrationRequirements,
  extractPlannerDecompositionDiagnostics,
  extractPlannerStructuralDiagnostics,
  buildExplicitDeterministicToolRefinementHint,
  buildExplicitDeterministicToolFailureMessage,
  buildPlannerParseRefinementHint,
  buildPlannerStructuralRefinementHint,
  buildPlannerValidationFailureMessage,
  buildPipelineDecompositionRefinementHint,
  buildPipelineFailureRepairRefinementHint,
  buildPlannerStepContractRefinementHint,
  buildSalvagedPlannerToolCallRefinementHint,
  buildExplicitSubagentOrchestrationRefinementHint,
  buildExplicitSubagentOrchestrationFailureMessage,
  extractRecoverablePlannerParseDiagnostics,
  isHighRiskSubagentPlan,
  requestRequiresToolGroundedExecution,
} from "./chat-executor-planner.js";
import { normalizePlannerResponse } from "./chat-executor-planner-normalization.js";
import {
  executePlannerPipelineWithVerifierLoop,
  runSubagentVerifierRound,
} from "./chat-executor-planner-verifier-loop.js";
import {
  deriveDelegationContextClusterId,
  type DelegationBanditPolicyTuner,
} from "./delegation-learning.js";
import {
  DEFAULT_PLANNER_MAX_REFINEMENT_ATTEMPTS,
  DEFAULT_PLANNER_MAX_STEP_CONTRACT_RETRIES,
  DEFAULT_PLANNER_MAX_RUNTIME_REPAIR_RETRIES,
} from "./chat-executor-constants.js";
import type {
  ToolCallRecord,
  ExecutionContext,
  PlannerDiagnostic,
  PlannerDeterministicToolStepIntent,
  PlannerSubAgentTaskStepIntent,
  ResolvedSubagentVerifierConfig,
  ChatCallUsageRecord,
} from "./chat-executor-types.js";
import type { LLMPipelineStopReason } from "./policy.js";
import type { LLMResponse } from "./types.js";
import {
  summarizeToolCalls,
  generateFallbackContent,
  truncateText,
} from "./chat-executor-text.js";

// ============================================================================
// Dependencies interface
// ============================================================================

export interface PlannerExecutionConfig {
  readonly plannerMaxTokens: number;
  readonly delegationNestingDepth: number;
  readonly delegationDecisionConfig: ResolvedDelegationDecisionConfig;
  readonly subagentVerifierConfig: ResolvedSubagentVerifierConfig;
  readonly delegationDefaultStrategyArmId: string;
  readonly allowedTools: Set<string> | null;
  readonly delegationBanditTuner?: DelegationBanditPolicyTuner;
  readonly resolveHostToolingProfile?: () => HostToolingProfile | null;
}

export interface PlannerExecutionCallbacks {
  emitPlannerTrace(
    ctx: ExecutionContext,
    type:
      | "planner_path_finished"
      | "planner_pipeline_finished"
      | "planner_synthesis_fallback_applied"
      | "planner_pipeline_started"
      | "planner_plan_parsed"
      | "planner_refinement_requested"
      | "planner_verifier_retry_scheduled"
      | "planner_verifier_round_finished",
    payload: Record<string, unknown>,
  ): void;
  setStopReason(
    ctx: ExecutionContext,
    reason: LLMPipelineStopReason,
    detail?: string,
  ): void;
  checkRequestTimeout(ctx: ExecutionContext, stage: string): boolean;
  callModelForPhase(
    ctx: ExecutionContext,
    input: {
      phase: ChatCallUsageRecord["phase"];
      callMessages: readonly import("./types.js").LLMMessage[];
      callSections?: readonly PromptBudgetSection[];
      onStreamChunk?: import("./types.js").StreamProgressCallback;
      statefulSessionId?: string;
      statefulResumeAnchor?: import("./types.js").LLMStatefulResumeAnchor;
      statefulHistoryCompacted?: boolean;
      routedToolNames?: readonly string[];
      persistRoutedToolNames?: boolean;
      toolChoice?: import("./types.js").LLMToolChoice;
      preparationDiagnostics?: Record<string, unknown>;
      allowRecallBudgetBypass?: boolean;
      budgetReason: string;
    },
  ): Promise<LLMResponse | undefined>;
  appendToolRecord(ctx: ExecutionContext, record: ToolCallRecord): void;
  runPipelineWithTimeout(
    ctx: ExecutionContext,
    pipeline: Pipeline,
  ): Promise<PipelineResult | undefined>;
  timeoutDetail(
    stage: string,
    requestTimeoutMs: number,
  ): string;
}

// ============================================================================
// Helper (local to planner execution)
// ============================================================================

function mergeExplicitRequirementToolNames(
  primaryToolNames: readonly string[],
  secondaryToolNames: readonly string[],
  fallbackToolNames: readonly string[],
): readonly string[] {
  const merged = Array.from(
    new Set([
      ...primaryToolNames,
      ...secondaryToolNames,
    ]),
  );
  if (merged.length > 0) {
    return merged;
  }
  return Array.from(new Set(fallbackToolNames));
}

function buildPlannerDiagnosticSignature(
  diagnostics: readonly PlannerDiagnostic[],
): string {
  return diagnostics
    .map((diagnostic) => {
      const stepName =
        typeof diagnostic.details?.stepName === "string"
          ? diagnostic.details.stepName
          : "";
      const installSteps =
        typeof diagnostic.details?.installSteps === "string"
          ? diagnostic.details.installSteps
          : "";
      const phases =
        typeof diagnostic.details?.phases === "string"
          ? diagnostic.details.phases
          : "";
      return [
        diagnostic.category,
        diagnostic.code,
        stepName,
        installSteps,
        phases,
        diagnostic.message,
      ].join("::");
    })
    .sort()
    .join("||");
}

function buildPipelineFailureSignature(result: PipelineResult): string {
  const normalizedError =
    typeof result.error === "string"
      ? truncateText(result.error.replace(/\s+/g, " ").trim(), 320)
      : "";
  return [
    result.status,
    result.stopReasonHint ?? "",
    String(result.completedSteps),
    String(result.totalSteps),
    normalizedError,
  ].join("::");
}

// ============================================================================
// executePlannerPath (standalone)
// ============================================================================

/**
 * Execute the planner path for high-complexity turns.
 */
export async function executePlannerPath(
  ctx: ExecutionContext,
  config: PlannerExecutionConfig,
  callbacks: PlannerExecutionCallbacks,
): Promise<void> {
  ctx.plannerSummaryState.used = true;
  const plannerSections: PromptBudgetSection[] = [
    "system_anchor",
    "history",
    "user",
  ];
  const explicitOrchestrationRequirements =
    extractExplicitSubagentOrchestrationRequirements(ctx.messageText);
  const explicitDeterministicToolRequirements =
    explicitOrchestrationRequirements
      ? undefined
      : extractExplicitDeterministicToolRequirements(
          ctx.messageText,
          mergeExplicitRequirementToolNames(
            ctx.activeRoutedToolNames,
            ctx.expandedRoutedToolNames,
            config.allowedTools ? [...config.allowedTools] : [],
          ),
        );
  const explicitVerificationRequirements =
    extractPlannerVerificationRequirements(ctx.messageText);
  const explicitVerificationCommandRequirements =
    extractPlannerVerificationCommandRequirements(ctx.messageText);
  const explicitPlannerToolNames =
    explicitDeterministicToolRequirements?.orderedToolNames;
  let refinementHint: string | undefined;
  const maxStructuralPlannerRetries = Math.max(
    0,
    DEFAULT_PLANNER_MAX_REFINEMENT_ATTEMPTS - 1,
  );
  const maxPlannerStepContractRetries = Math.max(
    0,
    DEFAULT_PLANNER_MAX_STEP_CONTRACT_RETRIES,
  );
  const maxRuntimeRepairRetries =
    DEFAULT_PLANNER_MAX_RUNTIME_REPAIR_RETRIES;
  const maxPlannerDecompositionRetries = 2;
  const maxPlannerAttempts =
    1 +
    maxStructuralPlannerRetries +
    maxPlannerStepContractRetries +
    maxRuntimeRepairRetries +
    maxPlannerDecompositionRetries;
  let structuralPlannerRetriesUsed = 0;
  let plannerStepContractRetriesUsed = 0;
  let decompositionPlannerRetriesUsed = 0;
  const seenStructuralDiagnosticSignatures = new Set<string>();
  const seenRuntimeRepairFailureSignatures = new Set<string>();
  let latestPlannerValidationDiagnostics: readonly PlannerDiagnostic[] = [];

  for (
    let plannerAttempt = 1;
    plannerAttempt <= maxPlannerAttempts;
    plannerAttempt++
  ) {
    const plannerMessages = buildPlannerMessages(
      ctx.messageText,
      ctx.history,
      config.plannerMaxTokens,
      explicitDeterministicToolRequirements,
      refinementHint,
      config.resolveHostToolingProfile?.(),
      {
        maxSubagentFanout: config.delegationDecisionConfig.maxFanoutPerTurn,
        currentDelegationDepth: config.delegationNestingDepth,
        maxDelegationDepth: config.delegationDecisionConfig.maxDepth,
        childCanDelegate: config.delegationNestingDepth + 1 < config.delegationDecisionConfig.maxDepth,
      },
    );
    const plannerResponse = await callbacks.callModelForPhase(ctx, {
      phase: "planner",
      callMessages: plannerMessages,
      callSections: plannerSections,
      ...(explicitPlannerToolNames
        ? { routedToolNames: explicitPlannerToolNames }
        : {}),
      budgetReason:
        "Planner pass blocked by max model recalls per request budget",
    });
    if (!plannerResponse) return;

    ctx.plannerSummaryState.plannerCalls = plannerAttempt;
    ctx.plannerSummaryState.delegationDecision = undefined;
    ctx.plannedSubagentSteps = 0;
    ctx.plannedDeterministicSteps = 0;
    ctx.plannedSynthesisSteps = 0;
    ctx.plannedFanout = 0;
    ctx.plannedDependencyDepth = 0;

    const plannerParse = normalizePlannerResponse({
      content: plannerResponse.content,
      toolCalls: plannerResponse.toolCalls,
      repairRequirements: explicitOrchestrationRequirements,
    });
    ctx.plannerSummaryState.diagnostics.push(...plannerParse.diagnostics);
    const plannerPlan = plannerParse.plan;
    if (!plannerPlan) {
      if (explicitOrchestrationRequirements) {
        if (
          plannerAttempt < maxPlannerAttempts &&
          structuralPlannerRetriesUsed < maxStructuralPlannerRetries
        ) {
          structuralPlannerRetriesUsed++;
          refinementHint = buildExplicitSubagentOrchestrationRefinementHint(
            explicitOrchestrationRequirements,
            plannerParse.diagnostics,
          );
          ctx.plannerSummaryState.diagnostics.push({
            category: "policy",
            code: "planner_required_orchestration_retry",
            message:
              "Planner failed to emit the user-required sub-agent orchestration plan; requesting a refined plan",
            details: {
              attempt: plannerAttempt,
              nextAttempt: plannerAttempt + 1,
              maxAttempts: maxPlannerAttempts,
            },
          });
          callbacks.emitPlannerTrace(ctx, "planner_refinement_requested", {
            attempt: plannerAttempt,
            nextAttempt: plannerAttempt + 1,
            reason: "planner_required_orchestration_retry",
            routeReason: "planner_required_orchestration_unmet",
            diagnostics: plannerParse.diagnostics,
          });
          continue;
        }
        ctx.plannerSummaryState.routeReason =
          "planner_required_orchestration_unmet";
        callbacks.setStopReason(
          ctx,
          "validation_error",
          "Planner could not produce the required sub-agent orchestration plan",
        );
        ctx.finalContent = buildExplicitSubagentOrchestrationFailureMessage(
          explicitOrchestrationRequirements,
          plannerParse.diagnostics,
        );
        callbacks.emitPlannerTrace(ctx, "planner_path_finished", {
          plannerCalls: plannerAttempt,
          routeReason: ctx.plannerSummaryState.routeReason,
          stopReason: ctx.stopReason,
          stopReasonDetail: ctx.stopReasonDetail,
          diagnostics: ctx.plannerSummaryState.diagnostics,
          handled: true,
        });
        ctx.plannerHandled = true;
        return;
      }
      if (explicitDeterministicToolRequirements) {
        if (
          plannerAttempt < maxPlannerAttempts &&
          structuralPlannerRetriesUsed < maxStructuralPlannerRetries
        ) {
          structuralPlannerRetriesUsed++;
          refinementHint = buildExplicitDeterministicToolRefinementHint(
            explicitDeterministicToolRequirements,
            plannerParse.diagnostics,
          );
          ctx.plannerSummaryState.diagnostics.push({
            category: "policy",
            code: "planner_explicit_tool_parse_retry",
            message:
              "Planner failed to emit the user-required deterministic tool plan; requesting a refined plan",
            details: {
              attempt: plannerAttempt,
              nextAttempt: plannerAttempt + 1,
              maxAttempts: maxPlannerAttempts,
            },
          });
          callbacks.emitPlannerTrace(ctx, "planner_refinement_requested", {
            attempt: plannerAttempt,
            nextAttempt: plannerAttempt + 1,
            reason: "planner_explicit_tool_parse_retry",
            routeReason: "planner_explicit_tool_requirements_unmet",
            diagnostics: plannerParse.diagnostics,
          });
          continue;
        }
        ctx.plannerSummaryState.routeReason =
          "planner_explicit_tool_requirements_unmet";
        callbacks.setStopReason(
          ctx,
          "validation_error",
          "Planner could not produce the required deterministic tool plan",
        );
        ctx.finalContent = buildExplicitDeterministicToolFailureMessage(
          explicitDeterministicToolRequirements,
          plannerParse.diagnostics,
        );
        callbacks.emitPlannerTrace(ctx, "planner_path_finished", {
          plannerCalls: plannerAttempt,
          routeReason: ctx.plannerSummaryState.routeReason,
          stopReason: ctx.stopReason,
          stopReasonDetail: ctx.stopReasonDetail,
          diagnostics: ctx.plannerSummaryState.diagnostics,
          handled: true,
        });
        ctx.plannerHandled = true;
        return;
      }
      const recoverablePlannerParseDiagnostics =
        extractRecoverablePlannerParseDiagnostics(
          plannerParse.diagnostics,
        );
      if (
        recoverablePlannerParseDiagnostics.length > 0 &&
        recoverablePlannerParseDiagnostics.length ===
          plannerParse.diagnostics.length &&
        plannerAttempt < maxPlannerAttempts &&
        plannerStepContractRetriesUsed < maxPlannerStepContractRetries
      ) {
        plannerStepContractRetriesUsed++;
        refinementHint = buildPlannerParseRefinementHint(
          recoverablePlannerParseDiagnostics,
        );
        ctx.plannerSummaryState.diagnostics.push({
          category: "policy",
          code: "planner_parse_contract_retry",
          message:
            "Planner emitted recoverable parse issues; requesting a refined plan",
          details: {
            attempt: plannerAttempt,
            nextAttempt: plannerAttempt + 1,
            maxAttempts: maxPlannerAttempts,
          },
        });
        callbacks.emitPlannerTrace(ctx, "planner_refinement_requested", {
          attempt: plannerAttempt,
          nextAttempt: plannerAttempt + 1,
          reason: "planner_parse_contract_retry",
          routeReason: "planner_parse_failed",
          diagnostics: recoverablePlannerParseDiagnostics,
        });
        continue;
      }
      ctx.plannerSummaryState.routeReason = "planner_parse_failed";
      callbacks.emitPlannerTrace(ctx, "planner_path_finished", {
        plannerCalls: plannerAttempt,
        routeReason: ctx.plannerSummaryState.routeReason,
        stopReason: ctx.stopReason,
        stopReasonDetail: ctx.stopReasonDetail,
        diagnostics: ctx.plannerSummaryState.diagnostics,
        handled: false,
      });
      return;
    }

    const salvagedToolPlanDiagnostics = validateSalvagedPlannerToolPlan({
      plannerPlan,
      messageText: ctx.messageText,
      history: ctx.history,
      explicitDeterministicRequirements: explicitDeterministicToolRequirements,
    });
    if (salvagedToolPlanDiagnostics.length > 0) {
      ctx.plannerSummaryState.diagnostics.push(...salvagedToolPlanDiagnostics);
      if (
        plannerAttempt < maxPlannerAttempts &&
        structuralPlannerRetriesUsed < maxStructuralPlannerRetries
      ) {
        structuralPlannerRetriesUsed++;
        refinementHint = buildSalvagedPlannerToolCallRefinementHint(
          salvagedToolPlanDiagnostics,
        );
        ctx.plannerSummaryState.diagnostics.push({
          category: "policy",
          code: "planner_salvaged_tool_call_retry",
          message:
            "Planner emitted raw tool calls that under-decomposed the request; requesting a refined JSON plan",
          details: {
            attempt: plannerAttempt,
            nextAttempt: plannerAttempt + 1,
            maxAttempts: maxPlannerAttempts,
          },
        });
        callbacks.emitPlannerTrace(ctx, "planner_refinement_requested", {
          attempt: plannerAttempt,
          nextAttempt: plannerAttempt + 1,
          reason: "planner_salvaged_tool_call_retry",
          routeReason: "planner_parse_failed",
          diagnostics: salvagedToolPlanDiagnostics,
        });
        continue;
      }
      ctx.plannerSummaryState.routeReason = "planner_parse_failed";
      callbacks.emitPlannerTrace(ctx, "planner_path_finished", {
        plannerCalls: plannerAttempt,
        routeReason: ctx.plannerSummaryState.routeReason,
        stopReason: ctx.stopReason,
        stopReasonDetail: ctx.stopReasonDetail,
        diagnostics: ctx.plannerSummaryState.diagnostics,
        handled: false,
      });
      return;
    }

    const graphDiagnostics = validatePlannerGraph(
      plannerPlan,
      {
        maxSubagentFanout: config.delegationDecisionConfig.maxFanoutPerTurn,
        maxSubagentDepth: config.delegationDecisionConfig.maxDepth,
      },
    );
    const plannerStepContractDiagnostics = validatePlannerStepContracts(
      plannerPlan,
    );
    const verificationRequirementDiagnostics =
      explicitVerificationRequirements.length > 0 ||
      explicitVerificationCommandRequirements.length > 0
        ? validatePlannerVerificationRequirements(
            plannerPlan,
            explicitVerificationRequirements,
            explicitVerificationCommandRequirements,
          )
        : [];
    const structuralGraphDiagnostics = extractPlannerStructuralDiagnostics(
      [
        ...graphDiagnostics,
        ...verificationRequirementDiagnostics,
      ],
    );
    const decompositionGraphDiagnostics =
      extractPlannerDecompositionDiagnostics(structuralGraphDiagnostics);
    const requiredOrchestrationDiagnostics =
      explicitOrchestrationRequirements
        ? validateExplicitSubagentOrchestrationRequirements(
            plannerPlan,
            explicitOrchestrationRequirements,
          )
        : [];
    const explicitToolDiagnostics =
      explicitDeterministicToolRequirements
        ? validateExplicitDeterministicToolRequirements(
            plannerPlan,
            explicitDeterministicToolRequirements,
          )
        : [];
    const hasStructuralDiagnostics =
      structuralGraphDiagnostics.length > 0 ||
      requiredOrchestrationDiagnostics.length > 0 ||
      explicitToolDiagnostics.length > 0;
    const currentValidationDiagnostics = [
      ...graphDiagnostics,
      ...plannerStepContractDiagnostics,
      ...verificationRequirementDiagnostics,
      ...requiredOrchestrationDiagnostics,
      ...explicitToolDiagnostics,
    ];
    latestPlannerValidationDiagnostics = currentValidationDiagnostics;
    const hasOnlyStepContractDiagnostics =
      !hasStructuralDiagnostics &&
      plannerStepContractDiagnostics.length > 0;
    const structuralDiagnosticSignature =
      hasStructuralDiagnostics
        ? buildPlannerDiagnosticSignature([
            ...structuralGraphDiagnostics,
            ...requiredOrchestrationDiagnostics,
            ...explicitToolDiagnostics,
          ])
        : "";
    const canUseProgressStructuralRetry =
      hasStructuralDiagnostics &&
      structuralPlannerRetriesUsed >= maxStructuralPlannerRetries &&
      plannerAttempt < maxPlannerAttempts &&
      structuralDiagnosticSignature.length > 0 &&
      !seenStructuralDiagnosticSignatures.has(structuralDiagnosticSignature);
    const hasOnlyDecompositionStructuralDiagnostics =
      decompositionGraphDiagnostics.length > 0 &&
      decompositionGraphDiagnostics.length ===
        structuralGraphDiagnostics.length &&
      plannerStepContractDiagnostics.length === 0 &&
      verificationRequirementDiagnostics.length === 0 &&
      requiredOrchestrationDiagnostics.length === 0 &&
      explicitToolDiagnostics.length === 0;
    const canUseDecompositionRetry =
      hasOnlyDecompositionStructuralDiagnostics &&
      decompositionPlannerRetriesUsed < maxPlannerDecompositionRetries &&
      plannerAttempt < maxPlannerAttempts;
    const shouldRefinePlan =
      (
        structuralGraphDiagnostics.length > 0 ||
        plannerStepContractDiagnostics.length > 0 ||
        verificationRequirementDiagnostics.length > 0 ||
        requiredOrchestrationDiagnostics.length > 0 ||
        explicitToolDiagnostics.length > 0
      ) &&
      plannerAttempt < maxPlannerAttempts &&
      (
        (
          hasOnlyStepContractDiagnostics &&
          plannerStepContractRetriesUsed < maxPlannerStepContractRetries
        ) ||
        structuralPlannerRetriesUsed < maxStructuralPlannerRetries ||
        canUseProgressStructuralRetry ||
        canUseDecompositionRetry
      );
    if (
      graphDiagnostics.length > 0 ||
      plannerStepContractDiagnostics.length > 0 ||
      verificationRequirementDiagnostics.length > 0 ||
      requiredOrchestrationDiagnostics.length > 0 ||
      explicitToolDiagnostics.length > 0
    ) {
      ctx.plannerSummaryState.diagnostics.push(...graphDiagnostics);
      ctx.plannerSummaryState.diagnostics.push(
        ...plannerStepContractDiagnostics,
      );
      ctx.plannerSummaryState.diagnostics.push(
        ...verificationRequirementDiagnostics,
      );
      ctx.plannerSummaryState.diagnostics.push(
        ...requiredOrchestrationDiagnostics,
      );
      ctx.plannerSummaryState.diagnostics.push(...explicitToolDiagnostics);
      if (shouldRefinePlan) {
        if (
          hasOnlyStepContractDiagnostics &&
          plannerStepContractRetriesUsed < maxPlannerStepContractRetries
        ) {
          plannerStepContractRetriesUsed++;
        } else if (structuralPlannerRetriesUsed < maxStructuralPlannerRetries) {
          structuralPlannerRetriesUsed++;
        } else if (canUseDecompositionRetry) {
          decompositionPlannerRetriesUsed++;
        }
        if (structuralDiagnosticSignature.length > 0) {
          seenStructuralDiagnosticSignatures.add(
            structuralDiagnosticSignature,
          );
        }
        const refinementHints: string[] = [];
        if (structuralGraphDiagnostics.length > 0) {
          refinementHints.push(
            buildPlannerStructuralRefinementHint(
              structuralGraphDiagnostics,
            ),
          );
        }
        if (plannerStepContractDiagnostics.length > 0) {
          refinementHints.push(
            buildPlannerStepContractRefinementHint(
              plannerStepContractDiagnostics,
            ),
          );
        }
        if (verificationRequirementDiagnostics.length > 0) {
          refinementHints.push(
            buildPlannerVerificationRequirementsRefinementHint(
              explicitVerificationRequirements,
              verificationRequirementDiagnostics,
            ),
          );
        }
        if (requiredOrchestrationDiagnostics.length > 0) {
          refinementHints.push(
            buildExplicitSubagentOrchestrationRefinementHint(
              explicitOrchestrationRequirements!,
              requiredOrchestrationDiagnostics,
            ),
          );
        }
        if (explicitToolDiagnostics.length > 0) {
          refinementHints.push(
            buildExplicitDeterministicToolRefinementHint(
              explicitDeterministicToolRequirements!,
              explicitToolDiagnostics,
            ),
          );
        }
        refinementHint = refinementHints.join(" ");
        const plannerRetryCode =
          requiredOrchestrationDiagnostics.length > 0
            ? "planner_required_orchestration_retry"
            : explicitToolDiagnostics.length > 0
              ? "planner_explicit_tool_retry"
              : verificationRequirementDiagnostics.length > 0
                ? "planner_verification_requirements_retry"
              : plannerStepContractDiagnostics.length > 0
                ? "planner_step_contract_retry"
              : "planner_refinement_retry";
        const plannerRetryMessage =
          requiredOrchestrationDiagnostics.length > 0
            ? "Planner did not satisfy the user-required sub-agent orchestration plan; requesting a refined plan"
            : explicitToolDiagnostics.length > 0
              ? "Planner drifted outside the explicitly requested deterministic tool contract; requesting a refined plan"
              : verificationRequirementDiagnostics.length > 0
                ? "Planner dropped one or more user-requested verification modes; requesting a refined plan"
              : plannerStepContractDiagnostics.length > 0
                ? "Planner emitted steps that violate runtime tool contracts; requesting a refined plan"
              : "Planner emitted structural delegation violations; requesting a refined plan";
        ctx.plannerSummaryState.diagnostics.push({
          category: "policy",
          code: plannerRetryCode,
          message: plannerRetryMessage,
          details: {
            attempt: plannerAttempt,
            nextAttempt: plannerAttempt + 1,
              maxAttempts: maxPlannerAttempts,
              progressRetry: canUseProgressStructuralRetry ? "true" : "false",
              decompositionRetry: canUseDecompositionRetry ? "true" : "false",
            },
          });
        callbacks.emitPlannerTrace(ctx, "planner_refinement_requested", {
          attempt: plannerAttempt,
          nextAttempt: plannerAttempt + 1,
          reason: plannerRetryCode,
          graphDiagnostics,
          decompositionGraphDiagnostics,
          plannerStepContractDiagnostics,
          verificationRequirementDiagnostics,
          requestedVerificationCategories: explicitVerificationRequirements,
          requestedVerificationCommands: explicitVerificationCommandRequirements,
          requiredOrchestrationDiagnostics,
          explicitToolDiagnostics,
          decompositionRetry: canUseDecompositionRetry,
        });
        continue;
      }
      if (requiredOrchestrationDiagnostics.length > 0) {
        ctx.plannerSummaryState.routeReason =
          "planner_required_orchestration_unmet";
        callbacks.setStopReason(
          ctx,
          "validation_error",
          "Planner did not satisfy the user-required sub-agent orchestration plan",
        );
        ctx.finalContent = buildExplicitSubagentOrchestrationFailureMessage(
          explicitOrchestrationRequirements!,
          requiredOrchestrationDiagnostics,
        );
        callbacks.emitPlannerTrace(ctx, "planner_path_finished", {
          plannerCalls: plannerAttempt,
          routeReason: ctx.plannerSummaryState.routeReason,
          stopReason: ctx.stopReason,
          stopReasonDetail: ctx.stopReasonDetail,
          diagnostics: ctx.plannerSummaryState.diagnostics,
          handled: true,
        });
        ctx.plannerHandled = true;
        return;
      }
      if (verificationRequirementDiagnostics.length > 0) {
        ctx.plannerSummaryState.routeReason =
          "planner_verification_requirements_unmet";
        callbacks.setStopReason(
          ctx,
          "validation_error",
          "Planner did not preserve the user-requested verification coverage",
        );
        ctx.finalContent =
          buildPlannerVerificationRequirementsFailureMessage(
            explicitVerificationRequirements,
            verificationRequirementDiagnostics,
          );
        callbacks.emitPlannerTrace(ctx, "planner_path_finished", {
          plannerCalls: plannerAttempt,
          routeReason: ctx.plannerSummaryState.routeReason,
          stopReason: ctx.stopReason,
          stopReasonDetail: ctx.stopReasonDetail,
          diagnostics: ctx.plannerSummaryState.diagnostics,
          handled: true,
        });
        ctx.plannerHandled = true;
        return;
      }
      if (explicitToolDiagnostics.length > 0) {
        ctx.plannerSummaryState.routeReason =
          "planner_explicit_tool_requirements_unmet";
        callbacks.setStopReason(
          ctx,
          "validation_error",
          "Planner did not satisfy the user-required deterministic tool plan",
        );
        ctx.finalContent = buildExplicitDeterministicToolFailureMessage(
          explicitDeterministicToolRequirements!,
          explicitToolDiagnostics,
        );
        callbacks.emitPlannerTrace(ctx, "planner_path_finished", {
          plannerCalls: plannerAttempt,
          routeReason: ctx.plannerSummaryState.routeReason,
          stopReason: ctx.stopReason,
          stopReasonDetail: ctx.stopReasonDetail,
          diagnostics: ctx.plannerSummaryState.diagnostics,
          handled: true,
        });
        ctx.plannerHandled = true;
        return;
      }
      ctx.plannerSummaryState.routeReason =
        explicitToolDiagnostics.length > 0
          ? "planner_explicit_tool_requirements_unmet"
          : "planner_validation_failed";
    } else if (plannerPlan.reason) {
      ctx.plannerSummaryState.routeReason = plannerPlan.reason;
    }

    callbacks.emitPlannerTrace(ctx, "planner_plan_parsed", {
      attempt: plannerAttempt,
      routeReason: ctx.plannerSummaryState.routeReason,
      requiresSynthesis: plannerPlan.requiresSynthesis === true,
      totalSteps: plannerPlan.steps.length,
      deterministicSteps: plannerPlan.steps.filter((step) =>
        step.stepType === "deterministic_tool"
      ).length,
      subagentSteps: plannerPlan.steps.filter((step) =>
        step.stepType === "subagent_task"
      ).length,
      synthesisSteps: plannerPlan.steps.filter((step) =>
        step.stepType === "synthesis"
      ).length,
      graphDiagnostics,
      plannerStepContractDiagnostics,
      verificationRequirementDiagnostics,
      requestedVerificationCategories: explicitVerificationRequirements,
      requiredOrchestrationDiagnostics,
      explicitToolDiagnostics,
      steps: plannerPlan.steps.map((step) => ({ ...step })),
      edges: plannerPlan.edges.map((edge) => ({ ...edge })),
    });

    ctx.plannerSummaryState.plannedSteps = plannerPlan.steps.length;
    ctx.plannedSubagentSteps = plannerPlan.steps.filter(
      (step) => step.stepType === "subagent_task",
    ).length;
    ctx.plannedDeterministicSteps = plannerPlan.steps.filter(
      (step) => step.stepType === "deterministic_tool",
    ).length;
    ctx.plannedSynthesisSteps = plannerPlan.steps.filter(
      (step) => step.stepType === "synthesis",
    ).length;
    ctx.plannedFanout = ctx.plannedSubagentSteps;
    ctx.plannedDependencyDepth = computePlannerGraphDepth(
      plannerPlan.steps.map((step) => step.name),
      plannerPlan.edges,
    ).maxDepth;

    const subagentSteps = plannerPlan.steps.filter(
      (step): step is PlannerSubAgentTaskStepIntent =>
        step.stepType === "subagent_task",
    );
    let delegationDecision: ReturnType<
      typeof assessAndRecordDelegationDecision
    > | undefined;
    if (subagentSteps.length > 0) {
      const highRiskPlan = isHighRiskSubagentPlan(subagentSteps);
      ctx.trajectoryContextClusterId = deriveDelegationContextClusterId({
        complexityScore: ctx.plannerDecision.score,
        subagentStepCount: subagentSteps.length,
        hasHistory: ctx.hasHistory,
        highRiskPlan,
      });

      const banditResult = resolveDelegationBanditArm(
        config.delegationBanditTuner,
        ctx.trajectoryContextClusterId,
        config.delegationDefaultStrategyArmId,
        ctx.baseDelegationThreshold,
      );
      ctx.selectedBanditArm = banditResult.selectedArm;
      ctx.tunedDelegationThreshold = banditResult.tunedThreshold;
      ctx.plannerSummaryState.delegationPolicyTuning = banditResult.policyTuning;

      delegationDecision = assessAndRecordDelegationDecision(
        {
          messageText: ctx.messageText,
          plannerPlan,
          subagentSteps,
          complexityScore: ctx.plannerDecision.score,
          tunedThreshold: ctx.tunedDelegationThreshold,
          delegationConfig: config.delegationDecisionConfig,
        },
        ctx.plannerSummaryState,
      );
      if (
        explicitOrchestrationRequirements &&
        delegationDecision &&
        !delegationDecision.shouldDelegate
      ) {
        delegationDecision = {
          ...delegationDecision,
          shouldDelegate: true,
          reason: "approved",
        };
        ctx.plannerSummaryState.diagnostics.push({
          category: "policy",
          code: "delegation_required_by_user",
          message:
            "User explicitly required sub-agent orchestration; bypassing delegation utility veto",
          details: {
            requiredSteps:
              explicitOrchestrationRequirements.stepNames.join(","),
          },
        });
      }
    }
    const deterministicSteps = plannerPlan.steps.filter(
      (step): step is PlannerDeterministicToolStepIntent =>
        step.stepType === "deterministic_tool",
    );
    const hasSynthesisStep = plannerPlan.steps.some(
      (step) => step.stepType === "synthesis",
    );
    const plannerPipelineSteps = mapPlannerStepsToPipelineSteps(
      plannerPlan.steps,
    );
    const plannerExecutionContext = buildPlannerExecutionContext(
      ctx.messageText,
      ctx.history,
      ctx.messages,
      ctx.messageSections,
      ctx.expandedRoutedToolNames.length > 0
        ? ctx.expandedRoutedToolNames
        : ctx.activeRoutedToolNames.length > 0
        ? ctx.activeRoutedToolNames
        : (config.allowedTools ? [...config.allowedTools] : undefined),
    );
    const hasExecutablePlannerSteps =
      (
        deterministicSteps.length > 0 &&
        (
          subagentSteps.length === 0 ||
          delegationDecision?.shouldDelegate === true
        )
      ) ||
      (
        subagentSteps.length > 0 &&
        delegationDecision?.shouldDelegate === true
      );

    if (
      hasExecutablePlannerSteps &&
      ctx.plannerSummaryState.routeReason !== "planner_validation_failed" &&
      ctx.plannerSummaryState.routeReason !==
        "planner_explicit_tool_requirements_unmet"
    ) {
      if (deterministicSteps.length > ctx.effectiveToolBudget) {
        callbacks.setStopReason(
          ctx,
          "budget_exceeded",
          `Planner produced ${deterministicSteps.length} deterministic steps but tool budget is ${ctx.effectiveToolBudget}`,
        );
        ctx.finalContent =
          `Planned ${deterministicSteps.length} deterministic steps, ` +
          `but request tool budget is ${ctx.effectiveToolBudget}.`;
        callbacks.emitPlannerTrace(ctx, "planner_path_finished", {
          plannerCalls: plannerAttempt,
          routeReason: ctx.plannerSummaryState.routeReason,
          stopReason: ctx.stopReason,
          stopReasonDetail: ctx.stopReasonDetail,
          diagnostics: ctx.plannerSummaryState.diagnostics,
          handled: true,
        });
        ctx.plannerHandled = true;
        return;
      }

      const pipeline: Pipeline = {
        id: `planner:${ctx.sessionId}:${Date.now()}`,
        createdAt: Date.now(),
        context: { results: {} },
        steps: deterministicSteps.map((step) => ({
          name: step.name,
          tool: step.tool,
          args: step.args,
          onError: step.onError,
          maxRetries: step.maxRetries,
        })),
        plannerSteps: plannerPipelineSteps,
        edges: plannerPlan.edges,
        maxParallelism: config.delegationDecisionConfig.maxFanoutPerTurn,
        plannerContext: plannerExecutionContext,
      };

      callbacks.emitPlannerTrace(ctx, "planner_pipeline_started", {
        attempt: plannerAttempt,
        pipelineId: pipeline.id,
        routeReason: ctx.plannerSummaryState.routeReason,
        deterministicSteps: deterministicSteps.map((step) => ({
          name: step.name,
          tool: step.tool,
          onError: step.onError ?? "abort",
          maxRetries: step.maxRetries ?? 0,
        })),
        delegatedSteps: subagentSteps.map((step) => step.name),
      });

      const shouldRunSubagentVerifier =
        subagentSteps.length > 0 &&
        delegationDecision?.shouldDelegate === true &&
        (
          config.subagentVerifierConfig.enabled ||
          config.subagentVerifierConfig.force
        );
      const {
        verifierRounds,
        verificationDecision,
        pipelineResult,
      } = await executePlannerPipelineWithVerifierLoop({
        pipeline,
        plannerPlan,
        subagentSteps,
        deterministicSteps,
        plannerExecutionContext,
        shouldRunSubagentVerifier,
        verifierConfig: config.subagentVerifierConfig,
        plannerSummaryState: ctx.plannerSummaryState,
        checkRequestTimeout: (stage: string) => callbacks.checkRequestTimeout(ctx, stage),
        runPipelineWithGlobalTimeout: (p: Pipeline) => callbacks.runPipelineWithTimeout(ctx, p),
        runSubagentVerifierRound: (input) =>
          runSubagentVerifierRound({
            systemPrompt: ctx.systemPrompt,
            messageText: ctx.messageText,
            sessionId: ctx.sessionId,
            stateful: ctx.stateful,
            plannerDiagnostics: ctx.plannerSummaryState.diagnostics,
            plannerPlan: input.plannerPlan,
            subagentSteps: input.subagentSteps,
            pipelineResult: input.pipelineResult,
            plannerContext: input.plannerContext,
            round: input.round,
            callModelForPhase: (phaseInput) => callbacks.callModelForPhase(ctx, phaseInput),
          }),
        onVerifierRoundFinished: (payload) =>
          callbacks.emitPlannerTrace(
            ctx,
            "planner_verifier_round_finished",
            payload,
          ),
        onVerifierRetryScheduled: (payload) =>
          callbacks.emitPlannerTrace(
            ctx,
            "planner_verifier_retry_scheduled",
            payload,
          ),
        appendToolRecord: (record: ToolCallRecord) => callbacks.appendToolRecord(ctx, record),
        setStopReason: (reason: LLMPipelineStopReason, detail?: string) => callbacks.setStopReason(ctx, reason, detail),
      });

      if (
        shouldRunSubagentVerifier &&
        verifierRounds === 0 &&
        !ctx.plannerSummaryState.subagentVerification.performed
      ) {
        ctx.plannerSummaryState.subagentVerification = {
          enabled: true,
          performed: false,
          rounds: 0,
          overall: "skipped",
          confidence: 1,
          unresolvedItems: [],
        };
      }

      if (
        pipelineResult?.decomposition &&
        plannerAttempt < maxPlannerAttempts &&
        structuralPlannerRetriesUsed < maxStructuralPlannerRetries
      ) {
        structuralPlannerRetriesUsed++;
        refinementHint = buildPipelineDecompositionRefinementHint(
          pipelineResult.decomposition,
        );
        ctx.plannerSummaryState.diagnostics.push({
          category: "policy",
          code: "planner_runtime_refinement_retry",
          message:
            "Delegated execution requested parent-side decomposition; replanning with smaller steps",
          details: {
            attempt: plannerAttempt,
            nextAttempt: plannerAttempt + 1,
            maxAttempts: maxPlannerAttempts,
          },
        });
        callbacks.emitPlannerTrace(ctx, "planner_pipeline_finished", {
          attempt: plannerAttempt,
          pipelineId: pipeline.id,
          status: pipelineResult.status,
          completedSteps: pipelineResult.completedSteps,
          totalSteps: pipelineResult.totalSteps,
          decomposition: pipelineResult.decomposition,
          verificationDecision,
        });
        callbacks.emitPlannerTrace(ctx, "planner_refinement_requested", {
          attempt: plannerAttempt,
          nextAttempt: plannerAttempt + 1,
          reason: "planner_runtime_refinement_retry",
          decomposition: pipelineResult.decomposition,
        });
        continue;
      }

      const runtimeRepairFailureSignature = pipelineResult
        ? buildPipelineFailureSignature(pipelineResult)
        : undefined;
      const runtimeRepairSignatureSeen =
        runtimeRepairFailureSignature !== undefined &&
        seenRuntimeRepairFailureSignatures.has(runtimeRepairFailureSignature);
      const shouldRetryFailedPipelineWithRepairPlan =
        pipelineResult?.status === "failed" &&
        plannerAttempt < maxPlannerAttempts &&
        pipelineResult.completedSteps > 0 &&
        !runtimeRepairSignatureSeen &&
        (
          pipelineResult.stopReasonHint === "tool_error" ||
          pipelineResult.stopReasonHint === "validation_error" ||
          pipelineResult.stopReasonHint === "no_progress" ||
          pipelineResult.stopReasonHint === undefined
        );

      if (
        pipelineResult &&
        shouldRetryFailedPipelineWithRepairPlan
      ) {
        if (runtimeRepairFailureSignature) {
          seenRuntimeRepairFailureSignatures.add(runtimeRepairFailureSignature);
        }
        refinementHint = buildPipelineFailureRepairRefinementHint({
          pipelineResult,
          plannerPlan,
        });
        ctx.plannerSummaryState.diagnostics.push({
          category: "policy",
          code: "planner_runtime_repair_retry",
          message:
            "Deterministic verification failed after partial planner execution; requesting a repair-focused replan",
          details: {
            attempt: plannerAttempt,
            nextAttempt: plannerAttempt + 1,
            maxAttempts: maxPlannerAttempts,
            completedSteps: pipelineResult.completedSteps,
            totalSteps: pipelineResult.totalSteps,
            stopReasonHint: pipelineResult.stopReasonHint ?? "tool_error",
          },
        });
        callbacks.emitPlannerTrace(ctx, "planner_pipeline_finished", {
          attempt: plannerAttempt,
          pipelineId: pipeline.id,
          status: pipelineResult.status,
          completedSteps: pipelineResult.completedSteps,
          totalSteps: pipelineResult.totalSteps,
          error: pipelineResult.error,
          stopReasonHint: pipelineResult.stopReasonHint,
          decomposition: pipelineResult.decomposition,
          verificationDecision,
        });
        callbacks.emitPlannerTrace(ctx, "planner_refinement_requested", {
          attempt: plannerAttempt,
          nextAttempt: plannerAttempt + 1,
          reason: "planner_runtime_repair_retry",
          stopReasonHint: pipelineResult.stopReasonHint,
          error: pipelineResult.error,
          completedSteps: pipelineResult.completedSteps,
          totalSteps: pipelineResult.totalSteps,
        });
        continue;
      }

      if (pipelineResult && runtimeRepairSignatureSeen) {
        ctx.plannerSummaryState.diagnostics.push({
          category: "policy",
          code: "planner_runtime_repair_stalled",
          message:
            "Deterministic verification repeated the same failure signature after a repair-focused replan; stopping additional repair retries",
          details: {
            attempt: plannerAttempt,
            completedSteps: pipelineResult.completedSteps,
            totalSteps: pipelineResult.totalSteps,
            stopReasonHint: pipelineResult.stopReasonHint ?? "tool_error",
          },
        });
      }

      if (pipelineResult) {
        callbacks.emitPlannerTrace(ctx, "planner_pipeline_finished", {
          attempt: plannerAttempt,
          pipelineId: pipeline.id,
          status: pipelineResult.status,
          completedSteps: pipelineResult.completedSteps,
          totalSteps: pipelineResult.totalSteps,
          error: pipelineResult.error,
          stopReasonHint: pipelineResult.stopReasonHint,
          decomposition: pipelineResult.decomposition,
          verificationDecision,
        });
      } else {
        callbacks.emitPlannerTrace(ctx, "planner_pipeline_finished", {
          attempt: plannerAttempt,
          pipelineId: pipeline.id,
          status: "timeout",
          stopReason: ctx.stopReason,
          stopReasonDetail: ctx.stopReasonDetail,
          verificationDecision,
        });
      }

      if (pipelineResult) {
        if (pipelineResult.status === "failed") {
          const hintedStopReason = isPipelineStopReasonHint(
            pipelineResult.stopReasonHint,
          )
            ? pipelineResult.stopReasonHint
            : "tool_error";
          callbacks.setStopReason(
            ctx,
            hintedStopReason,
            pipelineResult.error ??
              "Deterministic pipeline execution failed",
          );
        } else if (pipelineResult.status === "halted") {
          callbacks.setStopReason(
            ctx,
            "tool_calls",
            `Deterministic pipeline halted at step ${
              (pipelineResult.resumeFrom ?? 0) + 1
            } awaiting approval`,
          );
        }
      } else if (ctx.stopReason === "completed") {
        callbacks.setStopReason(
          ctx,
          "timeout",
          callbacks.timeoutDetail("planner pipeline execution", ctx.effectiveRequestTimeoutMs),
        );
      }

      if (ctx.failedToolCalls > ctx.effectiveFailureBudget) {
        callbacks.setStopReason(
          ctx,
          "tool_error",
          `Failure budget exceeded (${ctx.failedToolCalls}/${ctx.effectiveFailureBudget}) during deterministic pipeline execution`,
        );
      }

      let plannerFinalizationStrategy: string | undefined;
      if (
        pipelineResult &&
        !pipelineResult.decomposition &&
        ctx.stopReason === "completed" &&
        explicitDeterministicToolRequirements?.exactResponseLiteral
      ) {
        ctx.finalContent =
          explicitDeterministicToolRequirements.exactResponseLiteral;
        plannerFinalizationStrategy = "exact_response_literal";
        ctx.plannerSummaryState.diagnostics.push({
          category: "policy",
          code: "planner_exact_response_literal_applied",
          message:
            "Completed deterministic plan satisfied the explicit exact-response contract without planner synthesis",
          details: {
            literal:
              explicitDeterministicToolRequirements.exactResponseLiteral,
          },
        });
      }

      if (
        pipelineResult &&
        !pipelineResult.decomposition &&
        !ctx.finalContent &&
        (
          plannerPlan.requiresSynthesis ||
          hasSynthesisStep ||
          explicitOrchestrationRequirements?.requiresSynthesis === true ||
          ctx.stopReason !== "completed"
        )
      ) {
        const synthesisMessages = buildPlannerSynthesisMessages(
          ctx.systemPrompt,
          ctx.messageText,
          plannerPlan,
          pipelineResult,
          verificationDecision,
        );
        const synthesisSections: PromptBudgetSection[] = [
          "system_anchor",
          "system_runtime",
          "user",
        ];
        const stopReasonBeforeSynthesis = ctx.stopReason;
        const stopReasonDetailBeforeSynthesis = ctx.stopReasonDetail;
        try {
          const synthesisResponse = await callbacks.callModelForPhase(ctx, {
            phase: "planner_synthesis",
            callMessages: synthesisMessages,
            callSections: synthesisSections,
            onStreamChunk: ctx.activeStreamCallback,
            statefulSessionId: ctx.sessionId,
            statefulResumeAnchor: ctx.stateful?.resumeAnchor,
            statefulHistoryCompacted: ctx.stateful?.historyCompacted,
            routedToolNames: [],
            toolChoice: "none",
            budgetReason:
              "Planner synthesis blocked by max model recalls per request budget",
          });
          if (synthesisResponse) {
            ctx.response = synthesisResponse;
            ctx.finalContent = ensureSubagentProvenanceCitations(
              synthesisResponse.content,
              plannerPlan,
              pipelineResult,
            );
          }
        } catch (error) {
          if (
            pipelineResult.status === "completed" &&
            stopReasonBeforeSynthesis === "completed"
          ) {
            const failureDetail =
              typeof (error as { stopReasonDetail?: unknown })?.stopReasonDetail === "string"
                ? String((error as { stopReasonDetail: string }).stopReasonDetail)
                : error instanceof Error
                  ? error.message
                  : String(error);
            ctx.stopReason = stopReasonBeforeSynthesis;
            ctx.stopReasonDetail = stopReasonDetailBeforeSynthesis;
            ctx.plannerSummaryState.diagnostics.push({
              category: "runtime",
              code: "planner_synthesis_fallback_applied",
              message:
                "Planner synthesis failed after the pipeline completed; returning a deterministic fallback summary",
              details: {
                failureDetail,
              },
            });
            callbacks.emitPlannerTrace(ctx, "planner_synthesis_fallback_applied", {
              failureDetail,
              completedSteps: pipelineResult.completedSteps,
              totalSteps: pipelineResult.totalSteps,
            });
            ctx.finalContent = buildPlannerSynthesisFallbackContent(
              plannerPlan,
              pipelineResult,
              verificationDecision,
              verifierRounds,
              failureDetail,
            );
          } else {
            throw error;
          }
        }
      } else if (pipelineResult?.decomposition && !ctx.finalContent) {
        ctx.finalContent =
          pipelineResult.error ??
          pipelineResult.decomposition.reason;
      }

      if (!ctx.finalContent) {
        ctx.finalContent =
          generateFallbackContent(ctx.allToolCalls) ??
          summarizeToolCalls(
            ctx.allToolCalls.filter((call) => !call.isError),
          );
      }
      callbacks.emitPlannerTrace(ctx, "planner_path_finished", {
        plannerCalls: plannerAttempt,
        routeReason: ctx.plannerSummaryState.routeReason,
        stopReason: ctx.stopReason,
        stopReasonDetail: ctx.stopReasonDetail,
        diagnostics: ctx.plannerSummaryState.diagnostics,
        handled: true,
        ...(plannerFinalizationStrategy
          ? { finalizationStrategy: plannerFinalizationStrategy }
          : {}),
        deterministicStepsExecuted:
          ctx.plannerSummaryState.deterministicStepsExecuted,
      });
      ctx.plannerHandled = true;
      return;
    }

    if (
      !delegationDecision ||
      delegationDecision.shouldDelegate
    ) {
      if (
        ctx.plannerSummaryState.routeReason !== "planner_validation_failed" &&
        ctx.plannerSummaryState.routeReason !==
          "planner_explicit_tool_requirements_unmet"
      ) {
        ctx.plannerSummaryState.routeReason = "planner_no_deterministic_steps";
      }
    }
    if (ctx.plannerSummaryState.routeReason === "planner_validation_failed") {
      callbacks.setStopReason(
        ctx,
        "validation_error",
        "Planner emitted a structured plan that failed local validation",
      );
      ctx.finalContent = buildPlannerValidationFailureMessage(
        latestPlannerValidationDiagnostics.length > 0
          ? latestPlannerValidationDiagnostics
          : ctx.plannerSummaryState.diagnostics,
      );
      callbacks.emitPlannerTrace(ctx, "planner_path_finished", {
        plannerCalls: plannerAttempt,
        routeReason: ctx.plannerSummaryState.routeReason,
        stopReason: ctx.stopReason,
        stopReasonDetail: ctx.stopReasonDetail,
        diagnostics: ctx.plannerSummaryState.diagnostics,
        latestDiagnostics: latestPlannerValidationDiagnostics,
        handled: true,
      });
      ctx.plannerHandled = true;
      return;
    }
    callbacks.emitPlannerTrace(ctx, "planner_path_finished", {
      plannerCalls: plannerAttempt,
      routeReason: ctx.plannerSummaryState.routeReason,
      stopReason: ctx.stopReason,
      stopReasonDetail: ctx.stopReasonDetail,
      diagnostics: ctx.plannerSummaryState.diagnostics,
      handled: false,
    });
    return;
  }
}
