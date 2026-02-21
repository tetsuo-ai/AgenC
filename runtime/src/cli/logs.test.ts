import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LogsOptions } from "./types.js";
import { createContextCapture } from "./test-utils.js";

// Mock gateway dependencies to avoid @coral-xyz/anchor dependency chain
vi.mock("../gateway/gateway.js", () => ({}));
vi.mock("../gateway/config-watcher.js", () => ({
  getDefaultConfigPath: () => "/tmp/.agenc/config.json",
  loadGatewayConfig: vi.fn(),
  validateGatewayConfig: vi.fn(() => ({ valid: true, errors: [] })),
}));
vi.mock("../utils/logger.js", () => {
  const noop = () => {};
  return {
    silentLogger: { debug: noop, info: noop, warn: noop, error: noop },
  };
});

import { runLogsCommand } from "./logs.js";

describe("logs: runLogsCommand", () => {
  let workspace = "";
  let pidPath = "";

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "agenc-logs-"));
    pidPath = join(workspace, "daemon.pid");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(workspace, { recursive: true, force: true });
  });

  it("reports error when daemon is not running (no PID file)", async () => {
    const { context, errors } = createContextCapture();
    const opts: LogsOptions = { pidPath };

    const code = await runLogsCommand(context, opts);
    expect(code).toBe(1);
    expect(errors).toHaveLength(1);
    const payload = errors[0] as Record<string, unknown>;
    expect(payload.command).toBe("logs");
    expect(payload.message).toContain("not running");
    expect(payload.hint).toBeDefined();
  });

  it("reports error when PID file exists but process is dead", async () => {
    writeFileSync(
      pidPath,
      JSON.stringify({
        pid: 999999,
        port: 3100,
        configPath: "/tmp/config.json",
      }),
      "utf-8",
    );

    const { context, errors } = createContextCapture();
    const opts: LogsOptions = { pidPath };

    const code = await runLogsCommand(context, opts);
    expect(code).toBe(1);
    expect(errors).toHaveLength(1);
    const payload = errors[0] as Record<string, unknown>;
    expect(payload.message).toContain("stale PID");
  });

  it("outputs log viewing instructions when daemon is running", async () => {
    // Write a PID file with current process PID (which is always alive)
    writeFileSync(
      pidPath,
      JSON.stringify({
        pid: process.pid,
        port: 3100,
        configPath: "/tmp/config.json",
      }),
      "utf-8",
    );

    const { context, outputs, errors } = createContextCapture();
    const opts: LogsOptions = { pidPath };

    const code = await runLogsCommand(context, opts);
    expect(code).toBe(0);
    expect(errors).toHaveLength(0);

    const payload = outputs[0] as Record<string, unknown>;
    expect(payload.command).toBe("logs");
    expect(payload.pid).toBe(process.pid);
    expect(payload.port).toBe(3100);
    expect(Array.isArray(payload.methods)).toBe(true);
    expect((payload.methods as Array<unknown>).length).toBe(3);
  });

  it("includes session filter when sessionId is provided", async () => {
    writeFileSync(
      pidPath,
      JSON.stringify({
        pid: process.pid,
        port: 3100,
        configPath: "/tmp/config.json",
      }),
      "utf-8",
    );

    const { context, outputs } = createContextCapture();
    const opts: LogsOptions = { pidPath, sessionId: "client_42" };

    const code = await runLogsCommand(context, opts);
    expect(code).toBe(0);

    const payload = outputs[0] as Record<string, unknown>;
    expect(payload.sessionFilter).toBe("client_42");
  });

  it("includes --lines in journalctl hint when provided", async () => {
    writeFileSync(
      pidPath,
      JSON.stringify({
        pid: process.pid,
        port: 3100,
        configPath: "/tmp/config.json",
      }),
      "utf-8",
    );

    const { context, outputs } = createContextCapture();
    const opts: LogsOptions = { pidPath, lines: 50 };

    const code = await runLogsCommand(context, opts);
    expect(code).toBe(0);

    const payload = outputs[0] as Record<string, unknown>;
    const methods = payload.methods as Array<{ mode: string; command: string }>;
    const systemdMethod = methods.find((m) => m.mode === "systemd");
    expect(systemdMethod?.command).toContain("-n 50");
  });
});
