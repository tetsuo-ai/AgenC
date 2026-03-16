/**
 * Sub-agent task prompt construction helpers.
 *
 * Extracted from SubAgentOrchestrator — functions that build retry task
 * prompts, collect dependency contexts, derive downstream requirement lines,
 * build workspace verification contract lines, derive delegation specs,
 * compute acceptance criteria, summarize parent requests, and handle
 * npm workspace analysis.
 *
 * @module
 */

import type {
  Pipeline,
  PipelinePlannerDeterministicStep,
  PipelinePlannerStep,
  PipelinePlannerSubagentStep,
} from "../workflow/pipeline.js";
import type { HostToolingProfile } from "./host-tooling.js";
import type {
  DelegationContractSpec,
  DelegationOutputValidationCode,
} from "../utils/delegation-validation.js";
import {
  specRequiresMeaningfulBrowserEvidence,
} from "../utils/delegation-validation.js";
import { buildBrowserEvidenceRetryGuidance } from "../utils/browser-tool-taxonomy.js";
import { tokenizeShellCommand } from "../tools/system/command-line.js";
import {
  type DependencyArtifactCandidate,
  type DependencyContextEntry,
  type SubagentContextDiagnostics,
  type SubagentFailureOutcome,
  SUBAGENT_ORCHESTRATION_SECTION_RE,
} from "./subagent-orchestrator-types.js";
import {
  redactSensitiveData,
  truncateText,
  extractTerms,
} from "./subagent-context-curation.js";
import {
  isNodeWorkspaceRelevant,
} from "./subagent-workspace-probes.js";

/* ------------------------------------------------------------------ */
/*  Parent request summarization                                       */
/* ------------------------------------------------------------------ */

export function summarizeParentRequestForSubagent(
  parentRequest: string,
  step: PipelinePlannerSubagentStep,
): string {
  const stripped = parentRequest
    .replace(SUBAGENT_ORCHESTRATION_SECTION_RE, "")
    .replace(/\s+/g, " ")
    .trim();
  const highLevelScope = stripped
    .split(/\bExecution rules:\b/i)[0]
    ?.trim();
  const base =
    highLevelScope && highLevelScope.length > 0
      ? highLevelScope
      : stripped.length > 0
        ? stripped
      : `Complete only the assigned ${step.name} phase of the parent request.`;
  return truncateText(
    `${base} Assigned phase only: ${step.name}. Ignore broader orchestration instructions and other phases.`,
    600,
  );
}

/* ------------------------------------------------------------------ */
/*  Dependency context collection                                      */
/* ------------------------------------------------------------------ */

export function collectDependencyContexts(
  step: PipelinePlannerSubagentStep,
  pipeline: Pipeline,
  results: Readonly<Record<string, string>>,
): readonly DependencyContextEntry[] {
  const plannerSteps = pipeline.plannerSteps ?? [];
  if (plannerSteps.length === 0 || (step.dependsOn?.length ?? 0) === 0) {
    return [];
  }

  const stepIndexByName = new Map(
    plannerSteps.map((plannerStep, index) => [plannerStep.name, index]),
  );
  const stepByName = new Map(
    plannerSteps.map((plannerStep) => [plannerStep.name, plannerStep]),
  );
  const queue = (step.dependsOn ?? []).map((dependencyName) => ({
    dependencyName,
    depth: 1,
  }));
  const visited = new Set<string>();
  const collected: DependencyContextEntry[] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    if (visited.has(current.dependencyName)) continue;
    visited.add(current.dependencyName);

    collected.push({
      dependencyName: current.dependencyName,
      result: results[current.dependencyName] ?? null,
      depth: current.depth,
      orderIndex:
        stepIndexByName.get(current.dependencyName) ?? Number.MAX_SAFE_INTEGER,
    });

    const dependencyStep = stepByName.get(current.dependencyName);
    if (!dependencyStep) continue;
    for (const ancestorName of dependencyStep.dependsOn ?? []) {
      if (!visited.has(ancestorName)) {
        queue.push({
          dependencyName: ancestorName,
          depth: current.depth + 1,
        });
      }
    }
  }

  return collected.sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    return a.orderIndex - b.orderIndex;
  });
}

