/**
 * Shared repository-guide generation for Codex-style repo-guide scaffolding.
 *
 * AgenC uses a deterministic repository snapshot instead of a live model call,
 * but the section layout mirrors Codex's `/init` output target: short,
 * actionable contributor guidance rooted in the current workspace.
 *
 * @module
 */

import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";

export const REPOSITORY_GUIDELINES_FILENAME = "AGENC.md";
export const PROJECT_GUIDE_FILE_NAME = REPOSITORY_GUIDELINES_FILENAME;

const TOP_LEVEL_EXCLUDES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "target",
  ".next",
  ".turbo",
  ".cache",
]);
const KNOWN_TEST_DIRS = new Set([
  "test",
  "tests",
  "__tests__",
  "spec",
  "specs",
]);
const COMMAND_SCRIPT_ORDER = [
  "build",
  "test",
  "test:fast",
  "test:unit",
  "lint",
  "typecheck",
  "check",
  "dev",
  "start",
] as const;
const KNOWN_MANIFESTS = [
  "package.json",
  "pnpm-workspace.yaml",
  "Cargo.toml",
  "pyproject.toml",
  "go.mod",
  "Makefile",
  "docker-compose.yml",
] as const;

type PackageManager = "npm" | "pnpm" | "yarn" | "bun";
type CommitStyle = "conventional" | "generic" | "unknown";

export interface RepositoryCommandHint {
  readonly command: string;
  readonly description: string;
}

export interface RepositorySnapshot {
  readonly rootPath: string;
  readonly topDirectories: readonly string[];
  readonly topFiles: readonly string[];
  readonly manifests: readonly string[];
  readonly packageManager?: PackageManager;
  readonly languages: readonly string[];
  readonly styleTools: readonly string[];
  readonly testingFrameworks: readonly string[];
  readonly testLocations: readonly string[];
  readonly commands: readonly RepositoryCommandHint[];
  readonly commitStyle: CommitStyle;
}

export interface InitRepositoryGuidelinesOptions {
  readonly rootPath: string;
  readonly force?: boolean;
}

export interface InitRepositoryGuidelinesResult {
  readonly status: "created" | "overwritten" | "skipped";
  readonly rootPath: string;
  readonly outputPath: string;
  readonly content: string;
  readonly snapshot: RepositorySnapshot;
}

export type ProjectGuideSnapshot = RepositorySnapshot;

export interface WriteProjectGuideOptions {
  readonly force?: boolean;
}

export interface WriteProjectGuideResult {
  readonly filePath: string;
  readonly status: "created" | "updated" | "skipped";
  readonly content: string;
  readonly snapshot: ProjectGuideSnapshot;
}

interface InspectRepositoryDeps {
  readonly listRecentCommitSubjects?: (
    rootPath: string,
  ) => readonly string[] | Promise<readonly string[]>;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort((left, right) =>
    left.localeCompare(right),
  );
}

function topLevelNameList(input: readonly string[], max = 6): string[] {
  return input.slice(0, max);
}

function formatPathList(input: readonly string[]): string {
  return input.map((value) => `\`${value}\``).join(", ");
}

function pathExists(path: string): Promise<boolean> {
  return access(path, constants.F_OK)
    .then(() => true)
    .catch(() => false);
}

function inferPackageManager(fileNames: readonly string[]): PackageManager | undefined {
  if (fileNames.includes("pnpm-lock.yaml")) return "pnpm";
  if (fileNames.includes("yarn.lock")) return "yarn";
  if (fileNames.includes("bun.lockb") || fileNames.includes("bun.lock")) {
    return "bun";
  }
  if (fileNames.includes("package-lock.json") || fileNames.includes("package.json")) {
    return "npm";
  }
  return undefined;
}

function formatPackageScriptCommand(
  scriptName: string,
  packageManager: PackageManager,
): string {
  if (packageManager === "npm") {
    return scriptName === "test" ? "npm test" : `npm run ${scriptName}`;
  }
  if (packageManager === "yarn") {
    return scriptName === "test" ? "yarn test" : `yarn ${scriptName}`;
  }
  if (packageManager === "pnpm") {
    return scriptName === "test" ? "pnpm test" : `pnpm ${scriptName}`;
  }
  return scriptName === "test" ? "bun test" : `bun run ${scriptName}`;
}

function commandDescription(scriptName: string): string {
  switch (scriptName) {
    case "build":
      return "build the project artifacts";
    case "test":
      return "run the default automated test suite";
    case "test:fast":
      return "run the fast or smoke-style test suite";
    case "test:unit":
      return "run unit-focused tests";
    case "lint":
      return "run the configured linter";
    case "typecheck":
      return "run static type checking";
    case "check":
      return "run aggregate validation checks";
    case "dev":
      return "start the local development workflow";
    case "start":
      return "run the primary app or service entrypoint";
    default:
      return `run the \`${scriptName}\` script`;
  }
}

