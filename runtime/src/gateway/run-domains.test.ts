import { describe, expect, it } from "vitest";
import {
  createApprovalRunDomain,
  createBrowserRunDomain,
  createDesktopGuiRunDomain,
  createGenericRunDomain,
  createPipelineRunDomain,
  createRemoteMcpRunDomain,
  createResearchRunDomain,
  createWorkspaceRunDomain,
  verificationSupportsContinuation,
  type RunDomainRun,
} from "./run-domains.js";

function makeRun(
  overrides: Partial<RunDomainRun> = {},
): RunDomainRun {
  return {
    id: "bg-test",
    sessionId: "session-test",
    objective: "Monitor the background task.",
    contract: {
      domain: "generic",
      kind: "until_condition",
      successCriteria: ["Verify progress."],
      completionCriteria: ["Observe the success condition."],
      blockedCriteria: ["Missing required access."],
      nextCheckMs: 4_000,
      requiresUserStop: false,
      managedProcessPolicy: { mode: "none" },
    },
    approvalState: { status: "none" },
    blocker: undefined,
    carryForward: undefined,
    pendingSignals: [],
    observedTargets: [],
    watchRegistrations: [],
    lastUserUpdate: undefined,
    lastToolEvidence: undefined,
    ...overrides,
  };
}

