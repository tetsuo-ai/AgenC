import { describe, expect, it } from "vitest";

import {
  assessPlannerDecision,
  buildPipelineFailureRepairRefinementHint,
  buildPlannerMessages,
  buildPlannerVerificationRequirementsFailureMessage,
  buildPlannerVerificationRequirementsRefinementHint,
  extractPlannerVerificationRequirements,
  buildPlannerStructuralRefinementHint,
  extractExplicitDeterministicToolRequirements,
  extractExplicitSubagentOrchestrationRequirements,
  parsePlannerPlan,
  salvagePlannerToolCallsAsPlan,
  validatePlannerVerificationRequirements,
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

  it("includes first-pass runtime fanout guidance in planner messages", () => {
    const messages = buildPlannerMessages(
      "Create a TypeScript monorepo from scratch with multiple packages, tests, and docs.",
      [],
      512,
      undefined,
      undefined,
      undefined,
      { maxSubagentFanout: 8 },
    );

    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining(
            "Never emit more than 8 subagent_task steps in the full plan.",
          ),
        }),
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining(
            "Never merge research with setup/manifest work, or code implementation with broad validation/browser QA.",
          ),
        }),
      ]),
    );
  });

  it("extracts explicit request-level verification requirements from verification directives", () => {
    expect(
      extractPlannerVerificationRequirements(
        "Create the project from scratch.\n" +
          "Verify with install, build, test, and browser-grounded checks before finishing.\n" +
          "Do not ask clarifying questions.",
      ),
    ).toEqual(["install", "build", "test", "browser"]);
  });

  it("adds planner guidance to preserve explicit verification coverage", () => {
    const messages = buildPlannerMessages(
      "Create the project from scratch.\n" +
        "Verify with install, build, test, and browser-grounded checks before finishing.",
      [],
      256,
    );

    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining(
            "Preserve these verification modes in the plan: install -> build -> test -> browser.",
          ),
        }),
      ]),
    );
  });

  it("flags planner plans that drop explicit verification modes", () => {
    const result = parsePlannerPlan(
      JSON.stringify({
        reason: "freight_flow",
        requiresSynthesis: true,
        steps: [
          {
            name: "scaffold_monorepo",
            step_type: "subagent_task",
            objective: "Author manifests and initial source files.",
            input_contract: "Empty project directory.",
            acceptance_criteria: [
              "Workspace files authored",
              "Core, CLI, and web packages scaffolded",
            ],
            required_tool_capabilities: [
              "system.writeFile",
              "system.readFile",
              "system.listDir",
            ],
            context_requirements: ["cwd=/tmp/freight-flow-ts"],
            max_budget_hint: "4m",
          },
          {
            name: "install_dependencies",
            step_type: "deterministic_tool",
            depends_on: ["scaffold_monorepo"],
            tool: "system.bash",
            args: {
              command: "npm",
              args: ["install"],
              cwd: "/tmp/freight-flow-ts",
            },
          },
          {
            name: "run_verification",
            step_type: "subagent_task",
            depends_on: ["install_dependencies"],
            objective: "Execute build checks on the workspace before finishing.",
            input_contract: "Implementation complete.",
            acceptance_criteria: [
              "Build succeeds cleanly",
            ],
            required_tool_capabilities: [
              "system.bash",
              "system.readFile",
              "system.writeFile",
            ],
            context_requirements: ["cwd=/tmp/freight-flow-ts"],
            max_budget_hint: "5m",
          },
          {
            name: "final_synthesis",
            step_type: "synthesis",
            depends_on: ["run_verification"],
          },
        ],
      }),
    );

    const diagnostics = validatePlannerVerificationRequirements(
      result.plan!,
      ["install", "build", "test", "browser"],
    );

    expect(diagnostics).toEqual([
      expect.objectContaining({
        category: "validation",
        code: "planner_verification_requirements_missing",
        details: expect.objectContaining({
          missingCategories: "test,browser",
          requiredCategories: "install,build,test,browser",
        }),
      }),
    ]);
    expect(
      buildPlannerVerificationRequirementsRefinementHint(
        ["install", "build", "test", "browser"],
        diagnostics,
      ),
    ).toContain("The previous plan dropped: test, browser");
    expect(
      buildPlannerVerificationRequirementsFailureMessage(
        ["install", "build", "test", "browser"],
        diagnostics,
      ),
    ).toContain("Missing verification modes: test, browser");
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
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining(
            "Do not mention `npm install`, build, test, coverage, typecheck, lint, or runtime success",
          ),
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

  it("adds explicit browser split guidance for implementation-browser decomposition", () => {
    const hint = buildPlannerStructuralRefinementHint([
      {
        category: "validation",
        code: "subagent_step_needs_decomposition",
        message:
          'Planner subagent step "implement_web" is overloaded: Delegated objective is overloaded (implementation, browser).',
        details: {
          stepName: "implement_web",
          phases: "implementation,browser",
          suggestedSteps: "implement_core_scope,browser_validation",
        },
      },
    ]);

    expect(hint).toContain(
      "move browser-session validation into its own later step",
    );
  });

  it("preserves numeric fanout limits in structural refinement hints", () => {
    const hint = buildPlannerStructuralRefinementHint([
      {
        category: "validation",
        code: "subagent_fanout_exceeded",
        message: "Planner fanout exceeded",
        details: {
          maxFanoutPerTurn: 8,
        },
      },
    ]);

    expect(hint).toContain("maxFanoutPerTurn=8");
    expect(hint).not.toContain("the configured limit");
  });

  it("adds explicit no-verification guidance for pre-install scaffold steps", () => {
    const hint = buildPlannerStructuralRefinementHint([
      {
        category: "validation",
        code: "node_workspace_install_phase_mismatch",
        message:
          'Planner subagent step "scaffold_manifests" mixes Node workspace manifest/config scaffolding with install-sensitive verification before install',
        details: {
          stepName: "scaffold_manifests",
          installSteps: "run_npm_install",
          verificationModes: "runner_or_build_tooling",
          requiresPhaseSplit: "true",
        },
      },
    ]);

    expect(hint).toContain(
      "do not mention install/build/test/typecheck/lint/coverage success",
    );
    expect(hint).toContain(
      "Limit it to authored files, scripts, configs, directories, and local dependency links",
    );
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

  it("preserves explicit planner tool capabilities instead of merging heuristic repair defaults", () => {
    const requirements = extractExplicitSubagentOrchestrationRequirements(
      "Sub-agent orchestration plan required: " +
        "1. design_research: define the simulator rules and data model in workspace files. " +
        "2. tech_research: choose the stack and repo layout. " +
        "Final deliverables: implementation-ready workspace.",
    );

    const parsed = parsePlannerPlan(
      JSON.stringify({
        reason: "explicit_orchestration",
        requiresSynthesis: true,
        steps: [
          {
            name: "design_research",
            step_type: "subagent_task",
            objective:
              "Define the rules and data model for a rail-freight dispatch simulator.",
            input_contract: "User requirements for the simulator",
            acceptance_criteria: [
              "Defined TypeScript interfaces for Network, Segment, Train, Job, Scenario",
              "Documented simulation rules including conflicts, locks, deadlock, deadlines",
              "Authored design document or types in workspace files",
            ],
            required_tool_capabilities: [
              "system.bash",
              "system.writeFile",
              "system.readFile",
              "system.listDir",
            ],
            context_requirements: ["cwd=/tmp/freight-flow-ts"],
            max_budget_hint: "3m",
          },
        ],
      }),
      requirements,
    );

    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.plan?.steps).toEqual([
      expect.objectContaining({
        name: "design_research",
        stepType: "subagent_task",
        requiredToolCapabilities: [
          "system.bash",
          "system.writeFile",
          "system.readFile",
          "system.listDir",
        ],
      }),
    ]);
  });

  it("preserves semantic planner capabilities instead of falling back to heuristic repair defaults", () => {
    const requirements = extractExplicitSubagentOrchestrationRequirements(
      "Sub-agent orchestration plan required: " +
        "1. design_research: define the simulator rules and data model in workspace files. " +
        "2. tech_research: choose the stack and repo layout. " +
        "Final deliverables: implementation-ready workspace.",
    );

    const parsed = parsePlannerPlan(
      JSON.stringify({
        reason: "explicit_orchestration",
        requiresSynthesis: true,
        steps: [
          {
            name: "design_research",
            step_type: "subagent_task",
            objective:
              "Define rules, invariants, and data model for rail freight simulator in workspace files.",
            input_contract: "Fresh workspace dir at /tmp/freight-flow-ts",
            acceptance_criteria: [
              "Data models as TS interfaces in core/src",
              "Rules/invariants in Markdown or code comments",
              "Sample scenario JSONs authored",
              "Only file authoring completed",
            ],
            required_tool_capabilities: ["filesystem", "code_generation"],
            context_requirements: ["cwd=/tmp/freight-flow-ts"],
            max_budget_hint: "12m",
          },
        ],
      }),
      requirements,
    );

    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.plan?.steps).toEqual([
      expect.objectContaining({
        name: "design_research",
        stepType: "subagent_task",
        requiredToolCapabilities: ["filesystem", "code_generation"],
      }),
    ]);
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

  it("normalizes planner bash direct args with shell separators into shell mode", () => {
    const result = parsePlannerPlan(
      JSON.stringify({
        reason: "verify_build",
        requiresSynthesis: false,
        steps: [
          {
            name: "verify_all",
            step_type: "deterministic_tool",
            tool: "system.bash",
            args: {
              command: "npm",
              args: ["run", "build", "&&", "npm", "test", "--", "--coverage"],
              cwd: "/tmp/transit-weave",
            },
          },
        ],
      }),
    );

    expect(result.plan?.steps).toEqual([
      expect.objectContaining({
        name: "verify_all",
        stepType: "deterministic_tool",
        tool: "system.bash",
        args: {
          command: "npm run build && npm test -- --coverage",
          cwd: "/tmp/transit-weave",
        },
      }),
    ]);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "parse",
          code: "planner_bash_direct_args_normalized_to_shell_mode",
          details: expect.objectContaining({
            shellTokens: "&&",
          }),
        }),
      ]),
    );
    expect(
      validatePlannerStepContracts(result.plan!).some((diagnostic) =>
        diagnostic.code === "planner_bash_shell_syntax_in_direct_args"
      ),
    ).toBe(false);
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

  it("repairs explicit planner subagent budget hints up to the runtime minimum during parsing", () => {
    const parsed = parsePlannerPlan(
      JSON.stringify({
        reason: "budget_repair",
        requiresSynthesis: true,
        steps: [
          {
            name: "create_readme",
            step_type: "subagent_task",
            objective: "Write project README with usage",
            input_contract: "All packages done",
            acceptance_criteria: ["README.md present with instructions"],
            required_tool_capabilities: ["system.writeFile"],
            context_requirements: ["cwd=/tmp/maze-forge-ts"],
            max_budget_hint: "30s",
          },
        ],
      }),
    );

    expect(parsed.plan?.steps[0]).toEqual(
      expect.objectContaining({
        stepType: "subagent_task",
        maxBudgetHint: "60s",
      }),
    );
    expect(parsed.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "policy",
          code: "planner_subagent_budget_hint_clamped",
          details: expect.objectContaining({
            originalMaxBudgetHint: "30s",
            repairedMaxBudgetHint: "60s",
          }),
        }),
      ]),
    );
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

  it("allows node workspace scaffold steps whose acceptance criteria only require script definitions", () => {
    const diagnostics = validatePlannerGraph(
      {
        reason: "workspace_project",
        requiresSynthesis: true,
        confidence: 0.84,
        steps: [
          {
            name: "scaffold_monorepo_manifests",
            stepType: "subagent_task",
            dependsOn: [],
            objective:
              "Create all package.json, tsconfig.json, vite.config.ts and vitest config with proper scripts/deps.",
            inputContract:
              "Directory structure ready at /tmp/maze-forge-ts",
            acceptanceCriteria: [
              "Manifests present",
              "scripts for build/test/dev set",
              "no workspace:*",
            ],
            requiredToolCapabilities: [
              "system.writeFile",
              "system.readFile",
              "system.bash",
              "system.listDir",
            ],
            contextRequirements: ["cwd=/tmp/maze-forge-ts"],
            maxBudgetHint: "90s",
            canRunParallel: false,
          },
          {
            name: "install_dependencies",
            stepType: "deterministic_tool",
            dependsOn: ["scaffold_monorepo_manifests"],
            tool: "system.bash",
            args: {
              command: "npm",
              args: ["install"],
              cwd: "/tmp/maze-forge-ts",
            },
          },
        ],
        edges: [
          { from: "scaffold_monorepo_manifests", to: "install_dependencies" },
        ],
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

  it("allows scaffold_environment plans that inventory package metadata and build/test scripts before install", () => {
    const diagnostics = validatePlannerGraph(
      {
        reason: "workspace_project",
        requiresSynthesis: false,
        confidence: 0.82,
        steps: [
          {
            name: "create_project_dir",
            stepType: "deterministic_tool",
            tool: "system.bash",
            args: {
              command: "mkdir",
              args: ["-p", "/tmp/signal-cartography-ts-43"],
            },
            onError: "abort",
          },
          {
            name: "scaffold_environment",
            stepType: "subagent_task",
            dependsOn: ["create_project_dir"],
            objective:
              "Author root package.json (workspaces, build/test scripts), tsconfig.json, per-package manifests with file:../ local deps, src dirs and basic configs for core/data/cli/web only.",
            inputContract: "Empty target dir",
            acceptanceCriteria: [
              "Root package.json with workspaces and scripts",
              "Per-package package.json with names, file: deps, build/test scripts",
              "packages/*/src and tsconfigs present",
            ],
            requiredToolCapabilities: [
              "system.writeFile",
              "system.readFile",
              "system.listDir",
            ],
            contextRequirements: ["cwd=/tmp/signal-cartography-ts-43"],
            maxBudgetHint: "8m",
          },
          {
            name: "perform_npm_install",
            stepType: "deterministic_tool",
            dependsOn: ["scaffold_environment"],
            tool: "system.bash",
            args: {
              command: "npm",
              args: ["install"],
              cwd: "/tmp/signal-cartography-ts-43",
            },
            onError: "abort",
          },
        ],
        edges: [
          { from: "create_project_dir", to: "scaffold_environment" },
          { from: "scaffold_environment", to: "perform_npm_install" },
        ],
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

  it("allows authored manifest acceptance criteria that mention build/test/coverage scripts and devDeps", () => {
    const diagnostics = validatePlannerGraph(
      {
        reason: "workspace_project",
        requiresSynthesis: true,
        confidence: 0.84,
        steps: [
          {
            name: "scaffold_root_configs",
            stepType: "subagent_task",
            dependsOn: [],
            objective:
              "Author root package.json, tsconfig.json, .gitignore and README skeleton for a TypeScript workspaces monorepo.",
            inputContract: "None - create from scratch",
            acceptanceCriteria: [
              "Authored root package.json with private:true, workspaces:['packages/*'], scripts for build/test/coverage, devDeps including typescript, vitest, @vitest/coverage-v8. Authored tsconfig.json, .gitignore and basic README.md with setup/usage sections.",
            ],
            requiredToolCapabilities: [
              "system.writeFile",
              "system.readFile",
              "system.listDir",
            ],
            contextRequirements: ["cwd=/tmp/transit-weave-ts-26"],
            maxBudgetHint: "90s",
            canRunParallel: false,
          },
          {
            name: "install_dependencies",
            stepType: "deterministic_tool",
            dependsOn: ["scaffold_root_configs"],
            tool: "system.bash",
            args: {
              command: "npm",
              args: ["install"],
              cwd: "/tmp/transit-weave-ts-26",
            },
          },
        ],
        edges: [{ from: "scaffold_root_configs", to: "install_dependencies" }],
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

  it("allows pre-install scaffold objectives that only author README install/build/test placeholders", () => {
    const diagnostics = validatePlannerGraph(
      {
        reason: "freight_flow_scaffold",
        requiresSynthesis: true,
        confidence: 0.86,
        steps: [
          {
            name: "create_project_directory",
            stepType: "deterministic_tool",
            dependsOn: [],
            tool: "system.bash",
            args: {
              command: "mkdir",
              args: ["-p", "/tmp/freight-flow-ts-26/packages/core/src"],
            },
          },
          {
            name: "scaffold_monorepo",
            stepType: "subagent_task",
            dependsOn: ["create_project_directory"],
            objective:
              "Author root package.json, per-package manifests, tsconfig.json files, vite.config.ts, index.html, placeholder src files, and short README.md with install/test/build/run placeholders. Only create directories, manifests, configs and initial file contents.",
            inputContract:
              "Newly created empty directory tree with package subfolders",
            acceptanceCriteria: [
              "Root and per-package package.json files exist with correct metadata, file: local deps, and scripts",
              "tsconfig.json, vite.config.ts and index.html are authored",
              "README.md and basic src placeholder files are present",
              "Directory structure matches monorepo layout",
            ],
            requiredToolCapabilities: [
              "system.writeFile",
              "system.readFile",
              "system.listDir",
              "system.bash",
            ],
            contextRequirements: ["cwd=/tmp/freight-flow-ts-26"],
            maxBudgetHint: "2m",
            canRunParallel: false,
          },
          {
            name: "install_dependencies",
            stepType: "deterministic_tool",
            dependsOn: ["scaffold_monorepo"],
            tool: "system.bash",
            args: {
              command: "npm",
              args: ["install"],
              cwd: "/tmp/freight-flow-ts-26",
            },
          },
        ],
        edges: [
          { from: "create_project_directory", to: "scaffold_monorepo" },
          { from: "scaffold_monorepo", to: "install_dependencies" },
        ],
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

  it("accepts live web-monorepo refinement steps that stay code-only and pre-install-only", () => {
    const diagnostics = validatePlannerGraph(
      {
        reason: "transit_weave_refined_plan",
        requiresSynthesis: true,
        confidence: 0.86,
        steps: [
          {
            name: "create_directory",
            stepType: "deterministic_tool",
            dependsOn: [],
            tool: "system.bash",
            args: {
              command: "mkdir",
              args: [
                "-p",
                "/tmp/transit-weave-ts-29/packages/core",
                "/tmp/transit-weave-ts-29/packages/cli",
                "/tmp/transit-weave-ts-29/packages/web",
              ],
            },
          },
          {
            name: "scaffold_manifests",
            stepType: "subagent_task",
            dependsOn: ["create_directory"],
            objective:
              "Author only root package.json with workspaces, packages/core/package.json, packages/cli/package.json, packages/web/package.json using file:../core for local dep, tsconfig.json files, vite.config.ts in web, and basic npm scripts. Create no source logic files.",
            inputContract: "Empty dir at target path",
            acceptanceCriteria: [
              "All package.json files authored with correct metadata and file: deps",
              "tsconfig.json and vite config present",
              "Directory structure ready",
              "No logic code or install commands in objective",
            ],
            requiredToolCapabilities: ["system.writeFile", "system.listDir"],
            contextRequirements: ["cwd=/tmp/transit-weave-ts-29"],
            maxBudgetHint: "2m",
            canRunParallel: false,
          },
          {
            name: "install_dependencies",
            stepType: "deterministic_tool",
            dependsOn: ["scaffold_manifests"],
            tool: "system.bash",
            args: {
              command: "npm",
              args: ["install"],
              cwd: "/tmp/transit-weave-ts-29",
            },
          },
          {
            name: "implement_core",
            stepType: "subagent_task",
            dependsOn: ["install_dependencies"],
            objective:
              "Implement TypeScript parser and routing engine in packages/core supporting weighted terrain, one-way conveyors, paired portals, timed switches toggling on alternating turns, and itinerary search from S to G with path reconstruction and cost.",
            inputContract: "ASCII map string with defined symbols for S/G/terrain/mechanics",
            acceptanceCriteria: [
              "parseMap and findItinerary exported and functional",
              "All mechanics (portals, conveyors, switches, weights) implemented",
              "Path and total cost returned",
            ],
            requiredToolCapabilities: ["system.writeFile"],
            contextRequirements: ["cwd=/tmp/transit-weave-ts-29"],
            maxBudgetHint: "8m",
            canRunParallel: false,
          },
          {
            name: "implement_web",
            stepType: "subagent_task",
            dependsOn: ["implement_core"],
            objective:
              "Build Vite TS app in packages/web with map editor, in-browser solver using core, and visualization of path plus cost. Keep code/build only in this step.",
            inputContract: "Core imported via file dep",
            acceptanceCriteria: [
              "Vite app with editable map and solve button",
              "Visual path rendering and cost display",
              "Web source files complete",
            ],
            requiredToolCapabilities: ["system.writeFile"],
            contextRequirements: ["cwd=/tmp/transit-weave-ts-29"],
            maxBudgetHint: "6m",
            canRunParallel: false,
          },
        ],
        edges: [
          { from: "create_directory", to: "scaffold_manifests" },
          { from: "scaffold_manifests", to: "install_dependencies" },
          { from: "install_dependencies", to: "implement_core" },
          { from: "implement_core", to: "implement_web" },
        ],
      },
      {
        maxSubagentFanout: 8,
        maxSubagentDepth: 4,
      },
    );

    expect(
      diagnostics.some((diagnostic) =>
        diagnostic.code === "node_workspace_install_phase_mismatch" &&
        diagnostic.details.stepName === "scaffold_manifests"
      ),
    ).toBe(false);
    expect(
      diagnostics.some((diagnostic) =>
        diagnostic.code === "subagent_step_needs_decomposition" &&
        diagnostic.details.stepName === "implement_web"
      ),
    ).toBe(false);
  });

  it("allows refined workspace plans with source-code-free scaffolding and package-local compile acceptance", () => {
    const diagnostics = validatePlannerGraph(
      {
        reason: "refined_workspace_project",
        requiresSynthesis: true,
        confidence: 0.88,
        steps: [
          {
            name: "create_root_directory",
            stepType: "deterministic_tool",
            dependsOn: [],
            tool: "system.bash",
            args: {
              command: "mkdir",
              args: ["-p", "/tmp/transit-weave/packages/core/src"],
            },
          },
          {
            name: "scaffold_monorepo_configs",
            stepType: "subagent_task",
            dependsOn: ["create_root_directory"],
            objective:
              "Create root and per-package package.json/tsconfig/vite/vitest config files for workspaces monorepo; use file:../core links, add deps like typescript/vitest/commander/react/vite; no source code yet.",
            inputContract: "Root dir and empty package subdirs exist.",
            acceptanceCriteria: [
              "Root package.json has workspaces and scripts; per-package package.json and tsconfigs present; configs valid; no src implementation",
            ],
            requiredToolCapabilities: [
              "system.writeFile",
              "system.bash",
              "system.listDir",
            ],
            contextRequirements: ["cwd=/tmp/transit-weave"],
            maxBudgetHint: "4m",
          },
          {
            name: "install_dependencies",
            stepType: "deterministic_tool",
            dependsOn: ["scaffold_monorepo_configs"],
            tool: "system.bash",
            args: {
              command: "npm",
              args: ["install"],
              cwd: "/tmp/transit-weave",
            },
          },
          {
            name: "implement_core",
            stepType: "subagent_task",
            dependsOn: ["install_dependencies"],
            objective:
              "Implement packages/core/src for ASCII network parse and route search returning best itinerary plus two alternatives.",
            inputContract: "Monorepo scaffolded, deps installed, core/src empty.",
            acceptanceCriteria: [
              "parseNetwork and findRoutes exported with types; logic handles all features; compiles cleanly",
            ],
            requiredToolCapabilities: [
              "system.writeFile",
              "system.readFile",
              "system.bash",
            ],
            contextRequirements: ["cwd=/tmp/transit-weave"],
            maxBudgetHint: "6m",
          },
          {
            name: "implement_cli",
            stepType: "subagent_task",
            dependsOn: ["implement_core"],
            objective:
              "Implement packages/cli with commander commands validate and route that use core; output cost, transfer count, and ordered steps.",
            inputContract: "Core implemented and built; cli/src ready.",
            acceptanceCriteria: [
              "CLI commands functional and compile; uses core package",
            ],
            requiredToolCapabilities: [
              "system.writeFile",
              "system.readFile",
              "system.bash",
            ],
            contextRequirements: ["cwd=/tmp/transit-weave"],
            maxBudgetHint: "4m",
          },
        ],
        edges: [
          { from: "create_root_directory", to: "scaffold_monorepo_configs" },
          { from: "scaffold_monorepo_configs", to: "install_dependencies" },
          { from: "install_dependencies", to: "implement_core" },
          { from: "implement_core", to: "implement_cli" },
        ],
      },
      {
        maxSubagentFanout: 8,
        maxSubagentDepth: 4,
      },
    );

    expect(
      diagnostics.some((diagnostic) =>
        diagnostic.code === "subagent_step_needs_decomposition"
      ),
    ).toBe(false);
    expect(
      diagnostics.some((diagnostic) =>
        diagnostic.code === "node_workspace_install_phase_mismatch"
      ),
    ).toBe(false);
  });

  it("allows workspace bootstrap steps whose acceptance criteria only require build configs to exist", () => {
    const diagnostics = validatePlannerGraph(
      {
        reason: "bootstrap_workspace_project",
        requiresSynthesis: true,
        confidence: 0.85,
        steps: [
          {
            name: "create_directories",
            stepType: "deterministic_tool",
            dependsOn: [],
            tool: "system.bash",
            args: {
              command: "mkdir",
              args: ["-p", "/tmp/transit-weave/packages/core/src"],
            },
          },
          {
            name: "bootstrap_monorepo",
            stepType: "subagent_task",
            dependsOn: ["create_directories"],
            objective:
              "Scaffold root package.json with workspaces and scripts, per-package package.json using file:../core refs, tsconfig.json files, vite.config for web; no workspace:* specifiers",
            inputContract: "Empty dir at cwd",
            acceptanceCriteria: [
              "Root and package manifests valid",
              "TypeScript and build configs present",
              "No unsupported workspace:*",
              "All packages declared",
            ],
            requiredToolCapabilities: [
              "system.bash",
              "system.writeFile",
              "system.readFile",
              "system.listDir",
            ],
            contextRequirements: ["cwd=/tmp/transit-weave"],
            maxBudgetHint: "5m",
          },
          {
            name: "install_dependencies",
            stepType: "deterministic_tool",
            dependsOn: ["bootstrap_monorepo"],
            tool: "system.bash",
            args: {
              command: "npm",
              args: ["install"],
              cwd: "/tmp/transit-weave",
            },
          },
        ],
        edges: [
          { from: "create_directories", to: "bootstrap_monorepo" },
          { from: "bootstrap_monorepo", to: "install_dependencies" },
        ],
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

  it("allows workspace scaffold steps that explicitly prohibit install or test verification before install", () => {
    const diagnostics = validatePlannerGraph(
      {
        reason: "workspace_project",
        requiresSynthesis: true,
        confidence: 0.84,
        steps: [
          {
            name: "scaffold_web",
            stepType: "subagent_task",
            dependsOn: [],
            objective:
              "Scaffold packages/web: run create-vite react-ts, adjust package.json for monorepo/core dep file:../core, vite.config, no install/run or tests in this step.",
            inputContract: "cli scaffolded",
            acceptanceCriteria: ["web created and adjusted for monorepo"],
            requiredToolCapabilities: ["system.bash", "system.writeFile"],
            contextRequirements: ["cwd=/tmp/transit-weave"],
            maxBudgetHint: "3m",
          },
          {
            name: "npm_install",
            stepType: "deterministic_tool",
            dependsOn: ["scaffold_web"],
            tool: "system.bash",
            args: {
              command: "npm",
              args: ["install"],
              cwd: "/tmp/transit-weave",
            },
          },
        ],
        edges: [{ from: "scaffold_web", to: "npm_install" }],
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
