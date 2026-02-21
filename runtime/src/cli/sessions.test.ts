import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionsListOptions, SessionsKillOptions } from "./types.js";
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

import { runSessionsListCommand, runSessionsKillCommand } from "./sessions.js";

describe("sessions: runSessionsListCommand", () => {
  let workspace = "";
  let pidPath = "";

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "agenc-sessions-"));
    pidPath = join(workspace, "daemon.pid");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(workspace, { recursive: true, force: true });
  });

  it("reports error when daemon is not running (no PID file)", async () => {
    const { context, errors } = createContextCapture();
    const opts: SessionsListOptions = { pidPath };

    const code = await runSessionsListCommand(context, opts);
    expect(code).toBe(1);
    expect(errors).toHaveLength(1);
    const payload = errors[0] as Record<string, unknown>;
    expect(payload.command).toBe("sessions.list");
    expect(payload.message).toContain("not running");
  });

  it("reports error when PID file exists but process is dead", async () => {
    // Write a PID file pointing to a dead process (PID 999999)
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
    const opts: SessionsListOptions = { pidPath };

    const code = await runSessionsListCommand(context, opts);
    expect(code).toBe(1);
    expect(errors).toHaveLength(1);
    const payload = errors[0] as Record<string, unknown>;
    expect(payload.message).toContain("not running");
  });
});

describe("sessions: runSessionsKillCommand", () => {
  let workspace = "";
  let pidPath = "";

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "agenc-sessions-kill-"));
    pidPath = join(workspace, "daemon.pid");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(workspace, { recursive: true, force: true });
  });

  it("reports error when daemon is not running", async () => {
    const { context, errors } = createContextCapture();
    const opts: SessionsKillOptions = { pidPath, sessionId: "client_1" };

    const code = await runSessionsKillCommand(context, opts);
    expect(code).toBe(1);
    expect(errors).toHaveLength(1);
    const payload = errors[0] as Record<string, unknown>;
    expect(payload.command).toBe("sessions.kill");
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
    const opts: SessionsKillOptions = { pidPath, sessionId: "client_42" };

    const code = await runSessionsKillCommand(context, opts);
    expect(code).toBe(1);
    expect(errors).toHaveLength(1);
  });
});
