import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Provide real async utils (no dependency chain)
vi.mock("../utils/async.js", () => ({
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  toErrorMessage: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
}));

// Mock logger to avoid @agenc/sdk → @coral-xyz/anchor dependency chain
vi.mock("../utils/logger.js", () => {
  const noop = () => {};
  return {
    silentLogger: { debug: noop, info: noop, warn: noop, error: noop },
    createLogger: () => ({ debug: noop, info: noop, warn: noop, error: noop }),
  };
});

// Mock gateway.js to avoid @coral-xyz/anchor dependency chain
vi.mock("./gateway.js", () => {
  const MockGateway = vi.fn().mockImplementation(() => ({
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    state: "running",
    getStatus: vi.fn(() => ({
      state: "running",
      uptimeMs: 1000,
      channels: [],
      activeSessions: 0,
      controlPlanePort: 9000,
    })),
    reloadConfig: vi.fn(() => ({ safe: [], unsafe: [] })),
  }));
  return { Gateway: MockGateway };
});

// Mock config-watcher.js to avoid @coral-xyz/anchor dependency chain
vi.mock("./config-watcher.js", () => ({
  loadGatewayConfig: vi.fn(async () => ({
    gateway: { port: 9000 },
    agent: { name: "test" },
    connection: { rpcUrl: "http://localhost:8899" },
  })),
  getDefaultConfigPath: vi.fn(() => "/tmp/config.json"),
}));

import {
  getDefaultPidPath,
  writePidFile,
  readPidFile,
  removePidFile,
  pidFileExists,
  isProcessAlive,
  checkStalePid,
  DaemonManager,
  generateSystemdUnit,
  generateLaunchdPlist,
} from "./daemon.js";
import type { PidFileInfo } from "./daemon.js";

// ============================================================================
// PID file operations
// ============================================================================

describe("PID file operations", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agenc-daemon-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("writePidFile writes JSON with pid, port, configPath", async () => {
    const pidPath = join(tempDir, "test.pid");
    const info: PidFileInfo = {
      pid: 12345,
      port: 8080,
      configPath: "/tmp/config.json",
    };
    await writePidFile(info, pidPath);

    const raw = await readFile(pidPath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed).toEqual(info);
  });

  it("writePidFile creates file with 0o600 permissions", async () => {
    const pidPath = join(tempDir, "perms.pid");
    await writePidFile({ pid: 1, port: 80, configPath: "/c" }, pidPath);
    const st = await stat(pidPath);
    // eslint-disable-next-line no-bitwise
    expect(st.mode & 0o777).toBe(0o600);
  });

  it("writePidFile creates parent directories", async () => {
    const pidPath = join(tempDir, "nested", "dir", "test.pid");
    await writePidFile({ pid: 1, port: 80, configPath: "/c" }, pidPath);
    expect(await pidFileExists(pidPath)).toBe(true);
  });

  it("readPidFile parses JSON correctly", async () => {
    const pidPath = join(tempDir, "test.pid");
    const info: PidFileInfo = {
      pid: 42,
      port: 9090,
      configPath: "/etc/agenc.json",
    };
    await writePidFile(info, pidPath);

    const result = await readPidFile(pidPath);
    expect(result).toEqual(info);
  });

  it("readPidFile returns null for missing file", async () => {
    const result = await readPidFile(join(tempDir, "nonexistent.pid"));
    expect(result).toBeNull();
  });

  it("readPidFile returns null for invalid JSON", async () => {
    const pidPath = join(tempDir, "bad.pid");
    await writeFile(pidPath, "not json at all");

    const result = await readPidFile(pidPath);
    expect(result).toBeNull();
  });

  it("readPidFile returns null for JSON missing required fields", async () => {
    const pidPath = join(tempDir, "partial.pid");
    await writeFile(pidPath, JSON.stringify({ pid: 1 }));

    const result = await readPidFile(pidPath);
    expect(result).toBeNull();
  });

  it("removePidFile deletes file", async () => {
    const pidPath = join(tempDir, "test.pid");
    await writePidFile({ pid: 1, port: 80, configPath: "/c" }, pidPath);
    expect(await pidFileExists(pidPath)).toBe(true);

    await removePidFile(pidPath);
    expect(await pidFileExists(pidPath)).toBe(false);
  });

  it("removePidFile is idempotent (ENOENT swallowed)", async () => {
    const pidPath = join(tempDir, "nonexistent.pid");
    await expect(removePidFile(pidPath)).resolves.toBeUndefined();
  });

  it("pidFileExists returns true when file exists", async () => {
    const pidPath = join(tempDir, "test.pid");
    await writePidFile({ pid: 1, port: 80, configPath: "/c" }, pidPath);
    expect(await pidFileExists(pidPath)).toBe(true);
  });

  it("pidFileExists returns false when file missing", async () => {
    expect(await pidFileExists(join(tempDir, "nope.pid"))).toBe(false);
  });

  it("getDefaultPidPath respects AGENC_PID_PATH env var", () => {
    const original = process.env.AGENC_PID_PATH;
    try {
      process.env.AGENC_PID_PATH = "/custom/path.pid";
      expect(getDefaultPidPath()).toBe("/custom/path.pid");
    } finally {
      if (original === undefined) {
        delete process.env.AGENC_PID_PATH;
      } else {
        process.env.AGENC_PID_PATH = original;
      }
    }
  });

  it("getDefaultPidPath falls back to ~/.agenc/daemon.pid", () => {
    const original = process.env.AGENC_PID_PATH;
    try {
      delete process.env.AGENC_PID_PATH;
      const result = getDefaultPidPath();
      expect(result).toContain(".agenc");
      expect(result).toContain("daemon.pid");
    } finally {
      if (original !== undefined) {
        process.env.AGENC_PID_PATH = original;
      }
    }
  });
});

