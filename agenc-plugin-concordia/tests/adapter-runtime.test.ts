import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

describe("ConcordiaChannelAdapter registry-backed pending response handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    simulationRunnerMocks.reset();
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
});
