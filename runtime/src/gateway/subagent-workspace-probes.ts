/**
 * Workspace verification probes and package inspection for sub-agent
 * acceptance testing.
 *
 * Extracted from SubAgentOrchestrator — helpers that build acceptance probe
 * plans, inspect package authoring state, classify deterministic verification
 * commands, and detect workspace ecosystems (Node/Rust).
 *
 * @module
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import type {
  Pipeline,
  PipelinePlannerDeterministicStep,
  PipelinePlannerStep,
  PipelinePlannerSubagentStep,
} from "../workflow/pipeline.js";
import type { SubAgentResult } from "./sub-agent.js";
import { tokenizeShellCommand } from "../tools/system/command-line.js";
import { redactSensitiveData, normalizeDependencyArtifactPath } from "./subagent-context-curation.js";
import type {
  PipelinePlannerDeterministicStep as DeterministicStep,
} from "../workflow/pipeline.js";

function isNodeInstallPlannerStep(
  step: { stepType: string; tool?: string; args?: Record<string, unknown> },
): step is DeterministicStep {
  if (step.stepType !== "deterministic_tool") return false;
  const s = step as DeterministicStep;
  if (s.tool !== "system.bash" && s.tool !== "desktop.bash") return false;
  const command = typeof s.args.command === "string" ? s.args.command.trim().toLowerCase() : "";
  const commandArgs = Array.isArray(s.args.args)
    ? s.args.args.filter((v): v is string => typeof v === "string") : [];
  const firstArg = commandArgs[0]?.trim().toLowerCase() ?? "";
  if (!["npm", "pnpm", "yarn", "bun"].includes(command)) return false;
  if (command === "yarn" && firstArg.length === 0) return true;
  return ["install", "ci", "add"].includes(firstArg);
}
import {
  type AcceptanceProbeCategory,
  type AcceptanceProbePlan,
  type PackageAuthoringState,
  NODE_PACKAGE_TOOLING_RE,
  NODE_PACKAGE_MANIFEST_PATH_RE,
  NODE_WORKSPACE_AUTHORING_RE,
  RUST_WORKSPACE_TOOLING_RE,
  TEST_ARTIFACT_PATH_RE,
  SOURCE_ARTIFACT_PATH_RE,
  GENERATED_DECLARATION_PATH_RE,
  PLACEHOLDER_TEST_SCRIPT_RE,
  PACKAGE_AUTHORING_SCAN_SKIP_DIRS,
  PACKAGE_AUTHORING_MAX_SCAN_FILES,
} from "./subagent-orchestrator-types.js";
import { resolvePlannerStepWorkingDirectory } from "./subagent-failure-classification.js";

/* ------------------------------------------------------------------ */
/*  JSON / manifest helpers                                            */
/* ------------------------------------------------------------------ */

export function readJsonFileObject(path: string): Record<string, unknown> | undefined {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Best-effort acceptance probing should never crash orchestration.
  }
  return undefined;
}

export function readPackageManifest(
  packageDirectory: string,
): Record<string, unknown> | undefined {
  return readJsonFileObject(resolvePath(packageDirectory, "package.json"));
}

export function readPackageScripts(
  manifest: Record<string, unknown> | undefined,
): Partial<Record<AcceptanceProbeCategory, string>> | undefined {
  if (!manifest) return undefined;
  const rawScripts =
    manifest.scripts &&
    typeof manifest.scripts === "object" &&
    !Array.isArray(manifest.scripts)
      ? manifest.scripts as Record<string, unknown>
      : undefined;
  if (!rawScripts) return undefined;

  const scripts: Partial<Record<AcceptanceProbeCategory, string>> = {};
  for (const category of ["build", "typecheck", "lint", "test"] as const) {
    const value = rawScripts[category];
    if (typeof value === "string" && value.trim().length > 0) {
      scripts[category] = value.trim();
    }
  }
  return Object.keys(scripts).length > 0 ? scripts : undefined;
}

