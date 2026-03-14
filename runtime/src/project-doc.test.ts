import {
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