/* ------------------------------------------------------------------ */
/*  Artifact relevance terms                                           */
/* ------------------------------------------------------------------ */

export function buildArtifactRelevanceTerms(
  step: PipelinePlannerSubagentStep,
): ReadonlySet<string> {
  const aggregate = [
    step.objective,
    step.inputContract,
    ...step.acceptanceCriteria,
    ...step.contextRequirements,
    ...step.requiredToolCapabilities,
  ].join(" ");
  return new Set(extractTerms(aggregate));
}

/* ------------------------------------------------------------------ */
/*  Downstream requirement lines                                       */
/* ------------------------------------------------------------------ */

export function summarizeDownstreamRequirementStep(
  step: PipelinePlannerStep,
): readonly string[] {
  if (step.stepType === "subagent_task") {
    const inputContract = step.inputContract.trim();
    if (inputContract.length === 0) {
      return [];
    }
    return [
      `\`${step.name}\` expects: ${redactSensitiveData(inputContract)}`,
    ];
  }

  if (step.stepType === "deterministic_tool") {
    const commandSummary = summarizeDeterministicVerificationStep(step);
    return commandSummary ? [commandSummary] : [];
  }

  return [];
}

export function summarizeDeterministicVerificationStep(
  step: PipelinePlannerDeterministicStep,
): string | undefined {
  if (step.tool !== "system.bash" && step.tool !== "desktop.bash") {
    return undefined;
  }

  const args =
    typeof step.args === "object" &&
      step.args !== null &&
      !Array.isArray(step.args)
      ? step.args as Record<string, unknown>
      : undefined;
  const command = typeof args?.command === "string" ? args.command.trim() : "";
  const commandArgs = Array.isArray(args?.args)
    ? args.args.filter((value): value is string => typeof value === "string")
    : [];
  const rendered = [command, ...commandArgs].filter((value) => value.length > 0).join(" ");
  if (rendered.length === 0) {
    return undefined;
  }
  const normalizedCommand = command.toLowerCase();
  const normalizedArgs = commandArgs.map((value) => value.toLowerCase());
  const looksLikeTestVerification =
    step.name.toLowerCase().includes("test") ||
    normalizedCommand === "vitest" ||
    normalizedCommand === "jest" ||
    normalizedArgs.includes("test");
  if (looksLikeTestVerification) {
    return "Later deterministic verification reruns the workspace test command in non-interactive single-run mode.";
  }

  return `Later deterministic verification runs \`${redactSensitiveData(rendered)}\`.`;
}

export function buildDownstreamRequirementLines(
  step: PipelinePlannerSubagentStep,
  pipeline: Pipeline,
): readonly string[] {
  const plannerSteps = pipeline.plannerSteps ?? [];
  if (plannerSteps.length === 0) {
    return [];
  }

  const dependentsByName = new Map<string, PipelinePlannerStep[]>();
  for (const plannerStep of plannerSteps) {
    for (const dependencyName of plannerStep.dependsOn ?? []) {
      const dependents = dependentsByName.get(dependencyName) ?? [];
      dependents.push(plannerStep);
      dependentsByName.set(dependencyName, dependents);
    }
  }

  const queue = (dependentsByName.get(step.name) ?? []).map((dependentStep) => ({
    dependentStep,
    depth: 1,
  }));
  const visited = new Set<string>();
  const lines: string[] = [];
  while (queue.length > 0 && lines.length < 4) {
    const current = queue.shift();
    if (!current) break;
    if (visited.has(current.dependentStep.name)) continue;
    visited.add(current.dependentStep.name);

    const summarized = summarizeDownstreamRequirementStep(
      current.dependentStep,
    );
    for (const line of summarized) {
      if (!lines.includes(line)) {
        lines.push(line);
      }
      if (lines.length >= 4) break;
    }
    if (lines.length >= 4) break;

    for (const nextDependent of dependentsByName.get(current.dependentStep.name) ?? []) {
      if (!visited.has(nextDependent.name)) {
        queue.push({
          dependentStep: nextDependent,
          depth: current.depth + 1,
        });
      }
    }
  }

  return lines;
}