describe("run-domains", () => {
  it("generic domain summarizes existing run status", () => {
    const domain = createGenericRunDomain();
    const run = makeRun({
      lastUserUpdate: "Last verified check succeeded.",
    });

    expect(domain.matches(run)).toBe(true);
    expect(domain.summarizeStatus(run)).toBe("Last verified check succeeded.");
    expect(domain.eventSubscriptions(run)).toContain("tool_result");
  });

  it("generic domain restarts completed Doom autoplay sessions natively", async () => {
    const domain = createGenericRunDomain();
    const run = makeRun({
      objective:
        "Supervise the existing ViZDoom session for this user.\n" +
        "A scenario-based session is already configured.\n" +
        'Recovery objective JSON: {"objective_type":"explore","priority":1}\n' +
        "A non-idle gameplay objective is already configured; keep it unless verification shows it is no longer progressing.\n" +
        "If the episode ends or the player dies, use `mcp.doom.new_episode` and continue supervision.\n" +
        "Keep the session visibly active until the user explicitly stops it.",
      contract: {
        ...makeRun().contract,
        kind: "until_stopped",
        requiresUserStop: true,
      },
    });
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const toolHandler = async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === "mcp.doom.get_situation_report") {
        return '[{"episode_finished":true,"player_dead":false,"level_completed":true,"total_reward":93,"executor_state":"idle"}]';
      }
      if (name === "mcp.doom.new_episode") {
        return '{"status":"episode_started"}';
      }
      if (name === "mcp.doom.set_objective") {
        expect(args).toEqual({
          objective_type: "explore",
          priority: 1,
        });
        return '{"status":"objective_set"}';
      }
      throw new Error(`Unexpected tool: ${name}`);
    };

    const result = await domain.executeNativeCycle?.(run, {
      now: 50,
      toolHandler,
    });

    expect(result?.verification).toMatchObject({
      state: "safe_to_continue",
      userUpdate: "ViZDoom episode restarted (reward 93). Restored `explore` to keep gameplay active.",
      nextCheckMs: 4_000,
    });
    expect(result?.actorResult.toolCalls.map((toolCall) => toolCall.name)).toEqual([
      "mcp.doom.get_situation_report",
      "mcp.doom.new_episode",
      "mcp.doom.set_objective",
    ]);
    expect(run.lastVerifiedAt).toBe(50);
    expect(run.lastToolEvidence).toContain("mcp.doom.new_episode");
    expect(calls.map((call) => call.name)).toEqual([
      "mcp.doom.get_situation_report",
      "mcp.doom.new_episode",
      "mcp.doom.set_objective",
    ]);
  });

  it("generic domain preserves Doom movement constraints when recovering idle sessions", async () => {
    const domain = createGenericRunDomain();
    const run = makeRun({
      objective:
        "Supervise the existing ViZDoom session for this user.\n" +
        "The current session already has a user-requested movement constraint; preserve it unless the user changes the task.\n" +
        'Recovery objective JSON: {"objective_type":"hold_position","params":{"no_strafe":true,"smooth_movement":true,"aggressive":true},"priority":1}\n' +
        "If the executor becomes idle or stalls, restore forward progress with an active objective such as `explore`, or use tactical Doom tools directly.",
      contract: {
        ...makeRun().contract,
        kind: "until_stopped",
        requiresUserStop: true,
      },
    });
    const toolHandler = async (name: string, args: Record<string, unknown>) => {
      if (name === "mcp.doom.get_situation_report") {
        return '{"episode_finished":false,"player_dead":false,"level_completed":false,"executor_state":"idle","game_variables":{"KILLCOUNT":2}}';
      }
      if (name === "mcp.doom.set_objective") {
        expect(args).toEqual({
          objective_type: "hold_position",
          params: {
            no_strafe: true,
            smooth_movement: true,
            aggressive: true,
          },
          priority: 1,
        });
        return '{"status":"objective_set"}';
      }
      throw new Error(`Unexpected tool: ${name}`);
    };

    const result = await domain.executeNativeCycle?.(run, {
      now: 75,
      toolHandler,
    });

    expect(result?.verification).toMatchObject({
      state: "safe_to_continue",
      userUpdate:
        "ViZDoom executor went idle. Restored `hold_position` to keep gameplay moving.",
      nextCheckMs: 4_000,
    });
    expect(result?.actorResult.toolCalls.map((toolCall) => toolCall.name)).toEqual([
      "mcp.doom.get_situation_report",
      "mcp.doom.set_objective",
    ]);
    expect(run.lastVerifiedAt).toBe(75);
    expect(run.lastToolEvidence).toContain("mcp.doom.set_objective");
  });

  it("approval domain blocks deterministically while approval is pending", () => {
    const domain = createApprovalRunDomain();
    const run = makeRun({
      contract: {
        ...makeRun().contract,
        domain: "approval",
      },
      approvalState: {
        status: "waiting",
        requestedAt: 100,
        summary: "Waiting for approval from the operator.",
      },
    });

    const verification = domain.detectDeterministicVerification(run);

    expect(domain.matches(run)).toBe(true);
    expect(verification).toMatchObject({
      state: "blocked",
      blockerCode: "approval_required",
      safeToContinue: false,
    });
    expect(verificationSupportsContinuation(verification!)).toBe(false);
  });

  it("browser domain completes finite download objectives from artifact evidence", () => {
    const domain = createBrowserRunDomain();
    const run = makeRun({
      objective: "Download the report from the browser session.",
      contract: {
        domain: "browser",
        kind: "finite",
        successCriteria: ["Download the report artifact."],
        completionCriteria: ["Observe the report download completing."],
        blockedCriteria: ["Browser automation fails."],
        nextCheckMs: 4_000,
        requiresUserStop: false,
      },
      pendingSignals: [
        {
          id: "sig-browser-download",
          type: "tool_result",
          content: "Browser download completed at /tmp/report.pdf.",
          timestamp: 1,
          data: {
            category: "browser",
            toolName: "mcp.browser.browser_download",
            artifactPath: "/tmp/report.pdf",
            failed: false,
          },
        },
      ],
    });

    expect(domain.detectDeterministicVerification(run)).toMatchObject({
      state: "success",
      userUpdate: expect.stringContaining("Objective satisfied"),
    });
  });

  it("desktop gui domain blocks on explicit GUI tool failures", () => {
    const domain = createDesktopGuiRunDomain();
    const run = makeRun({
      contract: {
        ...makeRun().contract,
        domain: "desktop_gui",
      },
      pendingSignals: [
        {
          id: "sig-gui-failure",
          type: "tool_result",
          content: "Tool desktop.launch failed: application not found.",
          timestamp: 2,
          data: {
            category: "generic",
            toolName: "desktop.launch",
            failed: true,
            error: "application not found",
          },
        },
      ],
    });

    expect(domain.detectBlocker(run)).toMatchObject({
      state: "blocked",
      blockerCode: "tool_failure",
    });
  });

  it("workspace domain completes deterministic build/test objectives from command signals", () => {
    const domain = createWorkspaceRunDomain();
    const run = makeRun({
      objective: "Run the workspace test suite successfully.",
      contract: {
        domain: "workspace",
        kind: "finite",
        successCriteria: ["Execute the workspace tests."],
        completionCriteria: ["Verify the test command succeeds."],
        blockedCriteria: ["Workspace tooling is missing."],
        nextCheckMs: 4_000,
        requiresUserStop: false,
      },
      pendingSignals: [
        {
          id: "sig-workspace-test",
          type: "tool_result",
          content: "Tool result observed for system.bash.",
          timestamp: 3,
          data: {
            category: "generic",
            toolName: "system.bash",
            command: "npm",
            failed: false,
          },
        },
      ],
    });

    expect(domain.detectDeterministicVerification(run)).toMatchObject({
      state: "success",
    });
  });

  it("workspace domain completes finite workspace command objectives from generic shell evidence", () => {
    const domain = createWorkspaceRunDomain();
    const run = makeRun({
      objective: "Run `git status --short` in the workspace and tell me when the command succeeds.",
      contract: {
        domain: "workspace",
        kind: "finite",
        successCriteria: ["Execute the workspace command successfully."],
        completionCriteria: ["Verify the command succeeds in the workspace."],
        blockedCriteria: ["Workspace tooling is missing."],
        nextCheckMs: 4_000,
        requiresUserStop: false,
      },
      pendingSignals: [
        {
          id: "sig-workspace-command",
          type: "tool_result",
          content: "Tool result observed for desktop.bash.",
          timestamp: 3,
          data: {
            category: "generic",
            toolName: "desktop.bash",
            command: "git status --short",
            failed: false,
          },
        },
      ],
    });

    expect(domain.detectDeterministicVerification(run)).toMatchObject({
      state: "success",
      userUpdate: "Tool result observed for desktop.bash. Objective satisfied.",
    });
  });

  it("workspace domain executes explicit finite workspace commands natively", async () => {
    const domain = createWorkspaceRunDomain();
    const run = makeRun({
      objective: "Run `git status --short` in the workspace and tell me when the command succeeds.",
      contract: {
        domain: "workspace",
        kind: "until_condition",
        successCriteria: ["Execute the workspace command successfully."],
        completionCriteria: ["Verify the command succeeds in the workspace."],
        blockedCriteria: ["Workspace tooling is missing."],
        nextCheckMs: 4_000,
        requiresUserStop: false,
      },
    });
    const toolHandler = async (name: string, args: Record<string, unknown>) => {
      expect(name).toBe("system.bash");
      expect(args).toEqual({
        command: "git",
        args: ["status", "--short"],
      });
      return '{"stdout":"","stderr":"","exitCode":0}';
    };

    const result = await domain.executeNativeCycle?.(run, {
      now: 10,
      toolHandler,
    });

    expect(result?.verification).toMatchObject({
      state: "success",
      userUpdate: "Workspace command `git status --short` succeeded. Objective satisfied.",
    });
    expect(run.lastToolEvidence).toContain("system.bash [ok]");
    expect(run.lastVerifiedAt).toBe(10);
  });

  it("research domain treats persisted report artifacts as deterministic completion", () => {
    const domain = createResearchRunDomain();
    const run = makeRun({
      objective: "Research the vendor and save a short report.",
      contract: {
        domain: "research",
        kind: "finite",
        successCriteria: ["Produce the report artifact."],
        completionCriteria: ["Persist the report to disk."],
        blockedCriteria: ["Research tools fail."],
        nextCheckMs: 4_000,
        requiresUserStop: false,
      },
      pendingSignals: [
        {
          id: "sig-research-report",
          type: "webhook",
          content: "Artifact watcher saved the research report.",
          timestamp: 4,
          data: {
            source: "artifact-watcher",
            path: "/tmp/research-report.md",
          },
        },
      ],
    });

    expect(domain.detectDeterministicVerification(run)).toMatchObject({
      state: "success",
    });
  });

  it("pipeline domain blocks unhealthy service transitions deterministically", () => {
    const domain = createPipelineRunDomain();
    const run = makeRun({
      contract: {
        ...makeRun().contract,
        domain: "pipeline",
      },
      pendingSignals: [
        {
          id: "sig-pipeline-unhealthy",
          type: "external_event",
          content: "Service health event server.health for http://localhost:8080 (unhealthy).",
          timestamp: 5,
          data: {
            eventType: "server.health",
            state: "unhealthy",
            status: 503,
          },
        },
      ],
    });

    expect(domain.detectBlocker(run)).toMatchObject({
      state: "blocked",
      blockerCode: "missing_prerequisite",
    });
  });

  it("remote MCP domain completes from explicit remote job completion events", () => {
    const domain = createRemoteMcpRunDomain();
    const run = makeRun({
      objective: "Wait for the remote MCP job to finish.",
      contract: {
        domain: "remote_mcp",
        kind: "finite",
        successCriteria: ["Observe the remote MCP job complete."],
        completionCriteria: ["Receive a completion event from the remote server."],
        blockedCriteria: ["Remote MCP job fails."],
        nextCheckMs: 4_000,
        requiresUserStop: false,
      },
      pendingSignals: [
        {
          id: "sig-mcp-complete",
          type: "tool_result",
          content: "MCP event observed from remote-job-server (job-42) completed successfully.",
          timestamp: 6,
          data: {
            category: "mcp",
            jobId: "job-42",
            serverName: "remote-job-server",
            state: "completed",
            failed: false,
          },
        },
      ],
    });

    expect(domain.detectDeterministicVerification(run)).toMatchObject({
      state: "success",
    });
  });
});
