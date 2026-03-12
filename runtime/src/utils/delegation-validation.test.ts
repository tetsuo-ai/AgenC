import { describe, expect, it } from "vitest";
import {
  contentHasExplicitFileArtifact,
  getAcceptanceVerificationCategories,
  hasUnsupportedNarrativeFileClaims,
  isDefinitionOnlyVerificationText,
  refineDelegatedChildToolAllowlist,
  resolveDelegatedChildToolScope,
  resolveDelegatedCorrectionToolChoiceToolNames,
  resolveDelegatedInitialToolChoiceToolNames,
  resolveDelegatedInitialToolChoiceToolName,
  specRequiresFileMutationEvidence,
  specRequiresMeaningfulBrowserEvidence,
  validateDelegatedOutputContract,
} from "./delegation-validation.js";
import { PROVIDER_NATIVE_WEB_SEARCH_TOOL } from "../llm/provider-native-search.js";

describe("delegation-validation", () => {
  it("does not treat script-definition criteria as build or test verification", () => {
    expect(
      getAcceptanceVerificationCategories("scripts for build/test/dev set"),
    ).toEqual([]);
  });

  it("does not treat authored manifest criteria with build/test/coverage scripts and devDeps as runtime verification", () => {
    expect(
      getAcceptanceVerificationCategories(
        "Authored root package.json with private:true, workspaces:['packages/*'], scripts for build/test/coverage, devDeps including typescript, vitest, and @vitest/coverage-v8.",
      ),
    ).toEqual([]);
  });

  it("does not treat manifest inventory criteria with file deps and build/test scripts as runtime verification", () => {
    expect(
      getAcceptanceVerificationCategories(
        "Per-package package.json with names, file: deps, build/test scripts",
      ),
    ).toEqual([]);
  });

  it("does not treat config-definition criteria as build verification", () => {
    expect(
      getAcceptanceVerificationCategories("TypeScript and build configs present"),
    ).toEqual([]);
  });

  it("treats README install/build/test instructions as definition-only text", () => {
    const criterion =
      "Author short README.md with install/test/build/run instructions and usage placeholders.";
    expect(isDefinitionOnlyVerificationText(criterion)).toBe(true);
    expect(getAcceptanceVerificationCategories(criterion)).toEqual([]);
  });

  it("does not treat negative pre-install guardrails as build verification", () => {
    expect(
      getAcceptanceVerificationCategories("No logic code or install commands in objective"),
    ).toEqual([]);
  });

  it("rejects non-object output when JSON is required", () => {
    const result = validateDelegatedOutputContract({
      spec: {
        inputContract: "JSON output with files and verification",
      },
      output: "Completed desktop.bash",
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("expected_json_object");
  });

  it("accepts exact-output criteria that preserve memorized-token placeholders", () => {
    const result = validateDelegatedOutputContract({
      spec: {
        objective:
          "Return exactly TOKEN=<memorized_token> with no other text",
        inputContract:
          "follow exactly: no extra words, output only the token line",
        acceptanceCriteria: [
          "output exactly TOKEN=<memorized_token>",
        ],
      },
      output: "TOKEN=ONYX-SHARD-58",
    });

    expect(result.ok).toBe(true);
  });

  it("rejects exact-count acceptance criteria mismatches", () => {
    const result = validateDelegatedOutputContract({
      spec: {
        inputContract: "JSON output only",
        acceptanceCriteria: ["Exactly 3 references with valid URLs"],
      },
      output:
        '{"references":[{"name":"a"},{"name":"b"},{"name":"c"},{"name":"d"}]}',
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("acceptance_count_mismatch");
    expect(result.error).toContain("expected exactly 3 references, got 4");
  });

  it("rejects contradictory completion claims that self-report unresolved work", () => {
    const result = validateDelegatedOutputContract({
      spec: {
        task: "add_tests",
        objective:
          "Create Vitest tests that match the implemented CLI and core contracts",
        inputContract: "Core library and CLI already exist",
        acceptanceCriteria: [
          "Tests match the current CLI/core APIs",
          "Tests cover requirements",
        ],
      },
      output:
        "**add_tests complete**: test/map.test.ts created and coverage added. " +
        "Note: some tests may need minor impl tweaks due to code mismatches in cli/GridMap methods like parse/getGoal.",
      toolCalls: [{
        name: "system.writeFile",
        args: {
          path: "/workspace/grid-router-ts/tests/map.test.ts",
          content: "it('works', () => expect(true).toBe(true));\n",
        },
        result:
          '{"path":"/workspace/grid-router-ts/tests/map.test.ts","bytesWritten":48}',
      }],
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("contradictory_completion_claim");
    expect(result.error).toContain("claimed completion");
    expect(result.error).toContain("code mismatches");
  });

  it("rejects completion claims that admit the deliverable is only partial", () => {
    const result = validateDelegatedOutputContract({
      spec: {
        task: "add_tests_demos",
        objective:
          "Add demos plus comprehensive tests for parser, algorithms, tiles, and CLI behavior",
        acceptanceCriteria: [
          "Demo maps present",
          "Comprehensive tests for parser, algorithms, tiles, and CLI behavior",
        ],
      },
      output:
        "**Phase `add_tests_demos` completed.** Demos were added and tests pass. " +
        "CLI/algos partial; more coverage may still be needed.",
      toolCalls: [{
        name: "system.writeFile",
        args: {
          path: "/workspace/terrain-router-ts/packages/core/src/index.test.ts",
          content: "test('ok', () => expect(true).toBe(true));\n",
        },
        result:
          '{"path":"/workspace/terrain-router-ts/packages/core/src/index.test.ts","bytesWritten":42}',
      }],
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("contradictory_completion_claim");
    expect(result.error).toContain("partial");
  });

  it("does not treat domain phrases like partial deliveries as unresolved work", () => {
    const result = validateDelegatedOutputContract({
      spec: {
        task: "design_research",
        objective:
          "Define the simulator rules for deadlines, deadlocks, and partial deliveries",
        acceptanceCriteria: [
          "Design doc with scenario/train/job/network types",
          "Rules cover partial deliveries when enabled",
        ],
      },
      output:
        "**design_research complete** Rules cover single-track conflicts, deadlines, and partial deliveries when the scenario flag enables splitting. Ready for downstream tech_research.",
      toolCalls: [{
        name: "system.browse",
        args: { url: "https://en.wikipedia.org/wiki/Single-track_railway" },
        result:
          '{"url":"https://en.wikipedia.org/wiki/Single-track_railway","text":"single-track operations and passing loops"}',
      }],
    });

    expect(result.ok).toBe(true);
  });

  it("does not treat domain phrases like incomplete journeys as unresolved work in file evidence", () => {
    const result = validateDelegatedOutputContract({
      spec: {
        task: "implement_core",
        objective:
          "Implement the scoring engine for late deliveries and incomplete journeys",
        inputContract: "Workspace scaffold exists",
        acceptanceCriteria: [
          "Scoring logic covers late deliveries and incomplete journeys",
        ],
      },
      output:
        "**implement_core complete** Scoring logic now applies route, lateness, and incomplete journey penalties.",
      toolCalls: [{
        name: "system.writeFile",
        args: {
          path: "/workspace/freight-flow/packages/core/src/scoring.ts",
          content:
            "export const INCOMPLETE_JOURNEY_PENALTY = 25;\n" +
            "// Penalty for incomplete journeys when jobs never reach destination.\n",
        },
        result:
          "{\"path\":\"/workspace/freight-flow/packages/core/src/scoring.ts\",\"bytesWritten\":120}",
      }],
    });

    expect(result.ok).toBe(true);
  });

  it("rejects completion claims that omit required work due to a blocking issue", () => {
    const result = validateDelegatedOutputContract({
      spec: {
        task: "add_tests",
        objective:
          "Author Vitest test files covering parser, terrain weights, conveyors, portals, timed switches, unreachable cases, and CLI output.",
        inputContract: "Implemented packages with src",
        acceptanceCriteria: [
          "Test files created in core/cli with described cases",
        ],
      },
      output:
        "**Phase completed:** Created `packages/core/src/index.test.ts` with Vitest tests covering parser, terrain weights, conveyors, portals, timed switches (*), unreachable cases (returns null), and findItinerary export. " +
        "(CLI test file omitted due to core export duplication blocking runs; acceptance met via core test creation + inspections.)",
      toolCalls: [
        {
          name: "system.writeFile",
          args: {
            path: "/workspace/transit-weave-ts/packages/core/src/index.test.ts",
            content:
              "import { describe, it, expect } from 'vitest';\n",
          },
          result:
            '{"path":"/workspace/transit-weave-ts/packages/core/src/index.test.ts","bytesWritten":50}',
        },
        {
          name: "system.bash",
          args: {
            command: "npm",
            args: ["test", "--", "packages/core/src/index.test.ts"],
          },
          result:
            '{"stdout":"","stderr":"core export duplication blocking runs","exitCode":1}',
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("contradictory_completion_claim");
    expect(result.error).toContain("claimed completion");
    expect(result.error).toContain("unresolved work");
  });

  it("rejects completion claims that explicitly report an unmet acceptance criterion", () => {
    const result = validateDelegatedOutputContract({
      spec: {
        task: "implement_web_package",
        objective:
          "Build a Vite React TypeScript app with scenario editor, simulation runner, canvas visualization, timeline, and metrics panels",
        acceptanceCriteria: [
          "All UI components and integration coded",
          "App structure uses Vite/React/TS",
        ],
      },
      output:
        "**Phase `implement_web_package` completed.** Created/updated `packages/web/src/main.tsx`, `packages/web/src/index.css`, and `packages/web/src/App.tsx`. " +
        "Note: one acceptance criterion unmet - \"All UI components and integration coded\" lacks full evidence because tsc reported type errors in App.tsx.",
      toolCalls: [{
        name: "system.writeFile",
        args: {
          path: "/workspace/transit-weave-ts/packages/web/src/App.tsx",
          content:
            "export default function App(): null {\n" +
            "  return null;\n" +
            "}\n",
        },
        result:
          "{\"path\":\"/workspace/transit-weave-ts/packages/web/src/App.tsx\",\"bytesWritten\":56}",
      }],
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("contradictory_completion_claim");
    expect(result.error).toContain("unmet");
  });

  it("accepts scaffold completion claims that mention expected placeholders only", () => {
    const result = validateDelegatedOutputContract({
      spec: {
        task: "setup_project_structure",
        objective:
          "Create the workspace root plus packages/core and packages/cli with src/index.ts placeholders",
        inputContract: "Scaffold only; later phases implement the actual logic",
        acceptanceCriteria: [
          "packages/core and cli exist with package.json and src/index.ts placeholders",
          "Root package.json and tsconfig.json exist",
        ],
      },
      output:
        "**Phase `setup_project_structure` complete** Root package.json/tsconfig.json present and packages/core + packages/cli were scaffolded with src/index.ts placeholders. Ready for next phase (no sibling steps or final deliverable synthesized).",
      toolCalls: [
        {
          name: "system.writeFile",
          args: {
            path: "/workspace/terrain-router-ts/packages/core/src/index.ts",
            content: "// placeholder\n",
          },
          result:
            '{"path":"/workspace/terrain-router-ts/packages/core/src/index.ts","bytesWritten":15}',
        },
      ],
    });

    expect(result.ok).toBe(true);
  });

  it("accepts scaffold completion claims when placeholder files contain todo markers", () => {
    const result = validateDelegatedOutputContract({
      spec: {
        task: "scaffold_monorepo_structure",
        objective:
          "Create the workspace root and packages/core, data, cli, web with placeholder src/index.ts files only",
        inputContract:
          "Scaffold only; later phases implement the actual logic in these placeholder files",
        acceptanceCriteria: [
          "Root package.json and per-package manifests exist",
          "packages/core, data, cli, web contain placeholder source entrypoints",
        ],
      },
      output:
        "**Phase `scaffold_monorepo_structure` complete** Root/package manifests and placeholder entrypoints were authored for downstream implementation phases.",
      toolCalls: [
        {
          name: "system.writeFile",
          args: {
            path: "/workspace/transit-weave-ts/packages/core/src/index.ts",
            content:
              "export interface SimulationConfig {\n" +
              "  // TODO: implement core models in later phases\n" +
              "}\n",
          },
          result:
            '{"path":"/workspace/transit-weave-ts/packages/core/src/index.ts","bytesWritten":87}',
        },
        {
          name: "system.writeFile",
          args: {
            path: "/workspace/transit-weave-ts/packages/cli/src/index.ts",
            content:
              "export function main(): void {\n" +
              "  // FIXME: wire CLI commands in later phases\n" +
              "}\n",
          },
          result:
            '{"path":"/workspace/transit-weave-ts/packages/cli/src/index.ts","bytesWritten":82}',
        },
      ],
    });

    expect(result.ok).toBe(true);
  });

  it("accepts setup-heavy manifest scaffold phases with deferred entrypoint placeholders", () => {
    const result = validateDelegatedOutputContract({
      spec: {
        task: "scaffold_package_manifests",
        objective:
          "Author package.json, tsconfig.json, and entry files for core, data, cli, web packages",
        inputContract: "No inputs; build on root configs",
        acceptanceCriteria: [
          "Each package.json authored with name, file: deps to core/data/etc, and build scripts",
          "Web package includes Vite/React deps and config",
          "No npm install/build/test/typecheck/lint commands executed or claimed in this phase.",
        ],
      },
      output:
        "**Phase `scaffold_package_manifests` complete** Authored package manifests, tsconfig files, and minimal entry files for all packages. No install/build/test run in this phase.",
      toolCalls: [
        {
          name: "system.writeFile",
          args: {
            path: "/workspace/signal-cartography/packages/core/src/index.ts",
            content:
              "export const VERSION = '0.1.0';\n" +
              "// TODO: replace scaffold exports during implementation phase.\n",
          },
          result:
            "{\"path\":\"/workspace/signal-cartography/packages/core/src/index.ts\",\"bytesWritten\":91}",
        },
        {
          name: "system.writeFile",
          args: {
            path: "/workspace/signal-cartography/packages/web/src/main.tsx",
            content:
              "export function AppBootstrap() {\n" +
              "  return null;\n" +
              "}\n",
          },
          result:
            "{\"path\":\"/workspace/signal-cartography/packages/web/src/main.tsx\",\"bytesWritten\":48}",
        },
      ],
    });

    expect(result.ok).toBe(true);
  });

  it("does not treat historical scaffold placeholder mentions as unresolved after the file is overwritten", () => {
    const result = validateDelegatedOutputContract({
      spec: {
        task: "implement_core",
        objective:
          "Implement pure TypeScript functions and types in packages/core for JSON parsing, track modeling, train simulation, dispatch decisions, deadlock detection, and scoring",
        inputContract: "Scaffolded monorepo with installed dependencies",
        acceptanceCriteria: [
          "All core simulator logic and types fully implemented in src/index.ts",
          "Exports pure functions for simulation",
        ],
      },
      output:
        "**Phase `implement_core` completed successfully**\n\n" +
        "- Inspected scaffolded workspace (core/src/index.ts placeholder, package.json, tsconfig, empty test/, root scripts).\n" +
        "- Overwrote `packages/core/src/index.ts` with complete pure TS implementation.\n" +
        "- Verified: `npm run build --workspace=freight-flow-core` succeeds (tsc exits 0, no errors).",
      toolCalls: [
        {
          name: "system.writeFile",
          args: {
            path: "/workspace/freight-flow-ts/packages/core/src/index.ts",
            content:
              "export interface Scenario { tracks: string[]; }\n" +
              "export function parseScenario(input: string): Scenario { return JSON.parse(input) as Scenario; }\n",
          },
          result:
            "{\"path\":\"/workspace/freight-flow-ts/packages/core/src/index.ts\",\"bytesWritten\":142}",
        },
        {
          name: "system.bash",
          args: {
            command: "npm",
            args: ["run", "build", "--workspace=freight-flow-core"],
          },
          result:
            "{\"stdout\":\"build ok\\n\",\"stderr\":\"\",\"exitCode\":0}",
        },
      ],
    });

    expect(result.ok).toBe(true);
  });

  it("rejects scaffold phases that execute forbidden install commands before later verification steps", () => {
    const result = validateDelegatedOutputContract({
      spec: {
        task: "scaffold_manifests",
        objective:
          "Author only root/package manifests and config files for the monorepo",
        inputContract:
          "Scaffold only; later deterministic verification runs npm install",
        acceptanceCriteria: [
          "All package.json and tsconfig files authored",
          "No install/build/test commands executed or claimed",
          "No workspace:* specifiers used",
        ],
      },
      output:
        "**Phase scaffold_manifests completed.** Authored manifests and ran npm install to confirm the file: links work.",
      toolCalls: [
        {
          name: "system.writeFile",
          args: {
            path: "/workspace/transit-weave/package.json",
            content: '{ "name": "transit-weave", "private": true }',
          },
          result:
            '{"path":"/workspace/transit-weave/package.json","bytesWritten":44}',
        },
        {
          name: "system.bash",
          args: {
            command: "npm",
            args: ["install"],
          },
          result: '{"stdout":"ok","stderr":"","exitCode":0}',
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("forbidden_phase_action");
    expect(result.error).toContain("dependency-install commands");
    expect(result.error).toContain("npm install");
  });

  it("does not treat authored root config summaries as forbidden test execution claims", () => {
    const result = validateDelegatedOutputContract({
      spec: {
        task: "scaffold_root_files",
        objective:
          "Author only root files/configs and do not execute install/build/test commands in this phase",
        acceptanceCriteria: [
          "Root package.json authored with workspaces plus build/test scripts",
          "tsconfig.json, vitest.config.ts, and .gitignore authored",
          "No install/build/test commands executed or claimed",
        ],
      },
      output:
        "Root files confirmed via listDir+readFile: package.json (workspaces+scripts+file:deps), tsconfig.json, vitest.config.ts, .gitignore present+match expected root scaffolding.",
      toolCalls: [
        {
          name: "system.writeFile",
          args: {
            path: "/workspace/freight-flow/package.json",
            content:
              '{ "name": "freight-flow", "private": true, "scripts": { "build": "tsc -b", "test": "vitest run" } }',
          },
          result:
            '{"path":"/workspace/freight-flow/package.json","bytesWritten":103}',
        },
        {
          name: "system.listDir",
          args: {
            path: "/workspace/freight-flow",
          },
          result:
            '{"path":"/workspace/freight-flow","entries":[{"name":"package.json","type":"file"},{"name":"tsconfig.json","type":"file"},{"name":"vitest.config.ts","type":"file"},{"name":".gitignore","type":"file"}]}',
        },
        {
          name: "system.readFile",
          args: {
            path: "/workspace/freight-flow/vitest.config.ts",
          },
          result:
            '{"path":"/workspace/freight-flow/vitest.config.ts","content":"import { defineConfig } from \\"vitest/config\\";"}',
        },
      ],
    });

    expect(result.ok).toBe(true);
  });

  it("does not treat compact negative no-install/build/test summaries as forbidden phase claims", () => {
    const result = validateDelegatedOutputContract({
      spec: {
        task: "scaffold_manifests",
        objective:
          "Author only manifests/configs and do not execute install/build/test commands in this phase",
      },
      output:
        "All via writeFile (no bash/npm install/build/test per acceptance; file: protocol used in manifests).",
      toolCalls: [
        {
          name: "system.writeFile",
          args: {
            path: "/workspace/freight-flow/package.json",
            content:
              '{ "name": "freight-flow", "private": true, "scripts": { "build": "tsc -b", "test": "vitest run" } }',
          },
          result:
            '{"path":"/workspace/freight-flow/package.json","bytesWritten":106}',
        },
      ],
    });

    expect(result.ok).toBe(true);
  });

  it("does not treat scaffold inspection summaries with negative no-run status as forbidden phase execution claims", () => {
    const result = validateDelegatedOutputContract({
      spec: {
        task: "scaffold_monorepo",
        objective:
          "Author configs and dir structure only; do not execute install/build/test commands in this phase",
        acceptanceCriteria: [
          "Root and per-package package.json created with file: deps and no workspace:*",
          "tsconfig.json, vitest.config, vite.config.ts authored",
          "Basic dir layout with src placeholders",
          "No npm install/build/test executed",
        ],
      },
      output:
        "**Phase `scaffold_monorepo` complete.** Verified via tools (ls -R + cat packages/web/package.json): root + per-package package.json created (workspaces:[\"packages/*\"], deps use \"file:../core\", no workspace:*), tsconfig.json/vitest.config.ts/vite.config.ts authored, basic per-package tsconfigs + src/index.ts placeholders + web React vite config present, dir layout matches objective. No install/build/test run. (Host npm file: protocol satisfied; root scripts \"build\"/\"test\" defined.)",
      toolCalls: [
        {
          name: "system.bash",
          args: {
            command: "ls",
            args: ["-R"],
          },
          result:
            '{"exitCode":0,"stdout":"package.json\\npackages\\ntsconfig.json\\nvitest.config.ts","stderr":""}',
        },
        {
          name: "system.bash",
          args: {
            command: "cat",
            args: ["packages/web/package.json"],
          },
          result:
            '{"exitCode":0,"stdout":"{\\"name\\":\\"@freight-flow/web\\",\\"scripts\\":{\\"dev\\":\\"vite\\",\\"build\\":\\"tsc && vite build\\",\\"test\\":\\"vitest run\\"}}","stderr":""}',
        },
      ],
    });

    expect(result.ok).toBe(true);
  });

  it("does not treat scaffold summaries that mention future build commands as forbidden execution claims", () => {
    const result = validateDelegatedOutputContract({
      spec: {
        task: "scaffold_monorepo",
        objective:
          "Author configs and dir structure only; do not execute install/build/test commands in this phase",
        inputContract:
          "Scaffold only; later deterministic verification runs npm install",
        acceptanceCriteria: [
          "All manifests, configs and directories authored with correct deps and structure",
          "Root package.json authored with npm scripts for build, test",
          "No npm install/build/test/typecheck/lint commands executed or claimed in this phase",
        ],
      },
      output:
        "**Phase `scaffold_monorepo` completed.**\n\n" +
        "Authored:\n" +
        "- Root: `package.json` (workspaces, build/test scripts, devDeps), `tsconfig.json` (project references), `vitest.config.ts`.\n" +
        "- `packages/core/`: `package.json` (file deps none, build/test scripts), `tsconfig.json` (composite, NodeNext, src).\n" +
        "- `packages/data/`: `package.json` (core via `file:../core`), `tsconfig.json` (references core).\n" +
        "- `packages/cli/`: `package.json` (core+data via `file:../*`), `tsconfig.json` (references).\n" +
        "- `packages/web/`: `package.json` (core+data via `file:../*`, React/Vite deps), `tsconfig.json` (React JSX, references), `vite.config.ts`.\n" +
        "- Directories: `packages/*/src` (and parents via writeFile).\n\n" +
        "All use `file:../*` (no `workspace:*`), package-local TS configs for isolated `npm run build --workspace=...`, only manifests/configs (no source/code/commands executed). Verified via `ls -R` only.",
      toolCalls: [
        {
          name: "system.writeFile",
          args: {
            path: "/workspace/signal-cartography/package.json",
            content:
              '{ "name": "signal-cartography", "private": true, "scripts": { "build": "npm run build --workspaces", "test": "npm run test --workspaces" } }',
          },
          result:
            '{"path":"/workspace/signal-cartography/package.json","bytesWritten":138}',
        },
        {
          name: "system.writeFile",
          args: {
            path: "/workspace/signal-cartography/packages/web/package.json",
            content:
              '{ "name": "@signal-cartography/web", "scripts": { "build": "tsc && vite build", "test": "vitest run" } }',
          },
          result:
            '{"path":"/workspace/signal-cartography/packages/web/package.json","bytesWritten":109}',
        },
        {
          name: "system.bash",
          args: {
            command: "ls",
            args: ["-R"],
          },
          result:
            '{"exitCode":0,"stdout":"package.json\\npackages\\ntsconfig.json\\nvitest.config.ts","stderr":""}',
        },
      ],
    });

    expect(result.ok).toBe(true);
  });

  it("rejects completion claims that say the phase is blocked", () => {
    const result = validateDelegatedOutputContract({
      spec: {
        task: "add_examples_tests_readme",
        objective: "Add examples, tests, and README",
        acceptanceCriteria: [
          "examples present",
          "README.md with examples",
        ],
      },
      output:
        "**add_examples_tests_readme complete** Examples and README were added. " +
        "Blocked on full verification until the workspace issue is resolved.",
      toolCalls: [{
        name: "system.writeFile",
        args: {
          path: "/workspace/schedule-workbench/README.md",
          content: "# README\n",
        },
        result:
          '{"path":"/workspace/schedule-workbench/README.md","bytesWritten":9}',
      }],
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("blocked_phase_output");
    expect(result.error).toContain("Blocked on full verification");
  });

  it("rejects completion claims that describe an implementation as stubbed", () => {
    const result = validateDelegatedOutputContract({
      spec: {
        task: "implement_cli",
        objective:
          "Implement packages/cli to load scenario file via args, use core for dispatch plan and timeline summary, print output, fail clearly on invalid JSON or conflicts.",
        inputContract: "Existing cli structure and core import",
        acceptanceCriteria: [
          "CLI src/index.ts parses args, runs sim, outputs plan/timeline",
        ],
      },
      output:
        "**Phase `implement_cli` completed:** Wrote `packages/cli/src/index.ts`; implements arg-based scenario loading, stubbed dispatch-plan + timeline summary output, clear failure paths for bad JSON/validation/conflicts per contract.",
      toolCalls: [{
        name: "system.writeFile",
        args: {
          path: "/workspace/freight-flow-ts/packages/cli/src/index.ts",
          content:
            "export function main() {\n  return 'ok';\n}\n",
        },
        result:
          '{"path":"/workspace/freight-flow-ts/packages/cli/src/index.ts","bytesWritten":41}',
      }],
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("contradictory_completion_claim");
    expect(result.error).toContain("claimed completion");
    expect(result.error).toContain("stubbed dispatch-plan");
  });

  it("rejects completion claims when authored files still contain placeholder implementation markers", () => {
    const result = validateDelegatedOutputContract({
      spec: {
        task: "implement_cli",
        objective:
          "Implement packages/cli to load scenario file via args, use core for dispatch plan and timeline summary, print output, fail clearly on invalid JSON or conflicts.",
        inputContract: "Existing cli structure and core import",
        acceptanceCriteria: [
          "CLI src/index.ts parses args, runs sim, outputs plan/timeline",
        ],
      },
      output:
        "**Phase `implement_cli` completed:** Wrote `packages/cli/src/index.ts` and handled CLI error cases.",
      toolCalls: [{
        name: "system.writeFile",
        args: {
          path: "/workspace/freight-flow-ts/packages/cli/src/index.ts",
          content:
            "import type { DispatchPlan } from '@freight-flow/core';\n" +
            "// Placeholder for core functions assumed to exist based on types\n" +
            "function generateDispatchPlan(): DispatchPlan {\n" +
            "  return { decisions: [] };\n" +
            "}\n",
        },
        result:
          '{"path":"/workspace/freight-flow-ts/packages/cli/src/index.ts","bytesWritten":178}',
      }],
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("contradictory_completion_claim");
    expect(result.error).toContain("file-mutation evidence");
    expect(result.error).toContain("packages/cli/src/index.ts");
    expect(result.error).toContain("Placeholder for core functions");
  });

  it("rejects completion claims when authored code elides implementation behind omission comments", () => {
    const result = validateDelegatedOutputContract({
      spec: {
        task: "implement_web",
        objective:
          "Author the React app for the hex-grid simulator with editing, routing, metrics, and sample scenarios.",
        inputContract: "Core/data packages already exist",
        acceptanceCriteria: [
          "packages/web/src/App.tsx contains the full interactive React implementation",
        ],
      },
      output:
        "**Phase `implement_web` completed.** Authored `packages/web/src/App.tsx` with the required UI and preserved the existing behavior.",
      toolCalls: [{
        name: "system.writeFile",
        args: {
          path: "/workspace/signal-cartography-ts/packages/web/src/App.tsx",
          content:
            "function App() {\n" +
            "  // ... (rest of the component code remains unchanged to preserve functionality)\n" +
            "  // Note: full implementation omitted in this minimal repair; original behavior intact\n" +
            "  return (\n" +
            "    <div className=\"app\">\n" +
            "      {/* Original JSX structure preserved */}\n" +
            "      <h1>Signal Cartography</h1>\n" +
            "      {/* ... */}\n" +
            "    </div>\n" +
            "  );\n" +
            "}\n",
        },
        result:
          '{"path":"/workspace/signal-cartography-ts/packages/web/src/App.tsx","bytesWritten":340}',
      }],
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("contradictory_completion_claim");
    expect(result.error).toContain("file-mutation evidence");
    expect(result.error).toContain("packages/web/src/App.tsx");
    expect(result.error).toContain(
      "rest of the component code remains unchanged",
    );
  });

  it("accepts completion claims that explicitly replaced scaffold placeholders", () => {
    const result = validateDelegatedOutputContract({
      spec: {
        task: "implement_cli",
        objective:
          "Implement packages/cli to load scenario files, run commands, and print reports.",
        inputContract: "Existing cli scaffold and core/data imports",
        acceptanceCriteria: [
          "CLI src/index.ts provides the required commands and argument handling",
        ],
      },
      output:
        "**Phase `implement_cli` completed.** Updated `packages/cli/src/index.ts` " +
        "(replaced placeholder scaffold with Commander.js-based CLI commands for generate, simulate, and report).",
      toolCalls: [{
        name: "system.writeFile",
        args: {
          path: "/workspace/freight-flow-ts/packages/cli/src/index.ts",
          content:
            "import { Command } from 'commander';\n" +
            "const program = new Command();\n" +
            "program.command('generate');\n" +
            "program.command('simulate');\n" +
            "program.command('report');\n",
        },
        result:
          '{"path":"/workspace/freight-flow-ts/packages/cli/src/index.ts","bytesWritten":134}',
      }],
    });

    expect(result.ok).toBe(true);
  });

  it("uses the latest observed file state when checking contradictory completion claims", () => {
    const result = validateDelegatedOutputContract({
      spec: {
        task: "implement_core",
        objective:
          "Implement the core simulator and verify the package builds and tests cleanly",
        inputContract: "Workspace manifests and install are already complete",
        acceptanceCriteria: [
          "Core exports the simulator functions and types",
          "Builds and tests pass",
        ],
      },
      output:
        "**Core implemented:** Added the final simulator implementation, fixed the tests, and verified build/test success.",
      toolCalls: [
        {
          name: "system.writeFile",
          args: {
            path: "/workspace/freight-flow-ts/packages/core/src/index.ts",
            content:
              "export function isDeadlock(): boolean {\n" +
              "  // Simple cycle detection stub\n" +
              "  return false;\n" +
              "}\n",
          },
          result:
            "{\"path\":\"/workspace/freight-flow-ts/packages/core/src/index.ts\",\"bytesWritten\":85}",
        },
        {
          name: "system.writeFile",
          args: {
            path: "/workspace/freight-flow-ts/packages/core/src/index.ts",
            content:
              "export function isDeadlock(): boolean {\n" +
              "  return true;\n" +
              "}\n",
          },
          result:
            "{\"path\":\"/workspace/freight-flow-ts/packages/core/src/index.ts\",\"bytesWritten\":55}",
        },
        {
          name: "system.bash",
          args: {
            command: "npm",
            args: ["run", "build", "--workspace=@freight-flow/core"],
          },
          result:
            "{\"stdout\":\"build ok\\n\",\"stderr\":\"\",\"exitCode\":0}",
        },
      ],
    });

    expect(result.ok).toBe(true);
  });

  it("treats write-file result paths as canonical when later mutations replace earlier absolute-path reads", () => {
    const result = validateDelegatedOutputContract({
      spec: {
        task: "implement_cli",
        objective:
          "Implement the CLI package and verify it builds successfully",
        acceptanceCriteria: [
          "placeholder logic removed",
          "build succeeds",
        ],
      },
      output:
        "**implement_cli complete** placeholder logic removed and build succeeds.",
      toolCalls: [
        {
          name: "system.readFile",
          args: {
            path: "packages/cli/src/index.ts",
          },
          result: JSON.stringify({
            path: "/workspace/transit-weave/packages/cli/src/index.ts",
            content:
              "export function main() {\n" +
              "  // placeholder implementation\n" +
              "  return 'todo';\n" +
              "}\n",
          }),
        },
        {
          name: "system.writeFile",
          args: {
            path: "packages/cli/src/index.ts",
            content:
              "export function main() {\n" +
              "  return 'ok';\n" +
              "}\n",
          },
          result: JSON.stringify({
            path: "/workspace/transit-weave/packages/cli/src/index.ts",
            bytesWritten: 43,
          }),
        },
        {
          name: "system.bash",
          args: {
            command: "npm",
            args: ["run", "build", "--workspace=@transit-weave/cli"],
          },
          result: JSON.stringify({
            stdout: "build ok\n",
            stderr: "",
            exitCode: 0,
          }),
        },
      ],
    });

    expect(result.ok).toBe(true);
  });

  it("ignores stale generated-artifact snapshots after a later successful build", () => {
    const result = validateDelegatedOutputContract({
      spec: {
        task: "implement_cli",
        objective:
          "Implement the CLI package and verify it builds successfully",
        acceptanceCriteria: [
          "CLI commands are implemented",
          "CLI builds successfully",
        ],
      },
      output:
        "**implement_cli complete** `packages/cli/src/index.ts` implements the CLI commands and `npm run build --workspace=@transit-weave/cli` succeeds.",
      toolCalls: [
        {
          name: "system.bash",
          args: {
            command: "cat",
            args: ["packages/cli/dist/index.js"],
          },
          result: JSON.stringify({
            stdout:
              "export function main() {\n" +
              "  // would need fs, but for basic, just print\n" +
              "}\n",
            stderr: "",
            exitCode: 0,
          }),
        },
        {
          name: "system.writeFile",
          args: {
            path: "packages/cli/src/index.ts",
            content:
              "import * as fs from 'node:fs';\n" +
              "export function main() {\n" +
              "  return fs.existsSync('.') ? 'ok' : 'missing';\n" +
              "}\n",
          },
          result: JSON.stringify({
            path: "/workspace/transit-weave/packages/cli/src/index.ts",
            bytesWritten: 102,
          }),
        },
        {
          name: "system.bash",
          args: {
            command: "npm",
            args: ["run", "build", "--workspace=@transit-weave/cli"],
          },
          result: JSON.stringify({
            stdout: "build ok\n",
            stderr: "",
            exitCode: 0,
          }),
        },
      ],
    });

    expect(result.ok).toBe(true);
  });

  it("does not treat benign runtime warning strings inside authored code as unresolved work", () => {
    const result = validateDelegatedOutputContract({
      spec: {
        task: "implement_cli",
        objective:
          "Implement packages/cli to load scenario file via args, use core for dispatch plan and timeline summary, print output, fail clearly on invalid JSON or conflicts.",
        inputContract: "Existing cli structure and core import",
        acceptanceCriteria: [
          "CLI src/index.ts parses args, runs sim, outputs plan/timeline",
        ],
      },
      output:
        "**Phase `implement_cli` completed:** Wrote `packages/cli/src/index.ts`; scenario failures now emit a clear warning and the build passes.",
      toolCalls: [
        {
          name: "system.writeFile",
          args: {
            path: "/workspace/freight-flow-ts/packages/cli/src/index.ts",
            content:
              "export function reportIncompleteSimulation(): void {\n" +
              "  console.warn('Warning: Simulation did not complete successfully.');\n" +
              "}\n",
          },
          result:
            "{\"path\":\"/workspace/freight-flow-ts/packages/cli/src/index.ts\",\"bytesWritten\":118}",
        },
        {
          name: "system.bash",
          args: {
            command: "npm",
            args: ["run", "build", "--workspace=freight-flow-cli"],
          },
          result:
            "{\"stdout\":\"build ok\\n\",\"stderr\":\"\",\"exitCode\":0}",
        },
      ],
    });

    expect(result.ok).toBe(true);
  });

  it("still flags unresolved implementation markers in authored code when they are not benign runtime messages", () => {
    const result = validateDelegatedOutputContract({
      spec: {
        task: "implement_cli",
        objective: "Implement the CLI package and keep the workspace buildable",
        acceptanceCriteria: [
          "CLI reads input and outputs summary",
        ],
      },
      output:
        "**Phase `implement_cli` completed:** Wrote `packages/cli/src/index.ts` and verified it.",
      toolCalls: [{
        name: "system.writeFile",
        args: {
          path: "/workspace/freight-flow-ts/packages/cli/src/index.ts",
          content:
            "export function unsupported(): never {\n" +
            "  throw new Error('not yet implemented');\n" +
            "}\n",
        },
        result:
          "{\"path\":\"/workspace/freight-flow-ts/packages/cli/src/index.ts\",\"bytesWritten\":83}",
      }],
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("contradictory_completion_claim");
    expect(result.error).toContain("not yet implemented");
  });

  it("rejects blocked phase outputs even without a completion claim", () => {
    const result = validateDelegatedOutputContract({
      spec: {
        task: "implement_cli",
        objective: "Build the CLI package and keep the workspace buildable",
        acceptanceCriteria: [
          "CLI reads input and outputs summary",
        ],
      },
      output:
        "**implement_cli blocked** core package is not buildable yet and I cannot finish this phase until that issue is fixed.",
      toolCalls: [{
        name: "system.writeFile",
        args: {
          path: "/workspace/terrain-router-ts/packages/cli/src/index.ts",
          content: "export {};\n",
        },
        result:
          '{"path":"/workspace/terrain-router-ts/packages/cli/src/index.ts","bytesWritten":10}',
      }],
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("blocked_phase_output");
    expect(result.error).toContain("blocked or incomplete");
  });

  it("does not treat domain summaries about blocked cells as blocked phase output", () => {
    const result = validateDelegatedOutputContract({
      spec: {
        task: "implement_core",
        objective:
          "Implement typed hex-grid graph, Dijkstra and A* routing primitives, and reproducible scenario generator in the core package.",
        inputContract: "Scaffolded and installed monorepo",
        acceptanceCriteria: [
          "All core primitives implemented and typed correctly",
          "Routing algorithms produce deterministic results",
          "Build succeeds for the core package",
        ],
      },
      output:
        "**Phase `implement_core` complete** Implemented `HexGrid` with blocked cells, neighbors, and validity checks. " +
        "Added `dijkstra()` and `aStar()` plus reproducible scenario generation. " +
        "Verified with `npm run build`; dist artifacts are present and ready for downstream phases.",
      toolCalls: [
        {
          name: "system.writeFile",
          args: {
            path: "/workspace/signal-cartography/packages/core/src/index.ts",
            content:
              "export class HexGrid {\n" +
              "  blockedCells = new Set<string>();\n" +
              "}\n",
          },
          result:
            "{\"path\":\"/workspace/signal-cartography/packages/core/src/index.ts\",\"bytesWritten\":58}",
        },
        {
          name: "system.bash",
          args: {
            command: "npm",
            args: ["run", "build"],
            cwd: "/workspace/signal-cartography/packages/core",
          },
          result:
            "{\"stdout\":\"build ok\\n\",\"stderr\":\"\",\"exitCode\":0}",
        },
      ],
    });

    expect(result.ok).toBe(true);
  });

  it("prefers blocked-phase validation when output explicitly reports the phase as blocked", () => {
    const result = validateDelegatedOutputContract({
      spec: {
        task: "repair_cli",
        objective: "Implement the CLI and verify it end to end",
        acceptanceCriteria: ["CLI builds and runs"],
      },
      output:
        "**Phase result: blocked** CLI implementation is not complete and cannot be finished with the current evidence only.",
      toolCalls: [{
        name: "system.listDir",
        args: { path: "/workspace/project/packages/cli/src" },
        result: "{\"path\":\"/workspace/project/packages/cli/src\",\"entries\":[]}",
      }],
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("blocked_phase_output");
  });

  it("rejects build-oriented acceptance criteria without successful verification evidence", () => {
    const result = validateDelegatedOutputContract({
      spec: {
        task: "implement_cli",
        objective:
          "Build CLI in src/cli.ts that reads stdin/file and prints the chosen schedule",
        inputContract: "Use process.argv, import core",
        acceptanceCriteria: [
          "CLI bin and logic in src/cli.ts",
          "Builds and runs correctly",
        ],
      },
      output:
        "**implement_cli complete** Wrote packages/cli/src/cli.ts and package.json. " +
        "Build/run verification is still pending.",
      toolCalls: [
        {
          name: "system.writeFile",
          args: {
            path: "/workspace/schedule-workbench/packages/cli/src/cli.ts",
            content: "console.log('cli');\n",
          },
          result:
            '{"path":"/workspace/schedule-workbench/packages/cli/src/cli.ts","bytesWritten":20}',
        },
        {
          name: "system.bash",
          args: {
            command: "npm",
            args: ["run", "build", "--workspace=@schedule-workbench/cli"],
          },
          result:
            '{"stdout":"","stderr":"sh: 1: tsc: not found","exitCode":127}',
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("acceptance_evidence_missing");
    expect(result.error).toContain("Builds and runs correctly");
  });

  it("does not count package-file writes as build verification evidence", () => {
    const result = validateDelegatedOutputContract({
      spec: {
        task: "implement_cli",
        objective:
          "Build CLI in src/cli.ts that reads stdin/file and prints the chosen schedule",
        inputContract: "Use process.argv, import core",
        acceptanceCriteria: [
          "CLI bin and logic in src/cli.ts",
          "Builds cleanly",
        ],
      },
      output:
        "**implement_cli complete** Wrote packages/cli/src/cli.ts and package.json.",
      toolCalls: [
        {
          name: "system.writeFile",
          args: {
            path: "/workspace/schedule-workbench/packages/cli/package.json",
            content:
              '{ "scripts": { "build": "tsc -p tsconfig.json" }, "name": "@schedule-workbench/cli" }',
          },
          result:
            '{"path":"/workspace/schedule-workbench/packages/cli/package.json","bytesWritten":86}',
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("acceptance_evidence_missing");
    expect(result.error).toContain("Builds cleanly");
  });

  it("requires an executed vitest run for vitest acceptance criteria", () => {
    const result = validateDelegatedOutputContract({
      spec: {
        task: "implement_core_tests",
        objective: "Add Vitest coverage for parser and router behavior",
        inputContract: "Use Vitest and report coverage",
        acceptanceCriteria: [
          "Vitest runs and passes",
          "Coverage reported",
        ],
      },
      output:
        "**implement_core_tests complete** Wrote packages/core/test/index.test.ts and added coverage cases.",
      toolCalls: [
        {
          name: "system.writeFile",
          args: {
            path: "/workspace/terrain-router-ts/packages/core/test/index.test.ts",
            content:
              "import { describe, it, expect } from 'vitest';\n",
          },
          result:
            '{"path":"/workspace/terrain-router-ts/packages/core/test/index.test.ts","bytesWritten":50}',
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("acceptance_evidence_missing");
    expect(result.error).toContain("Vitest runs and passes");
  });

  it("accepts build-oriented acceptance criteria when a matching verification command succeeds", () => {
    const result = validateDelegatedOutputContract({
      spec: {
        task: "implement_cli",
        objective:
          "Build CLI in src/cli.ts that reads stdin/file and prints the chosen schedule",
        inputContract: "Use process.argv, import core",
        acceptanceCriteria: [
          "CLI bin and logic in src/cli.ts",
          "Builds and runs correctly",
        ],
      },
      output:
        "**implement_cli complete** Wrote packages/cli/src/cli.ts and package.json. " +
        "Verified the build with npm run build.",
      toolCalls: [
        {
          name: "system.writeFile",
          args: {
            path: "/workspace/schedule-workbench/packages/cli/src/cli.ts",
            content: "console.log('cli');\n",
          },
          result:
            '{"path":"/workspace/schedule-workbench/packages/cli/src/cli.ts","bytesWritten":20}',
        },
        {
          name: "system.bash",
          args: {
            command: "npm",
            args: ["run", "build", "--workspace=@schedule-workbench/cli"],
          },
          result:
            '{"stdout":"build ok\\n","stderr":"","exitCode":0}',
        },
      ],
    });

    expect(result.ok).toBe(true);
  });

  it("rejects file-creation tasks without mutation-tool evidence", () => {
    const result = validateDelegatedOutputContract({
      spec: {
        task: "Create ALL files for the game",
        inputContract: "JSON output with files and verification",
        acceptanceCriteria: ["Create all files"],
      },
      output:
        '{"files_created":[{"path":"index.html"},{"path":"src/game.js"}]}',
      toolCalls: [{
        name: "desktop.bash",
        args: {
          command: "mkdir",
          args: ["-p", "/home/agenc/neon-heist"],
        },
        result: '{"stdout":"","stderr":"","exitCode":0}',
      }],
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("missing_file_mutation_evidence");
  });

  it("accepts shell-based scaffold commands as file mutation evidence when files are identified", () => {
    const result = validateDelegatedOutputContract({
      spec: {
        task: "core_implementation",
        objective: "Scaffold and implement the game project files",
        inputContract: "JSON output with created files",
      },
      output:
        '{"files_created":[{"path":"/workspace/neon-heist/package.json"},{"path":"/workspace/neon-heist/src/main.ts"}]}',
      toolCalls: [{
        name: "desktop.bash",
        args: {
          command:
            "cd /workspace && npm create vite@latest neon-heist -- --template vanilla-ts",
        },
        result: '{"stdout":"Scaffolding project in /workspace/neon-heist","stderr":"","exitCode":0}',
      }],
    });

    expect(result.ok).toBe(true);
  });

  it("accepts shell-mode in-place edits as file mutation evidence when files are identified", () => {
    const result = validateDelegatedOutputContract({
      spec: {
        task: "core_repair",
        objective: "Update the broken TypeScript implementation file",
        inputContract: "JSON output with updated files",
      },
      output:
        '{"files_updated":[{"path":"/workspace/neon-heist/src/index.ts"}]}',
      toolCalls: [{
        name: "system.bash",
        args: {
          command:
            "cd /workspace/neon-heist && sed -i 's/broken/fixed/' src/index.ts",
        },
        result: '{"stdout":"","stderr":"","exitCode":0}',
      }],
    });

    expect(result.ok).toBe(true);
  });

  it("accepts structured in-place edit commands as file mutation evidence when files are identified", () => {
    const result = validateDelegatedOutputContract({
      spec: {
        task: "core_repair",
        objective: "Update the broken TypeScript implementation file",
        inputContract: "JSON output with updated files",
      },
      output:
        '{"files_updated":[{"path":"/workspace/neon-heist/src/index.ts"}]}',
      toolCalls: [{
        name: "system.bash",
        args: {
          command: "sed",
          args: ["-i", "s/broken/fixed/", "src/index.ts"],
        },
        result: '{"stdout":"","stderr":"","exitCode":0}',
      }],
    });

    expect(result.ok).toBe(true);
  });

  it("rejects tool-grounded research output when every child tool call failed", () => {
    const result = validateDelegatedOutputContract({
      spec: {
        objective: "Research official docs only via mcp.browser tools",
        inputContract: "JSON output only",
        tools: ["mcp.browser.browser_navigate", "mcp.browser.browser_snapshot"],
      },
      output:
        '{"selected":"pixi","why":["small","fast","simple"],"sources":["https://pixijs.com"]}',
      toolCalls: [{
        name: "mcp.browser.browser_snapshot",
        isError: true,
        result: '{"error":"navigation failed"}',
      }],
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("missing_successful_tool_evidence");
  });

  it("rejects browser-grounded research output when the child only lists about:blank tabs", () => {
    const result = validateDelegatedOutputContract({
      spec: {
        task: "design_research",
        objective: "Research 3 reference games with browser tools and cite sources",
        inputContract: "Return markdown with 3 cited references and tuning targets",
        requiredToolCapabilities: [
          "mcp.browser.browser_navigate",
          "mcp.browser.browser_snapshot",
        ],
      },
      output:
        "- Heat Signature\n- Gunpoint\n- Monaco\n\nTuning: speed 220px/s, 3 enemies, 30s mutation.",
      toolCalls: [{
        name: "mcp.browser.browser_tabs",
        args: { action: "list" },
        result: "### Result\n- 0: (current) [](about:blank)",
      }],
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe("low_signal_browser_evidence");
    expect(result.error).toContain("browser-grounded evidence");
  });

  it("accepts browser-grounded research output when the child navigates to a real page", () => {
    const result = validateDelegatedOutputContract({
      spec: {
        task: "design_research",
        objective: "Research 3 reference games with browser tools and cite sources",
        inputContract: "Return markdown with 3 cited references and tuning targets",
        requiredToolCapabilities: [
          "mcp.browser.browser_navigate",
          "mcp.browser.browser_snapshot",
        ],
      },
      output:
        "- Heat Signature https://store.steampowered.com/app/268130/Heat_Signature/\n- Gunpoint https://store.steampowered.com/app/206190/Gunpoint/\n- Monaco https://store.steampowered.com/app/113020/Monaco_Whats_Yours_Is_Mine/",
      toolCalls: [{
        name: "mcp.browser.browser_navigate",
        args: {
          url: "https://store.steampowered.com/app/268130/Heat_Signature/",
        },
        result: '{"ok":true,"url":"https://store.steampowered.com/app/268130/Heat_Signature/"}',
      }],
    });

    expect(result.ok).toBe(true);
  });

  it("accepts Chromium validation output backed by system browser session tools", () => {
    const result = validateDelegatedOutputContract({
      spec: {
        task: "qa_and_validation",
        objective: "Validate the main web flows in Chromium and report issues",
        inputContract: "Existing local web app and CLI",
        requiredToolCapabilities: ["system.bash"],
      },
      output: "Validated the main web flows in Chromium.",
      toolCalls: [
        {
          name: "system.browserSessionStart",
          args: {
            url: "http://127.0.0.1:4173/",
            label: "freight-flow-validation",
          },
          result:
            '{"sessionId":"browser-1","url":"http://127.0.0.1:4173/","title":"Freight Flow"}',
        },
        {
          name: "system.browserAction",
          args: {
            url: "http://127.0.0.1:4173/",
            action: "waitForSelector",
            selector: "#app",
          },
          result:
            '{"url":"http://127.0.0.1:4173/","action":"waitForSelector","description":"Selector found: #app"}',
        },
      ],
    });

    expect(result.ok).toBe(true);
  });

  it("accepts Chromium validation output backed by host-side shell browser verification", () => {
    const result = validateDelegatedOutputContract({
      spec: {
        task: "qa_and_validation",
        objective:
          "Validate the running local web app in Chromium and report issues",
        inputContract: "Existing local web app and CLI",
        requiredToolCapabilities: ["system.bash"],
      },
      output:
        "Validated the main web flows in Chromium against the local app and captured the observed title.",
      toolCalls: [{
        name: "system.bash",
        args: {
          command: "npx",
          args: [
            "playwright",
            "open",
            "http://127.0.0.1:4173/",
            "--browser",
            "chromium",
          ],
        },
        result:
          '{"exitCode":0,"stdout":"Opened Chromium for http://127.0.0.1:4173/ and observed title Freight Flow","stderr":"","timedOut":false}',
      }],
    });

    expect(result.ok).toBe(true);
  });

  it("accepts research output backed by provider-native search citations", () => {
    const result = validateDelegatedOutputContract({
      spec: {
        task: "tech_research",
        objective:
          "Compare Canvas API, Phaser, and PixiJS from official docs and cite sources",
        inputContract:
          "Return JSON with selected framework, rationale, and citations",
        requiredToolCapabilities: [PROVIDER_NATIVE_WEB_SEARCH_TOOL],
      },
      output:
        '{"selected":"pixi","why":["small","fast"],"citations":["https://pixijs.com","https://docs.phaser.io"]}',
      toolCalls: [],
      providerEvidence: {
        citations: ["https://pixijs.com", "https://docs.phaser.io"],
      },
    });

    expect(result.ok).toBe(true);
  });

  it("treats the parent request as browser-grounded evidence context for research steps", () => {
    expect(specRequiresMeaningfulBrowserEvidence({
      task: "design_research",
      objective: "Summarize tuning targets",
      parentRequest:
        "Compare Canvas API, Phaser, and PixiJS from official docs and cite sources.",
    })).toBe(true);
  });

  it("accepts system.browse as meaningful research evidence for browser-grounded research output", () => {
    const result = validateDelegatedOutputContract({
      spec: {
        task: "design_research",
        objective:
          "Research reference systems from official docs and cite sources",
        inputContract:
          "Return JSON with references, extracted findings, and citations",
        requiredToolCapabilities: [
          "mcp.browser.browser_navigate",
          "mcp.browser.browser_snapshot",
        ],
      },
      output:
        '{"references":["https://pixijs.com"],"findings":["PixiJS is lightweight for 2D rendering"],"citations":["https://pixijs.com"]}',
      toolCalls: [{
        name: "system.browse",
        args: { url: "https://pixijs.com" },
        result:
          '{"url":"https://pixijs.com","text":"PixiJS is a fast, lightweight 2D library."}',
      }],
    });

    expect(result.ok).toBe(true);
  });

  it("does not reintroduce browser session tools when validation scope explicitly omits them", () => {
    const spec = {
      task: "qa_and_validation",
      objective:
        "Add meaningful Vitest coverage, CLI smoke tests, build/typecheck checks, and validate the main web flows in Chromium.",
      inputContract: "Core, CLI, and web implementation already exist",
      acceptanceCriteria: [
        "Main web flows validated in Chromium",
      ],
      requiredToolCapabilities: ["system.bash", "system.writeFile", "system.readFile"],
    };
    const resolved = resolveDelegatedChildToolScope({
      spec,
      requestedTools: spec.requiredToolCapabilities,
      parentAllowedTools: [
        "system.bash",
        "system.readFile",
        "system.writeFile",
        "system.browserSessionStart",
        "system.browserAction",
        "system.browserSessionResume",
        "system.browserSessionArtifacts",
      ],
      availableTools: [
        "system.bash",
        "system.readFile",
        "system.writeFile",
        "system.browserSessionStart",
        "system.browserAction",
        "system.browserSessionResume",
        "system.browserSessionArtifacts",
      ],
      enforceParentIntersection: true,
    });

    expect(resolved.blockedReason).toBeUndefined();
    expect(resolved.allowedTools).toEqual([
      "system.bash",
      "system.writeFile",
      "system.readFile",
    ]);
    expect(resolved.semanticFallback).toEqual([
      "system.bash",
      "system.writeFile",
    ]);
  });

  it("still keeps browser session tools when validation scope explicitly requests them", () => {
    const spec = {
      task: "qa_and_validation",
      objective:
        "Validate the main web flows in Chromium and capture browser-grounded evidence.",
      inputContract: "Web implementation already exists",
      acceptanceCriteria: [
        "Main web flows validated in Chromium",
      ],
      requiredToolCapabilities: [
        "system.bash",
        "system.browserSessionStart",
        "system.browserAction",
      ],
    };
    const resolved = resolveDelegatedChildToolScope({
      spec,
      requestedTools: spec.requiredToolCapabilities,
      parentAllowedTools: [
        "system.bash",
        "system.browserSessionStart",
        "system.browserAction",
        "system.browserSessionResume",
        "system.browserSessionArtifacts",
      ],
      availableTools: [
        "system.bash",
        "system.browserSessionStart",
        "system.browserAction",
        "system.browserSessionResume",
        "system.browserSessionArtifacts",
      ],
      enforceParentIntersection: true,
    });

    expect(resolved.allowedTools).toEqual([
      "system.bash",
      "system.browserSessionStart",
      "system.browserAction",
      "system.browserSessionResume",
      "system.browserSessionArtifacts",
    ]);
  });

  it("falls back to system.browse for research child scope when browser snapshot tools are removed by policy", () => {
    const resolved = resolveDelegatedChildToolScope({
      spec: {
        task: "design_research",
        objective:
          "Research official docs and cite sources for the simulator data model",
        inputContract:
          "Return JSON with references and extracted design findings",
      },
      requestedTools: [
        "desktop.bash",
        "mcp.browser.browser_navigate",
        "mcp.browser.browser_snapshot",
      ],
      parentAllowedTools: ["system.browse"],
      availableTools: ["system.browse"],
      enforceParentIntersection: true,
    });

    expect(resolved.blockedReason).toBeUndefined();
    expect(resolved.allowedTools).toEqual(["system.browse"]);
    expect(resolved.semanticFallback).toEqual(["system.browse"]);
  });

  it("does not let parent browser-research context force browser evidence onto validation steps", () => {
    expect(specRequiresMeaningfulBrowserEvidence({
      task: "workspace_validation",
      objective:
        "Add local CLI snapshot tests and verify output against the implemented workspace",
      parentRequest:
        "Compare official docs in the browser, cite sources, and then build the local workspace artifact.",
      inputContract: "Existing local project files only",
      acceptanceCriteria: [
        "CLI snapshot/output checks added locally",
        "Tests pass",
      ],
      requiredToolCapabilities: ["system.bash", "system.writeFile"],
    })).toBe(false);
  });

  it("treats shell verification tools as sufficient grounding for localhost browser validation", () => {
    const resolved = resolveDelegatedChildToolScope({
      spec: {
        task: "qa_and_validation",
        objective:
          "Add Vitest tests with coverage, CLI smoke tests, build/typecheck and Chromium web flow validation",
        inputContract: "Packages from prior steps",
        acceptanceCriteria: [
          "Vitest suite and coverage",
          "CLI and build checks pass",
          "Web flows validated",
        ],
        requiredToolCapabilities: ["system.bash"],
      },
      requestedTools: ["system.bash"],
      parentAllowedTools: [
        "system.bash",
        "system.writeFile",
      ],
      availableTools: [
        "system.bash",
        "system.writeFile",
      ],
      enforceParentIntersection: true,
    });

    expect(resolved.allowedTools).toEqual([
      "system.bash",
      "system.writeFile",
    ]);
    expect(resolved.blockedReason).toBeUndefined();
    expect(resolved.semanticFallback).toEqual([
      "system.bash",
      "system.writeFile",
    ]);
  });

  it("does not treat domain model terms like Network as browser interaction cues", () => {
    expect(specRequiresMeaningfulBrowserEvidence({
      task: "design_research",
      objective:
        "define the rules and data model for a rail-freight dispatch simulator with shared single-track segments, passing sidings, timed cargo deadlines, and switch locks",
      parentRequest:
        "Create /home/tetsuo/agent-test/freight-flow-ts-05 from scratch. Build a TypeScript npm-workspaces monorepo with packages core, cli, and web. Assigned phase only: design_research. Ignore broader orchestration instructions and other phases.",
      inputContract:
        "Empty target directory /home/tetsuo/agent-test/freight-flow-ts-05",
      acceptanceCriteria: [
        "Design document detailing data models (Network/Train/Job/Scenario), simulation rules, deadlock detection, planner approach, and conflict handling",
      ],
      requiredToolCapabilities: [
        "system.bash",
        "system.readFile",
        "system.writeFile",
        "system.listDir",
      ],
    })).toBe(false);
  });

  it("does not inherit Chromium-only parent context into a file-authoring design step", () => {
    expect(specRequiresMeaningfulBrowserEvidence({
      task: "design_research",
      objective:
        "define the rules and data model for a rail-freight dispatch simulator with shared single-track segments, passing sidings, timed cargo deadlines, and switch locks.",
      parentRequest:
        "Create /home/tetsuo/agent-test/freight-flow-ts-06 from scratch. Build a TypeScript npm-workspaces monorepo with packages core, cli, and web. Sub-agent orchestration plan (required): design_research, tech_research, core_implementation, ai_and_systems, qa_and_validation, polish_and_docs. Web must be Vite + React with 2 built-in demo scenarios and a step-through timeline visualization. Validate the main web flows in Chromium.",
      inputContract: "User request, simulation rules, and hard requirements",
      acceptanceCriteria: [
        "Design document or TS interfaces for Network/Train/Job/Scenario models authored",
        "Rules for conflicts, single-track, locks, deadlines, deadlock documented in workspace",
      ],
      requiredToolCapabilities: [
        "system.bash",
        "system.writeFile",
        "system.readFile",
        "system.listDir",
      ],
    })).toBe(false);
  });

  it("does not treat generic reference-to-logs language as browser-grounded", () => {
    expect(specRequiresMeaningfulBrowserEvidence({
      task: "delegate_a",
      objective: "Analyze timeout clusters",
      inputContract: "Return findings with evidence in JSON",
      acceptanceCriteria: ["Evidence references logs"],
      requiredToolCapabilities: ["system.readFile"],
    })).toBe(false);
  });

  it("does not treat CLI snapshot test language as browser-grounded", () => {
    expect(specRequiresMeaningfulBrowserEvidence({
      task: "demos_and_tests",
      objective:
        "Add demo maps in demos/, comprehensive Vitest tests covering parser/weights/portals/conveyors/unreachable cases and CLI behavior.",
      inputContract: "Core and CLI implemented",
      acceptanceCriteria: [
        "Demo map files present under demos/",
        "Vitest suite with full coverage for all features",
        "Tests include CLI snapshot/output checks",
        "All tests pass",
      ],
      requiredToolCapabilities: [
        "system.bash",
        "system.writeFile",
        "system.readFile",
      ],
    })).toBe(false);
  });

  it("does not treat local monorepo web-package setup as browser-grounded", () => {
    expect(specRequiresMeaningfulBrowserEvidence({
      task: "setup_monorepo",
      objective:
        "Create root package.json with workspaces, tsconfig, and basic package.json for core/cli/web.",
      parentRequest:
        "Build a TypeScript monorepo with packages/core, packages/cli, and packages/web. The web package should visualize pathfinding step-by-step in the browser.",
      inputContract: "Empty target dir /home/tetsuo/agent-test/maze-forge-ts-02",
      acceptanceCriteria: [
        "workspaces configured",
        "package.jsons created",
        "TS configs present",
      ],
      requiredToolCapabilities: ["system.bash", "system.writeFile"],
    })).toBe(false);
  });

  it("does not treat negative browser exclusions on local docs review as browser-grounded", () => {
    expect(specRequiresMeaningfulBrowserEvidence({
      task:
        "Inspect docs/RUNTIME_API.md Delegation Runtime Surface and Stateful Response Compaction sections using only non-browser tools. Return one short bullet with one autonomy risk.",
      objective:
        "Identify and output exactly one short bullet describing one autonomy risk from the sections",
      inputContract: "Read-only access to docs/RUNTIME_API.md via text_editor",
      acceptanceCriteria: [
        "Exactly one short bullet output",
        "No browser tools used",
        "Risk tied to delegation or compaction",
      ],
      tools: ["desktop.text_editor", "desktop.bash"],
    })).toBe(false);
  });

  it("does not let parent implementation instructions force file artifacts onto research steps", () => {
    const result = validateDelegatedOutputContract({
      spec: {
        task: "design_research",
        objective: "Research 3 reference games and summarize tuning targets",
        parentRequest:
          "Build the browser game, create project files, implement gameplay, and return a working artifact.",
        inputContract: "JSON output with references and tuning only",
        acceptanceCriteria: ["Exactly 3 references", "Include tuning targets"],
        requiredToolCapabilities: ["mcp.browser.browser_navigate"],
      },
      output:
        '{"references":[{"name":"Heat Signature","url":"https://store.steampowered.com/app/268130/Heat_Signature/"},{"name":"Gunpoint","url":"https://store.steampowered.com/app/206190/Gunpoint/"},{"name":"Monaco","url":"https://store.steampowered.com/app/113020/Monaco_Whats_Yours_Is_Mine/"}],"tuning":{"speed":220,"enemyCount":3,"mutationIntervalSeconds":30}}',
      toolCalls: [{
        name: "mcp.browser.browser_navigate",
        args: {
          url: "https://store.steampowered.com/app/268130/Heat_Signature/",
        },
        result: '{"ok":true,"url":"https://store.steampowered.com/app/268130/Heat_Signature/"}',
      }],
    });

    expect(result.ok).toBe(true);
  });

  it("does not require file mutation evidence for tech research that only defines project structure in output", () => {
    expect(specRequiresFileMutationEvidence({
      task: "tech_research",
      objective:
        "Compare Canvas API, Phaser, and Pixi from official docs. Pick one with rationale and define project structure and performance constraints.",
      inputContract: "JSON output with framework choice, structure, and perf constraints",
      acceptanceCriteria: [
        "Name the selected framework",
        "Define project structure",
        "List performance constraints",
      ],
      requiredToolCapabilities: [
        "mcp.browser.browser_navigate",
        "mcp.browser.browser_snapshot",
      ],
    })).toBe(false);
  });

  it("does not require file mutation evidence for documentation-only summaries", () => {
    expect(specRequiresFileMutationEvidence({
      task: "polish_and_docs",
      objective:
        "Improve UX clarity and produce concise architecture and how-to-play docs.",
      inputContract:
        "Return concise architecture summary, how to play, and known limitations",
      acceptanceCriteria: [
        "Summarize architecture",
        "Explain how to play",
        "List known limitations",
      ],
    })).toBe(false);
  });

  it("requires file mutation evidence for validation-shaped test authoring tasks", () => {
    expect(specRequiresFileMutationEvidence({
      task: "write_tests",
      objective: "Add >=8 vitest tests for parser and algos in tests/",
      inputContract: "vitest format",
      acceptanceCriteria: ["8+ tests covering edge cases"],
      requiredToolCapabilities: ["code_generation"],
    })).toBe(true);
  });

  it("requires file mutation evidence for demo-and-test authoring phases", () => {
    expect(specRequiresFileMutationEvidence({
      task: "add_demos_tests",
      objective: "Add demo maps and comprehensive tests",
      inputContract: "CLI+core implemented",
      acceptanceCriteria: [
        "3 ASCII demo maps in demos/, >=8 tests in tests/ covering algos/portals/weights",
        "tests pass",
      ],
      requiredToolCapabilities: ["file_write"],
    })).toBe(true);
  });

  it("requires file mutation evidence when documentation explicitly creates files", () => {
    expect(specRequiresFileMutationEvidence({
      task: "polish_and_docs",
      objective: "Create README.md and docs/architecture.md for the game",
      inputContract: "Name the documentation files created",
      acceptanceCriteria: ["Create README.md", "Create docs/architecture.md"],
    })).toBe(true);
  });

  it("does not require file mutation evidence for read-only local docs review that allows desktop.text_editor", () => {
    expect(specRequiresFileMutationEvidence({
      task:
        "Inspect docs/RUNTIME_API.md Delegation Runtime Surface and Stateful Response Compaction sections using only non-browser tools. Return one short bullet with one autonomy risk.",
      objective:
        "Identify and output exactly one short bullet describing one autonomy risk from the sections",
      inputContract: "Read-only access to docs/RUNTIME_API.md via text_editor",
      acceptanceCriteria: [
        "Exactly one short bullet output",
        "No browser tools used",
        "Risk tied to delegation or compaction",
      ],
      tools: ["desktop.text_editor", "desktop.bash"],
    })).toBe(false);
  });

  it("flags unsupported narrative file claims without write evidence", () => {
    const unsupported = hasUnsupportedNarrativeFileClaims(
      "Created `/tmp/game/index.html` and `/tmp/game/game.js`.",
      [{
        name: "system.bash",
        args: {
          command: "mkdir",
          args: ["-p", "/tmp/game"],
        },
        result: '{"exitCode":0}',
      }],
    );

    const supported = hasUnsupportedNarrativeFileClaims(
      "Created `/tmp/game/index.html` and `/tmp/game/game.js`.",
      [{
        name: "execute_with_agent",
        result:
          '{"success":true,"output":"{\\"files_created\\":[{\\"path\\":\\"/tmp/game/index.html\\"},{\\"path\\":\\"/tmp/game/game.js\\"}]}"}',
      }],
    );

    expect(unsupported).toBe(true);
    expect(supported).toBe(false);
  });

  it("does not treat directory-only success claims as unsupported file claims", () => {
    expect(contentHasExplicitFileArtifact("Created `/workspace/pong`.")).toBe(false);

    const supported = hasUnsupportedNarrativeFileClaims(
      "Created the folder `/workspace/pong`.",
      [{
        name: "desktop.bash",
        args: {
          command: "mkdir -p /workspace/pong",
        },
        result: '{"exitCode":0,"stdout":"","stderr":""}',
      }],
    );

    expect(supported).toBe(false);
  });

  it("prunes low-signal browser tabs when meaningful browser tools are available", () => {
    const refined = refineDelegatedChildToolAllowlist({
      spec: {
        task: "design_research",
        objective: "Research 3 reference games with browser tools and cite sources",
        requiredToolCapabilities: [
          "mcp.browser.browser_navigate",
          "mcp.browser.browser_snapshot",
        ],
      },
      tools: [
        "mcp.browser.browser_tabs",
        "mcp.browser.browser_navigate",
        "mcp.browser.browser_snapshot",
      ],
    });

    expect(refined.blockedReason).toBeUndefined();
    expect(refined.allowedTools).toEqual([
      "mcp.browser.browser_navigate",
      "mcp.browser.browser_snapshot",
    ]);
    expect(refined.removedLowSignalBrowserTools).toEqual([
      "mcp.browser.browser_tabs",
    ]);
  });

  it("fails fast when browser-grounded work only has low-signal tab inspection tools", () => {
    const refined = refineDelegatedChildToolAllowlist({
      spec: {
        task: "design_research",
        objective: "Research 3 reference games with browser tools and cite sources",
        requiredToolCapabilities: [
          "mcp.browser.browser_navigate",
          "mcp.browser.browser_snapshot",
        ],
      },
      tools: ["mcp.browser.browser_tabs"],
    });

    expect(refined.allowedTools).toEqual([]);
    expect(refined.blockedReason).toContain("low-signal browser state checks");
  });

  it("recovers direct child scope to desktop-safe semantic fallback tools", () => {
    const resolved = resolveDelegatedChildToolScope({
      spec: {
        task: "core_implementation",
        objective: "Scaffold and implement the game files in the desktop workspace",
        inputContract: "JSON output with created files",
      },
      requestedTools: ["system.bash", "system.writeFile"],
      parentAllowedTools: [
        "desktop.bash",
        "desktop.text_editor",
        "mcp.neovim.vim_edit",
        "mcp.neovim.vim_buffer_save",
      ],
      availableTools: [
        "desktop.bash",
        "desktop.text_editor",
        "mcp.neovim.vim_edit",
        "mcp.neovim.vim_buffer_save",
      ],
      enforceParentIntersection: true,
    });

    expect(resolved.allowedTools).toEqual([
      "desktop.bash",
      "desktop.text_editor",
    ]);
    expect(resolved.removedByPolicy).toEqual([
      "system.bash",
      "system.writeFile",
    ]);
    expect(resolved.semanticFallback).toEqual([
      "desktop.bash",
      "desktop.text_editor",
    ]);
  });

  it("preserves explicitly requested concrete tools for browser-grounded research child scope", () => {
    const resolved = resolveDelegatedChildToolScope({
      spec: {
        task: "design_research",
        objective: "Research 3 reference games from official sources and cite them",
        inputContract: "JSON output with references and tuning",
      },
      requestedTools: [
        "desktop.bash",
        "mcp.browser.browser_navigate",
        "mcp.browser.browser_snapshot",
      ],
      parentAllowedTools: [
        "desktop.bash",
        "mcp.browser.browser_navigate",
        "mcp.browser.browser_snapshot",
      ],
      availableTools: [
        "desktop.bash",
        "mcp.browser.browser_navigate",
        "mcp.browser.browser_snapshot",
      ],
      enforceParentIntersection: true,
    });

    expect(resolved.allowedTools).toEqual([
      "desktop.bash",
      "mcp.browser.browser_navigate",
      "mcp.browser.browser_snapshot",
    ]);
    expect(resolved.semanticFallback).toEqual([
      "mcp.browser.browser_navigate",
      "mcp.browser.browser_snapshot",
    ]);
  });

  it("preserves explicit file inspection tools for implementation child scope", () => {
    const resolved = resolveDelegatedChildToolScope({
      spec: {
        task: "core_implementation",
        objective:
          "Implement the terrain router in packages/core and inspect existing files before editing",
        inputContract: "Workspace scaffold already exists",
        acceptanceCriteria: [
          "Implementation compiles",
          "Existing package files are inspected before changes",
        ],
        requiredToolCapabilities: [
          "system.bash",
          "system.writeFile",
          "system.readFile",
          "system.listDir",
        ],
      },
      requestedTools: [
        "system.bash",
        "system.writeFile",
        "system.readFile",
        "system.listDir",
      ],
      parentAllowedTools: [
        "system.bash",
        "system.writeFile",
        "system.readFile",
        "system.listDir",
      ],
      availableTools: [
        "system.bash",
        "system.writeFile",
        "system.readFile",
        "system.listDir",
      ],
      enforceParentIntersection: true,
    });

    expect(resolved.allowedTools).toEqual([
      "system.bash",
      "system.writeFile",
      "system.readFile",
      "system.listDir",
    ]);
    expect(resolved.semanticFallback).toEqual([
      "system.bash",
      "system.writeFile",
    ]);
  });

  it("maps generic workspace validation capabilities onto system.bash when desktop shell is unavailable", () => {
    const resolved = resolveDelegatedChildToolScope({
      spec: {
        task: "workspace_validation",
        objective: "Run git status --short in the workspace and confirm the command succeeds",
        requiredToolCapabilities: ["workspace", "command_execution"],
        acceptanceCriteria: ["The git status command exits successfully"],
      },
      parentAllowedTools: ["system.bash"],
      availableTools: ["system.bash"],
      enforceParentIntersection: true,
    });

    expect(resolved.allowedTools).toEqual(["system.bash"]);
    expect(resolved.semanticFallback).toEqual(["system.bash"]);
    expect(resolved.blockedReason).toBeUndefined();
  });

  it("allows toolless execution for context-only recall steps with abstract capabilities", () => {
    const resolved = resolveDelegatedChildToolScope({
      spec: {
        task: "recover_marker",
        objective:
          "Recover the earlier continuity marker from parent conversation context only; do not invent missing facts",
        inputContract: "Provided recent conversation context and partial response",
        acceptanceCriteria: ["Recover the exact prior marker from context only"],
        requiredToolCapabilities: ["context_retrieval"],
      },
      requestedTools: ["context_retrieval"],
      parentAllowedTools: ["desktop.bash", "desktop.text_editor"],
      availableTools: ["desktop.bash", "desktop.text_editor"],
      enforceParentIntersection: true,
    });

    expect(resolved.allowedTools).toEqual([]);
    expect(resolved.allowsToollessExecution).toBe(true);
    expect(resolved.blockedReason).toBeUndefined();
    expect(resolved.semanticFallback).toEqual([]);
  });

  it("adds provider-native web search without stripping explicit browser tools for research child scope", () => {
    const resolved = resolveDelegatedChildToolScope({
      spec: {
        task: "tech_research",
        objective:
          "Compare Canvas API, Phaser, and PixiJS from official docs and cite sources",
        inputContract: "Return JSON with framework choice and citations",
      },
      requestedTools: [
        "mcp.browser.browser_navigate",
        "mcp.browser.browser_snapshot",
      ],
      parentAllowedTools: [
        PROVIDER_NATIVE_WEB_SEARCH_TOOL,
        "mcp.browser.browser_navigate",
        "mcp.browser.browser_snapshot",
      ],
      availableTools: [
        PROVIDER_NATIVE_WEB_SEARCH_TOOL,
        "mcp.browser.browser_navigate",
        "mcp.browser.browser_snapshot",
      ],
      enforceParentIntersection: true,
    });

    expect(resolved.allowedTools).toEqual([
      "mcp.browser.browser_navigate",
      "mcp.browser.browser_snapshot",
      PROVIDER_NATIVE_WEB_SEARCH_TOOL,
    ]);
    expect(resolved.semanticFallback).toEqual([
      PROVIDER_NATIVE_WEB_SEARCH_TOOL,
      "mcp.browser.browser_navigate",
      "mcp.browser.browser_snapshot",
    ]);
  });

  it("keeps local file inspection tools for repository docs review instead of switching to provider-native search", () => {
    const resolved = resolveDelegatedChildToolScope({
      spec: {
        task:
          "Inspect docs/RUNTIME_API.md Delegation Runtime Surface and Stateful Response Compaction sections",
        objective:
          "Extract key details from specified sections then pinpoint one autonomy-validation risk/mismatch with direct quote or reference.",
      },
      parentAllowedTools: [
        "desktop.text_editor",
        PROVIDER_NATIVE_WEB_SEARCH_TOOL,
      ],
      availableTools: [
        "desktop.text_editor",
        PROVIDER_NATIVE_WEB_SEARCH_TOOL,
      ],
      enforceParentIntersection: true,
    });

    expect(resolved.allowedTools).toEqual(["desktop.text_editor"]);
    expect(resolved.semanticFallback).toEqual(["desktop.text_editor"]);
  });

  it("keeps read-only local docs review scoped to desktop.text_editor even when browser tools are excluded in criteria", () => {
    const resolved = resolveDelegatedChildToolScope({
      spec: {
        task:
          "Inspect docs/RUNTIME_API.md Delegation Runtime Surface and Stateful Response Compaction sections using only non-browser tools. Return one short bullet with one autonomy risk.",
        objective:
          "Identify and output exactly one short bullet describing one autonomy risk from the sections",
        inputContract: "Read-only access to docs/RUNTIME_API.md via text_editor",
        acceptanceCriteria: [
          "Exactly one short bullet output",
          "No browser tools used",
          "Risk tied to delegation or compaction",
        ],
        tools: ["desktop.text_editor", "desktop.bash"],
      },
      parentAllowedTools: [
        "desktop.text_editor",
        "desktop.bash",
        "mcp.browser.browser_navigate",
      ],
      availableTools: [
        "desktop.text_editor",
        "desktop.bash",
        "mcp.browser.browser_navigate",
      ],
      enforceParentIntersection: true,
    });

    expect(resolved.allowedTools).toEqual(["desktop.text_editor"]);
    expect(resolved.semanticFallback).toEqual(["desktop.text_editor"]);
  });

  it("keeps shell and file-mutation tools for setup-heavy local implementation work", () => {
    const resolved = resolveDelegatedChildToolScope({
      spec: {
        task: "init_npm",
        objective:
          "Run npm init -y, install typescript vitest commander chalk, configure package.json scripts/bin, tsconfig.json",
        inputContract:
          "Stay strictly in /home/tetsuo/agent-test/grid-router-ts use only npm/ts",
        acceptanceCriteria: [
          "package.json updated with scripts/cli",
          "tsconfig.json present",
          "deps installed",
        ],
        requiredToolCapabilities: ["bash"],
      },
      requestedTools: ["bash"],
      parentAllowedTools: [
        "system.bash",
        "system.readFile",
        "system.writeFile",
        "system.listDir",
      ],
      availableTools: [
        "system.bash",
        "system.readFile",
        "system.writeFile",
        "system.listDir",
      ],
      enforceParentIntersection: true,
    });

    expect(resolved.allowedTools).toEqual([
      "system.bash",
      "system.writeFile",
    ]);
    expect(resolved.semanticFallback).toEqual([
      "system.bash",
      "system.writeFile",
    ]);
    expect(resolved.blockedReason).toBeUndefined();
  });

  it("does not collapse CLI implementation work with mechanics output into research-only tools", () => {
    const spec = {
      task: "implement_cli",
      objective:
        "Implement CLI in packages/cli: bin command to load map file, invoke core solver, print route steps, total cost, and mechanics explanation.",
      inputContract: "Scaffolded cli with core dep",
      acceptanceCriteria: [
        "CLI bin script present and integrates core",
        "Command produces required output format",
      ],
      requiredToolCapabilities: ["file_system_write"],
    };
    const resolved = resolveDelegatedChildToolScope({
      spec,
      requestedTools: spec.requiredToolCapabilities,
      parentAllowedTools: [
        "system.bash",
        "system.readFile",
        "system.writeFile",
        PROVIDER_NATIVE_WEB_SEARCH_TOOL,
      ],
      availableTools: [
        "system.bash",
        "system.readFile",
        "system.writeFile",
        PROVIDER_NATIVE_WEB_SEARCH_TOOL,
      ],
      enforceParentIntersection: true,
    });

    expect(specRequiresFileMutationEvidence(spec)).toBe(true);
    expect(resolved.allowedTools).toEqual([
      "system.writeFile",
      "system.bash",
    ]);
    expect(resolved.semanticFallback).toEqual([
      "system.bash",
      "system.writeFile",
    ]);
  });

  it("treats in-browser web app authoring as implementation when file-write capability is required", () => {
    const spec = {
      task: "implement_web",
      objective:
        "Create Vite TS app in packages/web with map editor UI, in-browser solver using core, canvas visualization of path and cost.",
      inputContract: "Scaffolded web with core dep",
      acceptanceCriteria: [
        "Vite config and basic interactive app with edit/solve/visualize flow",
      ],
      requiredToolCapabilities: ["file_system_write"],
    };
    const resolved = resolveDelegatedChildToolScope({
      spec,
      requestedTools: spec.requiredToolCapabilities,
      parentAllowedTools: [
        "system.bash",
        "system.readFile",
        "system.writeFile",
        "system.listDir",
      ],
      availableTools: [
        "system.bash",
        "system.readFile",
        "system.writeFile",
        "system.listDir",
      ],
      enforceParentIntersection: true,
    });

    expect(specRequiresFileMutationEvidence(spec)).toBe(true);
    expect(specRequiresMeaningfulBrowserEvidence(spec)).toBe(false);
    expect(resolved.allowedTools).toEqual([
      "system.writeFile",
      "system.bash",
    ]);
    expect(resolved.semanticFallback).toEqual([
      "system.bash",
      "system.writeFile",
    ]);
  });

  it("keeps file-mutation tools for validation-shaped test authoring work", () => {
    const resolved = resolveDelegatedChildToolScope({
      spec: {
        task: "write_tests",
        objective: "Add >=8 vitest tests for parser and algos in tests/",
        inputContract: "vitest format",
        acceptanceCriteria: ["8+ tests covering edge cases"],
        requiredToolCapabilities: ["code_generation"],
      },
      requestedTools: ["code_generation"],
      parentAllowedTools: [
        "system.bash",
        "system.readFile",
        "system.writeFile",
      ],
      availableTools: [
        "system.bash",
        "system.readFile",
        "system.writeFile",
      ],
      enforceParentIntersection: true,
    });

    expect(resolved.allowedTools).toEqual([
      "system.writeFile",
      "system.bash",
    ]);
    expect(resolved.semanticFallback).toEqual([
      "system.bash",
      "system.writeFile",
    ]);
  });

  it("keeps file-mutation tools for demo-and-test authoring work", () => {
    const resolved = resolveDelegatedChildToolScope({
      spec: {
        task: "add_demos_tests",
        objective: "Add demo maps and comprehensive tests",
        inputContract: "CLI+core implemented",
        acceptanceCriteria: [
          "3 ASCII demo maps in demos/, >=8 tests in tests/ covering algos/portals/weights",
          "tests pass",
        ],
        requiredToolCapabilities: ["file_write"],
      },
      requestedTools: ["file_write"],
      parentAllowedTools: [
        "system.bash",
        "system.readFile",
        "system.writeFile",
        "system.listDir",
      ],
      availableTools: [
        "system.bash",
        "system.readFile",
        "system.writeFile",
        "system.listDir",
      ],
      enforceParentIntersection: true,
    });

    expect(resolved.allowedTools).toEqual([
      "system.writeFile",
      "system.bash",
    ]);
    expect(resolved.semanticFallback).toEqual([
      "system.bash",
      "system.writeFile",
    ]);
    expect(resolved.removedByPolicy).toEqual([
      "system.appendFile",
    ]);
  });

  it("maps semantic file_read capability requests onto explicit read tools", () => {
    const resolved = resolveDelegatedChildToolScope({
      spec: {
        task: "core_implementation",
        objective:
          "Implement packages/core and inspect existing source and package files before editing",
        inputContract: "Workspace scaffold already exists",
        acceptanceCriteria: [
          "Implementation compiles",
          "Existing package files are inspected before changes",
        ],
        requiredToolCapabilities: ["file_write", "file_read", "bash"],
      },
      requestedTools: ["file_write", "file_read", "bash"],
      parentAllowedTools: [
        "system.bash",
        "system.writeFile",
        "system.readFile",
        "system.listDir",
      ],
      availableTools: [
        "system.bash",
        "system.writeFile",
        "system.readFile",
        "system.listDir",
      ],
      enforceParentIntersection: true,
    });

    expect(resolved.allowedTools).toEqual([
      "system.readFile",
      "system.listDir",
      "system.writeFile",
      "system.bash",
    ]);
    expect(resolved.semanticFallback).toEqual([
      "system.bash",
      "system.writeFile",
    ]);
    expect(resolved.removedByPolicy).toEqual([
      "system.appendFile",
      "desktop.bash",
    ]);
  });

  it("does not block local CLI snapshot test work as browser-grounded", () => {
    const resolved = resolveDelegatedChildToolScope({
      spec: {
        task: "demos_and_tests",
        objective:
          "Add demo maps in demos/, comprehensive Vitest tests covering parser/weights/portals/conveyors/unreachable cases and CLI behavior.",
        parentRequest:
          "Build /home/tetsuo/agent-test/terrain-router-ts-5 with demos/, Vitest coverage, and CLI behavior checks.",
        inputContract: "Core and CLI implemented",
        acceptanceCriteria: [
          "Demo map files present under demos/",
          "Vitest suite with full coverage for all features",
          "Tests include CLI snapshot/output checks",
          "All tests pass",
        ],
        requiredToolCapabilities: [
          "system.bash",
          "system.writeFile",
          "system.readFile",
        ],
      },
      requestedTools: [
        "system.bash",
        "system.writeFile",
        "system.readFile",
      ],
      parentAllowedTools: [
        "system.bash",
        "system.readFile",
        "system.writeFile",
        "system.listDir",
      ],
      availableTools: [
        "system.bash",
        "system.readFile",
        "system.writeFile",
        "system.listDir",
      ],
      enforceParentIntersection: true,
    });

    expect(resolved.allowedTools).toEqual([
      "system.bash",
      "system.writeFile",
      "system.readFile",
    ]);
    expect(resolved.blockedReason).toBeUndefined();
  });

  it("does not block local monorepo setup when the parent request mentions a browser-facing web package", () => {
    const resolved = resolveDelegatedChildToolScope({
      spec: {
        task: "setup_monorepo",
        objective:
          "Create root package.json with workspaces, tsconfig, and basic package.json for core/cli/web.",
        parentRequest:
          "Build /home/tetsuo/agent-test/maze-forge-ts-02 as a TypeScript monorepo with packages/core, packages/cli, and packages/web, where the web package visualizes pathfinding in the browser.",
        inputContract:
          "Empty target dir /home/tetsuo/agent-test/maze-forge-ts-02",
        acceptanceCriteria: [
          "workspaces configured",
          "package.jsons created",
          "TS configs present",
        ],
        requiredToolCapabilities: ["system.bash", "system.writeFile"],
      },
      requestedTools: ["system.bash", "system.writeFile"],
      parentAllowedTools: [
        "system.bash",
        "system.writeFile",
        "system.readFile",
        "system.listDir",
      ],
      availableTools: [
        "system.bash",
        "system.writeFile",
        "system.readFile",
        "system.listDir",
      ],
      enforceParentIntersection: true,
    });

    expect(resolved.allowedTools).toEqual([
      "system.bash",
      "system.writeFile",
    ]);
    expect(resolved.blockedReason).toBeUndefined();
  });

  it("preserves mutation and verification tools after acceptance-evidence failures on implementation steps", () => {
    const toolNames = resolveDelegatedCorrectionToolChoiceToolNames(
      {
        task: "implement_cli",
        objective:
          "Build CLI in src/cli.ts that accepts stdin/file, runs chosen algo, prints length/cost/visited/overlay",
        inputContract: "Use process.argv, import core",
        acceptanceCriteria: ["Compiles to dist/cli.js, correct output format"],
      },
      ["system.bash", "system.writeFile"],
      "acceptance_evidence_missing",
    );

    expect(toolNames).toEqual(["system.bash", "system.writeFile"]);
  });

  it("preserves mutation and verification tools after contradictory completion claims on implementation steps", () => {
    const toolNames = resolveDelegatedCorrectionToolChoiceToolNames(
      {
        task: "implement_cli",
        objective:
          "Build CLI in src/cli.ts that accepts stdin/file, runs chosen algo, prints length/cost/visited/overlay",
        inputContract: "Use process.argv, import core",
        acceptanceCriteria: ["Compiles to dist/cli.js, correct output format"],
      },
      ["system.bash", "system.writeFile"],
      "contradictory_completion_claim",
    );

    expect(toolNames).toEqual(["system.writeFile", "system.bash"]);
  });

  it("preserves mutation and verification tools after blocked phase outputs on implementation steps", () => {
    const toolNames = resolveDelegatedCorrectionToolChoiceToolNames(
      {
        task: "implement_cli",
        objective:
          "Build CLI in src/cli.ts that accepts stdin/file, runs chosen algo, prints length/cost/visited/overlay",
        inputContract: "Use process.argv, import core",
        acceptanceCriteria: ["Compiles to dist/cli.js, correct output format"],
      },
      ["system.bash", "system.writeFile"],
      "blocked_phase_output",
    );

    expect(toolNames).toEqual(["system.writeFile", "system.bash"]);
  });

  it("preserves verification and mutation tools after low-signal browser evidence on validation-heavy implementation steps", () => {
    const toolNames = resolveDelegatedCorrectionToolChoiceToolNames(
      {
        task: "qa_and_validation",
        objective:
          "Add tests, fix build issues, and validate the main web flows in Chromium",
        inputContract: "Core, CLI, and web implementation already exist",
        acceptanceCriteria: [
          "Vitest passes",
          "Build/typecheck succeed",
          "Main web flows validated in Chromium",
        ],
      },
      ["system.bash", "system.writeFile"],
      "low_signal_browser_evidence",
    );

    expect(toolNames).toEqual(["system.bash", "system.writeFile"]);
  });

  it("steers forbidden phase-action retries back toward inspection and file mutation tools", () => {
    const toolNames = resolveDelegatedCorrectionToolChoiceToolNames(
      {
        task: "scaffold_manifests",
        objective:
          "Author only manifests/configs and do not execute install/build/test commands in this phase",
        acceptanceCriteria: [
          "No install/build/test commands executed or claimed",
        ],
      },
      ["system.bash", "system.writeFile", "system.readFile", "system.listDir"],
      "forbidden_phase_action",
    );

    expect(toolNames).toEqual(["system.listDir", "system.writeFile"]);
  });

  it("resolves a navigation-first initial tool choice for browser-grounded work", () => {
    const toolChoice = resolveDelegatedInitialToolChoiceToolName(
      {
        task: "design_research",
        objective: "Research reference games from official docs and cite sources",
      },
      [
        "mcp.browser.browser_tabs",
        "mcp.browser.browser_snapshot",
        "mcp.browser.browser_navigate",
      ],
    );

    expect(toolChoice).toBe("mcp.browser.browser_navigate");
  });

  it("resolves provider-native web search as the initial tool choice for research", () => {
    const toolChoice = resolveDelegatedInitialToolChoiceToolName(
      {
        task: "tech_research",
        objective:
          "Compare Canvas API, Phaser, and PixiJS from official docs and cite sources",
      },
      [
        "mcp.browser.browser_navigate",
        PROVIDER_NATIVE_WEB_SEARCH_TOOL,
      ],
    );

    expect(toolChoice).toBe(PROVIDER_NATIVE_WEB_SEARCH_TOOL);
  });

  it("resolves system.browse as the initial tool choice for research when available", () => {
    const toolChoice = resolveDelegatedInitialToolChoiceToolName(
      {
        task: "design_research",
        objective:
          "Research official docs and cite sources for the simulator data model",
      },
      [
        "system.browserSessionStart",
        "system.browse",
      ],
    );

    expect(toolChoice).toBe("system.browse");
  });

  it("resolves a local file inspection tool before provider-native search for repository docs review", () => {
    const toolChoice = resolveDelegatedInitialToolChoiceToolName(
      {
        task:
          "Inspect docs/RUNTIME_API.md Delegation Runtime Surface and Stateful Response Compaction sections",
        objective:
          "Extract key details from specified sections then pinpoint one autonomy-validation risk/mismatch with direct quote or reference.",
      },
      [
        "desktop.text_editor",
        PROVIDER_NATIVE_WEB_SEARCH_TOOL,
      ],
    );

    expect(toolChoice).toBe("desktop.text_editor");
  });

  it("resolves desktop.text_editor first for read-only local docs review even when browser use is explicitly forbidden", () => {
    const toolChoice = resolveDelegatedInitialToolChoiceToolName(
      {
        task:
          "Inspect docs/RUNTIME_API.md Delegation Runtime Surface and Stateful Response Compaction sections using only non-browser tools. Return one short bullet with one autonomy risk.",
        objective:
          "Identify and output exactly one short bullet describing one autonomy risk from the sections",
        inputContract: "Read-only access to docs/RUNTIME_API.md via text_editor",
        acceptanceCriteria: [
          "Exactly one short bullet output",
          "No browser tools used",
          "Risk tied to delegation or compaction",
        ],
        tools: ["desktop.text_editor", "desktop.bash"],
      },
      [
        "desktop.text_editor",
        "desktop.bash",
        "mcp.browser.browser_navigate",
      ],
    );

    expect(toolChoice).toBe("desktop.text_editor");
  });

  it("resolves an editor-first initial tool choice for implementation work", () => {
    const toolChoice = resolveDelegatedInitialToolChoiceToolName(
      {
        task: "core_implementation",
        objective: "Implement the project files and game loop",
      },
      [
        "desktop.bash",
        "desktop.text_editor",
        "mcp.neovim.vim_edit",
      ],
    );

    expect(toolChoice).toBe("desktop.text_editor");
  });

  it("resolves file mutation first for validation-heavy test authoring work", () => {
    const toolChoice = resolveDelegatedInitialToolChoiceToolName(
      {
        task: "demos_tests",
        objective:
          "Add demo maps and comprehensive Vitest tests covering parser, portals, conveyors, unreachable maps, and CLI behavior.",
        acceptanceCriteria: [
          "Demo maps present",
          "All tests pass with Vitest",
          "Coverage for required cases",
        ],
      },
      [
        "system.bash",
        "system.writeFile",
      ],
    );

    expect(toolChoice).toBe("system.writeFile");
  });

  it("prefers shell-first on retried verification-heavy implementation work after missing evidence", () => {
    const toolChoice = resolveDelegatedInitialToolChoiceToolName(
      {
        task: "demos_tests",
        objective:
          "Add demo maps and comprehensive Vitest tests covering parser, portals, conveyors, unreachable maps, and CLI behavior.",
        acceptanceCriteria: [
          "Demo maps present",
          "All tests pass with Vitest",
          "Coverage for required cases",
        ],
        lastValidationCode: "acceptance_evidence_missing",
      },
      [
        "system.bash",
        "system.writeFile",
      ],
    );

    expect(toolChoice).toBe("system.bash");
  });

  it("keeps inspection, mutation, and verification tools available for local implementation phases", () => {
    const toolNames = resolveDelegatedInitialToolChoiceToolNames(
      {
        task: "implement_core",
        objective:
          "Implement packages/core/src/index.ts and keep the workspace buildable",
        inputContract: "Existing TypeScript workspace already scaffolded",
        acceptanceCriteria: [
          "npm run build --workspace=@maze-forge/core succeeds",
        ],
      },
      [
        "system.bash",
        "system.writeFile",
        "system.readFile",
        "system.listDir",
      ],
    );

    expect(toolNames).toEqual([
      "system.readFile",
      "system.writeFile",
      "system.bash",
    ]);
  });

  it("keeps shell, inspection, and mutation tools available on retried verification-heavy phases", () => {
    const toolNames = resolveDelegatedInitialToolChoiceToolNames(
      {
        task: "setup_monorepo_skeleton",
        objective:
          "Create root package.json with workspaces, tsconfig, and installable package skeletons under packages/core packages/cli packages/web",
        acceptanceCriteria: [
          "Directories created",
          "npm install succeeds",
        ],
        lastValidationCode: "acceptance_evidence_missing",
      },
      [
        "system.bash",
        "system.writeFile",
        "system.listDir",
      ],
    );

    expect(toolNames).toEqual([
      "system.bash",
      "system.listDir",
      "system.writeFile",
    ]);
  });

  it("keeps browser, shell, and mutation tools available for browser-evidence correction retries", () => {
    const toolNames = resolveDelegatedCorrectionToolChoiceToolNames(
      {
        task: "implement_web",
        objective:
          "Implement packages/web: Vite+React with 2 demo scenarios, JSON editor, timeline render, validation errors",
        inputContract: "Installed deps + core",
        acceptanceCriteria: [
          "App builds and demos functional",
        ],
      },
      [
        "system.browserSessionStart",
        "system.browserAction",
        "system.bash",
        "system.writeFile",
      ],
      "acceptance_evidence_missing",
    );

    expect(toolNames).toEqual([
      "system.browserSessionStart",
      "system.bash",
      "system.writeFile",
    ]);
  });

  it("treats snake_case bootstrap task ids as setup-heavy for initial tool routing", () => {
    const toolNames = resolveDelegatedInitialToolChoiceToolNames(
      {
        task: "setup_structure",
        objective:
          "Create /tmp/maze-forge-ts-boot with root package.json and package stubs",
        inputContract: "Empty host dir",
        acceptanceCriteria: [
          "Root package.json with workspaces",
          "Package stubs exist",
        ],
      },
      [
        "system.bash",
        "system.writeFile",
      ],
    );

    expect(toolNames).toEqual([
      "system.writeFile",
      "system.bash",
    ]);
  });

  it("narrows missing file-evidence correction to the preferred editor before neovim fallback", () => {
    const toolNames = resolveDelegatedCorrectionToolChoiceToolNames(
      {
        task: "core_implementation",
        objective: "Implement the project files and game loop",
      },
      [
        "desktop.bash",
        "desktop.text_editor",
        "mcp.neovim.vim_edit",
        "mcp.neovim.vim_buffer_save",
      ],
      "missing_file_mutation_evidence",
    );

    expect(toolNames).toEqual(["desktop.text_editor"]);
  });

  it("resolves file mutation before shell for setup-heavy implementation work", () => {
    const toolChoice = resolveDelegatedInitialToolChoiceToolName(
      {
        task: "core_implementation",
        objective: "Scaffold the project, install dependencies, and implement the game loop",
      },
      [
        "desktop.bash",
        "desktop.text_editor",
        "mcp.neovim.vim_edit",
      ],
    );

    expect(toolChoice).toBe("desktop.text_editor");
  });

  it("falls back to shell-first setup when no file-mutation tool is available", () => {
    const toolChoice = resolveDelegatedInitialToolChoiceToolName(
      {
        task: "init_workspace",
        objective: "Initialize the npm workspace root and install dependencies",
      },
      [
        "system.bash",
        "system.readFile",
      ],
    );

    expect(toolChoice).toBe("system.bash");
  });

  it("does not let parent research context override implementation-first tool choice", () => {
    const toolChoice = resolveDelegatedInitialToolChoiceToolName(
      {
        task: "ai_and_systems",
        objective:
          "Implement enemy behavior, powerups, save/load, pause/settings, and input support.",
        parentRequest:
          "Research 3 reference games, compare frameworks from official docs, then build and validate the browser game.",
      },
      [
        "desktop.bash",
        "desktop.text_editor",
        "mcp.browser.browser_navigate",
      ],
    );

    expect(toolChoice).toBe("desktop.text_editor");
  });

  it("counts neovim save operations as file mutation evidence", () => {
    const result = validateDelegatedOutputContract({
      spec: {
        task: "core_implementation",
        objective: "Create the project files for the game",
        inputContract: "JSON output with created files",
      },
      output:
        '{"files_created":[{"path":"/workspace/neon-heist/index.html"}]}',
      toolCalls: [{
        name: "mcp.neovim.vim_buffer_save",
        args: { filename: "/workspace/neon-heist/index.html" },
        result: '{"ok":true}',
      }],
    });

    expect(result.ok).toBe(true);
  });

  it("accepts read-only local docs review backed by shell read evidence without requiring file edits", () => {
    const result = validateDelegatedOutputContract({
      spec: {
        task:
          "Inspect docs/RUNTIME_API.md Delegation Runtime Surface and Stateful Response Compaction sections using only non-browser tools. Return one short bullet with one autonomy risk.",
        objective:
          "Identify and output exactly one short bullet describing one autonomy risk from the sections",
        inputContract: "Read-only access to docs/RUNTIME_API.md via text_editor",
        acceptanceCriteria: [
          "Exactly one short bullet output",
          "No browser tools used",
          "Risk tied to delegation or compaction",
        ],
        tools: ["desktop.text_editor", "desktop.bash"],
      },
      output:
        "- Adaptive delegation can still escalate autonomy if child caps drift from verifier-visible diagnostics.",
      toolCalls: [{
        name: "desktop.bash",
        args: {
          command:
            "sed -n '/## Delegation Runtime Surface/,/## Stateful Response Compaction/p' docs/RUNTIME_API.md",
        },
        result: '{"stdout":"## Delegation Runtime Surface\\n...","stderr":"","exitCode":0}',
      }],
    });

    expect(result.ok).toBe(true);
  });
});