/* ------------------------------------------------------------------ */
/*  Workspace verification contract lines                              */
/* ------------------------------------------------------------------ */

export function buildWorkspaceVerificationContractLines(
  step: PipelinePlannerSubagentStep,
  pipeline: Pipeline,
  delegatedWorkingDirectory?: string,
): readonly string[] {
  const downstreamRootScripts = collectDownstreamRootNpmScripts(
    step,
    pipeline,
    delegatedWorkingDirectory,
  );
  const stepTexts = [
    step.name,
    step.objective,
    step.inputContract,
    ...step.acceptanceCriteria,
    ...step.contextRequirements,
    pipeline.plannerContext?.parentRequest ?? "",
    ...downstreamRootScripts.map((script) => `npm run ${script}`),
  ];
  const relevant =
    downstreamRootScripts.length > 0 ||
    isNodeWorkspaceRelevant(stepTexts);
  if (!relevant) {
    return [];
  }

  if (downstreamRootScripts.length === 0) {
    return [];
  }

  return [
    "If this phase authors the root workspace manifest or scaffold, define the downstream root npm scripts now: " +
      downstreamRootScripts.map((script) => `\`${script}\``).join(", ") +
      ".",
    "Do not leave those root script definitions for a later implementation-only step when deterministic verification already depends on them.",
  ];
}

/* ------------------------------------------------------------------ */
/*  Delegation spec & acceptance criteria                              */
/* ------------------------------------------------------------------ */

export function buildEffectiveDelegationSpec(
  step: PipelinePlannerSubagentStep,
  pipeline: Pipeline,
  options: {
    readonly parentRequest?: string;
    readonly lastValidationCode?: DelegationOutputValidationCode;
    readonly delegatedWorkingDirectory?: string;
    readonly resolveHostToolingProfile?: () => HostToolingProfile | null;
  } = {},
): DelegationContractSpec {
  return {
    task: step.name,
    objective: step.objective,
    parentRequest: options.parentRequest,
    inputContract: step.inputContract,
    acceptanceCriteria: buildEffectiveAcceptanceCriteria(
      step,
      pipeline,
      options.delegatedWorkingDirectory,
      options.resolveHostToolingProfile,
    ),
    requiredToolCapabilities: step.requiredToolCapabilities,
    contextRequirements: step.contextRequirements,
    ...(options.lastValidationCode
      ? { lastValidationCode: options.lastValidationCode }
      : {}),
  };
}

export function buildEffectiveAcceptanceCriteria(
  step: PipelinePlannerSubagentStep,
  pipeline: Pipeline,
  delegatedWorkingDirectory?: string,
  resolveHostToolingProfile?: () => HostToolingProfile | null,
): readonly string[] {
  return [
    ...step.acceptanceCriteria,
    ...buildDerivedWorkspaceAcceptanceCriteria(
      step,
      pipeline,
      delegatedWorkingDirectory,
      resolveHostToolingProfile,
    ),
  ]
    .map((item) => item.trim())
    .filter((item, index, items) =>
      item.length > 0 && items.indexOf(item) === index
    );
}

