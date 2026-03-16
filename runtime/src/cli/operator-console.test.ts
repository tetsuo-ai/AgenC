import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runOperatorConsole,
  type OperatorConsoleDeps,
} from "./operator-console.js";
import type { DaemonIdentityMatch } from "./daemon.js";

class FakeChildProcess extends EventEmitter {
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit("exit", code, signal);
  }
}

function createDeps(
  overrides: Partial<OperatorConsoleDeps> = {},
): OperatorConsoleDeps {
  return {
    defaultConfigPath: () => "/tmp/agenc.json",
    defaultPidPath: () => "/tmp/agenc.pid",
    loadGatewayConfig: vi.fn().mockResolvedValue({
      gateway: {
        port: 3100,
      },
    }),
    readPidFile: vi.fn().mockResolvedValue(null),
    isProcessAlive: vi.fn().mockReturnValue(false),
    runStartCommand: vi.fn().mockResolvedValue(0),
    findDaemonProcessesByIdentity: vi.fn().mockResolvedValue([]),
    resolveConsoleEntryPath: vi
      .fn()
      .mockReturnValue("/repo/scripts/agenc-watch.mjs"),
    resolveOperatorEventsModulePath: vi
      .fn()
      .mockReturnValue("/repo/runtime/dist/operator-events.mjs"),
    spawnProcess: vi.fn(),
    processExecPath: process.execPath,
    cwd: "/repo",
    env: {
      PATH: process.env.PATH ?? "",
    },
    createLogger: vi.fn().mockReturnValue({
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    }),
    ...overrides,
  };
}

