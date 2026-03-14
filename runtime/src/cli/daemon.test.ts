import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonStartOptions } from "./types.js";
import { createContextCapture } from "./test-utils.js";
import { generateSystemdUnit } from "../gateway/daemon.js";

const {
  execFileMock,
  forkMock,
  readFileMock,
  checkStalePidMock,
  readPidFileMock,
  removePidFileMock,
  pidFileExistsMock,
  loadGatewayConfigMock,
  sleepMock,
} = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  forkMock: vi.fn(),
  readFileMock: vi.fn(),
  checkStalePidMock: vi.fn(),
  readPidFileMock: vi.fn(),
  removePidFileMock: vi.fn(),
  pidFileExistsMock: vi.fn(),
  loadGatewayConfigMock: vi.fn(),
  sleepMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
  fork: forkMock,
}));

vi.mock("node:fs/promises", () => ({
  readFile: readFileMock,
}));

vi.mock("../gateway/daemon.js", () => ({
  checkStalePid: checkStalePidMock,
  readPidFile: readPidFileMock,
  removePidFile: removePidFileMock,
  isProcessAlive: vi.fn(() => true),
  pidFileExists: pidFileExistsMock,
  DaemonManager: vi.fn(),
  generateSystemdUnit: vi.fn(),
  generateLaunchdPlist: vi.fn(),
}));

vi.mock("../gateway/config-watcher.js", () => ({
  loadGatewayConfig: loadGatewayConfigMock,
  getDefaultConfigPath: () => "/tmp/.agenc/config.json",
}));

vi.mock("../utils/async.js", () => ({
  sleep: sleepMock,
  toErrorMessage: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
}));

vi.mock("../utils/logger.js", () => ({
  createLogger: vi.fn(() => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  })),
}));

import { findDaemonProcessesByIdentity, runStartCommand } from "./daemon.js";
import { runServiceInstallCommand } from "./daemon.js";

class FakeChildProcess extends EventEmitter {
  readonly pid?: number;
  connected = true;

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  unref(): void {
    // no-op
  }

  disconnect(): void {
    this.connected = false;
  }
}

describe("daemon: runStartCommand", () => {
  beforeEach(() => {
    execFileMock.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: Record<string, unknown>,
        callback: (error: Error | null, stdout: string) => void,
      ) => {
        callback(null, "");
      },
    );
    checkStalePidMock.mockResolvedValue({ status: "missing" });
    loadGatewayConfigMock.mockResolvedValue({ gateway: { port: 3100 } });
    removePidFileMock.mockResolvedValue(undefined);
    pidFileExistsMock.mockResolvedValue(false);
    readPidFileMock.mockResolvedValue(null);
    readFileMock.mockRejectedValue(Object.assign(new Error("missing /proc"), { code: "ENOENT" }));
    sleepMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("waits for a daemon.ready signal before reporting daemon startup success", async () => {
    const child = new FakeChildProcess(43210);
    forkMock.mockReturnValue(child);

    let pidReady = false;
    pidFileExistsMock.mockImplementation(async () => pidReady);
    readPidFileMock.mockImplementation(async () =>
      pidReady
        ? { pid: 43210, port: 3100, configPath: "/tmp/config.json" }
        : null,
    );
    sleepMock.mockImplementation(async () => {
      if (!pidReady) {
        pidReady = true;
        child.emit("message", {
          type: "daemon.ready",
          pid: 43210,
          configPath: "/tmp/config.json",
        });
      }
    });

    const { context, outputs, errors } = createContextCapture();
    const options: DaemonStartOptions = {
      configPath: "/tmp/config.json",
      pidPath: "/tmp/daemon.pid",
    };

    const code = await runStartCommand(context, options);

    expect(code).toBe(0);
    expect(errors).toHaveLength(0);
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toMatchObject({
      status: "ok",
      command: "start",
      mode: "daemon",
      pid: 43210,
      port: 3100,
    });
    expect(forkMock).toHaveBeenCalledTimes(1);
    const forkOptions = forkMock.mock.calls[0]?.[2] as { stdio: unknown[] };
    expect(Array.isArray(forkOptions.stdio)).toBe(true);
    expect(forkOptions.stdio[3]).toBe("ipc");
  });

  it("surfaces daemon startup_error messages instead of timing out on the PID file poll", async () => {
    const child = new FakeChildProcess(54321);
    forkMock.mockReturnValue(child);

    let errorSent = false;
    sleepMock.mockImplementation(async () => {
      if (!errorSent) {
        errorSent = true;
        child.emit("message", {
          type: "daemon.startup_error",
          pid: 54321,
          message: "desktop bootstrap failed",
          configPath: "/tmp/config.json",
        });
      }
    });

    const { context, outputs, errors } = createContextCapture();
    const options: DaemonStartOptions = {
      configPath: "/tmp/config.json",
      pidPath: "/tmp/daemon.pid",
    };

    const code = await runStartCommand(context, options);

    expect(code).toBe(1);
    expect(outputs).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      status: "error",
      command: "start",
      message: expect.stringContaining("desktop bootstrap failed"),
    });
  });

  it("passes --yolo through to the daemon child process", async () => {
    const child = new FakeChildProcess(65432);
    forkMock.mockReturnValue(child);

    let pidReady = false;
    pidFileExistsMock.mockImplementation(async () => pidReady);
    readPidFileMock.mockImplementation(async () =>
      pidReady
        ? { pid: 65432, port: 3100, configPath: "/tmp/config.json" }
        : null,
    );
    sleepMock.mockImplementation(async () => {
      if (!pidReady) {
        pidReady = true;
        child.emit("message", {
          type: "daemon.ready",
          pid: 65432,
          configPath: "/tmp/config.json",
        });
      }
    });

    const { context, outputs, errors } = createContextCapture();
    const options: DaemonStartOptions = {
      configPath: "/tmp/config.json",
      pidPath: "/tmp/daemon.pid",
      yolo: true,
    };

    const code = await runStartCommand(context, options);

    expect(code).toBe(0);
    expect(errors).toHaveLength(0);
    expect(outputs[0]).toMatchObject({
      status: "ok",
      command: "start",
      yolo: true,
      unsafeBenchmarkMode: "delegation_policy_bypass",
      hostExecutionDenyListsDisabled: true,
    });
    expect(forkMock).toHaveBeenCalledTimes(1);
    expect(forkMock.mock.calls[0]?.[1]).toContain("--yolo");
  });
});