export function buildDerivedWorkspaceAcceptanceCriteria(
  step: PipelinePlannerSubagentStep,
  pipeline: Pipeline,
  delegatedWorkingDirectory?: string,
  resolveHostToolingProfile?: () => HostToolingProfile | null,
): readonly string[] {
  const downstreamRootScripts = collectDownstreamRootNpmScripts(
    step,
    pipeline,
    delegatedWorkingDirectory,
  );
  const stepTexts = [
    step.name,
    step.objective,
    step.inputContract,
    ...step.acceptanceCriteria,
    ...step.contextRequirements,
    pipeline.plannerContext?.parentRequest ?? "",
    ...downstreamRootScripts.map((script) => `npm run ${script}`),
  ];
  const relevant =
    downstreamRootScripts.length > 0 ||
    isNodeWorkspaceRelevant(stepTexts);
  if (!relevant) {
    return [];
  }

  const criteria: string[] = [];
  if (downstreamRootScripts.length > 0) {
    criteria.push(
      `Root package.json authored with npm scripts for ${downstreamRootScripts.join(", ")}.`,
    );
  }
  if (stepAuthorsNodeWorkspaceManifestOrConfig(step, pipeline)) {
    criteria.push(
      "Buildable TypeScript workspace packages use package-local tsconfig/project references or equivalent so `npm run build --workspace=<workspace-name>` verifies the targeted package without compiling sibling packages.",
    );
  }

  if (isPreInstallNodeWorkspaceStep(step, pipeline)) {
    criteria.push(
      "No npm install/build/test/typecheck/lint commands executed or claimed in this phase.",
    );
    const profile = resolveHostToolingProfile?.();
    if (profile?.npm?.workspaceProtocolSupport === "unsupported") {
      criteria.push(
        "No `workspace:*` dependency specifiers used; use `file:` local dependency references instead.",
      );
    }
  }

  return criteria;
}

/* ------------------------------------------------------------------ */
/*  Node workspace authoring detection                                 */
/* ------------------------------------------------------------------ */

export function stepAuthorsNodeWorkspaceManifestOrConfig(
  step: PipelinePlannerSubagentStep,
  pipeline?: Pipeline,
): boolean {
  const combined = [
    step.name,
    step.objective,
    step.inputContract,
    ...step.acceptanceCriteria,
    ...step.contextRequirements,
  ].join(" ");
  const hasNodeWorkspaceCue = isNodeWorkspaceRelevant([
    combined,
    pipeline?.plannerContext?.parentRequest ?? "",
  ]);
  const hasManifestOrConfigTarget =
    /\b(?:manifest|config|package\.json|tsconfig(?:\.[a-z]+)?\.json|vite\.config(?:\.[a-z]+)?|vitest\.config(?:\.[a-z]+)?|readme|workspace|workspaces|dependencies|devdependencies|scripts?|bin)\b/i
      .test(combined);
  const hasAuthoringVerb =
    /\b(?:author|create|scaffold|write|update|define|configure|declare|add)\b/i
      .test(combined);
  return hasNodeWorkspaceCue &&
    hasManifestOrConfigTarget &&
    hasAuthoringVerb;
}

export function isPreInstallNodeWorkspaceStep(
  step: PipelinePlannerSubagentStep,
  pipeline: Pipeline,
): boolean {
  if (!hasReachableNodeInstallStep(step, pipeline)) {
    return false;
  }

  const combined = [
    step.name,
    step.objective,
    step.inputContract,
    ...step.acceptanceCriteria,
    ...step.contextRequirements,
  ].join(" ");
  return isNodeWorkspaceRelevant([combined]);
}

export function hasReachableNodeInstallStep(
  step: PipelinePlannerSubagentStep,
  pipeline: Pipeline,
): boolean {
  const plannerSteps = pipeline.plannerSteps ?? [];
  if (plannerSteps.length === 0) {
    return false;
  }
  const dependentsByName = new Map<string, PipelinePlannerStep[]>();
  for (const plannerStep of plannerSteps) {
    for (const dependency of plannerStep.dependsOn ?? []) {
      const dependents = dependentsByName.get(dependency) ?? [];
      dependents.push(plannerStep);
      dependentsByName.set(dependency, dependents);
    }
  }

  const queue = [...(dependentsByName.get(step.name) ?? [])];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current.name)) continue;
    visited.add(current.name);
    if (isNodeInstallPlannerStep(current)) {
      return true;
    }
    for (const dependent of dependentsByName.get(current.name) ?? []) {
      if (!visited.has(dependent.name)) {
        queue.push(dependent);
      }
    }
  }

  return false;
}

