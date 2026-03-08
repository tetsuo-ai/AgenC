import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

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
      buildStartArgs: ({ label, idempotencyKey }) => ({
        command: "/bin/sleep",
        args: ["5"],
        label,
        idempotencyKey,
      }),
      buildStatusArgs: ({ label, idempotencyKey }) => ({
        ...(label ? { label } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
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

  it("rejects denied commands", async () => {
    const manager = createManager();

    const result = await manager.start({
      command: "bash",
      args: ["-lc", "sleep 1"],
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("system_process.denied_command");
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
