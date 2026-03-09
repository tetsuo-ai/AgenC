import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createProcessTools, SystemProcessManager } from "./process.js";
import { runDurableHandleContractSuite } from "./handle-contract.test-utils.js";
import { silentLogger } from "../../utils/logger.js";

function wait(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

describe("system.process tools", () => {
  const cleanup: Array<{ manager: SystemProcessManager; rootDir: string }> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      const entry = cleanup.pop()!;
      await entry.manager.resetForTesting();
    }
  });

  function createManager(): SystemProcessManager {
    const rootDir = mkdtempSync(join(tmpdir(), "agenc-system-process-test-"));
    const manager = new SystemProcessManager({
      rootDir,
      allowList: ["/bin/sleep", "sleep", "/bin/echo", "echo"],
      logger: silentLogger,
      defaultStopWaitMs: 250,
    });
    cleanup.push({ manager, rootDir });
    return manager;
  }

  runDurableHandleContractSuite(() => {
    const manager = createManager();
    return {
      family: "system-process",
      handleIdField: "processId",
      runningState: "running",
      terminalState: "exited",
      resourceEnvelope: {
        cpu: 1,
        memoryMb: 128,
        wallClockMs: 30_000,
        environmentClass: "host",
        enforcement: "best_effort",
      },
      buildStartArgs: ({ label, idempotencyKey }) => ({
        command: "/bin/sleep",
        args: ["5"],
        label,
        idempotencyKey,
        resourceEnvelope: {
          cpu: 1,
          memoryMb: 128,
          wallClockMs: 30_000,
          environmentClass: "host",
        },
      }),
      buildStatusArgs: ({ label, idempotencyKey }) => ({
        ...(label ? { label } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      }),
      buildMissingStatusArgs: () => ({
        label: "missing-system-process-handle",
      }),
      buildStopArgs: ({ handleId, label, idempotencyKey }) => ({
        ...(handleId ? { processId: handleId } : {}),
        ...(label ? { label } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
        waitMs: 250,
      }),
      start: async (args) => JSON.parse((await manager.start(args)).content) as Record<string, unknown>,
      status: async (args) => JSON.parse((await manager.status(args)).content) as Record<string, unknown>,
      stop: async (args) => JSON.parse((await manager.stop(args)).content) as Record<string, unknown>,
    };
  });

  it("creates the five structured process tools", () => {
    const tools = createProcessTools({ rootDir: "/tmp/ignored", logger: silentLogger });
    expect(tools.map((tool) => tool.name)).toEqual([
      "system.processStart",
      "system.processStatus",
      "system.processResume",
      "system.processStop",
      "system.processLogs",
    ]);
  });

  it("starts, inspects, and stops a managed host process", async () => {
    const manager = createManager();

    const started = JSON.parse((await manager.start({
      command: "/bin/sleep",
      args: ["5"],
      label: "sleep-test",
    })).content) as Record<string, unknown>;

    expect(started.processId).toMatch(/^proc_/);
    expect(started.state).toBe("running");

    const status = JSON.parse((await manager.status({
      label: "sleep-test",
    })).content) as Record<string, unknown>;
    const resumed = JSON.parse((await manager.resume({
      label: "sleep-test",
    })).content) as Record<string, unknown>;

    expect(status.processId).toBe(started.processId);
    expect(status.state).toBe("running");
    expect(resumed.processId).toBe(started.processId);
    expect(resumed.resumed).toBe(true);

    const stopped = JSON.parse((await manager.stop({
      label: "sleep-test",
      waitMs: 250,
    })).content) as Record<string, unknown>;

    expect(stopped.processId).toBe(started.processId);
    expect(stopped.state).toBe("exited");
    expect(stopped.stopped).toBe(true);
  });

  it("captures persisted log output for short-lived commands", async () => {
    const manager = createManager();

    const started = JSON.parse((await manager.start({
      command: "/bin/echo",
      args: ["hello from process tool"],
      label: "echo-test",
    })).content) as Record<string, unknown>;

    await wait(75);

    const logs = JSON.parse((await manager.logs({
      processId: started.processId,
    })).content) as Record<string, unknown>;
    const status = JSON.parse((await manager.status({
      processId: started.processId,
    })).content) as Record<string, unknown>;

    expect(String(logs.output)).toContain("hello from process tool");
    expect(status.state).toBe("exited");
  });

  it("emits lifecycle callbacks when a managed host process exits", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "agenc-system-process-events-"));
    const onLifecycleEvent = vi.fn(async () => undefined);
    const manager = new SystemProcessManager({
      rootDir,
      allowList: ["/bin/echo", "echo"],
      logger: silentLogger,
      onLifecycleEvent,
    });
    cleanup.push({ manager, rootDir });

    const started = JSON.parse((await manager.start({
      command: "/bin/echo",
      args: ["evented"],
      label: "echo-evented",
    })).content) as Record<string, unknown>;

    await wait(75);

    expect(onLifecycleEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        processId: started.processId,
        label: "echo-evented",
        state: "exited",
        exitCode: 0,
        cause: "child_exit",
      }),
    );
  });

  it("surfaces immediate output for fast-exit commands without an external sleep", async () => {
    const manager = createManager();

    const started = JSON.parse((await manager.start({
      command: "/bin/echo",
      args: ["fast output"],
      label: "echo-immediate",
    })).content) as Record<string, unknown>;

    const logs = JSON.parse((await manager.logs({
      processId: started.processId,
      waitForOutputMs: 250,
    })).content) as Record<string, unknown>;
    const status = JSON.parse((await manager.status({
      processId: started.processId,
    })).content) as Record<string, unknown>;

    expect(String(logs.output)).toContain("fast output");
    expect(logs.state).toBe("exited");
    expect(status.state).toBe("exited");
  });

  it("migrates persisted stopped state to exited on load", async () => {
    const manager = createManager();
    const rootDir = cleanup[cleanup.length - 1]!.rootDir;

    await writeFile(
      join(rootDir, "registry.json"),
      JSON.stringify({
        version: 1,
        processes: [
          {
            version: 1,
            processId: "proc_legacy",
            label: "legacy-sleep",
            command: "/bin/sleep",
            args: ["1"],
            cwd: "/tmp",
            logPath: join(rootDir, "proc_legacy", "process.log"),
            pid: 999999,
            pgid: 999999,
            state: "stopped",
            createdAt: 1,
            updatedAt: 2,
            startedAt: 1,
            lastExitAt: 2,
            exitCode: 0,
            signal: null,
          },
        ],
      }),
      "utf8",
    );

    const status = JSON.parse((await manager.status({
      label: "legacy-sleep",
    })).content) as Record<string, unknown>;

    expect(status.processId).toBe("proc_legacy");
    expect(status.state).toBe("exited");
  });

  it("fails closed for persisted running handles that lack identity metadata", async () => {
    const manager = createManager();
    const rootDir = cleanup[cleanup.length - 1]!.rootDir;

    await writeFile(
      join(rootDir, "registry.json"),
      JSON.stringify({
        version: 1,
        processes: [
          {
            version: 1,
            processId: "proc_missing_identity",
            label: "legacy-running",
            command: "/bin/sleep",
            args: ["5"],
            cwd: "/tmp",
            logPath: join(rootDir, "proc_missing_identity", "process.log"),
            pid: process.pid,
            pgid: process.pid,
            state: "running",
            createdAt: 1,
            updatedAt: 2,
            startedAt: 1,
          },
        ],
      }),
      "utf8",
    );

    const status = JSON.parse((await manager.status({
      processId: "proc_missing_identity",
    })).content) as Record<string, unknown>;

    expect(status.state).toBe("exited");
    expect(String(status.lastError)).toMatch(/missing persisted identity metadata/i);
  });

  it("does not treat a mismatched live pid as the original managed process", async () => {
    const manager = createManager();
    const rootDir = cleanup[cleanup.length - 1]!.rootDir;

    await writeFile(
      join(rootDir, "registry.json"),
      JSON.stringify({
        version: 1,
        processes: [
          {
            version: 1,
            processId: "proc_stale_identity",
            label: "stale-running",
            command: "/bin/sleep",
            args: ["5"],
            cwd: "/tmp",
            logPath: join(rootDir, "proc_stale_identity", "process.log"),
            pid: process.pid,
            pgid: process.pid,
            processStartToken: "stale-start-token",
            processBootId: "stale-boot-id",
            state: "running",
            createdAt: 1,
            updatedAt: 2,
            startedAt: 1,
          },
        ],
      }),
      "utf8",
    );

    const stopped = JSON.parse((await manager.stop({
      processId: "proc_stale_identity",
      waitMs: 100,
    })).content) as Record<string, unknown>;

    expect(stopped.state).toBe("exited");
    expect(stopped.stopped).toBe(false);
    expect(String(stopped.lastError)).toMatch(/identity mismatch/i);
  });

  it("rejects denied commands", async () => {
    const manager = createManager();

    const result = await manager.start({
      command: "bash",
      args: ["-lc", "sleep 1"],
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("system_process.denied_command");
  });

  it("bypasses deny-prefix enforcement in unrestricted trusted mode", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "agenc-system-process-unrestricted-"));
    const manager = new SystemProcessManager({
      rootDir,
      unrestricted: true,
      logger: silentLogger,
      defaultStopWaitMs: 250,
    });
    cleanup.push({ manager, rootDir });

    const started = JSON.parse((await manager.start({
      command: process.execPath,
      args: ["-e", "setInterval(()=>{}, 1000);"],
      label: "trusted-node",
    })).content) as Record<string, unknown>;

    expect(started.processId).toMatch(/^proc_/);
    expect(started.state).toBe("running");

    const stopped = JSON.parse((await manager.stop({
      processId: String(started.processId),
      waitMs: 250,
    })).content) as Record<string, unknown>;

    expect(stopped.state).toBe("exited");
  });

  it("allows python3 when explicitly excluded from the structured process deny list", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "agenc-system-process-python-"));
    const manager = new SystemProcessManager({
      rootDir,
      allowList: ["python3"],
      denyExclusions: ["python3"],
      logger: silentLogger,
      defaultStopWaitMs: 250,
    });
    cleanup.push({ manager, rootDir });

    const started = JSON.parse((await manager.start({
      command: "python3",
      args: ["-c", "import time; time.sleep(5)"],
      label: "python-sleep",
    })).content) as Record<string, unknown>;

    expect(started.processId).toMatch(/^proc_/);
    expect(started.state).toBe("running");

    const stopped = JSON.parse((await manager.stop({
      processId: String(started.processId),
      waitMs: 250,
    })).content) as Record<string, unknown>;
    expect(stopped.state).toBe("exited");
  });

  it("reclaims a label once the previous process has exited", async () => {
    const manager = createManager();

    const started = JSON.parse((await manager.start({
      command: "/bin/echo",
      args: ["done"],
      label: "echo-once",
    })).content) as Record<string, unknown>;
    expect(started.processId).toBeDefined();

    await wait(75);

    const second = await manager.start({
      command: "/bin/echo",
      args: ["done"],
      label: "echo-once",
    });

    expect(second.isError).toBeUndefined();
    const parsed = JSON.parse(second.content) as Record<string, unknown>;
    expect(parsed.processId).not.toBe(started.processId);
    expect(parsed.label).toBe("echo-once");
  });
});