export function isNodeInstallPlannerStep(
  step: PipelinePlannerStep,
): step is PipelinePlannerDeterministicStep {
  if (step.stepType !== "deterministic_tool") {
    return false;
  }
  if (step.tool !== "system.bash" && step.tool !== "desktop.bash") {
    return false;
  }
  const command =
    typeof step.args.command === "string"
      ? step.args.command.trim().toLowerCase()
      : "";
  const commandArgs = Array.isArray(step.args.args)
    ? step.args.args.filter((value): value is string => typeof value === "string")
    : [];
  const firstArg = commandArgs[0]?.trim().toLowerCase() ?? "";
  if (!["npm", "pnpm", "yarn", "bun"].includes(command)) {
    return false;
  }
  if (command === "yarn" && firstArg.length === 0) {
    return true;
  }
  return ["install", "ci", "add"].includes(firstArg);
}

/* ------------------------------------------------------------------ */
/*  Downstream root npm scripts                                        */
/* ------------------------------------------------------------------ */

export function collectDownstreamRootNpmScripts(
  step: PipelinePlannerSubagentStep,
  pipeline: Pipeline,
  delegatedWorkingDirectory?: string,
): readonly string[] {
  const plannerSteps = pipeline.plannerSteps ?? [];
  const dependentsByName = new Map<string, PipelinePlannerStep[]>();
  for (const plannerStep of plannerSteps) {
    for (const dependency of plannerStep.dependsOn ?? []) {
      const dependents = dependentsByName.get(dependency) ?? [];
      dependents.push(plannerStep);
      dependentsByName.set(dependency, dependents);
    }
  }

  const queue = [...(dependentsByName.get(step.name) ?? [])];
  const visited = new Set<string>();
  const scripts: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current.name)) continue;
    visited.add(current.name);

    const scriptNames = current.stepType === "deterministic_tool"
      ? extractDownstreamRootNpmRunScripts(
        current,
        delegatedWorkingDirectory,
      )
      : [];
    for (const scriptName of scriptNames) {
      if (!scripts.includes(scriptName)) {
        scripts.push(scriptName);
      }
    }

    for (const next of dependentsByName.get(current.name) ?? []) {
      if (!visited.has(next.name)) {
        queue.push(next);
      }
    }
  }

  return scripts;
}

export function extractDownstreamRootNpmRunScripts(
  step: PipelinePlannerDeterministicStep,
  delegatedWorkingDirectory?: string,
): readonly string[] {
  if (step.tool !== "system.bash" && step.tool !== "desktop.bash") {
    return [];
  }

  const args =
    typeof step.args === "object" &&
      step.args !== null &&
      !Array.isArray(step.args)
      ? step.args as Record<string, unknown>
      : undefined;
  const cwd = typeof args?.cwd === "string" ? args.cwd.trim() : "";
  const normalizedDelegatedCwd = delegatedWorkingDirectory
    ? delegatedWorkingDirectory.replace(/\\/g, "/").replace(/\/+$/u, "")
    : "";
  const normalizedCommandCwd = cwd.replace(/\\/g, "/").replace(/\/+$/u, "");
  if (
    normalizedDelegatedCwd.length > 0 &&
    normalizedCommandCwd.length > 0 &&
    normalizedDelegatedCwd !== normalizedCommandCwd
  ) {
    return [];
  }

  const command = typeof args?.command === "string" ? args.command.trim() : "";
  const commandArgs = Array.isArray(args?.args)
    ? args.args.filter((value): value is string => typeof value === "string")
    : [];
  const tokens = commandArgs.length > 0
    ? [command, ...commandArgs]
    : tokenizeShellCommand(command);
  return collectRootNpmScriptsFromTokens(tokens);
}