// ============================================================================
// isProcessAlive
// ============================================================================

describe("isProcessAlive", () => {
  it("returns true for current process", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("returns false for non-existent PID", () => {
    // PID well above Linux PID_MAX (typically 4194304) — guaranteed ESRCH
    expect(isProcessAlive(99999999)).toBe(false);
  });
});

// ============================================================================
// checkStalePid
// ============================================================================

describe("checkStalePid", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agenc-stale-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns none when no PID file exists", async () => {
    const result = await checkStalePid(join(tempDir, "nope.pid"));
    expect(result).toEqual({ status: "none" });
  });

  it("returns alive when process is running", async () => {
    const pidPath = join(tempDir, "alive.pid");
    await writePidFile(
      { pid: process.pid, port: 8080, configPath: "/c" },
      pidPath,
    );

    const result = await checkStalePid(pidPath);
    expect(result.status).toBe("alive");
    expect(result.pid).toBe(process.pid);
    expect(result.port).toBe(8080);
  });

  it("returns stale when process is not running", async () => {
    const pidPath = join(tempDir, "stale.pid");
    await writePidFile(
      { pid: 99999999, port: 8080, configPath: "/c" },
      pidPath,
    );

    const result = await checkStalePid(pidPath);
    expect(result.status).toBe("stale");
    expect(result.pid).toBe(99999999);
  });
});

// ============================================================================
// DaemonManager
// ============================================================================

