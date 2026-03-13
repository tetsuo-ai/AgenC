/**
 * Contract-guidance and required-evidence helpers for ChatExecutor.
 *
 * @module
 */

import type {
  DelegationContractSpec,
  DelegationOutputValidationCode,
  DelegationOutputValidationResult,
} from "../utils/delegation-validation.js";
import {
  getMissingSuccessfulToolEvidenceMessage,
  specRequiresFileMutationEvidence,
  specRequiresMeaningfulBrowserEvidence,
  validateDelegatedOutputContract,
} from "../utils/delegation-validation.js";
import { buildBrowserEvidenceRetryGuidance } from "../utils/browser-tool-taxonomy.js";
import type { ExecutionContext, ToolCallRecord } from "./chat-executor-types.js";
import type { LLMProviderEvidence } from "./types.js";
import {
  type ToolContractGuidance,
  type ToolContractGuidancePhase,
  resolveToolContractGuidance,
} from "./chat-executor-contract-guidance.js";
import {
  getAllowedToolNamesForContractGuidance,
  getAllowedToolNamesForEvidence,
} from "./chat-executor-routing-state.js";

type ToolNameCollection = Iterable<string> | readonly string[];

type ContractFlowContext = Pick<
  ExecutionContext,
  | "messageText"
  | "allToolCalls"
  | "activeRoutedToolNames"
  | "initialRoutedToolNames"
  | "expandedRoutedToolNames"
  | "requiredToolEvidence"
  | "providerEvidence"
  | "response"
>;

export function resolveExecutionToolContractGuidance(input: {
  readonly ctx: ContractFlowContext;
  readonly allowedTools?: ToolNameCollection;
  readonly phase?: ToolContractGuidancePhase;
  readonly allowedToolNames?: readonly string[];
  readonly validationCode?: DelegationOutputValidationCode;
}): ToolContractGuidance | undefined {
  return resolveToolContractGuidance({
    phase: input.phase ?? "tool_followup",
    messageText: input.ctx.messageText,
    toolCalls: input.ctx.allToolCalls,
    allowedToolNames: getAllowedToolNamesForContractGuidance({
      override: input.allowedToolNames,
      activeRoutedToolNames: input.ctx.activeRoutedToolNames,
      initialRoutedToolNames: input.ctx.initialRoutedToolNames,
      expandedRoutedToolNames: input.ctx.expandedRoutedToolNames,
      allowedTools: input.allowedTools,
    }),
    requiredToolEvidence: input.ctx.requiredToolEvidence,
    validationCode: input.validationCode,
  });
}

export function validateRequiredToolEvidence(input: {
  readonly ctx: ContractFlowContext;
}): {
  readonly contractValidation?: DelegationOutputValidationResult;
  readonly missingEvidenceMessage?: string;
} {
  const requiredToolEvidence = input.ctx.requiredToolEvidence;
  if (!requiredToolEvidence) {
    return {};
  }

  const responseContent =
    typeof input.ctx.response?.content === "string"
      ? input.ctx.response.content
      : "";
  const contractValidation = requiredToolEvidence.delegationSpec
    ? validateDelegatedOutputContract({
        spec: requiredToolEvidence.delegationSpec,
        output: responseContent,
        toolCalls: input.ctx.allToolCalls,
        providerEvidence: input.ctx.providerEvidence,
      })
    : undefined;
  const missingEvidenceMessage = contractValidation?.error ??
    getMissingSuccessfulToolEvidenceMessage(
      input.ctx.allToolCalls,
      requiredToolEvidence.delegationSpec,
      input.ctx.providerEvidence,
    );
  return {
    contractValidation,
    missingEvidenceMessage: missingEvidenceMessage ?? undefined,
  };
}

export function resolveCorrectionAllowedToolNames(
  activeRoutedToolNames: readonly string[],
  allowedTools?: ToolNameCollection,
): readonly string[] {
  if (allowedTools) {
    return [...allowedTools];
  }
  return getAllowedToolNamesForEvidence(
    activeRoutedToolNames,
    allowedTools,
  );
}