export function collectRootNpmScriptsFromTokens(
  tokens: readonly string[],
): readonly string[] {
  if (tokens.length === 0) {
    return [];
  }

  const scripts: string[] = [];
  const pushScript = (scriptName: string | undefined) => {
    const normalized = scriptName?.trim();
    if (!normalized || normalized.startsWith("-")) {
      return;
    }
    if (!scripts.includes(normalized)) {
      scripts.push(normalized);
    }
  };

  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index]?.trim().toLowerCase();
    if (token !== "npm") {
      index += 1;
      continue;
    }

    index += 1;
    let rootScoped = true;
    while (index < tokens.length) {
      const current = tokens[index]?.trim();
      const normalized = current?.toLowerCase() ?? "";
      if (
        normalized === "&&" ||
        normalized === "||" ||
        normalized === ";" ||
        normalized === "|" ||
        normalized === "&"
      ) {
        break;
      }

      if (
        normalized === "--prefix" ||
        normalized === "-c" ||
        normalized === "--workspace" ||
        normalized === "-w" ||
        normalized.startsWith("--prefix=") ||
        normalized.startsWith("--workspace=")
      ) {
        rootScoped = false;
        if (
          normalized === "--prefix" ||
          normalized === "-c" ||
          normalized === "--workspace" ||
          normalized === "-w"
        ) {
          index += 1;
        }
        index += 1;
        continue;
      }

      if (normalized === "run") {
        if (rootScoped) {
          pushScript(tokens[index + 1]);
        }
        break;
      }

      if (normalized === "test") {
        if (rootScoped) {
          pushScript("test");
        }
        break;
      }

      index += 1;
    }

    while (index < tokens.length) {
      const current = tokens[index]?.trim().toLowerCase();
      if (
        current === "&&" ||
        current === "||" ||
        current === ";" ||
        current === "|" ||
        current === "&"
      ) {
        index += 1;
        break;
      }
      index += 1;
    }
  }

  return scripts;
}

/* ------------------------------------------------------------------ */
/*  Retry task prompt builder                                          */
/* ------------------------------------------------------------------ */

