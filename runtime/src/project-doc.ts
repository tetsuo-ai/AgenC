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
const KNOWN_DOC_SOURCE_PATHS = [
  "AGENTS.md",
  "README.md",
  "CODEX.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
] as const;
const KNOWN_HELPER_SCRIPT_PATHS = [
  "scripts/setup-dev.sh",
  "scripts/run-phase01-matrix.sh",
  "scripts/run-e2e-zk-local.sh",
  "scripts/agenc-watch.mjs",
] as const;
const CORE_TS_PACKAGE_PATHS = [
  "sdk",
  "runtime",
  "mcp",
  "docs-mcp",
] as const;
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

export interface MarkdownSection {
  readonly level: number;
  readonly heading: string;
  readonly body: string;
}

export interface RepositoryDocSource {
  readonly path: string;
  readonly content: string;
  readonly sections: readonly MarkdownSection[];
}

export interface RepositoryPackageSurface {
  readonly path: string;
  readonly manifest: "package.json" | "Cargo.toml";
  readonly name?: string;
  readonly description?: string;
  readonly scripts: readonly string[];
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
  readonly rootPackageName?: string;
  readonly docSources?: readonly RepositoryDocSource[];
  readonly helperScripts?: readonly string[];
  readonly packageSurfaces?: readonly RepositoryPackageSurface[];
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

function formatCommandList(input: readonly string[]): string {
  return input.map((value) => `\`${value}\``).join(", ");
}

function pathExists(path: string): Promise<boolean> {
  return access(path, constants.F_OK)
    .then(() => true)
    .catch(() => false);
}

function normalizeHeading(value: string): string {
  return value
    .replace(/`/g, "")
    .replace(/\[[^\]]+\]\([^)]+\)/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .toLowerCase();
}

function extractMarkdownSections(content: string): MarkdownSection[] {
  const lines = content.split(/\r?\n/);
  const sections: MarkdownSection[] = [];
  let inFence = false;
  let current:
    | {
        level: number;
        heading: string;
        lines: string[];
      }
    | undefined;

  const flushCurrent = (): void => {
    if (!current) return;
    sections.push({
      level: current.level,
      heading: current.heading,
      body: current.lines.join("\n").trim(),
    });
    current = undefined;
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (/^```/.test(trimmed)) {
      inFence = !inFence;
      if (current) current.lines.push(line);
      continue;
    }
    if (!inFence) {
      const match = /^(#{1,6})\s+(.+?)\s*$/.exec(trimmed);
      if (match) {
        flushCurrent();
        current = {
          level: match[1].length,
          heading: match[2].trim(),
          lines: [],
        };
        continue;
      }
    }
    if (current) current.lines.push(line);
  }

  flushCurrent();
  return sections;
}

function findDocSource(
  snapshot: RepositorySnapshot,
  path: string,
): RepositoryDocSource | undefined {
  return snapshot.docSources?.find((source) => source.path === path);
}

function findSection(
  source: RepositoryDocSource | undefined,
  heading: string,
): MarkdownSection | undefined {
  if (!source) return undefined;
  const target = normalizeHeading(heading);
  return source.sections.find(
    (section) => normalizeHeading(section.heading) === target,
  );
}

function sectionBullets(
  source: RepositoryDocSource | undefined,
  heading: string,
): string[] {
  const body = findSection(source, heading)?.body;
  if (!body) return [];
  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^-\s+/.test(line));
}

function hasTopDirectory(
  snapshot: RepositorySnapshot,
  directory: string,
): boolean {
  return snapshot.topDirectories.includes(`${directory}/`);
}

function hasTopFile(snapshot: RepositorySnapshot, fileName: string): boolean {
  return snapshot.topFiles.includes(fileName);
}

function packageSurface(
  snapshot: RepositorySnapshot,
  path: string,
): RepositoryPackageSurface | undefined {
  return snapshot.packageSurfaces?.find((surface) => surface.path === path);
}

function packageHasScript(
  snapshot: RepositorySnapshot,
  path: string,
  script: string,
): boolean {
  return packageSurface(snapshot, path)?.scripts.includes(script) === true;
}