export function isWorkspaceRootManifest(manifestPath: string): boolean {
  const manifest = readJsonFileObject(manifestPath);
  if (!manifest) return false;
  return Array.isArray(manifest.workspaces) ||
    (
      manifest.workspaces !== undefined &&
      typeof manifest.workspaces === "object" &&
      !Array.isArray(manifest.workspaces)
    );
}

/* ------------------------------------------------------------------ */
/*  File-path and package-directory discovery                          */
/* ------------------------------------------------------------------ */

export function findNearestPackageDirectory(startDirectory: string): string | undefined {
  let current = resolvePath(startDirectory);
  while (true) {
    const manifestPath = resolvePath(current, "package.json");
    if (existsSync(manifestPath) && !isWorkspaceRootManifest(manifestPath)) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

export function resolvePackageDirectoryFromFilePath(
  filePath: string,
  delegatedWorkingDirectory?: string,
): string | undefined {
  const trimmed = filePath.trim();
  if (trimmed.length === 0) return undefined;
  if (!trimmed.startsWith("/") && !delegatedWorkingDirectory) {
    return undefined;
  }

  const absolutePath = trimmed.startsWith("/")
    ? resolvePath(trimmed)
    : resolvePath(delegatedWorkingDirectory!, trimmed);
  return findNearestPackageDirectory(dirname(absolutePath));
}

export function collectMutatedFilePaths(
  toolCalls: readonly SubAgentResult["toolCalls"][number][],
): readonly string[] {
  const paths: string[] = [];
  const pushPath = (value: unknown): void => {
    if (typeof value !== "string") return;
    const normalized = value.trim();
    if (normalized.length === 0 || paths.includes(normalized)) {
      return;
    }
    paths.push(normalized);
  };

  for (const toolCall of toolCalls) {
    if (
      !toolCall ||
      typeof toolCall !== "object" ||
      typeof toolCall.name !== "string"
    ) {
      continue;
    }
    const args =
      toolCall.args &&
      typeof toolCall.args === "object" &&
      !Array.isArray(toolCall.args)
        ? toolCall.args as Record<string, unknown>
        : undefined;
    if (!args) continue;

    if (
      toolCall.name === "system.writeFile" ||
      toolCall.name === "system.appendFile"
    ) {
      pushPath(args.path);
      continue;
    }

    if (toolCall.name !== "desktop.text_editor") {
      continue;
    }
    const action =
      typeof args.command === "string" ? args.command.trim().toLowerCase() : "";
    if (
      action === "create" ||
      action === "insert" ||
      action === "str_replace"
    ) {
      pushPath(args.filePath);
    }
  }

  return paths;
}

export function hasFileMutationToolCalls(
  toolCalls: readonly SubAgentResult["toolCalls"][number][],
): boolean {
  return collectMutatedFilePaths(toolCalls).length > 0;
}

export function collectAcceptanceProbePackageDirectories(
  toolCalls: SubAgentResult["toolCalls"],
  delegatedWorkingDirectory?: string,
): readonly string[] {
  const directories: string[] = [];
  const pushDirectory = (value: string | undefined): void => {
    const normalized = value?.trim().replace(/\\/g, "/");
    if (!normalized || directories.includes(normalized)) {
      return;
    }
    directories.push(normalized);
  };

  for (const filePath of collectMutatedFilePaths(toolCalls)) {
    pushDirectory(
      resolvePackageDirectoryFromFilePath(
        filePath,
        delegatedWorkingDirectory,
      ),
    );
  }

  if (
    directories.length === 0 &&
    delegatedWorkingDirectory &&
    hasFileMutationToolCalls(toolCalls)
  ) {
    pushDirectory(
      findNearestPackageDirectory(
        resolvePath(delegatedWorkingDirectory),
      ),
    );
  }

  return directories;
}

/* ------------------------------------------------------------------ */
/*  Acceptance test probe eligibility                                  */
/* ------------------------------------------------------------------ */

export function shouldRunAcceptanceTestProbe(
  step: PipelinePlannerSubagentStep,
  toolCalls: readonly SubAgentResult["toolCalls"][number][],
  testScript: string | undefined,
): boolean {
  if (!testScript || PLACEHOLDER_TEST_SCRIPT_RE.test(testScript)) {
    return false;
  }
  const stepText = [
    step.name,
    step.objective,
    step.inputContract,
    ...step.acceptanceCriteria,
    ...step.contextRequirements,
  ].join(" ");
  if (/\b(?:test|tests|vitest|jest|spec|coverage)\b/i.test(stepText)) {
    return true;
  }
  return collectMutatedFilePaths(toolCalls).some((path) =>
    TEST_ARTIFACT_PATH_RE.test(path)
  );
}

export function hasCompletedNodeInstallDependency(
  step: PipelinePlannerSubagentStep,
  pipeline: Pipeline,
): boolean {
  const plannerSteps = pipeline.plannerSteps ?? [];
  if (plannerSteps.length === 0) {
    return false;
  }
  const stepByName = new Map(
    plannerSteps.map((plannerStep) => [plannerStep.name, plannerStep]),
  );
  const queue = [...(step.dependsOn ?? [])];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const dependencyName = queue.shift();
    if (!dependencyName || visited.has(dependencyName)) continue;
    visited.add(dependencyName);
    const dependency = stepByName.get(dependencyName);
    if (!dependency) continue;
    if (isNodeInstallPlannerStep(dependency)) {
      return true;
    }
    for (const ancestor of dependency.dependsOn ?? []) {
      if (!visited.has(ancestor)) {
        queue.push(ancestor);
      }
    }
  }
  return false;
}

/* ------------------------------------------------------------------ */
/*  Deterministic verification classification                         */
/* ------------------------------------------------------------------ */

export function classifyDeterministicVerificationCategories(
  step: PipelinePlannerDeterministicStep,
): readonly AcceptanceProbeCategory[] {
  if (step.tool !== "system.bash" && step.tool !== "desktop.bash") {
    return [];
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
  const tokens = commandArgs.length > 0
    ? [command, ...commandArgs]
    : tokenizeShellCommand(command);
  const normalized = tokens
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0);
  if (normalized.length === 0) {
    return [];
  }

  const categories = new Set<AcceptanceProbeCategory>();
  const joined = normalized.join(" ");
  if (
    /\b(?:npm|pnpm|yarn|bun)\b.*\bbuild\b/.test(joined) ||
    /\bvite\b.*\bbuild\b/.test(joined) ||
    (
      /\btsc\b/.test(joined) &&
      !normalized.includes("--noemit")
    )
  ) {
    categories.add("build");
  }
  if (
    /\b(?:npm|pnpm|yarn|bun)\b.*\btypecheck\b/.test(joined) ||
    (
      /\btsc\b/.test(joined) &&
      normalized.includes("--noemit")
    )
  ) {
    categories.add("typecheck");
  }
  if (
    /\b(?:npm|pnpm|yarn|bun)\b.*\blint\b/.test(joined) ||
    /\beslint\b/.test(joined)
  ) {
    categories.add("lint");
  }
  if (
    /\b(?:npm|pnpm|yarn|bun)\b.*\btest\b/.test(joined) ||
    /\b(?:vitest|jest|pytest|mocha|ava)\b/.test(joined)
  ) {
    categories.add("test");
  }
  return [...categories];
}

export function collectReachableVerificationCategories(
  step: PipelinePlannerSubagentStep,
  pipeline: Pipeline,
): ReadonlySet<AcceptanceProbeCategory> {
  const plannerSteps = pipeline.plannerSteps ?? [];
  if (plannerSteps.length === 0) {
    return new Set();
  }

  const dependentsByName = new Map<string, PipelinePlannerStep[]>();
  for (const plannerStep of plannerSteps) {
    for (const dependencyName of plannerStep.dependsOn ?? []) {
      const dependents = dependentsByName.get(dependencyName) ?? [];
      dependents.push(plannerStep);
      dependentsByName.set(dependencyName, dependents);
    }
  }

  const categories = new Set<AcceptanceProbeCategory>();
  const queue = [...(dependentsByName.get(step.name) ?? [])];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current.name)) continue;
    visited.add(current.name);

    if (current.stepType === "deterministic_tool") {
      for (const category of classifyDeterministicVerificationCategories(
        current,
      )) {
        categories.add(category);
      }
    }

    for (const next of dependentsByName.get(current.name) ?? []) {
      if (!visited.has(next.name)) {
        queue.push(next);
      }
    }
  }

  return categories;
}