describe("daemon: process identity parsing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("reads spaced config and pid paths from /proc argv", async () => {
    execFileMock.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: Record<string, unknown>,
        callback: (error: Error | null, stdout: string) => void,
      ) => {
        callback(
          null,
          "4242 node /runtime/dist/bin/daemon.js --config /tmp/config with spaces.json --pid-path /tmp/pid with spaces.pid\n",
        );
      },
    );
    readFileMock.mockResolvedValue(
      Buffer.from(
        [
          "node",
          "/runtime/dist/bin/daemon.js",
          "--config",
          "/tmp/config with spaces.json",
          "--pid-path=/tmp/pid with spaces.pid",
          "",
        ].join("\u0000"),
      ),
    );

    const matches = await findDaemonProcessesByIdentity({
      configPath: "/tmp/config with spaces.json",
      pidPath: "/tmp/pid with spaces.pid",
    });

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      pid: 4242,
      configPath: "/tmp/config with spaces.json",
      pidPath: "/tmp/pid with spaces.pid",
      matchedConfigPath: true,
      matchedPidPath: true,
    });
  });

  it("falls back to shell-like parsing when /proc argv is unavailable", async () => {
    execFileMock.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: Record<string, unknown>,
        callback: (error: Error | null, stdout: string) => void,
      ) => {
        callback(
          null,
          "5252 node /runtime/dist/bin/daemon.js --config \"/tmp/config with spaces.json\" --pid-path='/tmp/pid with spaces.pid'\n",
        );
      },
    );
    readFileMock.mockRejectedValue(Object.assign(new Error("missing /proc"), { code: "ENOENT" }));

    const matches = await findDaemonProcessesByIdentity({
      configPath: "/tmp/config with spaces.json",
      pidPath: "/tmp/pid with spaces.pid",
    });

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      pid: 5252,
      configPath: "/tmp/config with spaces.json",
      pidPath: "/tmp/pid with spaces.pid",
      matchedConfigPath: true,
      matchedPidPath: true,
    });
  });
});

describe("daemon: runServiceInstallCommand", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("includes --yolo in generated systemd units when requested", async () => {
    const { context, outputs } = createContextCapture();
    const generateSystemdUnitMock = vi.mocked(generateSystemdUnit);
    generateSystemdUnitMock.mockReturnValue("[Unit]");

    const code = await runServiceInstallCommand(context, {
      configPath: "/tmp/config.json",
      yolo: true,
    });

    expect(code).toBe(0);
    expect(generateSystemdUnitMock).toHaveBeenCalledWith({
      execStart: expect.stringContaining("--yolo"),
    });
    expect(outputs[0]).toMatchObject({
      status: "ok",
      command: "service.install",
      platform: "systemd",
      template: "[Unit]",
    });
  });
});
