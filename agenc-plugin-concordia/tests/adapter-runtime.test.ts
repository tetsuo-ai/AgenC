import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const simulationRunnerMocks = vi.hoisted(() => {
  let nextPid = 4000;
  const launchSimulationRunnerMock = vi.fn(async () => {
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      exitCode: number | null;
      kill: ReturnType<typeof vi.fn>;
    };
    child.pid = nextPid++;
    child.exitCode = null;
    child.kill = vi.fn();
    return {
      child,
      tempDir: `/tmp/concordia-${child.pid}`,
    };
  });
  const stopSimulationRunnerMock = vi.fn(async () => undefined);
  const reset = () => {
    nextPid = 4000;
    launchSimulationRunnerMock.mockClear();
    stopSimulationRunnerMock.mockClear();
  };
  return {
    launchSimulationRunnerMock,
    stopSimulationRunnerMock,
    reset,
  };
});

vi.mock("../src/simulation-runner.js", () => ({
  launchSimulationRunner: simulationRunnerMocks.launchSimulationRunnerMock,
  stopSimulationRunner: simulationRunnerMocks.stopSimulationRunnerMock,
}));

import { ConcordiaChannelAdapter } from "../src/adapter.js";

type PrivateAdapter = ConcordiaChannelAdapter & Record<string, any>;