export function renderDeterministicCommandSummary(
  step: PipelinePlannerDeterministicStep,
): string {
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
  const rendered = [command, ...commandArgs].filter((value) => value.length > 0)
    .join(" ");
  return rendered.length > 0
    ? `\`${redactSensitiveData(rendered)}\``
    : `deterministic probe "${step.name}"`;
}

/* ------------------------------------------------------------------ */
/*  Acceptance probe plan builder                                      */
/* ------------------------------------------------------------------ */

export function buildSubagentAcceptanceProbePlans(
  step: PipelinePlannerSubagentStep,
  pipeline: Pipeline,
  toolCalls: SubAgentResult["toolCalls"],
): readonly AcceptanceProbePlan[] {
  if (!hasCompletedNodeInstallDependency(step, pipeline)) {
    return [];
  }

  const verificationCategories = collectReachableVerificationCategories(
    step,
    pipeline,
  );
  if (verificationCategories.size === 0) {
    return [];
  }

  const delegatedWorkingDirectory = resolvePlannerStepWorkingDirectory(
    step,
    pipeline,
  );
  const packageDirectories = collectAcceptanceProbePackageDirectories(
    toolCalls,
    delegatedWorkingDirectory?.path,
  );
  if (packageDirectories.length === 0) {
    return [];
  }

  const plans: AcceptanceProbePlan[] = [];
  const seenCommands = new Set<string>();
  const pushProbe = (
    category: AcceptanceProbeCategory,
    scriptName: string,
    cwd: string,
  ): void => {
    const stepName = `acceptance_probe_${category}_${plans.length + 1}`;
    const commandKey = `${cwd}::${scriptName}`;
    if (seenCommands.has(commandKey)) {
      return;
    }
    seenCommands.add(commandKey);
    plans.push({
      name: stepName,
      category,
      step: {
        name: stepName,
        stepType: "deterministic_tool",
        tool: "system.bash",
        args: {
          command: "npm",
          args: ["run", scriptName],
          cwd,
        },
        onError: "abort",
      },
    });
  };

  for (const packageDirectory of packageDirectories) {
    const manifest = readPackageManifest(packageDirectory);
    const scripts = readPackageScripts(manifest);
    if (!scripts) continue;

    if (verificationCategories.has("build") && scripts.build) {
      pushProbe("build", "build", packageDirectory);
    }
    if (verificationCategories.has("typecheck") && scripts.typecheck) {
      pushProbe("typecheck", "typecheck", packageDirectory);
    }
    if (verificationCategories.has("lint") && scripts.lint) {
      pushProbe("lint", "lint", packageDirectory);
    }
    if (
      verificationCategories.has("test") &&
      shouldRunAcceptanceTestProbe(step, toolCalls, scripts.test)
    ) {
      pushProbe("test", "test", packageDirectory);
    }
  }

  return plans;
}