function inferCommitStyle(subjects: readonly string[]): CommitStyle {
  if (subjects.length === 0) return "unknown";
  const conventionalCount = subjects.filter((subject) =>
    /^[a-z]+(?:\([^)]+\))?!?:\s+\S/i.test(subject.trim()),
  ).length;
  return conventionalCount / subjects.length >= 0.6 ? "conventional" : "generic";
}

function readRecentCommitSubjects(rootPath: string): readonly string[] {
  const result = spawnSync(
    "git",
    ["-C", rootPath, "log", "-n", "12", "--format=%s"],
    {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  if (result.status !== 0 || typeof result.stdout !== "string") {
    return [];
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function packageRecord(
  value: unknown,
): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

async function readPackageJson(rootPath: string): Promise<Record<string, unknown> | null> {
  const filePath = join(rootPath, "package.json");
  if (!(await pathExists(filePath))) {
    return null;
  }
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function inspectRepository(
  rootPath: string,
  deps: InspectRepositoryDeps = {},
): Promise<RepositorySnapshot> {
  const resolvedRoot = resolvePath(rootPath);
  const stats = await lstat(resolvedRoot);
  if (!stats.isDirectory()) {
    throw new Error(`init target must be a directory: ${resolvedRoot}`);
  }

  const entries = await readdir(resolvedRoot, { withFileTypes: true });
  const visibleEntries = entries
    .filter((entry) => !TOP_LEVEL_EXCLUDES.has(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));

  const topDirectories = visibleEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${entry.name}/`);
  const topFiles = visibleEntries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  const manifests = KNOWN_MANIFESTS.filter((name) => topFiles.includes(name));
  const packageManager = inferPackageManager(topFiles);

  const packageJson = await readPackageJson(resolvedRoot);
  const packageScripts = packageRecord(packageJson?.scripts);
  const packageDeps = uniqueSorted([
    ...Object.keys(packageRecord(packageJson?.dependencies)),
    ...Object.keys(packageRecord(packageJson?.devDependencies)),
  ]);

  const commands: RepositoryCommandHint[] = [];
  if (packageManager) {
    for (const scriptName of COMMAND_SCRIPT_ORDER) {
      if (packageScripts[scriptName] === undefined) continue;
      commands.push({
        command: formatPackageScriptCommand(scriptName, packageManager),
        description: commandDescription(scriptName),
      });
    }
  }
  if (manifests.includes("Cargo.toml")) {
    commands.push(
      {
        command: "cargo build",
        description: "compile Rust crates from the workspace root",
      },
      {
        command: "cargo test",
        description: "run the Rust test suite",
      },
    );
  }
  if (manifests.includes("Makefile")) {
    commands.push({
      command: "make <target>",
      description: "run repository-defined make targets when they exist",
    });
  }

  const languages = uniqueSorted([
    ...(packageJson ? ["JavaScript/TypeScript"] : []),
    ...(manifests.includes("Cargo.toml") ? ["Rust"] : []),
    ...(manifests.includes("pyproject.toml") ? ["Python"] : []),
    ...(manifests.includes("go.mod") ? ["Go"] : []),
  ]);

  const styleTools = uniqueSorted([
    ...(packageDeps.includes("typescript") ? ["TypeScript type checking"] : []),
    ...(packageDeps.includes("eslint") ? ["ESLint"] : []),
    ...(packageDeps.includes("prettier") ? ["Prettier"] : []),
    ...(packageDeps.includes("biome") ? ["Biome"] : []),
    ...(manifests.includes("Cargo.toml") ? ["rustfmt", "clippy"] : []),
  ]);

  const testingFrameworks = uniqueSorted([
    ...(packageDeps.includes("vitest") ? ["Vitest"] : []),
    ...(packageDeps.includes("jest") ? ["Jest"] : []),
    ...(packageDeps.includes("mocha") ? ["Mocha"] : []),
    ...(packageDeps.includes("playwright") ? ["Playwright"] : []),
    ...(manifests.includes("Cargo.toml") ? ["cargo test"] : []),
  ]);

  const testLocations = uniqueSorted([
    ...topDirectories
      .filter((directory) =>
        KNOWN_TEST_DIRS.has(directory.slice(0, -1).toLowerCase()),
      )
      .map((directory) => directory),
    ...(Object.keys(packageScripts).some((name) => name.startsWith("test"))
      ? ["package-manager test scripts"]
      : []),
  ]);

  const commitSubjects = uniqueSorted(
    await Promise.resolve(
      deps.listRecentCommitSubjects?.(resolvedRoot) ??
        readRecentCommitSubjects(resolvedRoot),
    ),
  );

  return {
    rootPath: resolvedRoot,
    topDirectories,
    topFiles,
    manifests,
    packageManager,
    languages,
    styleTools,
    testingFrameworks,
    testLocations,
    commands,
    commitStyle: inferCommitStyle(commitSubjects),
  };
}

export function buildRepositoryGuidelines(snapshot: RepositorySnapshot): string {
  const lines: string[] = ["# Repository Guidelines", ""];

  lines.push("## Project Structure & Module Organization");
  if (snapshot.topDirectories.length > 0) {
    lines.push(
      `- Top-level directories: ${formatPathList(topLevelNameList(snapshot.topDirectories))}. Add new code in the closest existing feature or package folder instead of creating parallel one-off roots.`,
    );
  } else {
    lines.push(
      "- Keep source, tests, and docs grouped by feature so contributors can trace a change without hunting across the tree.",
    );
  }
  if (snapshot.manifests.length > 0) {
    lines.push(
      `- Root manifests/config to check first: ${formatPathList(snapshot.manifests)}.`,
    );
  }
  if (snapshot.topFiles.length > 0) {
    lines.push(
      `- Important root files: ${formatPathList(topLevelNameList(snapshot.topFiles.filter((file) => !snapshot.manifests.includes(file)), 4))}.`,
    );
  }
  lines.push("");

  lines.push("## Build, Test, and Development Commands");
  if (snapshot.commands.length > 0) {
    for (const hint of snapshot.commands.slice(0, 6)) {
      lines.push(`- \`${hint.command}\`: ${hint.description}.`);
    }
  } else {
    lines.push(
      "- Document and prefer the repository's existing build/test entrypoints from the root manifest or task runner before inventing new scripts.",
    );
  }
  lines.push("");

  lines.push("## Coding Style & Naming Conventions");
  if (snapshot.languages.length > 0) {
    lines.push(
      `- Primary languages: ${snapshot.languages.join(", ")}. Match the style of surrounding files and keep edits local to the relevant module.`,
    );
  } else {
    lines.push(
      "- Follow the formatting and naming patterns already present in touched files; avoid opportunistic style rewrites.",
    );
  }
  if (snapshot.styleTools.length > 0) {
    lines.push(
      `- Quality tools detected: ${snapshot.styleTools.join(", ")}. Run the applicable checks before handing work off.`,
    );
  }
  lines.push("");

  lines.push("## Testing Guidelines");
  if (snapshot.testingFrameworks.length > 0) {
    lines.push(
      `- Test frameworks/tooling: ${snapshot.testingFrameworks.join(", ")}.`,
    );
  }
  if (snapshot.testLocations.length > 0) {
    lines.push(
      `- Existing test entrypoints/locations: ${snapshot.testLocations.map((value) => `\`${value}\``).join(", ")}.`,
    );
  }
  lines.push(
    "- Add regression coverage for behavior changes and prefer the narrowest test command that exercises the touched area before running full-suite checks.",
  );
  lines.push("");

  lines.push("## Commit & Pull Request Guidelines");
  if (snapshot.commitStyle === "conventional") {
    lines.push(
      "- Use Conventional Commits when writing subjects (for example `feat(scope): summary` or `fix(scope): summary`).",
    );
  } else {
    lines.push(
      "- Keep commit subjects short, imperative, and consistent with the existing git history for this repository.",
    );
  }
  lines.push(
    "- Pull requests should describe the user-visible change, list validation performed, and call out config, migration, or rollout risk when applicable.",
  );

  return lines.join("\n");
}

export function renderProjectGuide(snapshot: ProjectGuideSnapshot): string {
  return buildRepositoryGuidelines(snapshot);
}

export async function initRepositoryGuidelines(
  options: InitRepositoryGuidelinesOptions,
  deps: InspectRepositoryDeps = {},
): Promise<InitRepositoryGuidelinesResult> {
  const rootPath = resolvePath(options.rootPath);
  const outputPath = join(rootPath, REPOSITORY_GUIDELINES_FILENAME);
  const snapshot = await inspectRepository(rootPath, deps);
  const content = buildRepositoryGuidelines(snapshot);
  const exists = await pathExists(outputPath);

  if (exists && options.force !== true) {
    return {
      status: "skipped",
      rootPath,
      outputPath,
      content,
      snapshot,
    };
  }

  await writeFile(outputPath, content, "utf-8");

  return {
    status: exists ? "overwritten" : "created",
    rootPath,
    outputPath,
    content,
    snapshot,
  };
}

export async function inspectProjectGuideWorkspace(
  rootPath: string,
  deps: InspectRepositoryDeps = {},
): Promise<ProjectGuideSnapshot> {
  return inspectRepository(rootPath, deps);
}

export async function writeProjectGuide(
  rootPath: string,
  options: WriteProjectGuideOptions = {},
  deps: InspectRepositoryDeps = {},
): Promise<WriteProjectGuideResult> {
  const result = await initRepositoryGuidelines(
    {
      rootPath,
      force: options.force,
    },
    deps,
  );
  return {
    filePath: result.outputPath,
    status: result.status === "overwritten" ? "updated" : result.status,
    content: result.content,
    snapshot: result.snapshot,
  };
}
