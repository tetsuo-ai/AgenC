import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DesktopSandboxManager } from "./manager.js";
import {
  DesktopSandboxPoolExhaustedError,
  DesktopSandboxLifecycleError,
} from "./errors.js";
import type { DesktopSandboxConfig } from "./types.js";
import { RuntimeErrorCodes } from "../types/errors.js";

// Mock child_process.execFile
const mockExecFile = vi.fn();
vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

// Mock fetch for health checks
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function makeConfig(
  overrides: Partial<DesktopSandboxConfig> = {},
): DesktopSandboxConfig {
  return {
    enabled: true,
    maxConcurrent: 4,
    idleTimeoutMs: 300_000,
    maxLifetimeMs: 600_000,
    ...overrides,
  };
}

/** Counter for generating unique container IDs */
let containerIdCounter = 0;

/** Simulate docker execFile calls returning specific values */
function mockDockerSuccess(
  responses: Record<string, string> = {},
): void {
  mockExecFile.mockImplementation(
    (
      cmd: string,
      args: string[],
      opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      if (cmd !== "docker") {
        cb(new Error(`unexpected cmd: ${cmd}`), "", "");
        return;
      }
      const subCommand = args[0];
      if (subCommand === "info") {
        cb(null, "ok", "");
        return;
      }
      if (subCommand === "run") {
        containerIdCounter++;
        // IDs must be unique within 12 chars (manager slices to 12)
        const id = responses.run ?? `ctr${String(containerIdCounter).padStart(9, "0")}ff\n`;
        cb(null, id, "");
        return;
      }
      if (subCommand === "inspect") {
        const formatArgIndex = args.indexOf("--format");
        if (formatArgIndex !== -1) {
          const port1 = 32768 + containerIdCounter * 2;
          const port2 = port1 + 1;
          cb(
            null,
            responses.inspect ??
              `{"6080/tcp":[{"HostIp":"127.0.0.1","HostPort":"${port1}"}],"9990/tcp":[{"HostIp":"127.0.0.1","HostPort":"${port2}"}]}`,
            "",
          );
          return;
        }
        const port1 = 32768 + containerIdCounter * 2;
        const port2 = port1 + 1;
        cb(
          null,
          responses.inspectFull ??
            JSON.stringify([
              {
                Id: args[1] ?? `ctr${String(containerIdCounter).padStart(9, "0")}ff`,
                Name: "/agenc-desktop-sess1",
                Created: "2026-03-07T07:00:00.000Z",
                Config: {
                  Env: [
                    "DISPLAY_WIDTH=1280",
                    "DISPLAY_HEIGHT=1024",
                    "DESKTOP_AUTH_TOKEN=recoveredtoken",
                  ],
                  Labels: {
                    "session-id": "sess1",
                    "agenc.desktop.resolution": "1280x1024",
                    "agenc.desktop.max-memory": "4g",
                    "agenc.desktop.max-cpu": "2.0",
                    "agenc.desktop.created-at": "1772866800000",
                  },
                },
                State: {
                  Running: true,
                  Status: "running",
                  StartedAt: "2026-03-07T07:00:01.000Z",
                },
                NetworkSettings: {
                  Ports: {
                    "6080/tcp": [{ HostIp: "127.0.0.1", HostPort: `${port1}` }],
                    "9990/tcp": [{ HostIp: "127.0.0.1", HostPort: `${port2}` }],
                  },
                },
              },
            ]),
          "",
        );
        return;
      }
      if (subCommand === "rm") {
        cb(null, "", "");
        return;
      }
      if (subCommand === "ps") {
        cb(null, responses.ps ?? "", "");
        return;
      }
      cb(null, "", "");
    },
  );
}

