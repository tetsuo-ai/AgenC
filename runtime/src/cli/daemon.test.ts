import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonStartOptions } from "./types.js";
import { createContextCapture } from "./test-utils.js";

const {
  execFileMock,
  forkMock,
  checkStalePidMock,
  readPidFileMock,
  removePidFileMock,
  pidFileExistsMock,
  loadGatewayConfigMock,
  sleepMock,
} = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  forkMock: vi.fn(),
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

import { runStartCommand } from "./daemon.js";

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
});
