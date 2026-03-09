/**
 * Contract-guidance and required-evidence helpers for ChatExecutor.
 *
 * @module
 */

import type {
  DelegationOutputValidationCode,
  DelegationOutputValidationResult,
} from "../utils/delegation-validation.js";
import {
  getMissingSuccessfulToolEvidenceMessage,
  validateDelegatedOutputContract,
} from "../utils/delegation-validation.js";
import type { ExecutionContext } from "./chat-executor-types.js";
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
}): string {
  const allowedToolSummary = input.allowedToolNames.length > 0
    ? ` Allowed tools: ${input.allowedToolNames.join(", ")}.`
    : "";
  const correctionLines = [
    "Tool-grounded evidence is required for this delegated task.",
    "Before answering, call one or more allowed tools and base the answer on those results.",
    "Do not answer from memory or restate the plan.",
  ];
  if (
    input.validationCode === "low_signal_browser_evidence" ||
    /browser-grounded evidence/i.test(input.missingEvidenceMessage)
  ) {
    correctionLines.push(
      "Use concrete non-blank URLs or localhost targets with browser navigation plus snapshot/run_code. `browser_tabs` and about:blank state checks do not count.",
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
  return (
    "Delegated output validation failed. " +
    `${input.missingEvidenceMessage}. ` +
    correctionLines.join(" ") +
    allowedToolSummary
  );
}
