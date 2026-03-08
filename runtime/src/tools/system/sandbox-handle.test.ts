import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { silentLogger } from "../../utils/logger.js";
import { runDurableHandleContractSuite } from "./handle-contract.test-utils.js";
import { createSandboxTools, SystemSandboxManager } from "./sandbox-handle.js";
import { handleErrorResult, handleOkResult } from "./handle-contract.js";

class FakeContainerAdapter {
  private counter = 0;
  readonly containers = new Map<string, { running: boolean; name: string }>();

  async createContainer(spec: {
    readonly sandboxId: string;
  }): Promise<{ readonly containerId: string; readonly containerName: string }> {
    this.counter += 1;
    const containerId = `ctr_${this.counter}`;
    const containerName = `agenc-sandbox-handle-${spec.sandboxId}`;
    this.containers.set(containerId, { running: true, name: containerName });
    return { containerId, containerName };
  }

  async inspectContainer(containerId: string): Promise<{
    readonly exists: boolean;
    readonly running: boolean;
    readonly exitCode?: number;
  }> {
    const entry = this.containers.get(containerId);
    if (!entry) {
      return { exists: false, running: false };
    }
    return {
      exists: true,
      running: entry.running,
      exitCode: entry.running ? 0 : 0,
    };
  }

  async stopContainer(containerId: string): Promise<void> {
    const entry = this.containers.get(containerId);
    if (!entry) {
      return;
    }
    entry.running = false;
  }
}

class FakeJobRunner {
  private counter = 0;
  readonly processes = new Map<string, { state: "running" | "exited"; log: string }>();

  async start(args: Record<string, unknown>) {
    this.counter += 1;
    const processId = `proc_${this.counter}`;
    const command = String(args.command ?? "");
    this.processes.set(processId, {
      state: "running",
      log: `${command} ${(args.args as string[] | undefined)?.join(" ") ?? ""}`.trim(),
    });
    return handleOkResult({
      processId,
      state: "running",
      logPath: `/tmp/${processId}.log`,
      recentOutput: this.processes.get(processId)?.log ?? "",
    });
  }

  async status(args: Record<string, unknown>) {
    const record = this.processes.get(String(args.processId ?? ""));
    if (!record) {
      return handleErrorResult(
        "system_process",
        "system_process.not_found",
        "Managed process not found.",
        false,
        undefined,
        "status",
        "not_found",
      );
    }
    return handleOkResult({
      processId: String(args.processId),
      state: record.state,
      recentOutput: record.log,
    });
  }

  async resume(args: Record<string, unknown>) {
    const status = await this.status(args);
    if (status.isError) return status;
    const parsed = JSON.parse(status.content) as Record<string, unknown>;
    return handleOkResult({ ...parsed, resumed: parsed.state === "running" });
  }

  async stop(args: Record<string, unknown>) {
    const record = this.processes.get(String(args.processId ?? ""));
    if (!record) {
      return handleErrorResult(
        "system_process",
        "system_process.not_found",
        "Managed process not found.",
        false,
        undefined,
        "stop",
        "not_found",
      );
    }
    record.state = "exited";
    return handleOkResult({
      processId: String(args.processId),
      state: "exited",
      stopped: true,
      recentOutput: record.log,
    });
  }

  async logs(args: Record<string, unknown>) {
    const record = this.processes.get(String(args.processId ?? ""));
    if (!record) {
      return handleErrorResult(
        "system_process",
        "system_process.not_found",
        "Managed process not found.",
        false,
        undefined,
        "logs",
        "not_found",
      );
    }
    return handleOkResult({
      processId: String(args.processId),
      state: record.state,
      output: record.log,
    });
  }
}