describe("DesktopSandboxManager", () => {
  let manager: DesktopSandboxManager;

  beforeEach(() => {
    vi.useFakeTimers();
    mockExecFile.mockReset();
    mockFetch.mockReset();
    containerIdCounter = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("isAvailable()", () => {
    it("returns true when Docker is available", async () => {
      mockDockerSuccess({});
      manager = new DesktopSandboxManager(makeConfig());
      expect(await manager.isAvailable()).toBe(true);
    });

    it("returns false when Docker is not available", async () => {
      mockExecFile.mockImplementation(
        (
          _cmd: string,
          _args: string[],
          _opts: unknown,
          cb: (err: Error | null, stdout: string, stderr: string) => void,
        ) => {
          cb(new Error("Docker not found"), "", "");
        },
      );
      manager = new DesktopSandboxManager(makeConfig());
      expect(await manager.isAvailable()).toBe(false);
    });

    it("caches the result", async () => {
      mockDockerSuccess({});
      manager = new DesktopSandboxManager(makeConfig());
      await manager.isAvailable();
      await manager.isAvailable();
      // Only one call to docker info
      const infoCalls = mockExecFile.mock.calls.filter(
        (c: unknown[]) => (c[1] as string[])[0] === "info",
      );
      expect(infoCalls.length).toBe(1);
    });
  });

  describe("start()", () => {
    it("recovers live managed containers on start", async () => {
      mockDockerSuccess({ ps: "deadbeef1234\n" });
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ status: "ok" }) });
      manager = new DesktopSandboxManager(makeConfig());
      await manager.start();

      const psCalls = mockExecFile.mock.calls.filter(
        (c: unknown[]) => (c[1] as string[])[0] === "ps",
      );
      expect(psCalls.length).toBe(1);
      expect((psCalls[0][1] as string[]).join(" ")).toContain(
        "managed-by=agenc-desktop",
      );

      expect(manager.activeCount).toBe(1);
      const recovered = manager.getHandleBySession("sess1");
      expect(recovered?.containerId).toBe("deadbeef1234");
      expect(recovered?.status).toBe("ready");
      expect(recovered?.apiHostPort).toBeGreaterThan(0);
      expect(recovered?.vncHostPort).toBeGreaterThan(0);

      const rmCalls = mockExecFile.mock.calls.filter(
        (c: unknown[]) =>
          (c[1] as string[])[0] === "rm" && (c[1] as string[])[1] === "-f",
      );
      expect(rmCalls.length).toBe(0);
    });

    it("removes dead managed containers it cannot recover", async () => {
      mockDockerSuccess({
        ps: "deadbeef1234\n",
        inspectFull: JSON.stringify([
          {
            Id: "deadbeef1234",
            Name: "/agenc-desktop-sess1",
            Config: {
              Env: ["DESKTOP_AUTH_TOKEN=recoveredtoken"],
              Labels: { "session-id": "sess1" },
            },
            State: {
              Running: false,
              Status: "exited",
            },
            NetworkSettings: { Ports: {} },
          },
        ]),
      });
      manager = new DesktopSandboxManager(makeConfig());
      await manager.start();

      expect(manager.activeCount).toBe(0);
      const rmCalls = mockExecFile.mock.calls.filter(
        (c: unknown[]) =>
          (c[1] as string[])[0] === "rm" && (c[1] as string[])[1] === "-f",
      );
      expect(rmCalls.length).toBe(1);
    });

    it("removes Docker-unhealthy managed containers instead of recovering them", async () => {
      mockDockerSuccess({
        ps: "deadbeef1234\n",
        inspectFull: JSON.stringify([
          {
            Id: "deadbeef1234",
            Name: "/agenc-desktop-sess1",
            Config: {
              Env: ["DESKTOP_AUTH_TOKEN=recoveredtoken"],
              Labels: { "session-id": "sess1" },
            },
            State: {
              Running: true,
              Status: "running",
              Health: {
                Status: "unhealthy",
              },
            },
            NetworkSettings: { Ports: {} },
          },
        ]),
      });
      manager = new DesktopSandboxManager(makeConfig());
      await manager.start();

      expect(manager.activeCount).toBe(0);
      expect(mockFetch).not.toHaveBeenCalled();
      const rmCalls = mockExecFile.mock.calls.filter(
        (c: unknown[]) =>
          (c[1] as string[])[0] === "rm" && (c[1] as string[])[1] === "-f",
      );
      expect(rmCalls.length).toBe(1);
    });
  });

  describe("create()", () => {
    beforeEach(() => {
      mockDockerSuccess({});
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ status: "ok" }) });
    });

    it("creates a container with correct docker run args", async () => {
      manager = new DesktopSandboxManager(makeConfig());
      await manager.start();
      const handle = await manager.create({ sessionId: "test-session" });

      expect(handle.containerId).toBe("ctr000000001");
      expect(handle.sessionId).toBe("test-session");
      expect(handle.status).toBe("ready");
      expect(handle.apiHostPort).toBeGreaterThan(0);
      expect(handle.vncHostPort).toBeGreaterThan(0);

      // Verify docker run was called with expected args
      const runCall = mockExecFile.mock.calls.find(
        (c: unknown[]) => (c[1] as string[])[0] === "run",
      );
      expect(runCall).toBeTruthy();
      const args = runCall![1] as string[];
      expect(args).toContain("--detach");
      expect(args).toContain("--pids-limit");
      expect(args).toContain("1024");
      expect(args).toContain("agenc/desktop:latest");
      expect(args).toContain("127.0.0.1::9990");
      expect(args).toContain("127.0.0.1::6080");
      expect(args.some((arg) => /^DESKTOP_AUTH_TOKEN=[a-f0-9]{64}$/.test(arg))).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/health"),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: expect.stringMatching(/^Bearer [a-f0-9]{64}$/),
          }),
        }),
      );
    });

    it("applies custom resolution", async () => {
      manager = new DesktopSandboxManager(makeConfig());
      await manager.start();
      const handle = await manager.create({
        sessionId: "sess1",
        resolution: { width: 1920, height: 1080 },
      });

      const runCall = mockExecFile.mock.calls.find(
        (c: unknown[]) => (c[1] as string[])[0] === "run",
      );
      const args = runCall![1] as string[];
      expect(args).toContain("DISPLAY_WIDTH=1920");
      expect(args).toContain("DISPLAY_HEIGHT=1080");
      expect(handle.resolution.width).toBe(1920);
    });

    it("applies per-sandbox maxMemory and maxCpu overrides", async () => {
      manager = new DesktopSandboxManager(makeConfig());
      await manager.start();
      const handle = await manager.create({
        sessionId: "sess-resources",
        maxMemory: "2g",
        maxCpu: "1.5",
      });

      const runCall = mockExecFile.mock.calls.find(
        (c: unknown[]) => (c[1] as string[])[0] === "run",
      );
      const args = runCall![1] as string[];
      expect(args).toContain("--memory");
      expect(args).toContain("2g");
      expect(args).toContain("--cpus");
      expect(args).toContain("1.5");
      expect(handle.maxMemory).toBe("2g");
      expect(handle.maxCpu).toBe("1.5");
    });

    it("normalizes bare integer memory overrides to gigabytes", async () => {
      manager = new DesktopSandboxManager(makeConfig());
      await manager.start();
      const handle = await manager.create({
        sessionId: "sess-resources-int",
        maxMemory: "16",
        maxCpu: "4",
      });

      const runCall = mockExecFile.mock.calls.find(
        (c: unknown[]) => (c[1] as string[])[0] === "run",
      );
      const args = runCall![1] as string[];
      expect(args).toContain("--memory");
      expect(args).toContain("16g");
      expect(handle.maxMemory).toBe("16g");
    });

    it("validates env var key names", async () => {
      manager = new DesktopSandboxManager(makeConfig());
      await manager.start();
      await manager.create({
        sessionId: "sess1",
        env: {
          VALID_KEY: "value",
          "invalid key!": "skipped",
        },
      });

      const runCall = mockExecFile.mock.calls.find(
        (c: unknown[]) => (c[1] as string[])[0] === "run",
      );
      const args = runCall![1] as string[];
      expect(args).toContain("VALID_KEY=value");
      expect(args.join(" ")).not.toContain("invalid key!");
    });

    it("does not allow DESKTOP_AUTH_TOKEN overrides from sandbox env", async () => {
      manager = new DesktopSandboxManager(makeConfig());
      await manager.start();
      await manager.create({
        sessionId: "sess-auth",
        env: {
          DESKTOP_AUTH_TOKEN: "user-supplied-token",
          VALID_KEY: "value",
        },
      });

      const runCall = mockExecFile.mock.calls.find(
        (c: unknown[]) => (c[1] as string[])[0] === "run",
      );
      const args = runCall![1] as string[];
      const authEnvVars = args.filter((arg) =>
        arg.startsWith("DESKTOP_AUTH_TOKEN=")
      );
      expect(authEnvVars).toHaveLength(1);
      expect(authEnvVars[0]).not.toBe("DESKTOP_AUTH_TOKEN=user-supplied-token");
    });

    it("mounts the host workspace and sets /workspace as cwd when configured", async () => {
      manager = new DesktopSandboxManager(makeConfig(), {
        workspacePath: "/home/user/project",
        hostUid: 1000,
        hostGid: 1000,
      });
      await manager.start();
      await manager.create({ sessionId: "sess-workspace" });

      const runCall = mockExecFile.mock.calls.find(
        (c: unknown[]) => (c[1] as string[])[0] === "run",
      );
      const args = runCall![1] as string[];
      expect(args).toContain("--volume");
      expect(args).toContain("/home/user/project:/workspace:rw");
      expect(args).toContain("--workdir");
      expect(args).toContain("/workspace");
      expect(args).toContain("AGENC_WORKSPACE_ROOT=/workspace");
      expect(args).toContain("AGENC_HOST_UID=1000");
      expect(args).toContain("AGENC_HOST_GID=1000");
    });

    it("skips workspace mounts when workspaceAccess is none", async () => {
      manager = new DesktopSandboxManager(makeConfig(), {
        workspacePath: "/home/user/project",
        workspaceAccess: "none",
      });
      await manager.start();
      await manager.create({ sessionId: "sess-no-workspace" });

      const runCall = mockExecFile.mock.calls.find(
        (c: unknown[]) => (c[1] as string[])[0] === "run",
      );
      const args = runCall![1] as string[];
      expect(args).not.toContain("--workdir");
      expect(args.join(" ")).not.toContain("/workspace");
      expect(args.join(" ")).not.toContain("AGENC_WORKSPACE_ROOT");
    });

    it("throws PoolExhaustedError when at max capacity", async () => {
      manager = new DesktopSandboxManager(makeConfig({ maxConcurrent: 1 }));
      await manager.start();
      await manager.create({ sessionId: "sess1" });

      await expect(manager.create({ sessionId: "sess2" })).rejects.toThrow(
        DesktopSandboxPoolExhaustedError,
      );
    });

    it("reclaims unhealthy tracked capacity before throwing pool exhaustion", async () => {
      mockExecFile.mockImplementation(
        (
          cmd: string,
          args: string[],
          _opts: unknown,
          cb: (err: Error | null, stdout: string, stderr: string) => void,
        ) => {
          if (cmd !== "docker") {
            cb(new Error(`unexpected cmd: ${cmd}`), "", "");
            return;
          }
          const subCommand = args[0];
          if (subCommand === "info") {
            cb(null, "ok", "");
            return;
          }
          if (subCommand === "ps") {
            cb(null, "", "");
            return;
          }
          if (subCommand === "run") {
            containerIdCounter++;
            cb(null, `ctr${String(containerIdCounter).padStart(9, "0")}ff\n`, "");
            return;
          }
          if (subCommand === "inspect" && args[1] === "ctr000000001") {
            cb(
              null,
              JSON.stringify([
                {
                  Id: "ctr000000001",
                  Name: "/agenc-desktop-sess1",
                  Config: {
                    Env: ["DESKTOP_AUTH_TOKEN=recoveredtoken"],
                    Labels: { "session-id": "sess1" },
                  },
                  State: {
                    Running: true,
                    Status: "running",
                    Health: {
                      Status: "unhealthy",
                    },
                  },
                  NetworkSettings: {
                    Ports: {
                      "6080/tcp": [{ HostIp: "127.0.0.1", HostPort: "32768" }],
                      "9990/tcp": [{ HostIp: "127.0.0.1", HostPort: "32769" }],
                    },
                  },
                },
              ]),
              "",
            );
            return;
          }
          if (subCommand === "inspect" && args.indexOf("--format") !== -1) {
            const port1 = 32768 + containerIdCounter * 2;
            const port2 = port1 + 1;
            cb(
              null,
              `{"6080/tcp":[{"HostIp":"127.0.0.1","HostPort":"${port1}"}],"9990/tcp":[{"HostIp":"127.0.0.1","HostPort":"${port2}"}]}`,
              "",
            );
            return;
          }
          if (subCommand === "rm") {
            cb(null, "", "");
            return;
          }
          cb(null, "", "");
        },
      );
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ status: "ok" }) });

      manager = new DesktopSandboxManager(makeConfig({ maxConcurrent: 1 }));
      await manager.start();
      const first = await manager.create({ sessionId: "sess1" });

      const second = await manager.create({ sessionId: "sess2" });

      expect(second.containerId).not.toBe(first.containerId);
      expect(manager.getHandleBySession("sess1")).toBeUndefined();
      expect(manager.getHandleBySession("sess2")?.containerId).toBe(second.containerId);
      const rmCalls = mockExecFile.mock.calls.filter(
        (c: unknown[]) =>
          (c[1] as string[])[0] === "rm" && (c[1] as string[])[1] === "-f",
      );
      expect(rmCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("throws LifecycleError for invalid maxMemory override", async () => {
      manager = new DesktopSandboxManager(makeConfig());
      await manager.start();
      await expect(
        manager.create({ sessionId: "sess-invalid-mem", maxMemory: "banana" }),
      ).rejects.toThrow(DesktopSandboxLifecycleError);
    });

    it("throws LifecycleError for invalid maxCpu override", async () => {
      manager = new DesktopSandboxManager(makeConfig());
      await manager.start();
      await expect(
        manager.create({ sessionId: "sess-invalid-cpu", maxCpu: "0" }),
      ).rejects.toThrow(DesktopSandboxLifecycleError);
    });

    it("throws LifecycleError when docker run fails", async () => {
      mockExecFile.mockImplementation(
        (
          _cmd: string,
          args: string[],
          _opts: unknown,
          cb: (err: Error | null, stdout: string, stderr: string) => void,
        ) => {
          if (args[0] === "info") {
            cb(null, "ok", "");
            return;
          }
          if (args[0] === "ps") {
            cb(null, "", "");
            return;
          }
          if (args[0] === "rm") {
            cb(null, "", "");
            return;
          }
          if (args[0] === "run") {
            cb(new Error("docker run failed"), "", "");
            return;
          }
          cb(null, "", "");
        },
      );

      manager = new DesktopSandboxManager(makeConfig());
      await manager.start();

      await expect(manager.create({ sessionId: "sess1" })).rejects.toThrow(
        DesktopSandboxLifecycleError,
      );
    });

    it("removes stale container with same name before create", async () => {
      mockDockerSuccess({});
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ status: "ok" }) });
      manager = new DesktopSandboxManager(makeConfig());
      await manager.start();
      await manager.create({ sessionId: "sess1" });

      // Find rm -f calls before the run call
      const calls = mockExecFile.mock.calls.map(
        (c: unknown[]) => (c[1] as string[]).join(" "),
      );
      const rmBeforeRun = calls.findIndex(
        (s) => s.startsWith("rm -f agenc-desktop"),
      );
      const runIdx = calls.findIndex((s) => s.startsWith("run"));
      expect(rmBeforeRun).toBeLessThan(runIdx);
    });
  });

  describe("session mapping", () => {
    beforeEach(() => {
      mockDockerSuccess({});
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ status: "ok" }) });
    });

    it("getHandleBySession returns the correct handle", async () => {
      manager = new DesktopSandboxManager(makeConfig());
      await manager.start();
      const handle = await manager.create({ sessionId: "sess1" });
      expect(manager.getHandleBySession("sess1")).toBe(handle);
    });

    it("getHandleBySession returns undefined for unknown session", async () => {
      manager = new DesktopSandboxManager(makeConfig());
      expect(manager.getHandleBySession("unknown")).toBeUndefined();
    });

    it("assignSession maps an additional session to an existing container", async () => {
      manager = new DesktopSandboxManager(makeConfig());
      await manager.start();
      const handle = await manager.create({ sessionId: "sess1" });

      const attached = manager.assignSession(handle.containerId, "sess2");

      expect(attached.containerId).toBe(handle.containerId);
      expect(attached.sessionId).toBe("sess2");
      expect(manager.getHandleBySession("sess1")?.containerId).toBe(
        handle.containerId,
      );
      expect(manager.getHandleBySession("sess2")?.containerId).toBe(
        handle.containerId,
      );
    });
  });

  describe("getOrCreate()", () => {
    beforeEach(() => {
      mockDockerSuccess({});
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ status: "ok" }) });
    });

    it("returns existing handle if ready", async () => {
      manager = new DesktopSandboxManager(makeConfig());
      await manager.start();
      const first = await manager.getOrCreate("sess1");
      const second = await manager.getOrCreate("sess1");
      expect(second).toBe(first);
    });

    it("creates new handle if previous one stopped", async () => {
      manager = new DesktopSandboxManager(makeConfig());
      await manager.start();
      const first = await manager.create({ sessionId: "sess1" });
      await manager.destroy(first.containerId);
      const second = await manager.getOrCreate("sess1");
      expect(second.containerId).not.toBe(first.containerId);
    });
  });

  describe("destroy()", () => {
    beforeEach(() => {
      mockDockerSuccess({});
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ status: "ok" }) });
    });

    it("removes container and clears session mapping", async () => {
      manager = new DesktopSandboxManager(makeConfig());
      await manager.start();
      const handle = await manager.create({ sessionId: "sess1" });

      await manager.destroy(handle.containerId);
      expect(manager.getHandleBySession("sess1")).toBeUndefined();
      expect(manager.getHandle(handle.containerId)).toBeUndefined();
      expect(manager.activeCount).toBe(0);
    });

    it("destroyBySession works", async () => {
      manager = new DesktopSandboxManager(makeConfig());
      await manager.start();
      await manager.create({ sessionId: "sess1" });

      await manager.destroyBySession("sess1");
      expect(manager.activeCount).toBe(0);
    });

    it("destroy removes all aliased session mappings for a container", async () => {
      manager = new DesktopSandboxManager(makeConfig());
      await manager.start();
      const handle = await manager.create({ sessionId: "sess1" });
      manager.assignSession(handle.containerId, "sess2");

      await manager.destroy(handle.containerId);
      expect(manager.getHandleBySession("sess1")).toBeUndefined();
      expect(manager.getHandleBySession("sess2")).toBeUndefined();
    });

    it("destroyAll clears everything", async () => {
      manager = new DesktopSandboxManager(
        makeConfig({ maxConcurrent: 3 }),
      );
      await manager.start();
      await manager.create({ sessionId: "sess1" });
      await manager.create({ sessionId: "sess2" });
      expect(manager.activeCount).toBe(2);

      await manager.destroyAll();
      expect(manager.activeCount).toBe(0);
    });

    it("stop preserves tracked containers for daemon recovery", async () => {
      manager = new DesktopSandboxManager(makeConfig());
      await manager.start();
      const handle = await manager.create({ sessionId: "sess1" });
      const rmCallsBeforeStop = mockExecFile.mock.calls.filter(
        (c: unknown[]) =>
          (c[1] as string[])[0] === "rm" && (c[1] as string[])[1] === "-f",
      ).length;

      await manager.stop();

      expect(manager.activeCount).toBe(0);
      expect(manager.getHandle(handle.containerId)).toBeUndefined();
      const rmCalls = mockExecFile.mock.calls.filter(
        (c: unknown[]) =>
          (c[1] as string[])[0] === "rm" && (c[1] as string[])[1] === "-f",
      );
      expect(rmCalls.length).toBe(rmCallsBeforeStop);
    });
  });

  describe("listAll()", () => {
    beforeEach(() => {
      mockDockerSuccess({});
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ status: "ok" }) });
    });

    it("returns info for all tracked containers", async () => {
      manager = new DesktopSandboxManager(
        makeConfig({ maxConcurrent: 3 }),
      );
      await manager.start();
      await manager.create({ sessionId: "sess1" });
      await manager.create({ sessionId: "sess2" });

      const list = manager.listAll();
      expect(list.length).toBe(2);
      expect(list[0].sessionId).toBe("sess1");
      expect(list[0].vncUrl).toContain("localhost");
      expect(list[1].sessionId).toBe("sess2");
    });
  });

  describe("idle timeout", () => {
    beforeEach(() => {
      mockDockerSuccess({});
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ status: "ok" }) });
    });

    it("destroys container after idle timeout", async () => {
      manager = new DesktopSandboxManager(
        makeConfig({ idleTimeoutMs: 5_000 }),
      );
      await manager.start();
      const handle = await manager.create({ sessionId: "sess1" });
      expect(manager.activeCount).toBe(1);

      // Advance past idle timeout
      vi.advanceTimersByTime(5_001);
      // Allow the async destroy to settle
      await vi.advanceTimersByTimeAsync(100);
      expect(manager.getHandle(handle.containerId)).toBeUndefined();
    });

    it("touchActivity resets the idle timer", async () => {
      manager = new DesktopSandboxManager(
        makeConfig({ idleTimeoutMs: 5_000 }),
      );
      await manager.start();
      const handle = await manager.create({ sessionId: "sess1" });

      // Advance partway
      vi.advanceTimersByTime(3_000);
      manager.touchActivity(handle.containerId);

      // Advance past original timeout but not reset one
      vi.advanceTimersByTime(3_000);
      expect(manager.getHandleBySession("sess1")).toBeTruthy();

      // Advance past reset timeout
      vi.advanceTimersByTime(3_000);
      await vi.advanceTimersByTimeAsync(100);
      expect(manager.getHandleBySession("sess1")).toBeUndefined();
    });
  });

  describe("max lifetime", () => {
    beforeEach(() => {
      mockDockerSuccess({});
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ status: "ok" }) });
    });

    it("destroys container after max lifetime", async () => {
      manager = new DesktopSandboxManager(
        makeConfig({ maxLifetimeMs: 10_000, idleTimeoutMs: 999_999 }),
      );
      await manager.start();
      await manager.create({ sessionId: "sess1" });

      vi.advanceTimersByTime(10_001);
      await vi.advanceTimersByTimeAsync(100);
      expect(manager.activeCount).toBe(0);
    });
  });

  describe("port parsing", () => {
    it("throws on missing port mapping", async () => {
      mockDockerSuccess({ inspect: '{"6080/tcp":null,"9990/tcp":null}' });

      manager = new DesktopSandboxManager(makeConfig());
      await manager.start();

      await expect(manager.create({ sessionId: "sess1" })).rejects.toThrow(
        DesktopSandboxLifecycleError,
      );
    });
  });

  describe("activeCount", () => {
    beforeEach(() => {
      mockDockerSuccess({});
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ status: "ok" }) });
    });

    it("tracks active container count", async () => {
      manager = new DesktopSandboxManager(
        makeConfig({ maxConcurrent: 5 }),
      );
      await manager.start();
      expect(manager.activeCount).toBe(0);

      await manager.create({ sessionId: "sess1" });
      expect(manager.activeCount).toBe(1);

      await manager.create({ sessionId: "sess2" });
      expect(manager.activeCount).toBe(2);

      await manager.destroyBySession("sess1");
      expect(manager.activeCount).toBe(1);
    });
  });
});