describe("operator console launcher", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("starts the daemon when needed and launches the watch console", async () => {
    const child = new FakeChildProcess();
    const readPidFile = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        pid: 43210,
        port: 3200,
        configPath: "/tmp/agenc.json",
      });
    const runStartCommand = vi.fn().mockResolvedValue(0);
    const spawnProcess = vi.fn().mockImplementation(() => {
      queueMicrotask(() => child.exit(0));
      return child;
    });
    const deps = createDeps({
      readPidFile,
      runStartCommand,
      spawnProcess,
    });

    const code = await runOperatorConsole({}, deps);

    expect(code).toBe(0);
    // The TUI launches immediately with the config port (3100) while the
    // daemon starts in the background — the TUI handles reconnection.
    expect(spawnProcess).toHaveBeenCalledWith(
      process.execPath,
      ["/repo/scripts/agenc-watch.mjs"],
      expect.objectContaining({
        stdio: "inherit",
        cwd: "/repo",
        env: expect.objectContaining({
          AGENC_WATCH_WS_URL: "ws://127.0.0.1:3100",
          AGENC_WATCH_OPERATOR_EVENTS_MODULE:
            "/repo/runtime/dist/operator-events.mjs",
          AGENC_WATCH_PROJECT_ROOT: "/repo",
          AGENC_WATCH_CLIENT_KEY: expect.stringMatching(
            /^agenc-repo-[a-f0-9]{12}$/,
          ),
        }),
      }),
    );
  });

  it("reuses an existing live daemon instead of starting a new one", async () => {
    const child = new FakeChildProcess();
    const readPidFile = vi.fn().mockResolvedValue({
      pid: 7654,
      port: 4100,
      configPath: "/tmp/agenc.json",
    });
    const runStartCommand = vi.fn().mockResolvedValue(0);
    const spawnProcess = vi.fn().mockImplementation(() => {
      queueMicrotask(() => child.exit(0));
      return child;
    });
    const deps = createDeps({
      readPidFile,
      isProcessAlive: vi.fn().mockReturnValue(true),
      runStartCommand,
      spawnProcess,
    });

    const code = await runOperatorConsole({}, deps);

    expect(code).toBe(0);
    expect(runStartCommand).not.toHaveBeenCalled();
    expect(spawnProcess).toHaveBeenCalledWith(
      process.execPath,
      ["/repo/scripts/agenc-watch.mjs"],
      expect.objectContaining({
        env: expect.objectContaining({
          AGENC_WATCH_WS_URL: "ws://127.0.0.1:4100",
          AGENC_WATCH_OPERATOR_EVENTS_MODULE:
            "/repo/runtime/dist/operator-events.mjs",
          AGENC_WATCH_PROJECT_ROOT: "/repo",
          AGENC_WATCH_CLIENT_KEY: expect.stringMatching(
            /^agenc-repo-[a-f0-9]{12}$/,
          ),
        }),
      }),
    );
  });

  it("preserves an explicitly configured watch client key", async () => {
    const child = new FakeChildProcess();
    const spawnProcess = vi.fn().mockImplementation(() => {
      queueMicrotask(() => child.exit(0));
      return child;
    });
    const deps = createDeps({
      readPidFile: vi.fn().mockResolvedValue({
        pid: 7654,
        port: 4100,
        configPath: "/tmp/agenc.json",
      }),
      isProcessAlive: vi.fn().mockReturnValue(true),
      spawnProcess,
      env: {
        PATH: process.env.PATH ?? "",
        AGENC_WATCH_CLIENT_KEY: "manual-watch-key",
      },
    });

    const code = await runOperatorConsole({}, deps);

    expect(code).toBe(0);
    expect(spawnProcess).toHaveBeenCalledWith(
      process.execPath,
      ["/repo/scripts/agenc-watch.mjs"],
      expect.objectContaining({
        env: expect.objectContaining({
          AGENC_WATCH_CLIENT_KEY: "manual-watch-key",
          AGENC_WATCH_PROJECT_ROOT: "/repo",
        }),
      }),
    );
  });

  it("attaches to an existing matching daemon when the pid file is missing", async () => {
    const child = new FakeChildProcess();
    const runStartCommand = vi.fn().mockResolvedValue(0);
    const spawnProcess = vi.fn().mockImplementation(() => {
      queueMicrotask(() => child.exit(0));
      return child;
    });
    const findDaemonProcesses = vi
      .fn<OperatorConsoleDeps["findDaemonProcessesByIdentity"]>()
      .mockResolvedValue([
        {
          pid: 1929004,
          args: "node /runtime/dist/bin/daemon.js --config /tmp/agenc.json --pid-path /tmp/agenc.pid",
          argv: [
            "node",
            "/runtime/dist/bin/daemon.js",
            "--config",
            "/tmp/agenc.json",
            "--pid-path",
            "/tmp/agenc.pid",
          ],
          configPath: "/tmp/agenc.json",
          pidPath: "/tmp/agenc.pid",
          matchedConfigPath: true,
          matchedPidPath: true,
        } satisfies DaemonIdentityMatch,
      ]);
    const deps = createDeps({
      readPidFile: vi.fn().mockResolvedValue(null),
      runStartCommand,
      findDaemonProcessesByIdentity: findDaemonProcesses,
      spawnProcess,
    });

    const code = await runOperatorConsole({}, deps);

    expect(code).toBe(0);
    expect(runStartCommand).not.toHaveBeenCalled();
    expect(findDaemonProcesses).toHaveBeenCalledWith({
      pidPath: "/tmp/agenc.pid",
      configPath: "/tmp/agenc.json",
    });
    expect(spawnProcess).toHaveBeenCalledWith(
      process.execPath,
      ["/repo/scripts/agenc-watch.mjs"],
      expect.objectContaining({
        env: expect.objectContaining({
          AGENC_WATCH_WS_URL: "ws://127.0.0.1:3100",
        }),
      }),
    );
  });

  it("connects to an existing daemon even when its config path differs from the requested one", async () => {
    const child = new FakeChildProcess();
    const spawnProcess = vi.fn().mockImplementation(() => {
      queueMicrotask(() => child.exit(0));
      return child;
    });
    const deps = createDeps({
      readPidFile: vi.fn().mockResolvedValue({
        pid: 1234,
        port: 3100,
        configPath: "/tmp/other.json",
      }),
      isProcessAlive: vi.fn().mockReturnValue(true),
      spawnProcess,
    });

    const code = await runOperatorConsole(
      {
        configPath: "/tmp/agenc.json",
      },
      deps,
    );

    expect(code).toBe(0);
    expect(spawnProcess).toHaveBeenCalledWith(
      process.execPath,
      ["/repo/scripts/agenc-watch.mjs"],
      expect.objectContaining({
        env: expect.objectContaining({
          AGENC_WATCH_WS_URL: "ws://127.0.0.1:3100",
        }),
      }),
    );
  });

  it("launches TUI first and starts daemon in background when pid file is missing and process-scan finds a different-config daemon", async () => {
    const child = new FakeChildProcess();
    const spawnProcess = vi.fn().mockImplementation(() => {
      queueMicrotask(() => child.exit(0));
      return child;
    });
    const deps = createDeps({
      readPidFile: vi.fn().mockResolvedValue(null),
      findDaemonProcessesByIdentity: vi.fn().mockResolvedValue([
        {
          pid: 1234,
          args: "node /runtime/dist/bin/daemon.js --config /tmp/other.json --pid-path /tmp/agenc.pid",
          argv: [
            "node",
            "/runtime/dist/bin/daemon.js",
            "--config",
            "/tmp/other.json",
            "--pid-path",
            "/tmp/agenc.pid",
          ],
          configPath: "/tmp/other.json",
          pidPath: "/tmp/agenc.pid",
          matchedConfigPath: false,
          matchedPidPath: true,
        } satisfies DaemonIdentityMatch,
      ]),
      spawnProcess,
    });

    // TUI launches immediately with config port; background ensureDaemon
    // failure is swallowed and the TUI shows a connection error instead.
    const code = await runOperatorConsole({}, deps);
    expect(code).toBe(0);
    expect(spawnProcess).toHaveBeenCalled();
  });
  it("fails when the operator console entrypoint cannot be located", async () => {
    const readPidFile = vi.fn().mockResolvedValue({
      pid: 7654,
      port: 3100,
      configPath: "/tmp/agenc.json",
    });
    const deps = createDeps({
      readPidFile,
      isProcessAlive: vi.fn().mockReturnValue(true),
      resolveConsoleEntryPath: vi.fn().mockReturnValue(null),
    });

    await expect(runOperatorConsole({}, deps)).rejects.toThrow(
      "unable to locate the operator console entrypoint",
    );
  });

  it("fails when the built operator event contract cannot be located", async () => {
    const readPidFile = vi.fn().mockResolvedValue({
      pid: 7654,
      port: 3100,
      configPath: "/tmp/agenc.json",
    });
    const deps = createDeps({
      readPidFile,
      isProcessAlive: vi.fn().mockReturnValue(true),
      resolveOperatorEventsModulePath: vi.fn().mockReturnValue(null),
    });

    await expect(runOperatorConsole({}, deps)).rejects.toThrow(
      "unable to locate the built operator event contract",
    );
  });
});