describe("system.sandbox tools", () => {
  const cleanup: SystemSandboxManager[] = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      const manager = cleanup.pop()!;
      await manager.resetForTesting();
    }
  });

  function createManager(): {
    readonly manager: SystemSandboxManager;
    readonly adapter: FakeContainerAdapter;
    readonly jobs: FakeJobRunner;
  } {
    const rootDir = mkdtempSync(join(tmpdir(), "agenc-system-sandbox-test-"));
    const adapter = new FakeContainerAdapter();
    const jobs = new FakeJobRunner();
    const manager = new SystemSandboxManager(
      {
        rootDir,
        logger: silentLogger,
        workspacePath: "/workspace",
      },
      {
        containerAdapter: adapter as any,
        jobRunner: jobs as any,
      },
    );
    cleanup.push(manager);
    return { manager, adapter, jobs };
  }

  runDurableHandleContractSuite(() => {
    const { manager } = createManager();
    return {
      family: "system-sandbox",
      handleIdField: "sandboxId",
      runningState: "running",
      terminalState: "stopped",
      resourceEnvelope: {
        cpu: 1,
        memoryMb: 256,
        wallClockMs: 120_000,
        environmentClass: "sandbox",
        enforcement: "best_effort",
      },
      buildStartArgs: ({ label, idempotencyKey }) => ({
        image: "node:20-slim",
        label,
        idempotencyKey,
        resourceEnvelope: {
          cpu: 1,
          memoryMb: 256,
          wallClockMs: 120_000,
          environmentClass: "sandbox",
        },
      }),
      buildStatusArgs: ({ label, idempotencyKey }) => ({
        ...(label ? { label } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      }),
      buildMissingStatusArgs: () => ({
        label: "missing-sandbox-handle",
      }),
      buildStopArgs: ({ handleId, label, idempotencyKey }) => ({
        ...(handleId ? { sandboxId: handleId } : {}),
        ...(label ? { label } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      }),
      start: async (args) =>
        JSON.parse((await manager.startSandbox(args)).content) as Record<string, unknown>,
      status: async (args) =>
        JSON.parse((await manager.sandboxStatus(args)).content) as Record<string, unknown>,
      stop: async (args) =>
        JSON.parse((await manager.sandboxStop(args)).content) as Record<string, unknown>,
    };
  });

  it("creates the nine structured sandbox tools", () => {
    const tools = createSandboxTools({
      rootDir: "/tmp/ignored",
      logger: silentLogger,
      workspacePath: "/workspace",
    });
    expect(tools.map((tool) => tool.name)).toEqual([
      "system.sandboxStart",
      "system.sandboxStatus",
      "system.sandboxResume",
      "system.sandboxStop",
      "system.sandboxJobStart",
      "system.sandboxJobStatus",
      "system.sandboxJobResume",
      "system.sandboxJobStop",
      "system.sandboxJobLogs",
    ]);
  });

  it("starts sandbox jobs and maps them to durable process-backed job handles", async () => {
    const { manager, jobs } = createManager();
    const startedSandbox = JSON.parse((await manager.startSandbox({
      label: "code-sandbox",
    })).content) as Record<string, unknown>;

    const startedJob = JSON.parse((await manager.sandboxJobStart({
      sandboxId: String(startedSandbox.sandboxId),
      label: "test-job",
      idempotencyKey: "test-job-request",
      command: "node",
      args: ["--version"],
      cwd: "/workspace",
    })).content) as Record<string, unknown>;

    expect(startedJob.sandboxId).toBe(startedSandbox.sandboxId);
    expect(startedJob.process.processId).toMatch(/^proc_/);
    expect(startedJob.state).toBe("running");

    const status = JSON.parse((await manager.sandboxJobStatus({
      sandboxJobId: String(startedJob.sandboxJobId),
    })).content) as Record<string, unknown>;
    expect(status.process.recentOutput).toContain("docker exec -w /workspace");

    const stopped = JSON.parse((await manager.sandboxJobStop({
      sandboxJobId: String(startedJob.sandboxJobId),
    })).content) as Record<string, unknown>;
    expect(stopped.state).toBe("exited");

    const logs = JSON.parse((await manager.sandboxJobLogs({
      sandboxJobId: String(startedJob.sandboxJobId),
    })).content) as Record<string, unknown>;
    expect(logs.output).toContain("docker exec");
    expect(jobs.processes.size).toBe(1);
  });

  it("promotes sandbox job logs to exited once the linked process has finished", async () => {
    const { manager, jobs } = createManager();
    const startedSandbox = JSON.parse((await manager.startSandbox({
      label: "job-log-terminal-sandbox",
    })).content) as Record<string, unknown>;

    const startedJob = JSON.parse((await manager.sandboxJobStart({
      sandboxId: String(startedSandbox.sandboxId),
      label: "job-log-terminal",
      command: "node",
      args: ["--version"],
    })).content) as Record<string, unknown>;

    const processId = String((startedJob.process as Record<string, unknown>).processId);
    jobs.processes.get(processId)!.state = "exited";

    const logs = JSON.parse((await manager.sandboxJobLogs({
      sandboxJobId: String(startedJob.sandboxJobId),
      waitForOutputMs: 250,
    })).content) as Record<string, unknown>;
    const status = JSON.parse((await manager.sandboxJobStatus({
      sandboxJobId: String(startedJob.sandboxJobId),
    })).content) as Record<string, unknown>;

    expect(logs.state).toBe("exited");
    expect(String(logs.output)).toContain("docker exec");
    expect(status.state).toBe("exited");
  });

  it("resolves label-shaped model retries when sandboxId carries the sandbox label", async () => {
    const { manager } = createManager();
    const startedSandbox = JSON.parse((await manager.startSandbox({
      label: "label-retry-sandbox",
    })).content) as Record<string, unknown>;

    const startedJob = JSON.parse((await manager.sandboxJobStart({
      sandboxId: String(startedSandbox.label),
      label: "label-retry-job",
      command: "node",
      args: ["--version"],
    })).content) as Record<string, unknown>;

    expect(startedJob.sandboxId).toBe(startedSandbox.sandboxId);
    expect(startedJob.state).toBe("running");
  });

  it("treats start-time sandboxId placeholders as durable idempotency tokens", async () => {
    const { manager } = createManager();
    const startedSandbox = JSON.parse((await manager.startSandbox({
      sandboxId: "test-sandbox",
      label: "node-sandbox",
    })).content) as Record<string, unknown>;

    expect(startedSandbox.idempotencyKey).toBe("test-sandbox");

    const startedJob = JSON.parse((await manager.sandboxJobStart({
      sandboxId: "test-sandbox",
      label: "check-node-version",
      command: "node",
      args: ["--version"],
    })).content) as Record<string, unknown>;

    expect(startedJob.sandboxId).toBe(startedSandbox.sandboxId);

    const stoppedSandbox = JSON.parse((await manager.sandboxStop({
      sandboxId: "test-sandbox",
    })).content) as Record<string, unknown>;

    expect(stoppedSandbox.sandboxId).toBe(startedSandbox.sandboxId);
    expect(stoppedSandbox.state).toBe("stopped");
  });

  it("recovers persisted sandboxes across manager restart", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "agenc-system-sandbox-recover-"));
    const adapter = new FakeContainerAdapter();
    const jobs = new FakeJobRunner();
    const first = new SystemSandboxManager(
      {
        rootDir,
        logger: silentLogger,
        workspacePath: "/workspace",
      },
      {
        containerAdapter: adapter as any,
        jobRunner: jobs as any,
      },
    );
    cleanup.push(first);

    const started = JSON.parse((await first.startSandbox({
      label: "recover-sandbox",
    })).content) as Record<string, unknown>;

    const second = new SystemSandboxManager(
      {
        rootDir,
        logger: silentLogger,
        workspacePath: "/workspace",
      },
      {
        containerAdapter: adapter as any,
        jobRunner: jobs as any,
      },
    );
    cleanup.push(second);

    const resumed = JSON.parse((await second.sandboxResume({
      sandboxId: String(started.sandboxId),
    })).content) as Record<string, unknown>;

    expect(resumed.sandboxId).toBe(started.sandboxId);
    expect(resumed.state).toBe("running");
    expect(resumed.resumed).toBe(true);
  });

  it("rejects shell-style sandbox job commands with a structured validation error", async () => {
    const { manager } = createManager();
    const startedSandbox = JSON.parse((await manager.startSandbox({
      label: "invalid-command-sandbox",
    })).content) as Record<string, unknown>;

    const result = await manager.sandboxJobStart({
      sandboxId: String(startedSandbox.sandboxId),
      command: "node --version",
    });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content) as {
      error?: { kind?: string; code?: string };
    };
    expect(parsed.error?.kind).toBe("validation");
    expect(parsed.error?.code).toBe("system_sandbox.invalid_command");
  });
});