export function buildRetryTaskPrompt(
  currentTaskPrompt: string,
  step: PipelinePlannerSubagentStep,
  allowedTools: readonly string[],
  failure: SubagentFailureOutcome,
  retryAttempt: number,
  ): string {
    if (failure.failureClass !== "malformed_result_contract") {
      return currentTaskPrompt;
    }

    const corrections: string[] = [];
    if (failure.validationCode === "expected_json_object") {
      corrections.push(
        "Return a single JSON object only. Do not wrap it in markdown, code fences, prose, or bullet lists.",
      );
    }
    if (failure.validationCode === "empty_output") {
      corrections.push(
        "Do not return an empty reply. Produce the required deliverable with concrete evidence.",
      );
    }
    if (failure.validationCode === "low_signal_browser_evidence") {
      corrections.push(...buildBrowserEvidenceRetryGuidance(allowedTools));
    }
    if (failure.validationCode === "acceptance_evidence_missing") {
      corrections.push(
        "Do not just restate the acceptance criteria. Use allowed tools to directly verify the missing criteria and cite the observed evidence.",
      );
      if (
        specRequiresMeaningfulBrowserEvidence({
          task: step.name,
          objective: step.objective,
          inputContract: step.inputContract,
          acceptanceCriteria: step.acceptanceCriteria,
          requiredToolCapabilities: step.requiredToolCapabilities,
          contextRequirements: step.contextRequirements,
        })
      ) {
        corrections.push(...buildBrowserEvidenceRetryGuidance(allowedTools));
      }
      if (
        /\b(?:compile|compiles|compiled|compiling|build|test|verify|validated?|output(?:\s+format)?|stdout|stderr|exit(?:\s+code|s)?)\b/i.test(
          [
            step.objective,
            step.inputContract,
            ...(step.acceptanceCriteria ?? []),
          ]
            .filter((value): value is string =>
              typeof value === "string" && value.length > 0
            )
            .join(" "),
        ) &&
        allowedTools.some((toolName) =>
          toolName === "desktop.bash" || toolName === "system.bash"
        )
      ) {
        corrections.push(
          "If the acceptance criteria mention compile/build/test/output behavior, run the relevant shell command(s) and report the observed result instead of rewriting the file again.",
        );
      }
    }
    if (failure.validationCode === "forbidden_phase_action") {
      corrections.push(
        "Do not execute or claim commands that this phase explicitly forbids, including install/build/test/typecheck/lint verification or banned dependency specifiers.",
      );
      corrections.push(
        "Stay within the file-authoring or inspection contract for this phase and leave verification for the later step.",
      );
    }
    if (failure.validationCode === "acceptance_probe_failed") {
      corrections.push(
        "A parent-side deterministic acceptance probe failed after your edits. Fix the cited package/workspace compatibility issue in the authored files before answering again.",
      );
      corrections.push(
        "Do not guess or restate success. Ground the retry in the concrete probe failure details.",
      );
      corrections.push(
        `Probe failure details: ${redactSensitiveData(failure.message)}`,
      );
      if (
        step.acceptanceCriteria.some((criterion) =>
          /\bno npm install\/build\/test\/typecheck\/lint commands executed or claimed in this phase\b/i
            .test(criterion)
        )
      ) {
        corrections.push(
          "Do not run install/build/test/typecheck/lint yourself if this phase forbids it; repair the files and let the parent acceptance probe re-run.",
        );
      }
    }
    if (failure.validationCode === "blocked_phase_output") {
      corrections.push(
        "Do not present the phase as successful if your own output says it is blocked or cannot be completed.",
      );
      corrections.push(
        "Only return a completed phase after fixing and verifying the blocking issue with the allowed tools.",
      );
    }
    if (failure.validationCode === "contradictory_completion_claim") {
      corrections.push(
        "Do not claim the phase is complete while also mentioning unresolved mismatches, placeholders, or follow-up work.",
      );
      corrections.push(
        "Fix and verify the issue with the allowed tools first. If the issue remains unresolved, report the phase as blocked instead of successful.",
      );
    }
    if (
      step.requiredToolCapabilities.length > 0 ||
      /tool-grounded evidence|no tool calls|all child tool calls failed/i.test(
        failure.message,
      )
    ) {
      corrections.push(
        `You must invoke one or more of the allowed tools before answering. Allowed tools: ${allowedTools.join(", ") || "none"}. Do not answer from memory.`,
      );
    }
    if (/file creation\/edit evidence|file mutation tools/i.test(failure.message)) {
      corrections.push(
        "You must create or edit the required files using allowed tools and identify those files in the output.",
      );
    }
    if (/identify any files/i.test(failure.message)) {
      corrections.push(
        "Your output must explicitly name the files you created or modified.",
      );
    }

    if (corrections.length === 0) {
      corrections.push(
        `The previous attempt for step "${step.name}" violated the delegated output contract. Re-run the phase and satisfy the stated input contract and acceptance criteria exactly.`,
      );
    }

    return `${currentTaskPrompt}\n\nRetry corrections (attempt ${retryAttempt}):\n${corrections.map((entry) => `- ${entry}`).join("\n")}`;
  }

/* ------------------------------------------------------------------ */
/*  Host tooling prompt section                                        */
/* ------------------------------------------------------------------ */