describe("DaemonManager", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agenc-dm-test-"));
    vi.clearAllMocks();
    // Skip wireWebChat to avoid heavy LLM/tool/skill dependency chain —
    // these tests cover daemon lifecycle (PID files, start/stop), not WebChat wiring.
    vi.spyOn(DaemonManager.prototype as any, "wireWebChat").mockResolvedValue(
      undefined,
    );
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("start creates Gateway and writes PID file", async () => {
    const pidPath = join(tempDir, "test.pid");
    const dm = new DaemonManager({ configPath: "/tmp/config.json", pidPath });
    vi.spyOn(dm, "setupSignalHandlers").mockImplementation(() => {});

    await dm.start();

    const pidInfo = await readPidFile(pidPath);
    expect(pidInfo).not.toBeNull();
    expect(pidInfo!.pid).toBe(process.pid);
    expect(pidInfo!.port).toBe(9000);

    await dm.stop();
  });

  it("start cleans up gateway if writePidFile fails", async () => {
    // Use a path under /dev/null which cannot be a directory
    const dm = new DaemonManager({
      configPath: "/tmp/config.json",
      pidPath: "/dev/null/impossible/path.pid",
    });
    vi.spyOn(dm, "setupSignalHandlers").mockImplementation(() => {});

    await expect(dm.start()).rejects.toThrow("Failed to write PID file");
  });

  it("stop calls gateway.stop and removes PID file", async () => {
    const pidPath = join(tempDir, "test.pid");
    const dm = new DaemonManager({ configPath: "/tmp/config.json", pidPath });
    vi.spyOn(dm, "setupSignalHandlers").mockImplementation(() => {});

    await dm.start();
    expect(await pidFileExists(pidPath)).toBe(true);

    await dm.stop();
    expect(await pidFileExists(pidPath)).toBe(false);
  });

  it("stop is idempotent", async () => {
    const pidPath = join(tempDir, "test.pid");
    const dm = new DaemonManager({ configPath: "/tmp/c.json", pidPath });

    await expect(dm.stop()).resolves.toBeUndefined();
    await expect(dm.stop()).resolves.toBeUndefined();
  });

  it("double start is rejected", async () => {
    const pidPath = join(tempDir, "test.pid");
    const dm = new DaemonManager({ configPath: "/tmp/config.json", pidPath });
    vi.spyOn(dm, "setupSignalHandlers").mockImplementation(() => {});

    await dm.start();
    await expect(dm.start()).rejects.toThrow("already running");

    await dm.stop();
  });

  it("setupSignalHandlers registers handlers", () => {
    const dm = new DaemonManager({ configPath: "/tmp/c.json" });
    const onSpy = vi.spyOn(process, "on");

    dm.setupSignalHandlers();

    const events = onSpy.mock.calls.map((call) => call[0]);
    expect(events).toContain("SIGTERM");
    expect(events).toContain("SIGINT");
    expect(events).toContain("SIGHUP");

    onSpy.mockRestore();
  });

  it("getStatus returns correct shape when not running", () => {
    const dm = new DaemonManager({ configPath: "/tmp/c.json" });
    const status = dm.getStatus();

    expect(status.running).toBe(false);
    expect(status.pid).toBe(process.pid);
    expect(status.uptimeMs).toBe(0);
    expect(status.gatewayStatus).toBeNull();
    expect(status.memoryUsage).toHaveProperty("heapUsedMB");
    expect(status.memoryUsage).toHaveProperty("rssMB");
  });

  it("setupSignalHandlers is idempotent", () => {
    const dm = new DaemonManager({ configPath: "/tmp/c.json" });
    const onSpy = vi.spyOn(process, "on");

    dm.setupSignalHandlers();
    dm.setupSignalHandlers();

    const signalCalls = onSpy.mock.calls.filter((call) =>
      ["SIGTERM", "SIGINT", "SIGHUP"].includes(call[0] as string),
    );
    expect(signalCalls.length).toBe(3);

    onSpy.mockRestore();
  });

  it("getStatus returns running status with gateway info", async () => {
    const pidPath = join(tempDir, "test.pid");
    const dm = new DaemonManager({ configPath: "/tmp/config.json", pidPath });
    vi.spyOn(dm, "setupSignalHandlers").mockImplementation(() => {});

    await dm.start();
    const status = dm.getStatus();

    expect(status.running).toBe(true);
    expect(status.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(status.gatewayStatus).not.toBeNull();

    await dm.stop();
  });
});

// ============================================================================
// Service templates
// ============================================================================

describe("Service templates", () => {
  it("systemd template contains required fields", () => {
    const unit = generateSystemdUnit({
      execStart:
        "node /usr/lib/agenc/daemon.js --config /etc/agenc.json --foreground",
    });

    expect(unit).toContain("[Unit]");
    expect(unit).toContain("[Service]");
    expect(unit).toContain("[Install]");
    expect(unit).toContain("Type=simple");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("RestartSec=10s");
    expect(unit).toContain("TimeoutStopSec=35s");
    expect(unit).toContain(
      "ExecStart=node /usr/lib/agenc/daemon.js --config /etc/agenc.json --foreground",
    );
    expect(unit).not.toContain("WatchdogSec");
  });

  it("systemd template includes user when provided", () => {
    const unit = generateSystemdUnit({
      execStart: "node daemon.js",
      user: "agenc",
    });
    expect(unit).toContain("User=agenc");
  });

  it("launchd template contains required fields", () => {
    const plist = generateLaunchdPlist({
      programArguments: [
        "node",
        "/usr/lib/agenc/daemon.js",
        "--config",
        "/etc/agenc.json",
        "--foreground",
      ],
    });

    expect(plist).toContain("<?xml version");
    expect(plist).toContain("plist");
    expect(plist).toContain("<key>Label</key>");
    expect(plist).toContain("ai.agenc.gateway");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<key>ProgramArguments</key>");
    expect(plist).toContain("StandardOutPath");
    expect(plist).toContain("StandardErrorPath");
  });

  it("launchd template uses custom label", () => {
    const plist = generateLaunchdPlist({
      programArguments: ["node", "daemon.js"],
      label: "com.custom.daemon",
    });
    expect(plist).toContain("com.custom.daemon");
  });

  it("launchd template handles paths with spaces", () => {
    const plist = generateLaunchdPlist({
      programArguments: [
        "node",
        "/path with spaces/daemon.js",
        "--config",
        "/my config/file.json",
      ],
    });
    expect(plist).toContain("<string>/path with spaces/daemon.js</string>");
    expect(plist).toContain("<string>/my config/file.json</string>");
  });
});