function hasHelperScript(
  snapshot: RepositorySnapshot,
  path: string,
): boolean {
  return snapshot.helperScripts?.includes(path) === true;
}

function packageScriptCommand(path: string, script: string): string {
  return script === "test"
    ? `npm --prefix ${path} test`
    : `npm --prefix ${path} run ${script}`;
}

function uniqueLines(input: readonly string[]): string[] {
  return Array.from(new Set(input));
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
  return readPackageJsonAt(rootPath, "");
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown> | null> {
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

async function readPackageJsonAt(
  rootPath: string,
  relativePath: string,
): Promise<Record<string, unknown> | null> {
  return readJsonObject(join(rootPath, relativePath, "package.json"));
}

async function readMarkdownSource(
  rootPath: string,
  relativePath: string,
): Promise<RepositoryDocSource | null> {
  const filePath = join(rootPath, relativePath);
  if (!(await pathExists(filePath))) {
    return null;
  }
  try {
    const content = await readFile(filePath, "utf-8");
    return {
      path: relativePath,
      content,
      sections: extractMarkdownSections(content),
    };
  } catch {
    return null;
  }
}

async function collectChildDirectories(
  rootPath: string,
  relativePath: string,
  maxDepth: number,
): Promise<string[]> {
  const results = new Set<string>();

  async function visit(currentPath: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await readdir(join(rootPath, currentPath), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") || TOP_LEVEL_EXCLUDES.has(entry.name)) {
        continue;
      }
      const childPath = `${currentPath}/${entry.name}`;
      results.add(childPath);
      if (depth < maxDepth) {
        await visit(childPath, depth + 1);
      }
    }
  }

  await visit(relativePath, 1);
  return Array.from(results);
}

async function inspectPackageSurface(
  rootPath: string,
  relativePath: string,
): Promise<RepositoryPackageSurface | null> {
  const packageJson = await readPackageJsonAt(rootPath, relativePath);
  if (packageJson) {
    return {
      path: relativePath,
      manifest: "package.json",
      name: typeof packageJson.name === "string" ? packageJson.name : undefined,
      description:
        typeof packageJson.description === "string"
          ? packageJson.description
          : undefined,
      scripts: uniqueSorted(Object.keys(packageRecord(packageJson.scripts))),
    };
  }
  if (await pathExists(join(rootPath, relativePath, "Cargo.toml"))) {
    return {
      path: relativePath,
      manifest: "Cargo.toml",
      scripts: [],
    };
  }
  return null;
}

async function inspectWorkspacePackageSurfaces(
  rootPath: string,
  topDirectories: readonly string[],
): Promise<RepositoryPackageSurface[]> {
  const candidatePaths = new Set<string>(
    topDirectories.map((directory) => directory.slice(0, -1)),
  );
  if (topDirectories.includes("programs/")) {
    for (const childPath of await collectChildDirectories(rootPath, "programs", 1)) {
      candidatePaths.add(childPath);
    }
  }
  if (topDirectories.includes("containers/")) {
    for (const childPath of await collectChildDirectories(rootPath, "containers", 2)) {
      candidatePaths.add(childPath);
    }
  }

  const surfaces: RepositoryPackageSurface[] = [];
  for (const relativePath of uniqueSorted(candidatePaths)) {
    const surface = await inspectPackageSurface(rootPath, relativePath);
    if (surface) surfaces.push(surface);
  }
  return surfaces;
}

function buildGenericRepositoryGuidelines(snapshot: RepositorySnapshot): string {
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

function buildRepoAwareGuidelines(snapshot: RepositorySnapshot): string | null {
  const agents = findDocSource(snapshot, "AGENTS.md");
  const readme = findDocSource(snapshot, "README.md");
  const codex = findDocSource(snapshot, "CODEX.md");
  const pullRequestTemplate = findDocSource(
    snapshot,
    ".github/PULL_REQUEST_TEMPLATE.md",
  );
  const currentStatus = findSection(readme, "Current Codebase Status")?.body;
  const hasRichRepoSignals =
    currentStatus !== undefined ||
    findSection(codex, "Package Map") !== undefined ||
    findSection(agents, "Project Structure & Module Organization") !== undefined;
  if (!hasRichRepoSignals) {
    return null;
  }

  const lines: string[] = ["# Repository Guidelines", ""];

  const repoStateLines: string[] = [];
  if (
    hasTopFile(snapshot, "REFACTOR-MASTER-PROGRAM.md") ||
    /refactor/i.test(currentStatus ?? "")
  ) {
    repoStateLines.push(
      "- AgenC is mid-refactor; treat `REFACTOR-MASTER-PROGRAM.md` as the current scope and migration-gate reference before broad changes.",
    );
  }
  if (hasTopDirectory(snapshot, "runtime")) {
    repoStateLines.push(
      "- `runtime/` is the live control plane: daemon lifecycle, gateway, LLM/tool execution, background runs, channels, desktop bridge, observability, and CLI entrypoints.",
    );
  }
  const corePackages = CORE_TS_PACKAGE_PATHS.filter((path) =>
    packageSurface(snapshot, path),
  );
  if (corePackages.length > 0) {
    repoStateLines.push(
      `- The maintained TypeScript build closure is ${formatPathList(corePackages.map((path) => `${path}/`))}; use those packages as the canonical contributor entrypoints.`,
    );
  }
  if (
    /legacy/i.test(currentStatus ?? "") ||
    (snapshot.rootPackageName === "grid-router-ts" && hasTopDirectory(snapshot, "src"))
  ) {
    repoStateLines.push(
      "- The root `package.json` and `src/` still expose a legacy surface. Do not treat root `npm run build` or `npm test` as authoritative for the active monorepo.",
    );
  }
  if (repoStateLines.length > 0) {
    lines.push("## Repo State & Canonical Entry Points");
    lines.push(...repoStateLines);
    lines.push("");
  }

  const structureLines = uniqueLines([
    ...sectionBullets(agents, "Project Structure & Module Organization"),
    ...(packageSurface(snapshot, "containers/desktop/server")
      ? [
          "- `containers/desktop/server/`: desktop sandbox REST server backing the VM/automation surface.",
        ]
      : []),
  ]);
  if (structureLines.length > 0) {
    lines.push("## Package & Surface Map");
    lines.push(...structureLines);
    lines.push("");
  }

  const commandLines: string[] = [];
  if (corePackages.length > 0) {
    commandLines.push(
      `- Install the maintained TS packages with ${formatCommandList(corePackages.map((path) => `npm --prefix ${path} install`))}.`,
    );
  }
  const buildCommands = corePackages.filter((path) =>
    packageHasScript(snapshot, path, "build"),
  );
  if (buildCommands.length > 0) {
    commandLines.push(
      `- Build core artifacts with ${formatCommandList(buildCommands.map((path) => packageScriptCommand(path, "build")))}.`,
    );
  }
  const verificationCommands = uniqueLines(
    [
      packageHasScript(snapshot, "runtime", "test")
        ? packageScriptCommand("runtime", "test")
        : null,
      packageHasScript(snapshot, "runtime", "typecheck")
        ? packageScriptCommand("runtime", "typecheck")
        : null,
      packageHasScript(snapshot, "sdk", "test")
        ? packageScriptCommand("sdk", "test")
        : null,
    ].filter((value): value is string => value !== null),
  );
  if (verificationCommands.length > 0) {
    commandLines.push(
      `- For core verification, run ${formatCommandList(verificationCommands)}.`,
    );
  }
  if (hasTopFile(snapshot, "Anchor.toml") || packageSurface(snapshot, "programs/agenc-coordination")) {
    commandLines.push(
      "- Use `anchor build` for the on-chain program, and export `ANCHOR_PROVIDER_URL` plus `ANCHOR_WALLET` before Anchor-driven tests.",
    );
  }
  const helperCommands = uniqueLines(
    [
      hasHelperScript(snapshot, "scripts/setup-dev.sh")
        ? "./scripts/setup-dev.sh"
        : null,
      hasHelperScript(snapshot, "scripts/run-phase01-matrix.sh")
        ? "./scripts/run-phase01-matrix.sh"
        : null,
      hasHelperScript(snapshot, "scripts/run-e2e-zk-local.sh")
        ? "./scripts/run-e2e-zk-local.sh"
        : null,
    ].filter((value): value is string => value !== null),
  );
  if (helperCommands.length > 0) {
    commandLines.push(
      `- Use ${formatCommandList(helperCommands)} for repo bootstrap and broader matrix checks.`,
    );
  }
  if (packageHasScript(snapshot, "runtime", "build")) {
    commandLines.push(
      "- Build the CLI/TUI artifacts with `npm --prefix runtime run build`, then launch the supported terminal workflow with `node runtime/dist/bin/agenc.js --config ~/.agenc/config.json` (or `agenc --config ...` after installation).",
    );
  }
  if (commandLines.length > 0) {
    lines.push("## Build, Test, and Development Commands");
    lines.push(...commandLines);
    lines.push("");
  }

  const styleLines = uniqueLines([
    ...sectionBullets(agents, "Coding Style & Naming Conventions"),
    ...(findSection(agents, "LLM Tool-Call Sequencing (Critical)") ||
    findSection(agents, "Approval Gating (Critical)") ||
    findSection(agents, "Runtime Stability (Critical)")
      ? [
          "- When touching runtime chat/tool pipelines or approvals, preserve tool-call ordering, keep approval rules narrow, and add regression tests for stability guard changes.",
        ]
      : []),
  ]);
  if (styleLines.length > 0) {
    lines.push("## Coding Style & Naming Conventions");
    lines.push(...styleLines);
    lines.push("");
  }

  const testingLines = uniqueLines([
    ...sectionBullets(agents, "Testing Guidelines").filter(
      (line) => !/`npm run/i.test(line),
    ),
    ...(verificationCommands.length > 0
      ? [
          `- For core package changes, run ${formatCommandList(verificationCommands)} before wider integration checks.`,
        ]
      : []),
    ...(packageHasScript(snapshot, "runtime", "benchmark:pipeline:ci")
      ? [
          "- For runtime pipeline or reliability changes, also run `npm --prefix runtime run benchmark:pipeline:ci` and the matching gate or mutation commands for the touched subsystem.",
        ]
      : []),
  ]);
  if (testingLines.length > 0) {
    lines.push("## Testing Guidelines");
    lines.push(...testingLines);
    lines.push("");
  }

  const commitLines = uniqueLines([
    ...sectionBullets(agents, "Commit & Pull Request Guidelines"),
    ...(pullRequestTemplate
    && !sectionBullets(agents, "Commit & Pull Request Guidelines").some((line) =>
      line.includes(".github/PULL_REQUEST_TEMPLATE.md"),
    )
      ? [
          "- Follow `.github/PULL_REQUEST_TEMPLATE.md`: fill in Summary, Changes, Testing, Security / Risk, Checklist, and Issue link(s).",
        ]
      : []),
  ]);
  if (commitLines.length > 0) {
    lines.push("## Commit & Pull Request Guidelines");
    lines.push(...commitLines);
    lines.push("");
  }

  while (lines.at(-1) === "") {
    lines.pop();
  }
  return lines.join("\n");
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
  const docSources = (
    await Promise.all(
      KNOWN_DOC_SOURCE_PATHS.map((path) => readMarkdownSource(resolvedRoot, path)),
    )
  ).filter((source): source is RepositoryDocSource => source !== null);
  const helperScripts = (
    await Promise.all(
      KNOWN_HELPER_SCRIPT_PATHS.map(async (path) =>
        (await pathExists(join(resolvedRoot, path))) ? path : null,
      ),
    )
  ).filter(
    (
      path,
    ): path is (typeof KNOWN_HELPER_SCRIPT_PATHS)[number] => path !== null,
  );
  const packageSurfaces = await inspectWorkspacePackageSurfaces(
    resolvedRoot,
    topDirectories,
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
    rootPackageName:
      typeof packageJson?.name === "string" ? packageJson.name : undefined,
    docSources,
    helperScripts,
    packageSurfaces,
  };
}

export function buildRepositoryGuidelines(snapshot: RepositorySnapshot): string {
  return (
    buildRepoAwareGuidelines(snapshot) ?? buildGenericRepositoryGuidelines(snapshot)
  );
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