export function buildHostToolingPromptSection(
  step: PipelinePlannerSubagentStep,
  pipeline: Pipeline,
  dependencyArtifactCandidates: readonly DependencyArtifactCandidate[],
  resolveHostToolingProfile: () => HostToolingProfile | null,
): {
  lines: readonly string[];
  diagnostics: SubagentContextDiagnostics["hostTooling"];
} {
  const stepTexts = [
    step.name,
    step.objective,
    step.inputContract,
    ...step.acceptanceCriteria,
    ...step.contextRequirements,
    pipeline.plannerContext?.parentRequest ?? "",
    ...dependencyArtifactCandidates.map((candidate) => candidate.path),
  ];
  const relevant = isNodeWorkspaceRelevant(stepTexts);
  if (!relevant) {
    return {
      lines: [],
      diagnostics: {
        included: false,
        reason: "not_relevant",
      },
    };
  }

  const profile = resolveHostToolingProfile();
  if (!profile) {
    return {
      lines: [],
      diagnostics: {
        included: false,
        reason: "profile_unavailable",
      },
    };
  }

  const diagnostics: SubagentContextDiagnostics["hostTooling"] = {
    included: true,
    reason: "node_package_tooling",
    nodeVersion: profile.nodeVersion,
    ...(profile.npm?.version ? { npmVersion: profile.npm.version } : {}),
    ...(profile.npm?.workspaceProtocolSupport
      ? { npmWorkspaceProtocolSupport: profile.npm.workspaceProtocolSupport }
      : {}),
    ...(profile.npm?.workspaceProtocolEvidence
      ? { npmWorkspaceProtocolEvidence: profile.npm.workspaceProtocolEvidence }
      : {}),
  };
  const lines = [`Host Node version: \`${profile.nodeVersion}\`.`];

  if (profile.npm?.version) {
    lines.push(`Host npm version: \`${profile.npm.version}\`.`);
  }
  lines.push(
    "Project-local CLIs such as `tsc`, `vite`, `vitest`, and `eslint` are not guaranteed to be on the host PATH. Prefer `npm run <script>`, `npx <bin>`, or `npm exec -- <bin>` from the correct cwd instead of assuming bare executables exist.",
  );
  lines.push(
    "For npm workspaces, use `npm run <script> --workspaces` to fan out or `npm run <script> --workspace=<workspace-name>` with a real workspace name. Do not use globbed selectors such as `--workspace=packages/*`.",
  );
  lines.push(
    "For TypeScript monorepos, prefer a package-local `tsconfig.json` (or project references) for each buildable package so `npm run build --workspace=<workspace-name>` verifies the targeted package without compiling sibling package source globs.",
  );
  if (profile.npm?.workspaceProtocolSupport === "unsupported") {
    const evidence = profile.npm.workspaceProtocolEvidence
      ? ` (${redactSensitiveData(profile.npm.workspaceProtocolEvidence)})`
      : "";
    lines.push(
      "Empirical npm probe: local `workspace:*` dependency specifiers are unsupported on this host" +
        `${evidence}.`,
    );
    lines.push(
      "Do not rely on `workspace:*` in generated manifests. Choose a host-compatible local dependency reference and verify it with `npm install` on this host before proceeding.",
    );
  } else if (profile.npm?.workspaceProtocolSupport === "unknown") {
    const evidence = profile.npm.workspaceProtocolEvidence
      ? ` (${redactSensitiveData(profile.npm.workspaceProtocolEvidence)})`
      : "";
    lines.push(
      "Empirical npm probe could not confirm whether local `workspace:*` dependency specifiers work on this host" +
        `${evidence}. Verify the manifest with a real install before depending on workspace protocol semantics.`,
    );
  } else if (profile.npm?.workspaceProtocolSupport === "supported") {
    lines.push(
      "Empirical npm probe: local `workspace:*` dependency specifiers are supported on this host.",
    );
  }

  return { lines, diagnostics };
}

/* ------------------------------------------------------------------ */
/*  Parent policy allowlist                                            */
/* ------------------------------------------------------------------ */

export function resolveParentPolicyAllowlist(
  pipeline: Pipeline,
  allowedParentTools: ReadonlySet<string>,
): readonly string[] {
  const plannerContextAllowed =
    pipeline.plannerContext?.parentAllowedTools
      ?.map((name) => name.trim())
      .filter((name) => name.length > 0) ?? [];
  if (plannerContextAllowed.length > 0) return plannerContextAllowed;
  if (allowedParentTools.size > 0) {
    return [...allowedParentTools];
  }
  return [];
}
