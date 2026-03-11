import { describe, expect, it } from "vitest";
import {
  contentHasExplicitFileArtifact,
  hasUnsupportedNarrativeFileClaims,
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
    expect(result.code).toBe("contradictory_completion_claim");
    expect(result.error).toContain("Blocked on full verification");
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
      "system.bash",
      "system.writeFile",
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
      "system.bash",
      "system.writeFile",
    ]);
    expect(resolved.semanticFallback).toEqual([
      "system.bash",
      "system.writeFile",
    ]);
    expect(resolved.removedByPolicy).toEqual(["file_write"]);
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
