/**
 * Subagent verifier/critic functions for ChatExecutor.
 *
 * @module
 */

import type {
  PipelinePlannerContext,
  PipelineResult,
} from "../workflow/pipeline.js";
import type {
  PlannerSubAgentTaskStepIntent,
  PlannerPlan,
  SubagentVerifierStepVerdict,
  SubagentVerifierStepAssessment,
  SubagentVerifierDecision,
} from "./chat-executor-types.js";
import type { LLMMessage } from "./types.js";
import {
  DEFAULT_SUBAGENT_VERIFIER_MIN_CONFIDENCE,
  MAX_SUBAGENT_VERIFIER_OUTPUT_CHARS,
  MAX_SUBAGENT_VERIFIER_ARTIFACT_CHARS,
} from "./chat-executor-constants.js";
import {
  truncateText,
  parseJsonObjectFromText,
} from "./chat-executor-text.js";
import {
  parsePlannerRequiredString,
  parsePlannerOptionalString,
} from "./chat-executor-planner.js";
import { safeStringify } from "../tools/types.js";

export function evaluateSubagentDeterministicChecks(
  subagentSteps: readonly PlannerSubAgentTaskStepIntent[],
  pipelineResult: PipelineResult,
  plannerContext: PipelinePlannerContext,
): SubagentVerifierDecision {
  const stepAssessments: SubagentVerifierStepAssessment[] = [];
  const unresolvedItems: string[] = [];
  const artifactCorpus = collectVerifierArtifacts(
    pipelineResult,
    plannerContext,
  );
  const artifactText = artifactCorpus.join(" ").toLowerCase();

  for (const step of subagentSteps) {
    const raw = pipelineResult.context.results[step.name];
    const issues: string[] = [];
    let verdict: SubagentVerifierStepVerdict = "pass";
    let retryable = true;
    let output = "";
    let status = "unknown";
    let toolCallsCount = 0;

    if (typeof raw !== "string") {
      issues.push("missing_subagent_result");
      verdict = "retry";
    } else {
      const parsed = parseJsonObjectFromText(raw);
      if (!parsed) {
        issues.push("malformed_subagent_result_payload");
        verdict = "retry";
        output = raw;
      } else {
        status = typeof parsed.status === "string"
          ? parsed.status.toLowerCase()
          : "unknown";
        output = typeof parsed.output === "string"
          ? parsed.output
          : safeStringify(parsed.output ?? "");
        toolCallsCount = Array.isArray(parsed.toolCalls)
          ? parsed.toolCalls.length
          : 0;
        if (parsed.success === false || status === "failed") {
          issues.push("child_reported_failure");
          verdict = "retry";
        }
        if (status === "cancelled") {
          issues.push("child_cancelled");
          verdict = "fail";
          retryable = false;
        }
        if (status === "delegation_fallback") {
          issues.push("child_used_parent_fallback");
          verdict = "fail";
          retryable = false;
        }
      }
    }

    const trimmedOutput = output.trim();
    if (trimmedOutput.length === 0) {
      issues.push("empty_child_output");
      verdict = moreSevereVerifierVerdict(verdict, "retry");
    }

    const expectsJson = step.inputContract.toLowerCase().includes("json");
    if (expectsJson && trimmedOutput.length > 0) {
      const parsedOutput = parseJsonObjectFromText(trimmedOutput);
      if (!parsedOutput) {
        issues.push("contract_violation_expected_json_output");
        verdict = moreSevereVerifierVerdict(verdict, "retry");
      }
    }

    const outputLower = trimmedOutput.toLowerCase();
    const likelyEvidence =
      /(line|file|log|trace|stderr|stdout|stack|error|\d)/.test(outputLower);
    if (trimmedOutput.length > 0 && !likelyEvidence) {
      issues.push("weak_evidence_density");
    }

    const expectationTokens = step.acceptanceCriteria
      .flatMap((criterion) =>
        extractVerifierTokens(criterion)
      )
      .slice(0, 24);
    if (expectationTokens.length > 0 && trimmedOutput.length > 0) {
      const matched = expectationTokens.some((token) =>
        outputLower.includes(token)
      );
      if (!matched) {
        issues.push("acceptance_criteria_not_evidenced");
      }
    }

    if (
      trimmedOutput.length > 0 &&
      /(according to|as seen in|from the logs|based on)/.test(outputLower) &&
      artifactText.length > 0 &&
      !outputIntersectsArtifacts(outputLower, artifactText)
    ) {
      issues.push("hallucination_risk_artifact_mismatch");
      verdict = moreSevereVerifierVerdict(verdict, "retry");
    }

    if (step.requiredToolCapabilities.length > 0 && toolCallsCount === 0) {
      issues.push("missing_tool_result_consistency_signal");
    }

    const confidence = Math.max(0, 1 - Math.min(0.9, issues.length * 0.18));
    if (verdict !== "pass" || confidence < DEFAULT_SUBAGENT_VERIFIER_MIN_CONFIDENCE) {
      unresolvedItems.push(
        `${step.name}:${issues.length > 0 ? issues.join(",") : "low_confidence"}`,
      );
    }
    stepAssessments.push({
      name: step.name,
      verdict,
      confidence,
      retryable,
      issues,
      summary:
        issues.length > 0
          ? issues.join("; ")
          : "deterministic verifier checks passed",
    });
  }

  const overall = resolveVerifierOverall(stepAssessments);
  const confidence = stepAssessments.length > 0
    ? Number(
        (
          stepAssessments.reduce((sum, step) => sum + step.confidence, 0) /
          stepAssessments.length
        ).toFixed(4),
      )
    : 1;
  return {
    overall,
    confidence,
    unresolvedItems,
    steps: stepAssessments,
    source: "deterministic",
  };
}

