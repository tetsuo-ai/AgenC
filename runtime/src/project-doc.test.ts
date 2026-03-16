import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  REPOSITORY_GUIDELINES_FILENAME,
  buildRepositoryGuidelines,
  inspectRepository,
  writeProjectGuide,
} from "./project-doc.js";

describe("project-doc", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  function createWorkspace(): string {
    const dir = mkdtempSync(join(tmpdir(), "agenc-project-doc-"));
    tempDirs.push(dir);
    return dir;
  }

  it("inspects common repository signals", async () => {
    const workspace = createWorkspace();
    writeFileSync(
      join(workspace, "package.json"),
      JSON.stringify(
        {
          scripts: {
            build: "tsup src/index.ts",
            test: "vitest run",
            typecheck: "tsc --noEmit",
          },
          devDependencies: {
            typescript: "^5.0.0",
            vitest: "^4.0.0",
            eslint: "^9.0.0",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    writeFileSync(join(workspace, "package-lock.json"), "{}\n", "utf-8");
    writeFileSync(join(workspace, "README.md"), "# Demo\n", "utf-8");
    writeFileSync(join(workspace, "Cargo.toml"), "[package]\nname = \"demo\"\n", "utf-8");
    writeFileSync(join(workspace, "Makefile"), "build:\n\t@echo ok\n", "utf-8");

    const snapshot = await inspectRepository(workspace, {
      listRecentCommitSubjects: () => [
        "feat(runtime): add project init",
        "fix(cli): tighten path handling",
      ],
    });

    expect(snapshot.packageManager).toBe("npm");
    expect(snapshot.commands.map((entry) => entry.command)).toContain("npm run build");
    expect(snapshot.commands.map((entry) => entry.command)).toContain("cargo test");
    expect(snapshot.styleTools).toContain("TypeScript type checking");
    expect(snapshot.testingFrameworks).toContain("Vitest");
    expect(snapshot.commitStyle).toBe("conventional");
  });

  it("builds concise repository guidelines markdown", () => {
    const content = buildRepositoryGuidelines({
      rootPath: "/repo",
      topDirectories: ["runtime/", "sdk/", "tests/"],
      topFiles: ["package.json", "README.md"],
      manifests: ["package.json"],
      packageManager: "npm",
      languages: ["JavaScript/TypeScript", "Rust"],
      styleTools: ["ESLint", "rustfmt"],
      testingFrameworks: ["Vitest", "cargo test"],
      testLocations: ["tests/", "package-manager test scripts"],
      commands: [
        {
          command: "npm run build",
          description: "build the project artifacts",
        },
        {
          command: "npm test",
          description: "run the default automated test suite",
        },
      ],
      commitStyle: "conventional",
    });

    expect(content).toContain("# Repository Guidelines");
    expect(content).toContain("## Project Structure & Module Organization");
    expect(content).toContain("`runtime/`, `sdk/`, `tests/`");
    expect(content).toContain("`npm run build`");
    expect(content).toContain("Conventional Commits");
  });

  it("prefers repo-aware guidance when contributor docs and package surfaces exist", async () => {
    const workspace = createWorkspace();
    mkdirSync(join(workspace, "src"), { recursive: true });
    mkdirSync(join(workspace, "runtime"), { recursive: true });
    mkdirSync(join(workspace, "sdk"), { recursive: true });
    mkdirSync(join(workspace, "mcp"), { recursive: true });
    mkdirSync(join(workspace, "docs-mcp"), { recursive: true });
    mkdirSync(join(workspace, "tests"), { recursive: true });
    mkdirSync(join(workspace, "programs", "agenc-coordination"), {
      recursive: true,
    });
    mkdirSync(join(workspace, "containers", "desktop", "server"), {
      recursive: true,
    });
    mkdirSync(join(workspace, "scripts"), { recursive: true });
    mkdirSync(join(workspace, ".github"), { recursive: true });

    writeFileSync(
      join(workspace, "package.json"),
      JSON.stringify({ name: "grid-router-ts" }, null, 2),
      "utf-8",
    );
    writeFileSync(
      join(workspace, "runtime", "package.json"),
      JSON.stringify(
        { scripts: { build: "tsup", test: "vitest run", typecheck: "tsc --noEmit" } },
        null,
        2,
      ),
      "utf-8",
    );
    writeFileSync(
      join(workspace, "sdk", "package.json"),
      JSON.stringify({ scripts: { build: "tsup", test: "vitest run" } }, null, 2),
      "utf-8",
    );
    writeFileSync(
      join(workspace, "mcp", "package.json"),
      JSON.stringify({ scripts: { build: "tsup" } }, null, 2),
      "utf-8",
    );
    writeFileSync(
      join(workspace, "docs-mcp", "package.json"),
      JSON.stringify({ scripts: { build: "tsup" } }, null, 2),
      "utf-8",
    );
    writeFileSync(
      join(workspace, "tests", "package.json"),
      JSON.stringify({ type: "module" }, null, 2),
      "utf-8",
    );
    writeFileSync(
      join(workspace, "containers", "desktop", "server", "package.json"),
      JSON.stringify({ name: "@tetsuo-ai/desktop-server" }, null, 2),
      "utf-8",
    );
    writeFileSync(
      join(workspace, "programs", "agenc-coordination", "Cargo.toml"),
      "[package]\nname = \"agenc-coordination\"\n",
      "utf-8",
    );
    writeFileSync(
      join(workspace, "AGENTS.md"),
      `# Repository Guidelines

## Project Structure & Module Organization
- \`programs/agenc-coordination/\`: Anchor Solana program.
- \`sdk/\`, \`runtime/\`, \`mcp/\`, and \`docs-mcp/\`: core TypeScript packages built independently.
- \`tests/\`: root integration suite.

## Coding Style & Naming Conventions
- TypeScript uses strict typing and 2-space indentation; preserve existing per-package style.
- In runtime/sdk code, keep ESM relative imports with \`.js\` suffixes.
- Use \`safeStringify()\` for any data containing bigint.

## Testing Guidelines
- Unit tests are co-located as \`*.test.ts\`.
- Root \`tests/*.ts\` covers protocol/integration behavior.
- LiteSVM clock doesn't auto-advance.

## LLM Tool-Call Sequencing (Critical)
- Always preserve assistant tool calls in history.

## Commit & Pull Request Guidelines
- Use Conventional Commits.
- Work from a focused branch such as \`feature/<short-name>\`.
`,
      "utf-8",
    );
    writeFileSync(
      join(workspace, "README.md"),
      `# AgenC

## Current Codebase Status

AgenC is in the middle of a whole-repository refactor program.
\`runtime/\` is the live control plane today.
The currently maintained core package build closure is \`sdk/\`, \`runtime/\`, \`mcp/\`, and \`docs-mcp/\`.
The root \`package.json\` and \`src/\` still expose a legacy surface.
`,
      "utf-8",
    );
    writeFileSync(
      join(workspace, "CODEX.md"),
      `# CODEX.md

## Package Map

- \`@tetsuo-ai/runtime\` (\`runtime/\`): agent runtime and orchestration layers.
`,
      "utf-8",
    );
    writeFileSync(
      join(workspace, ".github", "PULL_REQUEST_TEMPLATE.md"),
      "# Summary\n\n# Changes\n\n# Testing\n",
      "utf-8",
    );
    writeFileSync(join(workspace, "scripts", "setup-dev.sh"), "#!/usr/bin/env bash\n", "utf-8");
    writeFileSync(
      join(workspace, "scripts", "run-phase01-matrix.sh"),
      "#!/usr/bin/env bash\n",
      "utf-8",
    );

    const snapshot = await inspectRepository(workspace, {
      listRecentCommitSubjects: () => ["fix(runtime): improve init synthesis"],
    });
    const content = buildRepositoryGuidelines(snapshot);

    expect(content).toContain("## Repo State & Canonical Entry Points");
    expect(content).toContain("`runtime/` is the live control plane");
    expect(content).toContain("root `package.json` and `src/` still expose a legacy surface");
    expect(content).toContain("## Package & Surface Map");
    expect(content).toContain("`programs/agenc-coordination/`");
    expect(content).toContain("`npm --prefix runtime run build`");
    expect(content).toContain("`npm --prefix runtime test`");
    expect(content).toContain("Follow `.github/PULL_REQUEST_TEMPLATE.md`");
    expect(content).not.toContain("Top-level directories:");
  });

  it("writes AGENC.md and skips overwrite unless forced", async () => {
    const workspace = createWorkspace();
    writeFileSync(
      join(workspace, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run" } }, null, 2),
      "utf-8",
    );

    const created = await writeProjectGuide(
      workspace,
      {},
      {
        listRecentCommitSubjects: () => [],
      },
    );

    expect(created.status).toBe("created");
    const targetPath = join(workspace, REPOSITORY_GUIDELINES_FILENAME);
    expect(readFileSync(targetPath, "utf-8")).toContain("# Repository Guidelines");

    writeFileSync(targetPath, "# Existing\n", "utf-8");
    const skipped = await writeProjectGuide(workspace, {}, {
      listRecentCommitSubjects: () => [],
    });
    expect(skipped.status).toBe("skipped");
    expect(readFileSync(targetPath, "utf-8")).toBe("# Existing\n");

    const overwritten = await writeProjectGuide(
      workspace,
      {
        force: true,
      },
      {
        listRecentCommitSubjects: () => [],
      },
    );
    expect(overwritten.status).toBe("updated");
    expect(readFileSync(targetPath, "utf-8")).toContain("# Repository Guidelines");
  });
});
