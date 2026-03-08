/**
 * Contract-driven runtime guidance for tool-heavy chat turns.
 *
 * This module keeps domain-specific steering policies out of ChatExecutor's
 * main tool loop. Add new contract resolvers here instead of branching inline
 * in ChatExecutor when another tool family needs similar staged execution.
 *
 * @module
 */

import type { ToolCallRecord } from "./chat-executor-types.js";
import type { LLMToolChoice } from "./types.js";
import type {
  DelegationContractSpec,
  DelegationOutputValidationCode,
} from "../utils/delegation-validation.js";
import {
  getMissingDoomEvidenceGap,
  inferDoomTurnContract,
  summarizeDoomToolEvidence,
} from "./chat-executor-doom.js";
import {
  resolveDelegatedCorrectionToolChoiceToolNames,
  resolveDelegatedInitialToolChoiceToolName,
} from "../utils/delegation-validation.js";

export type ToolContractGuidancePhase =
  | "initial"
  | "tool_followup"
  | "correction";

export interface ToolContractGuidanceContext {
  readonly phase: ToolContractGuidancePhase;
  readonly messageText: string;
  readonly toolCalls: readonly ToolCallRecord[];
  readonly allowedToolNames: readonly string[];
  readonly requiredToolEvidence?: {
    readonly delegationSpec?: DelegationContractSpec;
  };
  readonly validationCode?: DelegationOutputValidationCode;
}

export interface ToolContractGuidance {
  readonly source: string;
  readonly runtimeInstruction?: string;
  readonly routedToolNames?: readonly string[];
  readonly toolChoice: LLMToolChoice;
}

interface ToolContractGuidanceResolver {
  readonly name: string;
  readonly priority: number;
  resolve(input: ToolContractGuidanceContext): ToolContractGuidance | undefined;
}

const TOOL_CONTRACT_GUIDANCE_RESOLVERS: readonly ToolContractGuidanceResolver[] = [
  {
    name: "delegation-correction",
    priority: 300,
    resolve: resolveDelegationCorrectionContractGuidance,
  },
  {
    name: "doom",
    priority: 200,
    resolve: resolveDoomToolContractGuidance,
  },
  {
    name: "delegation-initial",
    priority: 100,
    resolve: resolveDelegationInitialContractGuidance,
  },
];

export function resolveToolContractGuidance(
  input: ToolContractGuidanceContext,
): ToolContractGuidance | undefined {
  for (const resolver of TOOL_CONTRACT_GUIDANCE_RESOLVERS) {
    const guidance = resolver.resolve(input);
    if (guidance) return guidance;
  }
  return undefined;
}

function resolveDoomToolContractGuidance(
  input: ToolContractGuidanceContext,
): ToolContractGuidance | undefined {
  const contract = inferDoomTurnContract(input.messageText);
  if (!contract) return undefined;

  const gap = getMissingDoomEvidenceGap(
    contract,
    summarizeDoomToolEvidence(input.toolCalls),
  );
  if (!gap) return undefined;

  const routedToolNames = gap.preferredToolNames.filter(
    (toolName) =>
      input.allowedToolNames.length === 0 ||
      input.allowedToolNames.includes(toolName),
  );

  return {
    source: "doom",
    runtimeInstruction: gap.message,
    ...(routedToolNames.length > 0 ? { routedToolNames } : {}),
    toolChoice: "required",
  };
}

function resolveDelegationInitialContractGuidance(
  input: ToolContractGuidanceContext,
): ToolContractGuidance | undefined {
  if (input.phase !== "initial") return undefined;

  const spec = input.requiredToolEvidence?.delegationSpec;
  if (!spec) return undefined;

  const preferredToolName = resolveDelegatedInitialToolChoiceToolName(
    spec,
    input.allowedToolNames,
  );
  if (!preferredToolName) return undefined;

  return {
    source: "delegation-initial",
    routedToolNames: [preferredToolName],
    toolChoice: "required",
  };
}

function resolveDelegationCorrectionContractGuidance(
  input: ToolContractGuidanceContext,
): ToolContractGuidance | undefined {
  if (input.phase !== "correction") return undefined;

  const spec = input.requiredToolEvidence?.delegationSpec;
  if (!spec) return undefined;

  const preferredToolNames = resolveDelegatedCorrectionToolChoiceToolNames(
    spec,
    input.allowedToolNames,
    input.validationCode,
  );
  if (preferredToolNames.length === 0) return undefined;

  return {
    source: "delegation-correction",
    routedToolNames: preferredToolNames,
    toolChoice: "required",
  };
}