export function buildSubagentVerifierMessages(
  systemPrompt: string,
  messageText: string,
  plannerPlan: PlannerPlan,
  subagentSteps: readonly PlannerSubAgentTaskStepIntent[],
  pipelineResult: PipelineResult,
  plannerContext: PipelinePlannerContext,
  deterministicDecision: SubagentVerifierDecision,
): readonly LLMMessage[] {
  const artifactBundle = collectVerifierArtifacts(
    pipelineResult,
    plannerContext,
  );
  const childBundle = subagentSteps.map((step) => ({
    name: step.name,
    objective: step.objective,
    inputContract: step.inputContract,
    acceptanceCriteria: step.acceptanceCriteria,
    requiredToolCapabilities: step.requiredToolCapabilities,
    rawResult: truncateText(
      pipelineResult.context.results[step.name] ?? "missing",
      MAX_SUBAGENT_VERIFIER_OUTPUT_CHARS,
    ),
  }));
  return [
    { role: "system", content: systemPrompt },
    {
      role: "system",
      content:
        "You are a strict verifier for delegated child outputs. " +
        "Assess contract adherence, evidence quality, hallucination risk against provided artifacts, and tool-result consistency. " +
        "Return JSON only with schema: " +
        '{"overall":"pass|retry|fail","confidence":0..1,"unresolved":[string],"steps":[{"name":string,"verdict":"pass|retry|fail","confidence":0..1,"retryable":boolean,"issues":[string],"summary":string}]}.',
    },
    {
      role: "user",
      content: safeStringify({
        request: messageText,
        plannerReason: plannerPlan.reason,
        deterministicVerifier: deterministicDecision,
        childBundle,
        artifacts: artifactBundle.map((entry) =>
          truncateText(entry, MAX_SUBAGENT_VERIFIER_ARTIFACT_CHARS)
        ),
      }),
    },
  ];
}

export function parseSubagentVerifierDecision(
  content: string,
  subagentSteps: readonly PlannerSubAgentTaskStepIntent[],
): SubagentVerifierDecision | undefined {
  const parsed = parseJsonObjectFromText(content);
  if (!parsed) return undefined;
  const overallRaw = parsed.overall;
  if (
    overallRaw !== "pass" &&
    overallRaw !== "retry" &&
    overallRaw !== "fail"
  ) {
    return undefined;
  }
  const confidenceRaw = parsed.confidence;
  const confidence = typeof confidenceRaw === "number" && Number.isFinite(confidenceRaw)
    ? Math.max(0, Math.min(1, confidenceRaw))
    : 0.5;
  const unresolvedItems = Array.isArray(parsed.unresolved)
    ? parsed.unresolved
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    : [];
  const stepsByName = new Map(subagentSteps.map((step) => [step.name, step]));
  const parsedSteps = Array.isArray(parsed.steps) ? parsed.steps : [];
  const assessments: SubagentVerifierStepAssessment[] = [];
  for (const entry of parsedSteps) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      Array.isArray(entry)
    ) {
      continue;
    }
    const obj = entry as Record<string, unknown>;
    const name = parsePlannerRequiredString(obj.name);
    if (!name || !stepsByName.has(name)) continue;
    const verdictRaw = obj.verdict;
    if (
      verdictRaw !== "pass" &&
      verdictRaw !== "retry" &&
      verdictRaw !== "fail"
    ) {
      continue;
    }
    const stepConfidenceRaw = obj.confidence;
    const stepConfidence =
      typeof stepConfidenceRaw === "number" && Number.isFinite(stepConfidenceRaw)
        ? Math.max(0, Math.min(1, stepConfidenceRaw))
        : confidence;
    const retryable =
      typeof obj.retryable === "boolean" ? obj.retryable : true;
    const issues = Array.isArray(obj.issues)
      ? obj.issues
          .filter((issue): issue is string => typeof issue === "string")
          .map((issue) => issue.trim())
          .filter((issue) => issue.length > 0)
      : [];
    const summary = parsePlannerOptionalString(obj.summary) ??
      (issues.length > 0 ? issues.join("; ") : "verifier assessment");
    assessments.push({
      name,
      verdict: verdictRaw,
      confidence: stepConfidence,
      retryable,
      issues,
      summary,
    });
  }
  if (assessments.length === 0) return undefined;
  return {
    overall: overallRaw,
    confidence,
    unresolvedItems,
    steps: assessments,
    source: "model",
  };
}

