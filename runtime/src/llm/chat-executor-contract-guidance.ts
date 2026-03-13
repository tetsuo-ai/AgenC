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
  resolveDelegatedInitialToolChoiceToolNames,
  resolveDelegatedInitialToolChoiceToolName,
} from "../utils/delegation-validation.js";
import {
  TYPED_ARTIFACT_DOMAINS,
  inferTypedArtifactInspectionIntent,
  type TypedArtifactDomain,
} from "../tools/system/typed-artifact-domains.js";
import { extractExplicitImperativeToolNames } from "./chat-executor-explicit-tools.js";
import { getAcceptanceVerificationCategories } from "../utils/delegation-validation.js";

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
  /** When false, treat routedToolNames as a one-call override instead of sticky turn state. */
  readonly persistRoutedToolNames?: boolean;
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
    name: "explicit-tool-invocation",
    priority: 260,
    resolve: resolveExplicitToolInvocationContractGuidance,
  },
  {
    name: "server-handle",
    priority: 250,
    resolve: resolveServerHandleContractGuidance,
  },
  {
    name: "typed-artifact",
    priority: 225,
    resolve: resolveTypedArtifactContractGuidance,
  },
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

function resolveServerHandleContractGuidance(
  input: ToolContractGuidanceContext,
): ToolContractGuidance | undefined {
  if (!inferServerHandleTurn(input.messageText)) return undefined;

  const hasServerStart = input.toolCalls.some(
    (call) => call.name === "system.serverStart",
  );
  const hasServerVerification = input.toolCalls.some(
    (call) =>
      call.name === "system.serverStatus" || call.name === "system.serverResume",
  );

  if (!hasServerStart) {
    const routedToolNames = ["system.serverStart"].filter((toolName) =>
      input.allowedToolNames.length === 0 || input.allowedToolNames.includes(toolName)
    );
    if (routedToolNames.length === 0) return undefined;
    return {
      source: "server-handle",
      runtimeInstruction:
        "This durable server request must begin with `system.serverStart`. " +
        "Use the typed server handle path first, then verify readiness before answering.",
      routedToolNames,
      toolChoice: "required",
      enforcement: {
        mode: "block_other_tools",
        message:
          "This server turn must begin with `system.serverStart`. " +
          "Do not launch or probe the server with `desktop.bash`, `desktop.process_start`, `system.processStart`, or ad hoc shell commands before the typed server handle exists.",
      },
    };
  }

  if (!hasServerVerification) {
    const routedToolNames = ["system.serverStatus", "system.serverResume"].filter(
      (toolName) =>
        input.allowedToolNames.length === 0 ||
        input.allowedToolNames.includes(toolName),
    );
    if (routedToolNames.length === 0) return undefined;
    return {
      source: "server-handle",
      runtimeInstruction:
        "The server handle is started but not yet verified. " +
        "Call `system.serverStatus` (or `system.serverResume`) and confirm readiness before claiming the server is running.",
      routedToolNames,
      toolChoice: "required",
    };
  }

  return undefined;
}

