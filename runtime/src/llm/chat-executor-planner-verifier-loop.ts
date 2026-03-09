/**
 * Planner pipeline and subagent verifier loop helpers for ChatExecutor.
 *
 * @module
 */

import type {
  LLMResponse,
  LLMStatefulResumeAnchor,
  LLMMessage,
} from "./types.js";
import type {
  PlannerPipelineVerifierLoopInput,
  PlannerSubAgentTaskStepIntent,
  PlannerPlan,
  ResolvedSubagentVerifierConfig,
  PlannerDiagnostic,
  SubagentVerifierDecision,
} from "./chat-executor-types.js";
import type { PromptBudgetSection } from "./prompt-budget.js";
import type {
  PipelinePlannerContext,
  PipelineResult,
} from "../workflow/pipeline.js";
import { pipelineResultToToolCalls } from "./chat-executor-planner.js";
import {
  buildSubagentVerifierMessages,
  evaluateSubagentDeterministicChecks,
  mergeSubagentVerifierDecisions,
  parseSubagentVerifierDecision,
} from "./chat-executor-verifier.js";

interface CallModelForPhaseResult extends Pick<LLMResponse, "content"> {}

export async function runSubagentVerifierRound(params: {
  readonly systemPrompt: string;
  readonly messageText: string;
  readonly sessionId: string;
  readonly stateful?: {
    readonly resumeAnchor?: LLMStatefulResumeAnchor;
    readonly historyCompacted?: boolean;
  };
  readonly plannerDiagnostics: PlannerDiagnostic[];
  readonly plannerPlan: PlannerPlan;
  readonly subagentSteps: readonly PlannerSubAgentTaskStepIntent[];
  readonly pipelineResult: PipelineResult;
  readonly plannerContext: PipelinePlannerContext;
  readonly round: number;
  readonly callModelForPhase: (input: {
    phase: "planner_verifier";
    callMessages: readonly LLMMessage[];
    callSections: readonly PromptBudgetSection[];
    statefulSessionId?: string;
    statefulResumeAnchor?: LLMStatefulResumeAnchor;
    statefulHistoryCompacted?: boolean;
    budgetReason: string;
  }) => Promise<CallModelForPhaseResult | undefined>;
}): Promise<SubagentVerifierDecision> {
  const deterministic = evaluateSubagentDeterministicChecks(
    params.subagentSteps,
    params.pipelineResult,
    params.plannerContext,
  );
  const verifierMessages = buildSubagentVerifierMessages(
    params.systemPrompt,
    params.messageText,
    params.plannerPlan,
    params.subagentSteps,
    params.pipelineResult,
    params.plannerContext,
    deterministic,
  );
  const verifierSections: PromptBudgetSection[] = [
    "system_anchor",
    "system_runtime",
    "user",
  ];
  const verifierResponse = await params.callModelForPhase({
    phase: "planner_verifier",
    callMessages: verifierMessages,
    callSections: verifierSections,
    statefulSessionId: params.sessionId,
    statefulResumeAnchor: params.stateful?.resumeAnchor,
    statefulHistoryCompacted: params.stateful?.historyCompacted,
    budgetReason:
      "Planner verifier blocked by max model recalls per request budget",
  });
  if (!verifierResponse) {
    return deterministic;
  }
  const modelDecision = parseSubagentVerifierDecision(
    verifierResponse.content,
    params.subagentSteps,
  );
  if (!modelDecision) {
    params.plannerDiagnostics.push({
      category: "parse",
      code: "subagent_verifier_parse_failed",
      message:
        "Sub-agent verifier returned non-JSON or malformed schema; using deterministic verifier fallback",
      details: {
        round: params.round,
      },
    });
    return deterministic;
  }
  return mergeSubagentVerifierDecisions(
    deterministic,
    modelDecision,
  );
}

export async function executePlannerPipelineWithVerifierLoop(
  input: PlannerPipelineVerifierLoopInput & {
    readonly verifierConfig: ResolvedSubagentVerifierConfig;
  },
): Promise<{
  verifierRounds: number;
  verificationDecision?: SubagentVerifierDecision;
  pipelineResult?: PipelineResult;
}> {
  let verifierRounds = 0;
  let verificationDecision: SubagentVerifierDecision | undefined;
  let pipelineResult: PipelineResult | undefined;

  while (true) {
    if (input.checkRequestTimeout("planner pipeline execution")) break;
    const nextPipelineResult = await input.runPipelineWithGlobalTimeout(
      input.pipeline,
    );
    if (!nextPipelineResult) break;
    pipelineResult = nextPipelineResult;

    for (const record of pipelineResultToToolCalls(
      input.plannerPlan.steps,
      nextPipelineResult,
    )) {
      input.appendToolRecord(record);
    }
    input.plannerSummaryState.deterministicStepsExecuted =
      input.deterministicSteps.filter((step) =>
        typeof nextPipelineResult.context.results[step.name] === "string"
      ).length;

    if (
      !input.shouldRunSubagentVerifier ||
      nextPipelineResult.status !== "completed"
    ) {
      break;
    }

    verifierRounds++;
    verificationDecision = await input.runSubagentVerifierRound({
      plannerPlan: input.plannerPlan,
      subagentSteps: input.subagentSteps,
      pipelineResult: nextPipelineResult,
      plannerContext: input.plannerExecutionContext,
      round: verifierRounds,
    });
    input.plannerSummaryState.subagentVerification = {
      enabled: true,
      performed: true,
      rounds: verifierRounds,
      overall: verificationDecision.overall,
      confidence: verificationDecision.confidence,
      unresolvedItems: [...verificationDecision.unresolvedItems],
    };

    const belowConfidence =
      verificationDecision.confidence <
      input.verifierConfig.minConfidence;
    const retryable =
      verificationDecision.steps.some((step) => step.retryable);
    const canRetry =
      verifierRounds < input.verifierConfig.maxRounds &&
      (
        verificationDecision.overall === "retry" ||
        belowConfidence
      ) &&
      retryable;

    if (canRetry) {
      input.plannerSummaryState.diagnostics.push({
        category: "policy",
        code: "subagent_verifier_retry",
        message:
          "Sub-agent verifier requested retry; rerunning planner pipeline",
        details: {
          round: verifierRounds,
          maxRounds: input.verifierConfig.maxRounds,
          confidence: Number(verificationDecision.confidence.toFixed(3)),
          minConfidence: Number(
            input.verifierConfig.minConfidence.toFixed(3),
          ),
        },
      });
      continue;
    }

    if (
      verificationDecision.overall !== "pass" ||
      belowConfidence
    ) {
      const unresolvedPreview =
        verificationDecision.unresolvedItems.slice(0, 3).join("; ");
      input.setStopReason(
        "validation_error",
        unresolvedPreview.length > 0
          ? `Sub-agent verifier rejected child outputs: ${unresolvedPreview}`
          : "Sub-agent verifier rejected child outputs",
      );
    }
    break;
  }

  return {
    verifierRounds,
    verificationDecision,
    pipelineResult,
  };
}