export function mergeSubagentVerifierDecisions(
  deterministic: SubagentVerifierDecision,
  model: SubagentVerifierDecision,
): SubagentVerifierDecision {
  const byName = new Map<string, SubagentVerifierStepAssessment>();
  for (const step of deterministic.steps) {
    byName.set(step.name, step);
  }
  for (const step of model.steps) {
    const existing = byName.get(step.name);
    if (!existing) {
      byName.set(step.name, step);
      continue;
    }
    const mergedVerdict = moreSevereVerifierVerdict(
      existing.verdict,
      step.verdict,
    );
    const mergedIssues = [...new Set([...existing.issues, ...step.issues])];
    byName.set(step.name, {
      name: step.name,
      verdict: mergedVerdict,
      confidence: Math.min(existing.confidence, step.confidence),
      retryable: existing.retryable && step.retryable,
      issues: mergedIssues,
      summary:
        mergedIssues.length > 0
          ? mergedIssues.join("; ")
          : "merged verifier checks passed",
    });
  }
  const steps = [...byName.values()];
  const overall = resolveVerifierOverall(steps);
  const unresolvedItems = [
    ...new Set([
      ...deterministic.unresolvedItems,
      ...model.unresolvedItems,
      ...steps
        .filter((step) => step.verdict !== "pass")
        .map((step) => `${step.name}:${step.summary}`),
    ]),
  ];
  return {
    overall,
    confidence: Math.min(deterministic.confidence, model.confidence),
    unresolvedItems,
    steps,
    source: "merged",
  };
}

export function resolveVerifierOverall(
  steps: readonly SubagentVerifierStepAssessment[],
): "pass" | "retry" | "fail" {
  let overall: "pass" | "retry" | "fail" = "pass";
  for (const step of steps) {
    overall = moreSevereVerifierVerdict(overall, step.verdict);
    if (overall === "fail") return "fail";
  }
  return overall;
}

export function moreSevereVerifierVerdict(
  a: SubagentVerifierStepVerdict,
  b: SubagentVerifierStepVerdict,
): SubagentVerifierStepVerdict {
  const weight: Record<SubagentVerifierStepVerdict, number> = {
    pass: 0,
    retry: 1,
    fail: 2,
  };
  return weight[a] >= weight[b] ? a : b;
}

export function extractVerifierTokens(value: string): string[] {
  const matches = value.toLowerCase().match(/[a-z0-9_.-]+/g) ?? [];
  const deduped = new Set<string>();
  for (const match of matches) {
    if (match.length < 4) continue;
    deduped.add(match);
  }
  return [...deduped];
}

export function collectVerifierArtifacts(
  pipelineResult: PipelineResult,
  plannerContext: PipelinePlannerContext,
): readonly string[] {
  const artifacts: string[] = [];
  for (const item of plannerContext.toolOutputs ?? []) {
    artifacts.push(item.content);
  }
  for (const item of plannerContext.memory ?? []) {
    artifacts.push(item.content);
  }
  for (const item of Object.values(pipelineResult.context.results)) {
    if (typeof item !== "string") continue;
    artifacts.push(item);
  }
  return artifacts
    .map((entry) => truncateText(entry, MAX_SUBAGENT_VERIFIER_ARTIFACT_CHARS))
    .filter((entry) => entry.length > 0)
    .slice(0, 24);
}

export function outputIntersectsArtifacts(
  outputLower: string,
  artifactLower: string,
): boolean {
  const tokens = extractVerifierTokens(outputLower).slice(0, 24);
  return tokens.some((token) =>
    token.length >= 5 && artifactLower.includes(token)
  );
}