export function buildRequiredToolEvidenceRetryInstruction(input: {
  readonly missingEvidenceMessage: string;
  readonly validationCode?: DelegationOutputValidationCode;
  readonly allowedToolNames: readonly string[];
  readonly requiresAdditionalToolCalls?: boolean;
}): string {
  const requiresAdditionalToolCalls =
    input.requiresAdditionalToolCalls !== false;
  const allowedToolSummary = requiresAdditionalToolCalls &&
    input.allowedToolNames.length > 0
    ? ` Allowed tools: ${input.allowedToolNames.join(", ")}.`
    : "";
  const correctionLines = requiresAdditionalToolCalls
    ? [
      "Tool-grounded evidence is required for this delegated task.",
      "Before answering, call one or more allowed tools and base the answer on those results.",
      "Do not answer from memory or restate the plan.",
    ]
    : [
      "The required tool-grounded evidence is already present in this turn.",
      "Do not call additional tools for this retry.",
      "Re-emit the final answer only, grounded in the tools already executed.",
    ];
  if (
    input.validationCode === "low_signal_browser_evidence" ||
    /browser-grounded evidence/i.test(input.missingEvidenceMessage)
  ) {
    correctionLines.push(
      ...buildBrowserEvidenceRetryGuidance(input.allowedToolNames),
    );
  }
  if (
    input.validationCode === "expected_json_object" ||
    input.validationCode === "empty_structured_payload"
  ) {
    correctionLines.push(
      "Your final answer must be a single JSON object only, with no markdown fences or prose around it.",
    );
  }
  if (
    input.validationCode === "missing_file_mutation_evidence" ||
    /file creation\/edit evidence|file mutation tools/i.test(
      input.missingEvidenceMessage,
    )
  ) {
    correctionLines.push(
      "Create or edit the required files with the allowed file-mutation tools before answering, and name those files in the final output.",
    );
  }
  if (input.validationCode === "forbidden_phase_action") {
    correctionLines.push(
      "This phase explicitly forbids one or more actions such as install/build/test/typecheck/lint execution or banned dependency specifiers. Do not repeat them.",
    );
    correctionLines.push(
      "Limit the retry to the file-authoring or inspection work that belongs to this phase, and leave verification for the later step.",
    );
  }
  if (input.validationCode === "blocked_phase_output") {
    correctionLines.push(
      "Do not return a success-path answer that says the phase is blocked or cannot be completed.",
    );
    correctionLines.push(
      "Either fix the blocking issue with the allowed tools and verify the result, or let the failure surface instead of presenting a completed phase.",
    );
  }
  if (input.validationCode === "contradictory_completion_claim") {
    correctionLines.push(
      "Do not claim the phase is complete while also mentioning unresolved mismatches, placeholders, or needed follow-up.",
    );
    correctionLines.push(
      "If the latest allowed-tool evidence fixes the issue, re-emit a completion-only answer grounded in that evidence.",
    );
    correctionLines.push(
      "Report the phase as blocked only when the blocking issue still remains after the allowed tool work.",
    );
  }
  return (
    "Delegated output validation failed. " +
    `${input.missingEvidenceMessage}. ` +
    correctionLines.join(" ") +
    allowedToolSummary
  );
}

export function canRetryDelegatedOutputWithoutAdditionalToolCalls(input: {
  readonly validationCode?: DelegationOutputValidationCode;
  readonly toolCalls: readonly ToolCallRecord[];
  readonly delegationSpec?: DelegationContractSpec;
  readonly providerEvidence?: LLMProviderEvidence;
}): boolean {
  if (
    input.validationCode !== "expected_json_object" &&
    input.validationCode !== "empty_structured_payload" &&
    input.validationCode !== "blocked_phase_output"
  ) {
    return false;
  }

  if (
    input.validationCode === "blocked_phase_output" &&
    input.delegationSpec &&
    (
      specRequiresFileMutationEvidence(input.delegationSpec) ||
      specRequiresMeaningfulBrowserEvidence(input.delegationSpec)
    )
  ) {
    return false;
  }

  return !getMissingSuccessfulToolEvidenceMessage(
    input.toolCalls,
    input.delegationSpec,
    input.providerEvidence,
  );
}
