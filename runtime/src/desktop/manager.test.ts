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
        const port1 = 32768 + containerIdCounter * 2;
        const port2 = port1 + 1;
        cb(
          null,
          responses.inspect ??
            `{"6080/tcp":[{"HostIp":"0.0.0.0","HostPort":"${port1}"}],"9990/tcp":[{"HostIp":"0.0.0.0","HostPort":"${port2}"}]}`,
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
    it("cleans up orphan containers on start", async () => {
      mockDockerSuccess({ ps: "deadbeef1234\noldcontainer1\n" });
      manager = new DesktopSandboxManager(makeConfig());
      await manager.start();

      // Should have called docker ps with our label filter
      const psCalls = mockExecFile.mock.calls.filter(
        (c: unknown[]) => (c[1] as string[])[0] === "ps",
      );
      expect(psCalls.length).toBe(1);
      expect((psCalls[0][1] as string[]).join(" ")).toContain(
        "managed-by=agenc-desktop",
      );

      // Should have rm -f each orphan
      const rmCalls = mockExecFile.mock.calls.filter(
        (c: unknown[]) =>
          (c[1] as string[])[0] === "rm" && (c[1] as string[])[1] === "-f",
      );
      expect(rmCalls.length).toBe(2);
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
      expect(args).toContain("256");
      expect(args).toContain("agenc/desktop:latest");
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

    it("throws PoolExhaustedError when at max capacity", async () => {
      manager = new DesktopSandboxManager(makeConfig({ maxConcurrent: 1 }));
      await manager.start();
      await manager.create({ sessionId: "sess1" });

      await expect(manager.create({ sessionId: "sess2" })).rejects.toThrow(
        DesktopSandboxPoolExhaustedError,
      );
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
