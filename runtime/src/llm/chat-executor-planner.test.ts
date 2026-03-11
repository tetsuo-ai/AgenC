import { describe, expect, it } from "vitest";

import {
  assessPlannerDecision,
  buildPipelineFailureRepairRefinementHint,
  buildPlannerMessages,
  extractExplicitDeterministicToolRequirements,
  extractExplicitSubagentOrchestrationRequirements,
  parsePlannerPlan,
  salvagePlannerToolCallsAsPlan,
  validatePlannerGraph,
  validatePlannerStepContracts,
  validateSalvagedPlannerToolPlan,
  validateExplicitDeterministicToolRequirements,
} from "./chat-executor-planner.js";

describe("chat-executor-planner explicit orchestration requirements", () => {
  it("includes non-interactive validation guidance in planner messages", () => {
    const messages = buildPlannerMessages(
      "Create a TypeScript package and run tests before finishing.",
      [],
      512,
    );

    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining(
            "Verification/build/test commands must be non-interactive and exit on their own.",
          ),
        }),
      ]),
    );
  });

  it("adds runner-compatible repair guidance for npm test -- --run failures", () => {
    const hint = buildPipelineFailureRepairRefinementHint({
      pipelineResult: {
        status: "failed",
        completedSteps: 4,
        totalSteps: 7,
        error:
          '● Unrecognized CLI Parameter:\n\n  Unrecognized option "run". Did you mean "u"?',
        stopReasonHint: "tool_error",
      },
      plannerPlan: {
        reason: "repair",
        requiresSynthesis: true,
        steps: [
          {
            name: "inspect_workspace",
            stepType: "deterministic_tool",
            tool: "system.listDir",
            args: { path: "/tmp/project" },
          },
          {
            name: "npm_install",
            stepType: "deterministic_tool",
            tool: "system.bash",
            args: { command: "npm", args: ["install"] },
          },
          {
            name: "run_tests",
            stepType: "deterministic_tool",
            tool: "system.bash",
            args: { command: "npm", args: ["test", "--", "--run"] },
          },
        ],
      },
    });

    expect(hint).toContain("runner-compatible single-run command");
    expect(hint).toContain("CI=1 npm test");
  });

  it("adds host tooling planner guidance when npm workspace protocol is unsupported", () => {
    const messages = buildPlannerMessages(
      "Create a TypeScript npm workspace project with package.json files for core and cli.",
      [],
      512,
      undefined,
      undefined,
      {
        nodeVersion: "v25.2.1",
        npm: {
          version: "11.7.0",
          workspaceProtocolSupport: "unsupported",
          workspaceProtocolEvidence: "npm error code EUNSUPPORTEDPROTOCOL",
        },
      },
    );

    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining(
            "Do not emit `workspace:*` in generated manifests.",
          ),
        }),
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining("npm error code EUNSUPPORTEDPROTOCOL"),
        }),
      ]),
    );
  });

  it("adds workspace protocol repair guidance for EUNSUPPORTEDPROTOCOL failures", () => {
    const hint = buildPipelineFailureRepairRefinementHint({
      pipelineResult: {
        status: "failed",
        completedSteps: 9,
        totalSteps: 16,
        error:
          'npm error code EUNSUPPORTEDPROTOCOL\nnpm error Unsupported URL Type "workspace:": workspace:*\n',
        stopReasonHint: "tool_error",
      },
      plannerPlan: {
        reason: "repair",
        requiresSynthesis: true,
        steps: [
          {
            name: "create_project_structure",
            stepType: "deterministic_tool",
            tool: "system.bash",
            args: { command: "mkdir", args: ["-p", "/tmp/project/packages/core"] },
          },
          {
            name: "write_cli_package_json",
            stepType: "deterministic_tool",
            tool: "system.writeFile",
            args: {
              path: "/tmp/project/packages/cli/package.json",
              content: '{"dependencies":{"core":"workspace:*"}}',
            },
          },
          {
            name: "npm_install",
            stepType: "deterministic_tool",
            tool: "system.bash",
            args: { command: "npm", args: ["install"] },
          },
        ],
      },
    });

    expect(hint).toContain("Do not emit `workspace:*`");
    expect(hint).toContain("rerun `npm install`");
  });

  it("treats execute_with_agent child-memory prompts as planner-worthy delegation turns", () => {
    const decision = assessPlannerDecision(
      true,
      "LIVE-ENDURANCE-R7 C1. Use execute_with_agent for this exact task. In the child agent, memorize token ONYX-SHARD-58 for later recall and answer exactly CHILD-STORED-R7-C1. Return exactly the child answer.",
      [],
    );

    expect(decision.shouldPlan).toBe(true);
    expect(decision.reason).toContain("delegation_cue");
  });

  it("extracts required subagent steps from the compact 'plan required' prompt shape", () => {
    const requirements = extractExplicitSubagentOrchestrationRequirements(
      "Subagent context audit SG3. Sub-agent orchestration plan required: " +
        "1. recover_marker: recover the earlier continuity marker from parent conversation context only; do not invent missing facts. " +
        "2. echo_marker: using desktop.bash, run /usr/bin/printf so it prints the recovered marker exactly once. " +
        "Final deliverables: recovered marker, printed output, known limitations.",
    );

    expect(requirements).toBeDefined();
    expect(requirements?.stepNames).toEqual([
      "recover_marker",
      "echo_marker",
    ]);
    expect(requirements?.requiresSynthesis).toBe(true);
    expect(requirements?.steps[0]?.description).toContain(
      "recover the earlier continuity marker",
    );
  });

  it("extracts repeated deterministic tool counts and exact final literals from soak-style prompts", () => {
    const requirements = extractExplicitDeterministicToolRequirements(
      "Run token: social-live-20260310a.\n" +
        "Use `social.sendMessage` exactly 3 times in `off-chain` mode.\n" +
        "Recipients and themes:\n" +
        "- `agent-2`: throughput + backpressure\n" +
        "- `agent-3`: reputation gates + abuse resistance\n" +
        "- `agent-4`: restart/recovery + message durability\n" +
        "After the tool calls, reply with exactly `A1_R1_DONE`.",
      ["social.sendMessage"],
    );

    expect(requirements).toEqual({
      orderedToolNames: ["social.sendMessage"],
      minimumToolCallsByName: { "social.sendMessage": 3 },
      forcePlanner: true,
      exactResponseLiteral: "A1_R1_DONE",
    });
  });

  it("adds first-pass planner guidance for explicit deterministic tool contracts", () => {
    const requirements = extractExplicitDeterministicToolRequirements(
      "Run token: social-live-20260310f.\n" +
        "Use `social.getRecentMessages` first with `{ \"direction\": \"incoming\", \"limit\": 20, \"mode\": \"off-chain\" }`.\n" +
        "Then use `social.sendMessage` exactly 3 times in `off-chain` mode.\n" +
        "After the tool calls, reply with exactly `A1_R3_DONE`.",
      ["social.getRecentMessages", "social.sendMessage"],
    );

    const messages = buildPlannerMessages(
      "Run token: social-live-20260310f.\n" +
        "Use `social.getRecentMessages` first with `{ \"direction\": \"incoming\", \"limit\": 20, \"mode\": \"off-chain\" }`.\n" +
        "Then use `social.sendMessage` exactly 3 times in `off-chain` mode.\n" +
        "After the tool calls, reply with exactly `A1_R3_DONE`.",
      [],
      256,
      requirements,
    );

    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining(
            "The user supplied an explicit deterministic tool contract for this turn.",
          ),
        }),
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining(
            "Use only these tools in this order: social.getRecentMessages -> social.sendMessage x3.",
          ),
        }),
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining(
            "do not emit `subagent_task` steps",
          ),
        }),
      ]),
    );
  });

  it("defaults omitted subagent can_run_parallel to false", () => {
    const result = parsePlannerPlan(
      JSON.stringify({
        reason: "delegate_core_work",
        requiresSynthesis: true,
        steps: [
          {
            name: "implement_core",
            step_type: "subagent_task",
            objective: "Implement the core solver",
            input_contract: "Project scaffold already exists",
            acceptance_criteria: ["Exports compile", "Weighted search works"],
            required_tool_capabilities: ["system.writeFile", "system.readFile"],
            context_requirements: ["workspace ready"],
            max_budget_hint: "medium",
          },
        ],
      }),
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.plan?.steps).toEqual([
      expect.objectContaining({
        name: "implement_core",
        stepType: "subagent_task",
        canRunParallel: false,
      }),
    ]);
  });

  it("parses planner subagent steps whose delegation contract is nested inside args", () => {
    const result = parsePlannerPlan(
      JSON.stringify({
        reason: "delegate_core_work",
        requiresSynthesis: true,
        steps: [
          {
            name: "implement_core",
            step_type: "subagent_task",
            tool: "execute_with_agent",
            args: {
              task: "implement_core",
              objective: "Create src/ with parser and weighted pathfinding",
              input_contract: "Configured TS project with src/ ready",
              acceptance_criteria: [
                "Core parser+algorithms in src/grid.ts and src/algorithms.ts",
              ],
              required_tool_capabilities: [
                "system.writeFile",
                "system.readFile",
              ],
              context_requirements: ["cwd:/tmp/grid-router-ts"],
              max_budget_hint: "12m",
            },
          },
        ],
      }),
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.plan?.steps).toEqual([
      expect.objectContaining({
        name: "implement_core",
        stepType: "subagent_task",
        objective: "Create src/ with parser and weighted pathfinding",
        inputContract: "Configured TS project with src/ ready",
        acceptanceCriteria: [
          "Core parser+algorithms in src/grid.ts and src/algorithms.ts",
        ],
        requiredToolCapabilities: ["system.writeFile", "system.readFile"],
        contextRequirements: ["cwd:/tmp/grid-router-ts"],
        maxBudgetHint: "12m",
        canRunParallel: false,
      }),
    ]);
  });

  it("promotes deterministic tool parameters from the step root into args", () => {
    const result = parsePlannerPlan(
      JSON.stringify({
        reason: "verify_build",
        requiresSynthesis: false,
        steps: [
          {
            name: "run_tests",
            step_type: "deterministic_tool",
            tool: "system.bash",
            args: {
              command: "npm",
              args: ["test", "--", "--run"],
            },
            cwd: "/tmp/grid-router-ts",
            timeoutMs: 45000,
          },
        ],
      }),
    );

    expect(result.plan?.steps).toEqual([
      expect.objectContaining({
        name: "run_tests",
        stepType: "deterministic_tool",
        tool: "system.bash",
        args: {
          command: "npm",
          args: ["test", "--", "--run"],
          cwd: "/tmp/grid-router-ts",
          timeoutMs: 45000,
        },
      }),
    ]);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "parse",
          code: "planner_tool_root_args_promoted",
          details: expect.objectContaining({
            promotedFields: "cwd,timeoutMs",
          }),
        }),
      ]),
    );
  });

  it("salvages direct planner tool calls into deterministic steps", () => {
    const result = salvagePlannerToolCallsAsPlan([
      {
        id: "tc-1",
        name: "execute_with_agent",
        arguments: JSON.stringify({
          task: "Return exactly TOKEN=ONYX-SHARD-58",
          objective: "Output exactly TOKEN=ONYX-SHARD-58",
        }),
      },
    ]);

    expect(result.plan).toBeDefined();
    expect(result.plan?.reason).toBe("planner_tool_call_salvaged");
    expect(result.plan?.steps).toEqual([
      expect.objectContaining({
        stepType: "deterministic_tool",
        tool: "execute_with_agent",
        args: {
          task: "Return exactly TOKEN=ONYX-SHARD-58",
          objective: "Output exactly TOKEN=ONYX-SHARD-58",
        },
      }),
    ]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        category: "parse",
        code: "planner_tool_call_salvaged",
      }),
    ]);
  });

  it("flags salvaged raw tool calls that under-decompose structured implementation requests", () => {
    const result = salvagePlannerToolCallsAsPlan([
      {
        id: "tc-1",
        name: "system.bash",
        arguments: JSON.stringify({
          command: "mkdir",
          args: ["-p", "/tmp/grid-router-ts"],
        }),
      },
    ]);

    const diagnostics = validateSalvagedPlannerToolPlan({
      plannerPlan: result.plan!,
      messageText:
        "In /tmp create a reusable TypeScript library and CLI for ASCII grid maps.\n" +
        "Requirements:\n" +
        "- implement bfs, dijkstra, and astar\n" +
        "- include weighted tiles and portals\n" +
        "- add Vitest coverage\n" +
        "- write a README and report exact passing commands",
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        category: "validation",
        code: "salvaged_tool_plan_underdecomposed",
        details: expect.objectContaining({
          minimumExpectedSteps: 3,
        }),
      }),
    ]);
  });

  it("allows salvaged raw tool calls when the turn has an explicit single-tool contract", () => {
    const result = salvagePlannerToolCallsAsPlan([
      {
        id: "tc-1",
        name: "execute_with_agent",
        arguments: JSON.stringify({
          task: "Return exactly TOKEN=ONYX-SHARD-58",
          objective: "Output exactly TOKEN=ONYX-SHARD-58",
        }),
      },
    ]);
    const requirements = extractExplicitDeterministicToolRequirements(
      "Use `execute_with_agent` for this exact task and return exactly `TOKEN=ONYX-SHARD-58`.",
      ["execute_with_agent"],
    );

    const diagnostics = validateSalvagedPlannerToolPlan({
      plannerPlan: result.plan!,
      messageText:
        "Use `execute_with_agent` for this exact task and return exactly `TOKEN=ONYX-SHARD-58`.",
      explicitDeterministicRequirements: requirements,
    });

    expect(diagnostics).toEqual([]);
  });

  it("rejects planner plans that drift outside explicit deterministic social tools", () => {
    const requirements = extractExplicitDeterministicToolRequirements(
      "Use social.getRecentMessages first. Then use social.sendMessage twice.",
      ["social.getRecentMessages", "social.sendMessage"],
    );

    const diagnostics = validateExplicitDeterministicToolRequirements(
      {
        reason: "social_loop",
        requiresSynthesis: false,
        confidence: 0.8,
        steps: [
          {
            name: "get_incoming_msgs",
            stepType: "deterministic_tool",
            dependsOn: [],
            tool: "social.getRecentMessages",
            args: { direction: "incoming", limit: 5 },
          },
          {
            name: "read_tagged_message",
            stepType: "subagent_task",
            dependsOn: ["get_incoming_msgs"],
            objective: "Read the newest tagged message through email tools.",
            inputContract: "Return the exact tagged content",
            acceptanceCriteria: ["Message read"],
            requiredToolCapabilities: ["system.emailMessageInfo"],
            contextRequirements: ["get_incoming_msgs"],
            maxBudgetHint: "2m",
            canRunParallel: true,
          },
          {
            name: "send_reply",
            stepType: "deterministic_tool",
            dependsOn: ["read_tagged_message"],
            tool: "social.sendMessage",
            args: { recipient: "agent-a", content: "reply", mode: "off-chain" },
          },
        ],
        edges: [],
      },
      requirements!,
    );

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "explicit_tool_plan_subagent_forbidden",
        }),
      ]),
    );
  });

  it("rejects deterministic bash wrapper steps that use bash -c", () => {
    const diagnostics = validatePlannerStepContracts({
      reason: "bad_bash_wrapper",
      requiresSynthesis: false,
      confidence: 0.7,
      steps: [
        {
          name: "setup_project",
          stepType: "deterministic_tool",
          dependsOn: [],
          tool: "system.bash",
          args: {
            command: "bash",
            args: ["-c", "mkdir -p grid-router-ts && cat > tsconfig.json <<'EOF'"],
          },
        },
      ],
      edges: [],
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        category: "validation",
        code: "planner_bash_nested_shell_forbidden",
      }),
    ]);
  });

  it("rejects deterministic bash steps that embed shell separators in direct args", () => {
    const diagnostics = validatePlannerStepContracts({
      reason: "bad_direct_bash_args",
      requiresSynthesis: false,
      confidence: 0.7,
      steps: [
        {
          name: "final_verify",
          stepType: "deterministic_tool",
          dependsOn: [],
          tool: "system.bash",
          args: {
            command: "npm",
            args: ["run", "build", "&&", "npm", "test"],
          },
        },
      ],
      edges: [],
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        category: "validation",
        code: "planner_bash_shell_syntax_in_direct_args",
        details: expect.objectContaining({
          shellTokens: "&&",
        }),
      }),
    ]);
  });

  it("rejects ambiguous or undersized planner subagent budget hints", () => {
    const diagnostics = validatePlannerStepContracts({
      reason: "bad_budgets",
      requiresSynthesis: true,
      confidence: 0.8,
      steps: [
        {
          name: "implement_core",
          stepType: "subagent_task",
          dependsOn: [],
          objective: "Implement the parser",
          inputContract: "Project scaffold exists",
          acceptanceCriteria: ["Parser compiles"],
          requiredToolCapabilities: ["system.writeFile", "system.readFile"],
          contextRequirements: ["repo_context"],
          maxBudgetHint: "0.08",
          canRunParallel: false,
        },
        {
          name: "run_tests",
          stepType: "subagent_task",
          dependsOn: ["implement_core"],
          objective: "Run tests",
          inputContract: "Parser exists",
          acceptanceCriteria: ["Tests pass"],
          requiredToolCapabilities: ["system.bash"],
          contextRequirements: ["implement_core"],
          maxBudgetHint: "30s",
          canRunParallel: false,
        },
      ],
      edges: [{ from: "implement_core", to: "run_tests" }],
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        category: "validation",
        code: "planner_subagent_budget_hint_ambiguous",
      }),
      expect.objectContaining({
        category: "validation",
        code: "planner_subagent_budget_hint_too_small",
      }),
    ]);
  });

  it("rejects node workspace steps that mix manifest setup with pre-install verification", () => {
    const diagnostics = validatePlannerGraph(
      {
        reason: "workspace_project",
        requiresSynthesis: true,
        confidence: 0.82,
        steps: [
          {
            name: "initialize_root",
            stepType: "subagent_task",
            dependsOn: [],
            objective:
              "Create root package.json with npm workspaces, tsconfig.json, and root scripts.",
            inputContract: "Workspace root does not exist yet.",
            acceptanceCriteria: [
              "package.json with workspaces and scripts",
              "tsconfig.json present",
            ],
            requiredToolCapabilities: ["system.writeFile", "system.readFile"],
            contextRequirements: ["cwd=/tmp/maze-forge-ts"],
            maxBudgetHint: "2m",
            canRunParallel: false,
          },
          {
            name: "implement_web",
            stepType: "subagent_task",
            dependsOn: ["initialize_root"],
            objective:
              "Setup packages/web package.json, index.html, and src/main.ts for a Vite vanilla TS app that renders the grid.",
            inputContract: "Use a local file:../core dependency and add the web package manifest.",
            acceptanceCriteria: [
              "web package.json with vite",
              "index.html and src/main.ts created",
              "builds successfully",
            ],
            requiredToolCapabilities: ["system.writeFile", "system.bash"],
            contextRequirements: ["cwd=/tmp/maze-forge-ts"],
            maxBudgetHint: "4m",
            canRunParallel: false,
          },
          {
            name: "npm_install",
            stepType: "deterministic_tool",
            dependsOn: ["implement_web"],
            tool: "system.bash",
            args: {
              command: "npm",
              args: ["install"],
              cwd: "/tmp/maze-forge-ts",
            },
          },
        ],
        edges: [
          { from: "initialize_root", to: "implement_web" },
          { from: "implement_web", to: "npm_install" },
        ],
      },
      {
        maxSubagentFanout: 8,
        maxSubagentDepth: 4,
      },
    );

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "validation",
          code: "node_workspace_install_phase_mismatch",
          details: expect.objectContaining({
            stepName: "implement_web",
            installSteps: "npm_install",
            requiresPhaseSplit: "true",
          }),
        }),
      ]),
    );
  });

  it("allows node workspace scaffold steps that only define scripts and configs before install", () => {
    const diagnostics = validatePlannerGraph(
      {
        reason: "workspace_project",
        requiresSynthesis: true,
        confidence: 0.84,
        steps: [
          {
            name: "scaffold_structure_manifests",
            stepType: "subagent_task",
            dependsOn: [],
            objective:
              "Create all package.json, tsconfig.json, vite.config.ts, dirs for packages/core/cli/web/src; use file:../core for local deps, scripts for tsc/vitest/vite, no install or logic code.",
            inputContract:
              "Valid workspaces monorepo, no workspace:*, hoistable devDependencies.",
            acceptanceCriteria: [
              "package.json files valid",
              "tsconfig files present",
              "no node_modules",
            ],
            requiredToolCapabilities: [
              "system.writeFile",
              "system.bash",
              "system.listDir",
            ],
            contextRequirements: ["cwd=/tmp/maze-forge-ts"],
            maxBudgetHint: "2m",
            canRunParallel: false,
          },
          {
            name: "npm_install",
            stepType: "deterministic_tool",
            dependsOn: ["scaffold_structure_manifests"],
            tool: "system.bash",
            args: {
              command: "npm",
              args: ["install"],
              cwd: "/tmp/maze-forge-ts",
            },
          },
        ],
        edges: [{ from: "scaffold_structure_manifests", to: "npm_install" }],
      },
      {
        maxSubagentFanout: 8,
        maxSubagentDepth: 4,
      },
    );

    expect(
      diagnostics.some((diagnostic) =>
        diagnostic.code === "node_workspace_install_phase_mismatch"
      ),
    ).toBe(false);
  });

  it("rejects objective-only node verification before install even without acceptance verification criteria", () => {
    const diagnostics = validatePlannerGraph(
      {
        reason: "workspace_project",
        requiresSynthesis: true,
        confidence: 0.84,
        steps: [
          {
            name: "scaffold_and_smoke_test",
            stepType: "subagent_task",
            dependsOn: [],
            objective:
              "Create root package.json and tsconfig.json, then run npm test and vite build to verify the workspace skeleton.",
            inputContract: "Workspace root does not exist yet.",
            acceptanceCriteria: [
              "package.json present",
              "tsconfig.json present",
              "no node_modules",
            ],
            requiredToolCapabilities: ["system.writeFile", "system.bash"],
            contextRequirements: ["cwd=/tmp/maze-forge-ts"],
            maxBudgetHint: "2m",
            canRunParallel: false,
          },
          {
            name: "npm_install",
            stepType: "deterministic_tool",
            dependsOn: ["scaffold_and_smoke_test"],
            tool: "system.bash",
            args: {
              command: "npm",
              args: ["install"],
              cwd: "/tmp/maze-forge-ts",
            },
          },
        ],
        edges: [{ from: "scaffold_and_smoke_test", to: "npm_install" }],
      },
      {
        maxSubagentFanout: 8,
        maxSubagentDepth: 4,
      },
    );

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "validation",
          code: "node_workspace_install_phase_mismatch",
          details: expect.objectContaining({
            stepName: "scaffold_and_smoke_test",
            installSteps: "npm_install",
            requiresPhaseSplit: "true",
          }),
        }),
      ]),
    );
  });

  it("requires dependency gating between explicitly ordered deterministic tools", () => {
    const requirements = extractExplicitDeterministicToolRequirements(
      "Use social.getRecentMessages first. Then use social.sendMessage twice.",
      ["social.getRecentMessages", "social.sendMessage"],
    );

    const diagnostics = validateExplicitDeterministicToolRequirements(
      {
        reason: "social_loop",
        requiresSynthesis: false,
        confidence: 0.8,
        steps: [
          {
            name: "get_incoming_msgs",
            stepType: "deterministic_tool",
            dependsOn: [],
            tool: "social.getRecentMessages",
            args: { direction: "incoming", limit: 5 },
          },
          {
            name: "send_reply",
            stepType: "deterministic_tool",
            dependsOn: [],
            tool: "social.sendMessage",
            args: { recipient: "agent-a", content: "reply", mode: "off-chain" },
          },
          {
            name: "send_followup",
            stepType: "deterministic_tool",
            dependsOn: ["send_reply"],
            tool: "social.sendMessage",
            args: { recipient: "agent-b", content: "followup", mode: "off-chain" },
          },
        ],
        edges: [],
      },
      requirements!,
    );

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "explicit_tool_plan_dependency_mismatch",
        }),
      ]),
    );
  });

  it("requires enough repeated deterministic calls for explicitly repeated tools", () => {
    const requirements = extractExplicitDeterministicToolRequirements(
      "Use social.sendMessage exactly 3 times in off-chain mode. After the tool calls, reply with exactly DONE.",
      ["social.sendMessage"],
    );

    const diagnostics = validateExplicitDeterministicToolRequirements(
      {
        reason: "social_loop",
        requiresSynthesis: false,
        confidence: 0.8,
        steps: [
          {
            name: "send_reply_a",
            stepType: "deterministic_tool",
            dependsOn: [],
            tool: "social.sendMessage",
            args: { recipient: "agent-a", content: "reply", mode: "off-chain" },
          },
          {
            name: "send_reply_b",
            stepType: "deterministic_tool",
            dependsOn: ["send_reply_a"],
            tool: "social.sendMessage",
            args: {
              recipient: "agent-b",
              content: "followup",
              mode: "off-chain",
            },
          },
        ],
        edges: [],
      },
      requirements!,
    );

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "explicit_tool_plan_insufficient_tool_calls",
        }),
      ]),
    );
  });
});