/* ------------------------------------------------------------------ */
/*  Package authoring state inspection                                 */
/* ------------------------------------------------------------------ */

export function inspectPackageAuthoringState(
  packageDirectory: string,
  workspaceRoot: string,
): PackageAuthoringState | undefined {
  const absolutePackageDirectory = resolvePath(packageDirectory);
  const relativePackageDirectory = normalizeDependencyArtifactPath(
    absolutePackageDirectory,
    workspaceRoot,
  );
  if (relativePackageDirectory.length === 0) {
    return undefined;
  }

  const sourceDirectory = resolvePath(absolutePackageDirectory, "src");
  const relativeSourceDirectory = normalizeDependencyArtifactPath(
    sourceDirectory,
    workspaceRoot,
  );
  const sourceDirExists = existsSync(sourceDirectory);
  const pendingDirectories = [absolutePackageDirectory];
  let scannedFiles = 0;
  let sourceFileCount = 0;
  let testFileCount = 0;

  while (
    pendingDirectories.length > 0 &&
    scannedFiles < PACKAGE_AUTHORING_MAX_SCAN_FILES
  ) {
    const currentDirectory = pendingDirectories.shift();
    if (!currentDirectory) break;

    let entries: { name: string; isDirectory(): boolean; isFile(): boolean }[];
    try {
      entries = readdirSync(currentDirectory, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (scannedFiles >= PACKAGE_AUTHORING_MAX_SCAN_FILES) {
        break;
      }
      if (entry.isDirectory()) {
        if (!PACKAGE_AUTHORING_SCAN_SKIP_DIRS.has(entry.name)) {
          pendingDirectories.push(join(currentDirectory, entry.name));
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }

      scannedFiles += 1;
      const absolutePath = join(currentDirectory, entry.name);
      const relativePath = normalizeDependencyArtifactPath(
        absolutePath,
        workspaceRoot,
      );
      if (
        relativePath.length === 0 ||
        GENERATED_DECLARATION_PATH_RE.test(relativePath)
      ) {
        continue;
      }
      if (TEST_ARTIFACT_PATH_RE.test(relativePath)) {
        testFileCount += 1;
        continue;
      }
      if (
        relativePath.startsWith(`${relativePackageDirectory}/src/`) &&
        SOURCE_ARTIFACT_PATH_RE.test(relativePath)
      ) {
        sourceFileCount += 1;
      }
    }
  }

  return {
    relativePackageDirectory,
    relativeSourceDirectory,
    sourceDirExists,
    sourceFileCount,
    testFileCount,
  };
}

/* ------------------------------------------------------------------ */
/*  Workspace ecosystem detection                                      */
/* ------------------------------------------------------------------ */

export function scoreWorkspaceEcosystem(
  texts: readonly string[],
  patterns: readonly { pattern: RegExp; weight: number }[],
): number {
  return patterns.reduce((total, cue) => {
    const matched = texts.some((text) => cue.pattern.test(text));
    return matched ? total + cue.weight : total;
  }, 0);
}

export function resolveWorkspaceEcosystem(
  texts: readonly string[],
): "node" | "rust" | "unknown" {
  const normalized = texts
    .map((text) => text.trim())
    .filter((text) => text.length > 0);
  if (normalized.length === 0) {
    return "unknown";
  }

  const nodeScore = scoreWorkspaceEcosystem(normalized, [
    { pattern: NODE_PACKAGE_TOOLING_RE, weight: 4 },
    { pattern: NODE_PACKAGE_MANIFEST_PATH_RE, weight: 5 },
    { pattern: NODE_WORKSPACE_AUTHORING_RE, weight: 2 },
    { pattern: /\bworkspace:\*/i, weight: 3 },
  ]);
  const rustScore = scoreWorkspaceEcosystem(normalized, [
    { pattern: RUST_WORKSPACE_TOOLING_RE, weight: 4 },
    { pattern: /\bcargo\s+(?:build|check|run|test)\b/i, weight: 4 },
    { pattern: /\bcargo\s+.*\s--workspace\b/i, weight: 3 },
    { pattern: /(?:^|\/)(?:cargo\.toml|cargo\.lock)$/i, weight: 5 },
  ]);

  if (nodeScore > 0 && rustScore === 0) {
    return "node";
  }
  if (rustScore > 0 && nodeScore === 0) {
    return "rust";
  }
  if (nodeScore >= rustScore + 2) {
    return "node";
  }
  if (rustScore >= nodeScore + 2) {
    return "rust";
  }
  return "unknown";
}

export function isNodeWorkspaceRelevant(texts: readonly string[]): boolean {
  return resolveWorkspaceEcosystem(texts) === "node";
}

/* ------------------------------------------------------------------ */
/*  Workspace state guidance for prompts                               */
/* ------------------------------------------------------------------ */

export function collectPromptArtifactPackageDirectories(
  promptArtifactCandidates: readonly { path: string }[],
  workspaceRoot: string,
): readonly string[] {
  const directories: string[] = [];
  const pushDirectory = (value: string | undefined): void => {
    const normalized = value?.trim();
    if (!normalized || directories.includes(normalized)) {
      return;
    }
    directories.push(normalized);
  };

  for (const candidate of promptArtifactCandidates) {
    const packageDirectory = resolvePackageDirectoryFromFilePath(
      candidate.path,
      workspaceRoot,
    );
    pushDirectory(packageDirectory);
  }

  return directories;
}

export function buildWorkspaceStateGuidanceLines(
  step: PipelinePlannerSubagentStep,
  pipeline: Pipeline,
  promptArtifactCandidates: readonly { path: string }[],
  delegatedWorkingDirectory?: string,
): readonly string[] {
  if (
    typeof delegatedWorkingDirectory !== "string" ||
    delegatedWorkingDirectory.trim().length === 0
  ) {
    return [];
  }

  const workspaceRoot = resolvePath(delegatedWorkingDirectory);
  if (!existsSync(workspaceRoot)) {
    return [
      "The delegated workspace root does not exist yet. Create it before listing directories or writing phase files.",
    ];
  }
  const packageDirectories = collectPromptArtifactPackageDirectories(
    promptArtifactCandidates,
    workspaceRoot,
  );
  if (packageDirectories.length === 0) {
    return [];
  }

  const stepText = [
    step.name,
    step.objective,
    step.inputContract,
    ...step.acceptanceCriteria,
    ...step.contextRequirements,
  ].join(" ");
  const phaseMentionsTests =
    collectReachableVerificationCategories(step, pipeline).has("test") ||
    /\b(?:test|tests|vitest|jest|coverage|spec)\b/i.test(stepText);

  const lines: string[] = [];
  let missingSourceFiles = false;
  let missingTests = false;
  for (const packageDirectory of packageDirectories.slice(0, 3)) {
    const state = inspectPackageAuthoringState(
      packageDirectory,
      workspaceRoot,
    );
    if (!state) continue;

    if (state.sourceFileCount === 0) {
      lines.push(
        state.sourceDirExists
          ? `\`${state.relativeSourceDirectory}\` exists but has no authored source files yet.`
          : `\`${state.relativeSourceDirectory}\` does not exist yet.`,
      );
      missingSourceFiles = true;
    }
    if (phaseMentionsTests && state.testFileCount === 0) {
      lines.push(
        `No test files are present yet under \`${state.relativePackageDirectory}\` for this phase's test or coverage requirements.`,
      );
      missingTests = true;
    }
  }

  if (missingSourceFiles) {
    lines.push(
      "Execution ordering: author the missing source files for this phase before invoking any verification command.",
    );
  }
  if (missingTests) {
    lines.push(
      "If this phase owns test coverage, write the missing tests before invoking a test runner.",
    );
  }

  return lines.filter((line, index, entries) =>
    line.length > 0 && entries.indexOf(line) === index
  );
}
