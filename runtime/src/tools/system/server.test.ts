import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { silentLogger } from "../../utils/logger.js";
import { runDurableHandleContractSuite } from "./handle-contract.test-utils.js";
import { createServerTools, SystemServerManager } from "./server.js";

let nextPort = 43100;

function reserveTestPort(): number {
  nextPort += 1;
  return nextPort;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildNodeServerArgs(port: number): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: [
      "-e",
      [
        "const http=require('node:http');",
        `const port=${port};`,
        "const server=http.createServer((_req,res)=>{res.statusCode=200;res.end('ok');});",
        "server.listen(port,'127.0.0.1',()=>console.log('ready:'+port));",
      ].join(""),
    ],
  };
}

describe("system.server tools", () => {
  const cleanup: SystemServerManager[] = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      const manager = cleanup.pop()!;
      await manager.resetForTesting();
    }
  });

  function createManager(): SystemServerManager {
    const rootDir = mkdtempSync(join(tmpdir(), "agenc-system-server-test-"));
    const manager = new SystemServerManager({
      rootDir,
      allowList: [process.execPath],
      logger: silentLogger,
      defaultStopWaitMs: 250,
      defaultReadinessTimeoutMs: 4_000,
      healthTimeoutMs: 500,
      unrestricted: true,
    });
    cleanup.push(manager);
    return manager;
  }

  runDurableHandleContractSuite(() => {
    const manager = createManager();
    const port = reserveTestPort();
    return {
      family: "system-server",
      handleIdField: "serverId",
      runningState: "running",
      terminalState: "exited",
      resourceEnvelope: {
        cpu: 1,
        memoryMb: 256,
        wallClockMs: 60_000,
        network: "enabled",
        enforcement: "best_effort",
      },
      buildStartArgs: ({ label, idempotencyKey }) => ({
        ...buildNodeServerArgs(port),
        host: "127.0.0.1",
        port,
        label,
        idempotencyKey,
        resourceEnvelope: {
          cpu: 1,
          memoryMb: 256,
          wallClockMs: 60_000,
          network: "enabled",
        },
      }),
      buildStatusArgs: ({ label, idempotencyKey }) => ({
        ...(label ? { label } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      }),
      buildMissingStatusArgs: () => ({
        label: "missing-system-server-handle",
      }),
      buildStopArgs: ({ handleId, label, idempotencyKey }) => ({
        ...(handleId ? { serverId: handleId } : {}),
        ...(label ? { label } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
        waitMs: 250,
      }),
      start: async (args) =>
        JSON.parse((await manager.start(args)).content) as Record<string, unknown>,
      status: async (args) =>
        JSON.parse((await manager.status(args)).content) as Record<string, unknown>,
      stop: async (args) =>
        JSON.parse((await manager.stop(args)).content) as Record<string, unknown>,
    };
  });

  it("creates the five structured server tools", () => {
    const tools = createServerTools({ rootDir: "/tmp/ignored", logger: silentLogger });
    expect(tools.map((tool) => tool.name)).toEqual([
      "system.serverStart",
      "system.serverStatus",
      "system.serverResume",
      "system.serverStop",
      "system.serverLogs",
    ]);
  });

  it("starts, monitors, and stops a managed server handle", async () => {
    const manager = createManager();
    const port = reserveTestPort();

    const started = JSON.parse((await manager.start({
      ...buildNodeServerArgs(port),
      label: "http-server",
      port,
      resourceEnvelope: {
        cpu: 1,
        memoryMb: 256,
        wallClockMs: 60_000,
        network: "enabled",
      },
    })).content) as Record<string, unknown>;

    expect(started.serverId).toMatch(/^server_/);
    expect(started.processId).toMatch(/^proc_/);
    expect(started.command).toBe(process.execPath);
    expect(started.args).toEqual(buildNodeServerArgs(port).args);
    expect(started.state).toBe("running");
    expect(started.ready).toBe(true);
    expect(started.resourceEnvelope).toMatchObject({
      cpu: 1,
      memoryMb: 256,
      wallClockMs: 60_000,
      network: "enabled",
    });

    const status = JSON.parse((await manager.status({
      label: "http-server",
    })).content) as Record<string, unknown>;
    expect(status.serverId).toBe(started.serverId);
    expect(status.command).toBe(process.execPath);
    expect(status.args).toEqual(buildNodeServerArgs(port).args);
    expect(status.ready).toBe(true);
    expect(status.lastStatusCode).toBe(200);

    const logs = JSON.parse((await manager.logs({
      serverId: String(started.serverId),
    })).content) as Record<string, unknown>;
    expect(String(logs.output)).toContain(`ready:${port}`);

    const stopped = JSON.parse((await manager.stop({
      serverId: String(started.serverId),
      waitMs: 250,
    })).content) as Record<string, unknown>;
    expect(stopped.state).toBe("exited");
    expect(stopped.stopped).toBe(true);
  });

  it("returns a structured timeout when the server never becomes ready", async () => {
    const manager = createManager();
    const result = await manager.start({
      command: process.execPath,
      args: ["-e", "setInterval(()=>{}, 1000);"],
      label: "stuck-server",
      port: reserveTestPort(),
      readinessTimeoutMs: 500,
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("system_server.timeout");
  });

  it("blocks unsafe external health URLs", async () => {
    const manager = createManager();
    const result = await manager.start({
      command: process.execPath,
      args: ["-e", "setInterval(()=>{}, 1000);"],
      healthUrl: "http://169.254.169.254/latest/meta-data",
      readinessTimeoutMs: 500,
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("system_server.health_url_blocked");
  });

  it("allows python3 servers when python3 is explicitly excluded from the structured deny list", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "agenc-system-server-python-"));
    const manager = new SystemServerManager({
      rootDir,
      allowList: ["python3"],
      denyExclusions: ["python3"],
      logger: silentLogger,
      defaultStopWaitMs: 250,
      defaultReadinessTimeoutMs: 4_000,
      healthTimeoutMs: 500,
    });
    cleanup.push(manager);
    const port = reserveTestPort();

    const started = JSON.parse((await manager.start({
      command: "python3",
      args: ["-m", "http.server", String(port), "--bind", "127.0.0.1"],
      cwd: "/home/tetsuo/git/AgenC",
      label: "python-http-server",
      port,
    })).content) as Record<string, unknown>;

    expect(started.serverId).toMatch(/^server_/);
    expect(started.state).toBe("running");
    expect(started.ready).toBe(true);

    const stopped = JSON.parse((await manager.stop({
      serverId: String(started.serverId),
      waitMs: 250,
    })).content) as Record<string, unknown>;
    expect(stopped.state).toBe("exited");
  });

  it("reattaches to a running server after manager restart", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "agenc-system-server-recover-"));
    const first = new SystemServerManager({
      rootDir,
      allowList: [process.execPath],
      logger: silentLogger,
      defaultStopWaitMs: 250,
      defaultReadinessTimeoutMs: 4_000,
      healthTimeoutMs: 500,
      unrestricted: true,
    });
    cleanup.push(first);
    const port = reserveTestPort();
    const started = JSON.parse((await first.start({
      ...buildNodeServerArgs(port),
      label: "recover-server",
      port,
    })).content) as Record<string, unknown>;

    const second = new SystemServerManager({
      rootDir,
      allowList: [process.execPath],
      logger: silentLogger,
      defaultStopWaitMs: 250,
      defaultReadinessTimeoutMs: 4_000,
      healthTimeoutMs: 500,
      unrestricted: true,
    });
    cleanup.push(second);

    const resumed = JSON.parse((await second.resume({
      serverId: String(started.serverId),
    })).content) as Record<string, unknown>;

    expect(resumed.serverId).toBe(started.serverId);
    expect(resumed.state).toBe("running");
    expect(resumed.ready).toBe(true);

    await wait(25);
  });
});