function inferServerHandleTurn(messageText: string): boolean {
  const lower = messageText.toLowerCase();
  const mentionsServer =
    /\b(server|http server|http service|service)\b/.test(lower) ||
    lower.includes("server handle");
  if (!mentionsServer) return false;

  return (
    lower.includes("durable") ||
    lower.includes("typed server handle") ||
    lower.includes("keep it running") ||
    lower.includes("until i tell you to stop") ||
    lower.includes("until i say stop") ||
    lower.includes("verify it is ready") ||
    lower.includes("verify readiness") ||
    lower.includes("readiness") ||
    /\bport\s+\d+\b/.test(lower)
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

  const routedToolNames = resolvePreferredContractTools(
    gap.preferredToolNames,
    input.allowedToolNames,
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

function resolveExplicitToolInvocationContractGuidance(
  input: ToolContractGuidanceContext,
): ToolContractGuidance | undefined {
  if (input.phase !== "initial") return undefined;
  if (input.toolCalls.length > 0) return undefined;

  const routedToolNames = extractExplicitImperativeToolNames(
    input.messageText,
    input.allowedToolNames,
  );
  if (routedToolNames.length === 0) return undefined;

  const toolSummary = routedToolNames
    .map((toolName) => `\`${toolName}\``)
    .join(", ");
  const noun = routedToolNames.length === 1 ? "that tool" : "those tools";
  return {
    source: "explicit-tool-invocation",
    runtimeInstruction:
      `The user explicitly instructed this turn to call ${toolSummary}. ` +
      `Execute ${noun} before answering.`,
    routedToolNames,
    toolChoice: "required",
  };
}

function resolvePreferredContractTools(
  preferredToolNames: readonly string[],
  allowedToolNames: readonly string[],
): readonly string[] {
  for (const toolName of preferredToolNames) {
    if (
      allowedToolNames.length === 0 ||
      allowedToolNames.includes(toolName)
    ) {
      return [toolName];
    }
  }

  return preferredToolNames.filter(
    (toolName) => allowedToolNames.includes(toolName),
  );
}

function resolveTypedArtifactContractGuidance(
  input: ToolContractGuidanceContext,
): ToolContractGuidance | undefined {
  const contract = inferTypedArtifactContract(input);
  if (!contract) return undefined;

  const hasSuccessfulInfo = input.toolCalls.some(
    (call) => call.name === contract.infoToolName && !call.isError,
  );
  const hasSuccessfulDetail = input.toolCalls.some(
    (call) => call.name === contract.detailToolName && !call.isError,
  );
  const hasFailedRequiredCall = input.toolCalls.some(
    (call) =>
      (call.name === contract.infoToolName || call.name === contract.detailToolName) &&
      call.isError,
  );
  if (hasFailedRequiredCall) {
    return undefined;
  }

  if (!hasSuccessfulInfo) {
    const routedToolNames = [contract.infoToolName].filter(
      (toolName) =>
        input.allowedToolNames.length === 0 ||
        input.allowedToolNames.includes(toolName),
    );
    if (routedToolNames.length === 0) return undefined;
    return {
      source: contract.source,
      runtimeInstruction:
        `This ${contract.label} is not complete yet. ` +
        `Start with \`${contract.infoToolName}\` so the answer is grounded in real metadata before you summarize or quote details.`,
      routedToolNames,
      toolChoice: "required",
      enforcement: {
        mode: "block_other_tools",
        message:
          `This ${contract.label} must begin with \`${contract.infoToolName}\`. ` +
          "Do not use `desktop.bash`, `desktop.text_editor`, `system.bash`, or ad hoc file parsing before the typed inspection path starts.",
      },
    };
  }

  if (!hasSuccessfulDetail) {
    const routedToolNames = [contract.detailToolName].filter(
      (toolName) =>
        input.allowedToolNames.length === 0 ||
        input.allowedToolNames.includes(toolName),
    );
    if (routedToolNames.length === 0) return undefined;
    return {
      source: contract.source,
      runtimeInstruction:
        `Metadata alone is not enough for this ${contract.label}. ` +
        `Call \`${contract.detailToolName}\` before answering so the response includes grounded structured content, not just a metadata summary.`,
      routedToolNames,
      toolChoice: "required",
      enforcement: {
        mode: "block_other_tools",
        message:
          `This ${contract.label} still requires \`${contract.detailToolName}\`. ` +
          "Do not stop early or switch to shell/editor fallbacks while the typed read/extract step is still missing.",
      },
    };
  }

  return undefined;
}

function inferTypedArtifactContract(
  input: ToolContractGuidanceContext,
): TypedArtifactDomain | undefined {
  for (const contract of TYPED_ARTIFACT_DOMAINS) {
    if (!inferTypedArtifactInspectionIntent(input.messageText, contract)) {
      continue;
    }

    const hasAnyAllowedTool =
      input.allowedToolNames.length === 0 ||
      input.allowedToolNames.includes(contract.infoToolName) ||
      input.allowedToolNames.includes(contract.detailToolName);
    if (!hasAnyAllowedTool) continue;

    return contract;
  }
  return undefined;
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

  const routedToolNames = resolveDelegatedInitialToolChoiceToolNames(
    spec,
    input.allowedToolNames,
  );
  if (routedToolNames.length === 0) return undefined;

  const workspaceBootstrap =
    isDelegatedWorkspaceBootstrapPhase(spec);
  const fileAuthoringOnlyPhase =
    !workspaceBootstrap &&
    isDelegatedFileAuthoringPhaseWithoutVerification(spec);
  const shellFilteredToolNames = fileAuthoringOnlyPhase
    ? routedToolNames.filter(
        (toolName) =>
          toolName !== "system.bash" && toolName !== "desktop.bash",
      )
    : routedToolNames;
  const effectiveRoutedToolNames = workspaceBootstrap
    ? [preferredToolName]
    : shellFilteredToolNames.length > 0
      ? shellFilteredToolNames
      : routedToolNames;
  const usesFlexibleInitialSubset = effectiveRoutedToolNames.length > 1;
  const runtimeInstruction = usesFlexibleInitialSubset
    ? workspaceBootstrap
      ? "Bootstrap the delegated workspace before inspecting it. " +
        "If the delegated cwd does not exist yet, create the workspace root first or keep targeting that workspace via absolute paths until it exists. " +
        "After the workspace root exists, create or update the required files directly and use shell verification only after meaningful mutations."
      : fileAuthoringOnlyPhase
        ? "Start with the smallest grounded step that reduces uncertainty in the delegated contract. " +
          "Inspect the existing workspace state before mutating files when that will prevent avoidable rework, " +
          "then create or update the required files directly. Do not spend shell rounds on speculative build/test/runtime verification unless acceptance explicitly requires that evidence."
      : "Start with the smallest grounded step that reduces uncertainty in the delegated contract. " +
        "Inspect the existing workspace state before mutating files when that will prevent avoidable rework, " +
        "and use shell verification when build/test/install evidence is part of acceptance."
    : preferredToolName === "system.writeFile" ||
        preferredToolName === "system.appendFile"
      ? workspaceBootstrap
        ? "Begin by creating or updating files under the delegated workspace root. " +
          "If the delegated cwd does not exist yet, target that workspace via absolute paths instead of starting with shell inspection."
        : "Begin by creating or updating the required files from the delegated contract. " +
          "Do not spend the first tool round rediscovering the workspace with shell inspection."
      : undefined;

  return {
    source: "delegation-initial",
    runtimeInstruction,
    routedToolNames: effectiveRoutedToolNames,
    persistRoutedToolNames: false,
    toolChoice: "required",
  };
}

function isDelegatedFileAuthoringPhaseWithoutVerification(
  spec: DelegationContractSpec,
): boolean {
  if ((spec.lastValidationCode ?? "") === "acceptance_evidence_missing") {
    return false;
  }

  const acceptanceCriteria = spec.acceptanceCriteria ?? [];
  const acceptanceRequiresVerification = acceptanceCriteria.some(
    (criterion) => getAcceptanceVerificationCategories(criterion).length > 0,
  );
  if (acceptanceRequiresVerification) {
    return false;
  }

  const combined = [
    spec.task ?? "",
    spec.objective ?? "",
    spec.inputContract ?? "",
    ...acceptanceCriteria,
  ]
    .join(" ")
    .trim();
  if (combined.length === 0) {
    return false;
  }

  return !/\b(?:verify|verified|validation|test|tests|build|compile|coverage|lint|typecheck|install|stdout|stderr|exit code)\b/i.test(
    combined,
  );
}

function isDelegatedWorkspaceBootstrapPhase(
  spec: DelegationContractSpec,
): boolean {
  const stepText = [
    spec.task ?? "",
    spec.objective ?? "",
    spec.inputContract ?? "",
    ...(spec.acceptanceCriteria ?? []),
    ...(spec.contextRequirements ?? []),
  ]
    .join("\n")
    .toLowerCase();
  if (stepText.length === 0) return false;

  const hasSetupCue =
    /\b(?:setup|bootstrap|scaffold|initialize|initialise|init|create)\b/.test(
      stepText,
    );
  if (!hasSetupCue) return false;

  const hasEmptyWorkspaceCue =
    /\b(?:empty|new|missing)\s+(?:host\s+)?(?:dir|directory|workspace|project|repo|root)\b/.test(
      stepText,
    ) ||
    /\bfrom scratch\b/.test(stepText);
  const hasRootCreationCue =
    /\bcreate\s+(?:the\s+)?root\s+(?:dir|directory|workspace|project|repo|root)\b/.test(
      stepText,
    ) ||
    /\broot\s+(?:dir|directory|workspace|project|repo)\s+exists\b/.test(
      stepText,
    ) ||
    /\bpackage\s+dirs?\s+created\b/.test(stepText) ||
    /\bskeleton\s+package\.json\b/.test(stepText);
  const hasTargetRootCue =
    /^create\s+\/\S+/m.test(spec.objective ?? "") ||
    (spec.contextRequirements ?? []).some((entry) => entry.startsWith("cwd=/"));

  return hasTargetRootCue && (hasEmptyWorkspaceCue || hasRootCreationCue);
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
    persistRoutedToolNames: false,
    toolChoice: "required",
  };
}
