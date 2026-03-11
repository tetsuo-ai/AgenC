import { describe, it, expect } from "vitest";
import {
  assessDelegationDecision,
  resolveDelegationDecisionConfig,
} from "./delegation-decision.js";

describe("delegation-decision", () => {
  it("normalizes delegation scoring config bounds", () => {
    const resolved = resolveDelegationDecisionConfig({
      enabled: true,
      mode: "handoff",
      scoreThreshold: 2,
      maxFanoutPerTurn: 0,
      maxDepth: -1,
      handoffMinPlannerConfidence: 2,
      hardBlockedTaskClasses: ["wallet_transfer", "destructive_host_mutation"],
    });

    expect(resolved.enabled).toBe(true);
    expect(resolved.mode).toBe("handoff");
    expect(resolved.scoreThreshold).toBe(1);
    expect(resolved.maxFanoutPerTurn).toBe(1);
    expect(resolved.maxDepth).toBe(1);
    expect(resolved.handoffMinPlannerConfidence).toBe(1);
    expect(resolved.hardBlockedTaskClasses.has("wallet_transfer")).toBe(true);
    expect(
      resolved.hardBlockedTaskClasses.has("destructive_host_mutation"),
    ).toBe(true);
  });

  it("vetoes trivial single-hop plans", () => {
    const decision = assessDelegationDecision({
      messageText: "First run one quick check and report.",
      complexityScore: 4,
      totalSteps: 1,
      synthesisSteps: 0,
      edges: [],
      subagentSteps: [
        {
          name: "quick_check",
          acceptanceCriteria: ["return one status"],
          requiredToolCapabilities: ["system.readFile"],
          contextRequirements: ["workspace_root"],
          maxBudgetHint: "2m",
          canRunParallel: false,
        },
      ],
      config: { enabled: true, scoreThreshold: 0.65 },
    });

    expect(decision.shouldDelegate).toBe(false);
    expect(decision.reason).toBe("trivial_request");
  });

  it("vetoes delegation when fanout exceeds configured guardrail", () => {
    const decision = assessDelegationDecision({
      messageText: "Analyze module A and module B, then summarize.",
      complexityScore: 7,
      totalSteps: 2,
      synthesisSteps: 0,
      edges: [],
      subagentSteps: [
        {
          name: "a",
          acceptanceCriteria: ["evidence"],
          requiredToolCapabilities: ["system.readFile"],
          contextRequirements: ["module_a"],
          maxBudgetHint: "5m",
          canRunParallel: true,
        },
        {
          name: "b",
          acceptanceCriteria: ["evidence"],
          requiredToolCapabilities: ["system.readFile"],
          contextRequirements: ["module_b"],
          maxBudgetHint: "5m",
          canRunParallel: true,
        },
      ],
      config: {
        enabled: true,
        scoreThreshold: 0.2,
        maxFanoutPerTurn: 1,
      },
    });

    expect(decision.shouldDelegate).toBe(false);
    expect(decision.reason).toBe("fanout_exceeded");
  });

  it("approves delegation when utility clears threshold and guardrails", () => {
    const decision = assessDelegationDecision({
      messageText:
        "First cluster CI failures, then map source hotspots, then merge findings into one remediation plan.",
      complexityScore: 9,
      totalSteps: 3,
      synthesisSteps: 1,
      edges: [{ from: "logs", to: "code" }],
      subagentSteps: [
        {
          name: "logs",
          acceptanceCriteria: ["cluster failures", "cite evidence"],
          requiredToolCapabilities: ["system.readFile", "system.searchFiles"],
          contextRequirements: ["ci_logs", "recent_failures"],
          maxBudgetHint: "10m",
          canRunParallel: true,
        },
        {
          name: "code",
          dependsOn: ["logs"],
          acceptanceCriteria: ["map hotspots to clusters"],
          requiredToolCapabilities: ["system.readFile", "system.searchFiles"],
          contextRequirements: ["runtime_sources", "test_sources"],
          maxBudgetHint: "10m",
          canRunParallel: true,
        },
      ],
      config: { enabled: true, scoreThreshold: 0.2 },
    });

    expect(decision.shouldDelegate).toBe(true);
    expect(decision.reason).toBe("approved");
    expect(decision.utilityScore).toBeGreaterThanOrEqual(0.2);
  });

  it("hard-blocks delegation for wallet transfer/signing task classes", () => {
    const decision = assessDelegationDecision({
      messageText: "Sign and send SOL transfer from treasury wallet.",
      complexityScore: 8,
      totalSteps: 2,
      synthesisSteps: 0,
      edges: [],
      subagentSteps: [
        {
          name: "transfer",
          acceptanceCriteria: ["signed tx", "transfer receipt"],
          requiredToolCapabilities: ["wallet.transfer"],
          contextRequirements: ["treasury_wallet"],
          maxBudgetHint: "5m",
          canRunParallel: false,
        },
      ],
      config: {
        enabled: true,
        scoreThreshold: 0.2,
        hardBlockedTaskClasses: ["wallet_transfer"],
      },
    });

    expect(decision.shouldDelegate).toBe(false);
    expect(decision.reason).toBe("hard_blocked_task_class");
    expect(decision.diagnostics.hasHardBlockedTaskClass).toBe(true);
    expect(decision.hardBlockedTaskClass).toBe("wallet_transfer");
    expect(decision.hardBlockedTaskClassSource).toBe("capability");
    expect(decision.hardBlockedTaskClassSignal).toBe("wallet.transfer");
  });

  it("requires explicit planner confidence threshold for handoff mode", () => {
    const decision = assessDelegationDecision({
      messageText: "Decompose this investigation and hand off execution.",
      plannerConfidence: 0.55,
      complexityScore: 9,
      totalSteps: 3,
      synthesisSteps: 1,
      edges: [],
      subagentSteps: [
        {
          name: "delegate_a",
          acceptanceCriteria: ["collect evidence"],
          requiredToolCapabilities: ["system.readFile", "system.searchFiles"],
          contextRequirements: ["runtime_sources"],
          maxBudgetHint: "10m",
          canRunParallel: true,
        },
        {
          name: "delegate_b",
          acceptanceCriteria: ["correlate findings"],
          requiredToolCapabilities: ["system.readFile"],
          contextRequirements: ["test_sources"],
          maxBudgetHint: "10m",
          canRunParallel: true,
        },
      ],
      config: {
        enabled: true,
        mode: "handoff",
        handoffMinPlannerConfidence: 0.8,
        scoreThreshold: 0.2,
      },
    });

    expect(decision.shouldDelegate).toBe(false);
    expect(decision.reason).toBe("handoff_confidence_below_threshold");
  });

  it("does not auto-veto coding delegation just because child steps write files", () => {
    const decision = assessDelegationDecision({
      messageText:
        "Scaffold the TypeScript library, implement the solver, add the CLI, add tests, then summarize the exact passing commands.",
      complexityScore: 9,
      totalSteps: 5,
      synthesisSteps: 1,
      edges: [
        { from: "core", to: "algorithms" },
        { from: "algorithms", to: "cli" },
        { from: "cli", to: "tests" },
      ],
      subagentSteps: [
        {
          name: "core",
          acceptanceCriteria: ["Parser compiles", "Grid types exported"],
          requiredToolCapabilities: [
            "system.writeFile",
            "system.readFile",
            "system.bash",
          ],
          contextRequirements: ["workspace_ready"],
          maxBudgetHint: "5m",
          canRunParallel: false,
        },
        {
          name: "algorithms",
          dependsOn: ["core"],
          acceptanceCriteria: ["BFS works", "Dijkstra works", "A* works"],
          requiredToolCapabilities: [
            "system.writeFile",
            "system.readFile",
            "system.bash",
          ],
          contextRequirements: ["core"],
          maxBudgetHint: "5m",
          canRunParallel: false,
        },
      ],
      config: { enabled: true, scoreThreshold: 0.2 },
    });

    expect(decision.shouldDelegate).toBe(true);
    expect(decision.reason).toBe("approved");
    expect(decision.safetyRisk).toBeLessThan(0.9);
  });

  it("does not treat plain delegation wording as stake-or-rewards intent", () => {
    const decision = assessDelegationDecision({
      messageText:
        "Build a TypeScript workspace from scratch and delegate separate child phases for scaffold, core implementation, CLI/tests, and verification.",
      complexityScore: 8,
      totalSteps: 5,
      synthesisSteps: 1,
      edges: [
        { from: "scaffold", to: "core" },
        { from: "core", to: "cli_tests" },
        { from: "cli_tests", to: "verify" },
      ],
      subagentSteps: [
        {
          name: "scaffold",
          acceptanceCriteria: ["workspace exists", "tsconfig configured"],
          requiredToolCapabilities: ["system.bash", "system.writeFile"],
          contextRequirements: ["cwd=/home/tetsuo/agent-test/terrain-router-ts-3"],
          maxBudgetHint: "5m",
          canRunParallel: false,
        },
        {
          name: "core",
          dependsOn: ["scaffold"],
          acceptanceCriteria: ["router implemented", "parser implemented"],
          requiredToolCapabilities: [
            "system.bash",
            "system.writeFile",
            "system.readFile",
          ],
          contextRequirements: ["cwd=/home/tetsuo/agent-test/terrain-router-ts-3"],
          maxBudgetHint: "12m",
          canRunParallel: false,
        },
        {
          name: "cli_tests",
          dependsOn: ["core"],
          acceptanceCriteria: ["CLI implemented", "tests added"],
          requiredToolCapabilities: [
            "system.bash",
            "system.writeFile",
            "system.readFile",
          ],
          contextRequirements: ["cwd=/home/tetsuo/agent-test/terrain-router-ts-3"],
          maxBudgetHint: "8m",
          canRunParallel: false,
        },
        {
          name: "verify",
          dependsOn: ["cli_tests"],
          acceptanceCriteria: ["npm run build passes", "tests pass"],
          requiredToolCapabilities: ["system.bash", "system.writeFile"],
          contextRequirements: ["cwd=/home/tetsuo/agent-test/terrain-router-ts-3"],
          maxBudgetHint: "10m",
          canRunParallel: false,
        },
      ],
      config: { enabled: true, scoreThreshold: 0.2 },
    });

    expect(decision.shouldDelegate).toBe(true);
    expect(decision.reason).toBe("approved");
    expect(decision.hardBlockedTaskClass).toBeNull();
    expect(decision.diagnostics.hasHardBlockedTaskClass).toBe(false);
  });

  it("still hard-blocks genuine staking or reward tasks from text evidence", () => {
    const decision = assessDelegationDecision({
      messageText:
        "Delegate stake from the treasury wallet to the validator and claim staking rewards after confirmation.",
      complexityScore: 8,
      totalSteps: 2,
      synthesisSteps: 0,
      edges: [],
      subagentSteps: [
        {
          name: "staking_flow",
          acceptanceCriteria: [
            "stake delegated to validator",
            "staking rewards claimed",
          ],
          requiredToolCapabilities: ["system.readFile"],
          contextRequirements: ["treasury_wallet"],
          maxBudgetHint: "5m",
          canRunParallel: false,
        },
      ],
      config: {
        enabled: true,
        scoreThreshold: 0.2,
        hardBlockedTaskClasses: ["stake_or_rewards"],
      },
    });

    expect(decision.shouldDelegate).toBe(false);
    expect(decision.reason).toBe("hard_blocked_task_class");
    expect(decision.hardBlockedTaskClass).toBe("stake_or_rewards");
    expect(decision.hardBlockedTaskClassSource).toBe("text");
    expect(decision.hardBlockedTaskClassSignal).toMatch(
      /stake from the treasury wallet to the validator|staking rewards/i,
    );
    expect(decision.diagnostics.hardBlockedTaskClassMatchedByText).toBe(true);
  });

  it("keeps repeated coding capabilities from inflating safety risk across sequential phases", () => {
    const sequentialDecision = assessDelegationDecision({
      messageText:
        "Build the TypeScript grid-router project end-to-end with delegated implementation, CLI, demos, tests, and validation phases.",
      complexityScore: 4,
      totalSteps: 12,
      synthesisSteps: 1,
      edges: [
        { from: "implement_core_library", to: "implement_cli" },
        { from: "implement_cli", to: "create_demos_and_readme" },
        { from: "create_demos_and_readme", to: "create_tests" },
      ],
      subagentSteps: [
        {
          name: "implement_core_library",
          acceptanceCriteria: [
            "src/gridRouter.ts created with parseMap, solveBFS, solveDijkstra, solveAStar",
            "Supports weights and portals",
            "Returns path, cost, visited stats",
          ],
          requiredToolCapabilities: [
            "system.writeFile",
            "system.readFile",
            "system.bash",
          ],
          contextRequirements: ["cwd=/home/tetsuo/agent-test/grid-router-ts"],
          maxBudgetHint: "4m",
          canRunParallel: false,
        },
        {
          name: "implement_cli",
          dependsOn: ["implement_core_library"],
          acceptanceCriteria: [
            "src/cli.ts parses args and calls solver",
            "Outputs required stats and overlay",
            "Builds to dist/cli.js",
          ],
          requiredToolCapabilities: ["system.writeFile", "system.bash"],
          contextRequirements: ["cwd=/home/tetsuo/agent-test/grid-router-ts"],
          maxBudgetHint: "2m",
          canRunParallel: false,
        },
        {
          name: "create_demos_and_readme",
          dependsOn: ["implement_cli"],
          acceptanceCriteria: [
            "demos/ has >=3 .txt files",
            "README.md covers all requirements and CLI examples",
          ],
          requiredToolCapabilities: ["system.writeFile"],
          contextRequirements: ["cwd=/home/tetsuo/agent-test/grid-router-ts"],
          maxBudgetHint: "90s",
          canRunParallel: false,
        },
        {
          name: "create_tests",
          dependsOn: ["create_demos_and_readme"],
          acceptanceCriteria: [
            "tests/ has test file",
            ">=8 passing tests for parse/solvers",
          ],
          requiredToolCapabilities: ["system.writeFile", "system.bash"],
          contextRequirements: ["cwd=/home/tetsuo/agent-test/grid-router-ts"],
          maxBudgetHint: "2m",
          canRunParallel: false,
        },
      ],
      config: { enabled: true, scoreThreshold: 0.2 },
    });

    const parallelDecision = assessDelegationDecision({
      messageText:
        "Split the same coding task across parallel delegated phases that all need the same risky tools.",
      complexityScore: 4,
      totalSteps: 12,
      synthesisSteps: 1,
      edges: [],
      subagentSteps: [
        {
          name: "phase_a",
          acceptanceCriteria: ["A"],
          requiredToolCapabilities: ["system.writeFile", "system.bash"],
          contextRequirements: ["cwd=/tmp/project"],
          maxBudgetHint: "2m",
          canRunParallel: true,
        },
        {
          name: "phase_b",
          acceptanceCriteria: ["B"],
          requiredToolCapabilities: ["system.writeFile", "system.bash"],
          contextRequirements: ["cwd=/tmp/project"],
          maxBudgetHint: "2m",
          canRunParallel: true,
        },
        {
          name: "phase_c",
          acceptanceCriteria: ["C"],
          requiredToolCapabilities: ["system.writeFile", "system.bash"],
          contextRequirements: ["cwd=/tmp/project"],
          maxBudgetHint: "2m",
          canRunParallel: true,
        },
      ],
      config: { enabled: true, scoreThreshold: 0.2 },
    });

    expect(sequentialDecision.shouldDelegate).toBe(true);
    expect(sequentialDecision.reason).toBe("approved");
    expect(sequentialDecision.safetyRisk).toBeLessThan(0.35);
    expect(sequentialDecision.utilityScore).toBeGreaterThanOrEqual(0.2);
    expect(parallelDecision.safetyRisk).toBeGreaterThan(
      sequentialDecision.safetyRisk,
    );
  });

  it("approves moderate multi-phase coding fanout at the calibrated default threshold", () => {
    const decision = assessDelegationDecision({
      messageText:
        "In /home/tetsuo/agent-test create a new folder named grid-router-ts and build the project there. " +
        "Create a reusable npm + TypeScript library plus CLI for solving ASCII grid maps. " +
        "Implement BFS, Dijkstra, and A* search, support weighted tiles and one-way portals, " +
        "add demo maps, add Vitest coverage, run build/tests, and report the exact passing commands.",
      complexityScore: 4,
      totalSteps: 8,
      synthesisSteps: 1,
      edges: [
        { from: "create_dir", to: "setup_project" },
        { from: "setup_project", to: "implement_core" },
        { from: "implement_core", to: "add_cli_demos" },
        { from: "add_cli_demos", to: "add_tests" },
        { from: "add_tests", to: "build_and_test" },
        { from: "build_and_test", to: "run_tests" },
        { from: "run_tests", to: "synthesize_results" },
      ],
      subagentSteps: [
        {
          name: "setup_project",
          acceptanceCriteria: [
            "package.json ready with scripts",
            "tsconfig.json",
            "deps installed",
            "src dir",
          ],
          requiredToolCapabilities: ["bash", "file_write"],
          contextRequirements: ["directory exists"],
          maxBudgetHint: "3m",
          canRunParallel: false,
        },
        {
          name: "implement_core",
          dependsOn: ["setup_project"],
          acceptanceCriteria: [
            "Algorithms implemented and exported",
            "handles stdin/file input",
            "weighted tiles and portals supported",
          ],
          requiredToolCapabilities: ["bash", "file_write"],
          contextRequirements: ["src dir ready"],
          maxBudgetHint: "5m",
          canRunParallel: false,
        },
        {
          name: "add_cli_demos",
          dependsOn: ["implement_core"],
          acceptanceCriteria: [
            "CLI prints length/cost/visited+overlay",
            "3 demo .txt maps",
            "README with examples",
          ],
          requiredToolCapabilities: ["bash", "file_write"],
          contextRequirements: ["core lib present"],
          maxBudgetHint: "3m",
          canRunParallel: false,
        },
        {
          name: "add_tests",
          dependsOn: ["add_cli_demos"],
          acceptanceCriteria: [
            ">=8 passing Vitest tests",
            "test/ dir with .test.ts",
          ],
          requiredToolCapabilities: ["bash", "file_write"],
          contextRequirements: ["prior files complete"],
          maxBudgetHint: "3m",
          canRunParallel: false,
        },
      ],
      config: { enabled: true },
    });

    expect(decision.shouldDelegate).toBe(true);
    expect(decision.reason).toBe("approved");
    expect(decision.threshold).toBe(0.2);
    expect(decision.utilityScore).toBeGreaterThanOrEqual(0.2);
  });

  it("approves deep sequential planner-shaped coding plans without collapsing into fallback loops", () => {
    const decision = assessDelegationDecision({
      messageText:
        "In /home/tetsuo/agent-test create a new folder named grid-router-ts and build the project there. " +
        "Create a reusable npm + TypeScript library plus CLI for solving ASCII grid maps. " +
        "Support weighted tiles and one-way portals, add demo maps, add Vitest coverage, " +
        "run build/tests, and report exact passing commands.",
      plannerConfidence: 1,
      complexityScore: 5,
      totalSteps: 11,
      synthesisSteps: 1,
      edges: [
        { from: "initialize_project", to: "implement_core_library" },
        { from: "implement_core_library", to: "implement_cli" },
        { from: "implement_cli", to: "add_demo_maps" },
        { from: "add_demo_maps", to: "add_tests" },
        { from: "add_tests", to: "create_readme" },
      ],
      subagentSteps: [
        {
          name: "initialize_project",
          acceptanceCriteria: [
            "package.json present",
            "tsconfig.json present",
            "deps installed",
          ],
          requiredToolCapabilities: ["file_system", "package_manager"],
          contextRequirements: ["cwd=/home/tetsuo/agent-test/grid-router-ts"],
          maxBudgetHint: "2m",
          canRunParallel: false,
        },
        {
          name: "implement_core_library",
          dependsOn: ["initialize_project"],
          acceptanceCriteria: [
            "grid parser implemented",
            "BFS, Dijkstra, and A* implemented",
            "weights and portals supported",
          ],
          requiredToolCapabilities: ["code_generation", "file_system"],
          contextRequirements: ["cwd=/home/tetsuo/agent-test/grid-router-ts"],
          maxBudgetHint: "5m",
          canRunParallel: false,
        },
        {
          name: "implement_cli",
          dependsOn: ["implement_core_library"],
          acceptanceCriteria: [
            "CLI reads stdin or file",
            "CLI prints stats and overlay",
          ],
          requiredToolCapabilities: ["code_generation", "file_system"],
          contextRequirements: ["cwd=/home/tetsuo/agent-test/grid-router-ts"],
          maxBudgetHint: "3m",
          canRunParallel: false,
        },
        {
          name: "add_demo_maps",
          dependsOn: ["implement_cli"],
          acceptanceCriteria: ["3 demo maps present"],
          requiredToolCapabilities: ["file_system"],
          contextRequirements: ["cwd=/home/tetsuo/agent-test/grid-router-ts"],
          maxBudgetHint: "1m",
          canRunParallel: false,
        },
        {
          name: "add_tests",
          dependsOn: ["add_demo_maps"],
          acceptanceCriteria: [
            ">=8 tests present",
            "tests cover parse and routing",
          ],
          requiredToolCapabilities: ["code_generation", "file_system"],
          contextRequirements: ["cwd=/home/tetsuo/agent-test/grid-router-ts"],
          maxBudgetHint: "4m",
          canRunParallel: false,
        },
        {
          name: "create_readme",
          dependsOn: ["add_tests"],
          acceptanceCriteria: ["README has usage examples"],
          requiredToolCapabilities: ["file_system", "documentation"],
          contextRequirements: ["cwd=/home/tetsuo/agent-test/grid-router-ts"],
          maxBudgetHint: "1m",
          canRunParallel: false,
        },
      ],
      config: { enabled: true, scoreThreshold: 0.2 },
    });

    expect(decision.shouldDelegate).toBe(true);
    expect(decision.reason).toBe("approved");
    expect(decision.utilityScore).toBeGreaterThanOrEqual(0.2);
    expect(decision.coordinationOverhead).toBeLessThan(0.7);
    expect(decision.latencyCostRisk).toBeLessThan(0.7);
  });
});