function makeContext(overrides: Record<string, unknown> = {}) {
  return {
    config: {},
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    on_message: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createHandle(adapter: PrivateAdapter, simulationId: string) {
  return adapter.registry.createHandle({
    request: {
      world_id: `world-${simulationId}`,
      workspace_id: `ws-${simulationId}`,
      simulation_id: simulationId,
      lineage_id: null,
      parent_simulation_id: null,
      agents: [],
      premise: `premise-${simulationId}`,
    },
    status: "running",
    currentAlias: false,
  });
}

function createSession(adapter: PrivateAdapter, simulationId: string, agentId: string) {
  return adapter.sessionManager.getOrCreate({
    agentId,
    agentName: agentId,
    worldId: `world-${simulationId}`,
    workspaceId: `ws-${simulationId}`,
    simulationId,
  });
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function flushCleanupTurn(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

const LOOPBACK_HOST = "127.0.0.1";
const PLAY_CONTROL_PORT = 4101;
const PLAY_EVENT_PORT = 4102;
const STEP_CONTROL_PORT = 4201;
const STEP_EVENT_PORT = 4202;

function controlUrl(controlPort: number, command: string): string {
  return `http://${LOOPBACK_HOST}:${controlPort}/simulation/${command}`;
}

function statusUrl(controlPort: number): string {
  return `http://${LOOPBACK_HOST}:${controlPort}/simulation/status`;
}

function makeRunnerStatus(overrides: Record<string, unknown> = {}) {
  return {
    step: 2,
    max_steps: 10,
    running: true,
    paused: false,
    world_id: "world-sim-play",
    simulation_id: "sim-play",
    agent_count: 1,
    last_step_outcome: "step_complete",
    terminal_reason: null,
    last_transition_at: 1,
    ...overrides,
  };
}

function stubLifecycleFetch(
  controlPort: number,
  command: "play" | "step",
  statusPayload: Record<string, unknown>,
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === controlUrl(controlPort, command)) {
      expect(init?.method).toBe("POST");
      return jsonResponse({ status: "ok" });
    }
    if (url === statusUrl(controlPort)) {
      return jsonResponse(statusPayload);
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function launchControllableSimulation(
  adapter: PrivateAdapter,
  params: {
    readonly worldId: string;
    readonly workspaceId: string;
    readonly simulationId: string;
    readonly premise: string;
    readonly controlPort: number;
    readonly eventPort: number;
    readonly maxSteps?: number;
  },
): Promise<void> {
  await adapter.handleLaunch({
    world_id: params.worldId,
    workspace_id: params.workspaceId,
    simulation_id: params.simulationId,
    agents: [{ agent_id: "agent-a", agent_name: "Agent A", personality: "steady" }],
    premise: params.premise,
    control_port: params.controlPort,
    event_port: params.eventPort,
    max_steps: params.maxSteps ?? 10,
  });
}

describe("ConcordiaChannelAdapter registry-backed pending response handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    simulationRunnerMocks.reset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves a pending act via session fallback when request_id is missing", async () => {
    const adapter = new ConcordiaChannelAdapter() as PrivateAdapter;
    const context = makeContext();
    await adapter.initialize(context as never);

    const handle = createHandle(adapter, "sim-1");
    const session = createSession(adapter, "sim-1", "agent-a");
    const pending = adapter.createPendingResponse(
      handle,
      "req-1",
      session.sessionId,
      "agent-a",
      5_000,
      "timeout",
      session.worldId,
      1,
      handle.simulationId,
    ) as Promise<string>;

    await adapter.send({
      session_id: session.sessionId,
      content: "resolved action",
      is_partial: false,
      metadata: {},
    } as never);

    await expect(pending).resolves.toBe("resolved action");
    expect(handle.pendingResponses.size).toBe(0);
    expect(context.logger.warn).toHaveBeenCalled();
  });

  it("rejects the pending act immediately on session mismatch", async () => {
    const adapter = new ConcordiaChannelAdapter() as PrivateAdapter;
    const context = makeContext();
    await adapter.initialize(context as never);

    const handle = createHandle(adapter, "sim-2");
    const session = createSession(adapter, "sim-2", "agent-a");
    const pending = adapter.createPendingResponse(
      handle,
      "req-2",
      session.sessionId,
      "agent-a",
      5_000,
      "timeout",
      session.worldId,
      2,
      handle.simulationId,
    ) as Promise<string>;

    await adapter.send({
      session_id: "other-session",
      content: "resolved action",
      is_partial: false,
      metadata: { request_id: "req-2" },
    } as never);

    await expect(pending).rejects.toThrow(/session mismatch/);
    expect(handle.pendingResponses.size).toBe(0);
  });

  it("keeps pending responses isolated per simulation", async () => {
    const adapter = new ConcordiaChannelAdapter() as PrivateAdapter;
    const context = makeContext();
    await adapter.initialize(context as never);

    const handleA = createHandle(adapter, "sim-a");
    const handleB = createHandle(adapter, "sim-b");
    const sessionA = createSession(adapter, "sim-a", "agent-a");
    const sessionB = createSession(adapter, "sim-b", "agent-b");

    const pendingA = adapter.createPendingResponse(
      handleA,
      "req-a",
      sessionA.sessionId,
      "agent-a",
      5_000,
      "timeout",
      sessionA.worldId,
      1,
      handleA.simulationId,
    ) as Promise<string>;
    const pendingB = adapter.createPendingResponse(
      handleB,
      "req-b",
      sessionB.sessionId,
      "agent-b",
      5_000,
      "timeout",
      sessionB.worldId,
      1,
      handleB.simulationId,
    ) as Promise<string>;

    await adapter.send({
      session_id: sessionB.sessionId,
      content: "crossed response",
      is_partial: false,
      metadata: { request_id: "req-a" },
    } as never);

    await expect(pendingA).rejects.toThrow(/session mismatch/);
    expect(handleA.pendingResponses.size).toBe(0);
    expect(handleB.pendingResponses.size).toBe(1);

    await adapter.send({
      session_id: sessionB.sessionId,
      content: "resolved b",
      is_partial: false,
      metadata: { request_id: "req-b" },
    } as never);

    await expect(pendingB).resolves.toBe("resolved b");
    expect(handleB.pendingResponses.size).toBe(0);
  });

  it("ignores out-of-band messages without request_id when nothing is pending", async () => {
    const adapter = new ConcordiaChannelAdapter();
    const context = makeContext();
    await adapter.initialize(context as never);

    await adapter.send({
      session_id: "session-idle",
      content: "approval prompt",
      is_partial: false,
      metadata: {},
    } as never);

    expect(context.logger.warn).not.toHaveBeenCalled();
    expect(context.logger.debug).toHaveBeenCalled();
  });

  it("cleans up a pending act when dispatch into the daemon pipeline fails", async () => {
    const onMessage = vi.fn().mockImplementation(async () => {
      throw new Error("dispatch exploded");
    });
    const adapter = new ConcordiaChannelAdapter() as PrivateAdapter;
    const context = makeContext({ on_message: onMessage });
    await adapter.initialize(context as never);

    const handle = createHandle(adapter, "sim-dispatch");
    const session = createSession(adapter, "sim-dispatch", "agent-a");
    adapter.registry.setCurrentAlias(handle.simulationId);

    await expect(
      adapter.handleAct("agent-a", session.sessionId, "What do you do?", "req-3"),
    ).rejects.toThrow("dispatch exploded");

    expect(handle.pendingResponses.size).toBe(0);
    expect(onMessage).toHaveBeenCalledOnce();
  });

  it("launches a second simulation without overwriting the first", async () => {
    const adapter = new ConcordiaChannelAdapter() as PrivateAdapter;
    const context = makeContext();
    await adapter.initialize(context as never);

    await adapter.handleLaunch({
      world_id: "world-alpha",
      workspace_id: "ws-alpha",
      simulation_id: "sim-alpha",
      agents: [],
      premise: "alpha premise",
    });
    await adapter.handleLaunch({
      world_id: "world-beta",
      workspace_id: "ws-beta",
      simulation_id: "sim-beta",
      agents: [],
      premise: "beta premise",
    });

    const summaries = adapter.registry.listSummaries();
    expect(
      summaries.map((summary: { simulation_id: string }) => summary.simulation_id),
    ).toEqual(expect.arrayContaining(["sim-alpha", "sim-beta"]));
    expect(adapter.registry.get("sim-alpha")?.runner).toBeTruthy();
    expect(adapter.registry.get("sim-beta")?.runner).toBeTruthy();
    expect(simulationRunnerMocks.stopSimulationRunnerMock).not.toHaveBeenCalled();
  });

  it("records trust, visibility, and provenance on replay events", async () => {
    const adapter = new ConcordiaChannelAdapter() as PrivateAdapter;
    const context = makeContext();
    await adapter.initialize(context as never);

    createHandle(adapter, "sim-governed");

    await adapter.handleEvent({
      type: "action",
      step: 3,
      acting_agent: "agent-a",
      content: "Agent A posts a bid.",
      world_id: "world-sim-governed",
      workspace_id: "ws-sim-governed",
      simulation_id: "sim-governed",
      timestamp: 12345,
      metadata: { source: "live-test" },
    });

    const replayEvents = adapter.registry.listReplayEvents("sim-governed");
    expect(replayEvents).toHaveLength(1);
    expect(replayEvents[0]).toEqual(expect.objectContaining({
      visibility: "world-visible",
      trust: expect.objectContaining({ source: "agent" }),
      provenance: [expect.objectContaining({
        type: "concordia_event:action",
        source: "agent",
        source_id: "agent-a",
        simulation_id: "sim-governed",
      })],
      world_event: expect.objectContaining({
        trust: expect.objectContaining({ source: "agent" }),
        provenance: [expect.objectContaining({ type: "concordia_event:action" })],
      }),
      metadata: expect.objectContaining({
        trust_source: "agent",
        provenance_type: "concordia_event:action",
      }),
    }));
  });


  it("rejects new launches when simulation capacity is exhausted", async () => {
    const adapter = new ConcordiaChannelAdapter() as PrivateAdapter;
    const context = makeContext({ config: { max_concurrent_simulations: 1 } });
    await adapter.initialize(context as never);

    await adapter.handleLaunch({
      world_id: "world-alpha",
      workspace_id: "ws-alpha",
      simulation_id: "sim-alpha",
      agents: [],
      premise: "alpha premise",
    });

    await expect(
      adapter.handleLaunch({
        world_id: "world-beta",
        workspace_id: "ws-beta",
        simulation_id: "sim-beta",
        agents: [],
        premise: "beta premise",
      }),
    ).rejects.toThrow(/capacity exhausted/i);
    expect(simulationRunnerMocks.launchSimulationRunnerMock).toHaveBeenCalledTimes(1);
  });

  it("passes resolved run budgets and runner operation timeouts into the runner", async () => {
    const adapter = new ConcordiaChannelAdapter() as PrivateAdapter;
    const context = makeContext({
      config: {
        act_timeout_ms: 90_000,
        simultaneous_max_workers: 6,
        proxy_action_timeout_seconds: 45,
        proxy_action_max_retries: 4,
        proxy_retry_delay_seconds: 3,
        runner_startup_timeout_ms: 12_345,
        runner_shutdown_timeout_ms: 6_789,
      },
    });
    await adapter.initialize(context as never);

    await adapter.handleLaunch({
      world_id: "world-budget",
      workspace_id: "ws-budget",
      simulation_id: "sim-budget",
      agents: [],
      premise: "budget premise",
      run_budget: {
        act_timeout_ms: 30_000,
        simultaneous_max_workers: 2,
        proxy_action_timeout_seconds: 12,
        proxy_action_max_retries: 1,
        proxy_retry_delay_seconds: 0.5,
      },
    });

    const launchArgs = simulationRunnerMocks.launchSimulationRunnerMock.mock.calls[0]?.[0];
    expect(launchArgs.runnerStartupTimeoutMs).toBe(12_345);
    expect(launchArgs.runnerShutdownTimeoutMs).toBe(6_789);
    expect(launchArgs.request.run_budget).toEqual({
      act_timeout_ms: 30_000,
      simultaneous_max_workers: 2,
      proxy_action_timeout_seconds: 12,
      proxy_action_max_retries: 1,
      proxy_retry_delay_seconds: 0.5,
    });
  });

  it("uses the configured runner shutdown timeout during cleanup", async () => {
    const adapter = new ConcordiaChannelAdapter() as PrivateAdapter;
    const context = makeContext({ config: { runner_shutdown_timeout_ms: 4_321 } });
    await adapter.initialize(context as never);

    await adapter.handleLaunch({
      world_id: "world-cleanup",
      workspace_id: "ws-cleanup",
      simulation_id: "sim-cleanup",
      agents: [],
      premise: "cleanup premise",
    });

    const handle = adapter.registry.get("sim-cleanup");
    const runner = handle?.runner ?? null;
    expect(runner).toBeTruthy();

    await adapter.cleanupSimulationHandle(handle, "cleanup test", {
      status: "stopped",
      stopRunner: true,
      removeSessions: true,
      runPostCleanup: false,
      clearMemoryContext: true,
    });

    expect(simulationRunnerMocks.stopSimulationRunnerMock).toHaveBeenCalledWith(
      runner,
      4_321,
    );
  });

  it("advances a paused simulation past step 1 when play is issued", async () => {
    const fetchMock = stubLifecycleFetch(
      PLAY_CONTROL_PORT,
      "play",
      makeRunnerStatus({
        world_id: "world-sim-play",
        simulation_id: "sim-play",
      }),
    );

    const adapter = new ConcordiaChannelAdapter() as PrivateAdapter;
    await adapter.initialize(makeContext() as never);
    await launchControllableSimulation(adapter, {
      worldId: "world-sim-play",
      workspaceId: "ws-sim-play",
      simulationId: "sim-play",
      premise: "play premise",
      controlPort: PLAY_CONTROL_PORT,
      eventPort: PLAY_EVENT_PORT,
    });

    adapter.registry.updateLifecycle("sim-play", {
      status: "paused",
      lastCompletedStep: 1,
      lastStepOutcome: "idle",
    });

    const status = await adapter.handleControlSimulation("sim-play", "play");

    expect(status).toEqual(expect.objectContaining({
      simulation_id: "sim-play",
      status: "running",
      paused: false,
      step: 2,
      last_step_outcome: "step_complete",
    }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("advances exactly one step and remains paused when step is issued", async () => {
    const fetchMock = stubLifecycleFetch(
      STEP_CONTROL_PORT,
      "step",
      makeRunnerStatus({
        paused: true,
        world_id: "world-sim-step",
        simulation_id: "sim-step",
        last_step_outcome: "single_step_complete",
      }),
    );

    const adapter = new ConcordiaChannelAdapter() as PrivateAdapter;
    await adapter.initialize(makeContext() as never);
    await launchControllableSimulation(adapter, {
      worldId: "world-sim-step",
      workspaceId: "ws-sim-step",
      simulationId: "sim-step",
      premise: "step premise",
      controlPort: STEP_CONTROL_PORT,
      eventPort: STEP_EVENT_PORT,
    });

    adapter.registry.updateLifecycle("sim-step", {
      status: "paused",
      lastCompletedStep: 1,
      lastStepOutcome: "idle",
    });

    const stepped = await adapter.handleControlSimulation("sim-step", "step");
    const refreshed = await adapter.handleGetSimulationStatus("sim-step");

    expect(stepped).toEqual(expect.objectContaining({
      simulation_id: "sim-step",
      status: "paused",
      paused: true,
      step: 2,
    }));
    expect(refreshed?.step).toBe(2);
    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/simulation/status"))).toHaveLength(2);
  });

  it("stops a simulation by clearing pending responses and shutting down the runner", async () => {
    const adapter = new ConcordiaChannelAdapter() as PrivateAdapter;
    await adapter.initialize(makeContext() as never);
    await adapter.handleLaunch({
      world_id: "world-stop",
      workspace_id: "ws-stop",
      simulation_id: "sim-stop",
      agents: [{ agent_id: "agent-a", agent_name: "Agent A", personality: "steady" }],
      premise: "stop premise",
      control_port: 4301,
      event_port: 4302,
    });

    const handle = adapter.registry.get("sim-stop");
    const session = createSession(adapter, "sim-stop", "agent-a");
    const pending = adapter.createPendingResponse(
      handle,
      "req-stop",
      session.sessionId,
      "agent-a",
      5_000,
      "timeout",
      session.worldId,
      3,
      handle.simulationId,
    ) as Promise<string>;

    await adapter.cleanupSimulationHandle(handle, "stop requested", {
      status: "stopped",
      stopRunner: true,
      removeSessions: true,
      runPostCleanup: false,
      clearMemoryContext: true,
    });

    await expect(pending).rejects.toThrow(/stop requested/i);
    expect(adapter.registry.getPendingResponseCount()).toBe(0);
    expect(simulationRunnerMocks.stopSimulationRunnerMock).toHaveBeenCalledOnce();
    expect(adapter.registry.get("sim-stop")?.status).toBe("stopped");
  });


  it("does not emit unhandled rejections when shutdown clears a pending act", async () => {
    const adapter = new ConcordiaChannelAdapter() as PrivateAdapter;
    await adapter.initialize(makeContext() as never);
    await adapter.handleLaunch({
      world_id: "world-stop-clean",
      workspace_id: "ws-stop-clean",
      simulation_id: "sim-stop-clean",
      agents: [{ agent_id: "agent-a", agent_name: "Agent A", personality: "steady" }],
      premise: "stop premise",
      control_port: 4311,
      event_port: 4312,
    });

    const handle = adapter.registry.get("sim-stop-clean");
    const session = createSession(adapter, "sim-stop-clean", "agent-a");
    const pending = adapter.createPendingResponse(
      handle,
      "req-stop-clean",
      session.sessionId,
      "agent-a",
      5_000,
      "timeout",
      session.worldId,
      4,
      handle.simulationId,
    ) as Promise<string>;
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    try {
      await adapter.cleanupSimulationHandle(handle, "stop requested", {
        status: "stopped",
        stopRunner: true,
        removeSessions: true,
        runPostCleanup: false,
        clearMemoryContext: true,
      });
      await flushCleanupTurn();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.removeListener("unhandledRejection", unhandled);
      await pending.catch(() => undefined);
    }
  });

  it("terminalizes one simulation on unexpected child exit without corrupting others", async () => {
    const adapter = new ConcordiaChannelAdapter() as PrivateAdapter;
    await adapter.initialize(makeContext() as never);

    await adapter.handleLaunch({
      world_id: "world-sim-a",
      workspace_id: "ws-sim-a",
      simulation_id: "sim-a",
      agents: [],
      premise: "alpha premise",
      control_port: 4401,
      event_port: 4402,
    });
    await adapter.handleLaunch({
      world_id: "world-sim-b",
      workspace_id: "ws-sim-b",
      simulation_id: "sim-b",
      agents: [],
      premise: "beta premise",
      control_port: 4501,
      event_port: 4502,
    });

    adapter.registry.updateLifecycle("sim-a", { status: "running" });
    adapter.registry.updateLifecycle("sim-b", { status: "running" });
    const runnerA = adapter.registry.get("sim-a")?.runner;
    const runnerB = adapter.registry.get("sim-b")?.runner;

    adapter.handleRunnerExit("sim-a", runnerA, 1, null);
    await flushCleanupTurn();

    expect(adapter.registry.get("sim-a")?.status).toBe("failed");
    expect(adapter.registry.get("sim-a")?.error).toContain("runner exited code=1");
    expect(adapter.registry.get("sim-b")?.status).toBe("running");
    expect(adapter.registry.get("sim-b")?.runner).toBe(runnerB);
  });

  it("preserves stopped status when a user-stopped runner exits cleanly", async () => {
    const adapter = new ConcordiaChannelAdapter() as PrivateAdapter;
    await adapter.initialize(makeContext() as never);

    await adapter.handleLaunch({
      world_id: "world-stop",
      workspace_id: "ws-stop",
      simulation_id: "sim-stop",
      agents: [],
      premise: "stop premise",
      control_port: 4601,
      event_port: 4602,
    });

    adapter.registry.updateLifecycle("sim-stop", {
      status: "stopping",
      reason: "stop_requested",
    });
    const runner = adapter.registry.get("sim-stop")?.runner;

    adapter.handleRunnerExit("sim-stop", runner, 0, null);
    await flushCleanupTurn();

    expect(adapter.registry.get("sim-stop")?.status).toBe("stopped");
    expect(adapter.registry.get("sim-stop")?.reason).toBe("stopped_by_user");
    expect(adapter.registry.get("sim-stop")?.error).toBeNull();
  });

  it("ignores events whose simulation identity does not match a known run", async () => {
    const context = makeContext();
    const adapter = new ConcordiaChannelAdapter() as PrivateAdapter;
    await adapter.initialize(context as never);
    createHandle(adapter, "sim-known");

    await adapter.handleEvent({
      type: "resolution",
      step: 4,
      acting_agent: "agent-a",
      content: "This should be ignored.",
      world_id: "world-sim-known",
      workspace_id: "ws-sim-known",
      simulation_id: "sim-unknown",
    });

    expect(adapter.registry.listReplayEvents("sim-known")).toHaveLength(0);
    expect(context.logger.warn).toHaveBeenCalledWith(
      "[concordia] Ignoring event for unknown simulation sim-unknown",
    );
  });

  it("rejects act requests when the session survives but the simulation handle is gone", async () => {
    const context = makeContext();
    const adapter = new ConcordiaChannelAdapter() as PrivateAdapter;
    await adapter.initialize(context as never);

    const session = createSession(adapter, "sim-orphan", "agent-a");

    await expect(
      adapter.handleAct(
        "agent-a",
        session.sessionId,
        "Take a turn.",
        "req-orphan",
      ),
    ).rejects.toThrow("Simulation sim-orphan is not active");

    expect(context.logger.warn).toHaveBeenCalledWith(
      "[concordia] Rejecting /act for unknown simulation sim-orphan",
    );
    expect(adapter.registry.get("sim-orphan")).toBeUndefined();
  });

  it("resumes a stopped simulation into a lineage-linked child run without reusing sessions", async () => {
    const adapter = new ConcordiaChannelAdapter() as PrivateAdapter;
    await adapter.initialize(makeContext() as never);

    const originalSession = createSession(adapter, "sim-a", "agent-a");
    const resumed = await adapter.handleResume({
      simulation_id: "sim-c",
      checkpoint: {
        checkpoint_id: "sim-a:step:5",
        checkpoint_path: "/tmp/sim-a_step_5.json",
        schema_version: 3,
        version: 3,
        world_id: "world-sim-a",
        workspace_id: "ws-sim-a",
        simulation_id: "sim-a",
        lineage_id: "lineage-a",
        parent_simulation_id: null,
        step: 5,
        timestamp: 123,
        max_steps: 12,
        user_id: null,
        config: {
          world_id: "world-sim-a",
          workspace_id: "ws-sim-a",
          simulation_id: "sim-a",
          premise: "resume premise",
          agents: [{ id: "agent-a", name: "Agent A", personality: "steady", goal: "watch" }],
        },
        restored_sessions: [],
        scene_cursor: null,
        runtime_cursor: {
          current_step: 5,
          start_step: 6,
          max_steps: 12,
          last_acting_agent: "agent-a",
          last_step_outcome: "resolved",
          engine_type: "simultaneous",
        },
        replay_cursor: {
          replay_cursor: 9,
          replay_event_count: 9,
          last_event_id: "9",
        },
        world_state_refs: {
          source: "inline_checkpoint",
          gm_state_key: "gm_state",
          entity_state_keys: ["agent-a"],
          authoritative_snapshot_ref: null,
        },
        memory_namespace_refs: {},
        subsystem_state: {
          resumed: ["gm_state", "entity_states", "scene_cursor", "runtime_cursor", "replay_cursor", "session_mappings", "world_state_refs", "memory_namespaces"],
          reset: ["control_port", "event_port", "pending_responses", "live_subscribers", "runner_process"],
        },
        entity_logs: {},
        entity_states: {
          "agent-a": { turn_count: 5, last_action: "Inspect the square" },
        },
        gm_state: {},
        agent_ids: ["agent-a"],
      },
    });

    const resumedSession = adapter.sessionManager.getAllForSimulation("sim-c", "ws-sim-a")[0];
    expect(resumed).toEqual(expect.objectContaining({
      simulation_id: "sim-c",
      lineage_id: "lineage-a",
      parent_simulation_id: "sim-a",
      resumed_from_step: 5,
    }));
    expect(resumedSession?.sessionId).toBeTruthy();
    expect(resumedSession?.sessionId).not.toBe(originalSession.sessionId);
    expect(adapter.registry.get("sim-c")?.status).toBe("paused");
    expect(adapter.registry.get("sim-c")?.lineageId).toBe("lineage-a");
  });


});
