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
  readonly enforcement?: {
    readonly mode: "block_other_tools";
    readonly message: string;
  };
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

export function resolveToolContractExecutionBlock(
  input: ToolContractGuidanceContext & {
    readonly candidateToolName: string;
  },
): string | undefined {
  const guidance = resolveToolContractGuidance(input);
  if (guidance?.enforcement?.mode !== "block_other_tools") {
    return undefined;
  }

  const requiredToolNames = guidance.routedToolNames ?? [];
  if (
    requiredToolNames.length === 0 ||
    requiredToolNames.includes(input.candidateToolName)
  ) {
    return undefined;
  }

  const requiredSummary = requiredToolNames
    .map((toolName) => `\`${toolName}\``)
    .join(", ");
  return (
    `${guidance.enforcement.message} ` +
    `Allowed now: ${requiredSummary}. ` +
    `Do not use \`${input.candidateToolName}\` yet.`
  );
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
  const enforcement =
    gap.code === "missing_launch"
      ? {
        mode: "block_other_tools" as const,
        message:
          "This Doom turn must begin with `mcp.doom.start_game`. " +
          "Do not launch or inspect Doom with `desktop.bash`, `desktop.process_start`, `system.bash`, or direct binary commands before the MCP launch succeeds.",
      }
      : gap.code === "missing_async_start"
      ? {
        mode: "block_other_tools" as const,
        message:
          "Continuous Doom play was requested, but the game is not yet running in async mode. " +
          "Restart it with `mcp.doom.start_game` and `async_player: true` before using other tools.",
      }
      : undefined;

  return {
    source: "doom",
    runtimeInstruction: gap.message,
    ...(routedToolNames.length > 0 ? { routedToolNames } : {}),
    toolChoice: "required",
    ...(enforcement ? { enforcement } : {}),
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
