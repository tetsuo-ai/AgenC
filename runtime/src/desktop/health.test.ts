import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DesktopSandboxWatchdog } from "./health.js";
import type { DesktopSandboxManager } from "./manager.js";
import type { DesktopSandboxHandle, DesktopSandboxInfo } from "./types.js";

// Mock execFile for docker restart
const mockExecFile = vi.fn();
vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

// Mock fetch for health checks
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function createMockHandle(
  overrides: Partial<DesktopSandboxHandle> = {},
): DesktopSandboxHandle {
  return {
    containerId: "ctr001",
    containerName: "agenc-desktop-test",
    sessionId: "sess1",
    status: "ready",
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    apiHostPort: 32769,
    vncHostPort: 32768,
    resolution: { width: 1024, height: 768 },
    ...overrides,
  };
}

function createMockInfo(
  overrides: Partial<DesktopSandboxInfo> = {},
): DesktopSandboxInfo {
  return {
    containerId: "ctr001",
    sessionId: "sess1",
    status: "ready",
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    vncUrl: "http://localhost:32768/vnc.html",
    uptimeMs: 60000,
    ...overrides,
  };
}

function mockManager(
  handles: Map<string, DesktopSandboxHandle> = new Map(),
  infos: DesktopSandboxInfo[] = [],
): DesktopSandboxManager {
  return {
    listAll: vi.fn().mockReturnValue(infos),
    getHandle: vi.fn((id: string) => handles.get(id)),
    destroyBySession: vi.fn(),
  } as unknown as DesktopSandboxManager;
}

describe("DesktopSandboxWatchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockExecFile.mockReset();
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts and stops without error", () => {
    const manager = mockManager();
    const watchdog = new DesktopSandboxWatchdog(manager, {
      intervalMs: 5000,
    });
    watchdog.start();
    watchdog.stop();
  });

  it("checks health of all ready containers", async () => {
    const handle = createMockHandle();
    const handles = new Map([["ctr001", handle]]);
    const info = createMockInfo();
    const manager = mockManager(handles, [info]);

    mockFetch.mockResolvedValue({ ok: true });

    const watchdog = new DesktopSandboxWatchdog(manager, {
      intervalMs: 5000,
    });

    await watchdog.checkAll();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(handle.status).toBe("ready");
  });

  it("marks container as unhealthy on health check failure", async () => {
    const handle = createMockHandle();
    const handles = new Map([["ctr001", handle]]);
    const info = createMockInfo();
    const manager = mockManager(handles, [info]);

    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

    const watchdog = new DesktopSandboxWatchdog(manager, {
      intervalMs: 5000,
      unhealthyThreshold: 3,
    });

    await watchdog.checkAll();
    expect(handle.status).toBe("unhealthy");
  });

  it("resets failure counter on successful health check", async () => {
    const handle = createMockHandle();
    const handles = new Map([["ctr001", handle]]);
    const info = createMockInfo();
    const manager = mockManager(handles, [info]);

    // First check fails
    mockFetch.mockRejectedValueOnce(new Error("fail"));
    const watchdog = new DesktopSandboxWatchdog(manager, {
      intervalMs: 5000,
      unhealthyThreshold: 3,
    });
    await watchdog.checkAll();
    expect(handle.status).toBe("unhealthy");

    // Second check succeeds
    mockFetch.mockResolvedValueOnce({ ok: true });
    // Need to re-mock listAll since status changed
    (manager.listAll as ReturnType<typeof vi.fn>).mockReturnValue([
      { ...info, status: "unhealthy" },
    ]);
    await watchdog.checkAll();
    expect(handle.status).toBe("ready");
  });

  it("attempts restart after threshold consecutive failures", async () => {
    const handle = createMockHandle();
    const handles = new Map([["ctr001", handle]]);
    const info = createMockInfo();
    const manager = mockManager(handles, [info]);

    mockFetch.mockRejectedValue(new Error("fail"));
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null) => void,
      ) => {
        cb(null);
      },
    );

    const watchdog = new DesktopSandboxWatchdog(manager, {
      intervalMs: 5000,
      unhealthyThreshold: 2,
    });

    // First failure
    await watchdog.checkAll();
    expect(handle.status).toBe("unhealthy");

    // Update info status for next check
    (manager.listAll as ReturnType<typeof vi.fn>).mockReturnValue([
      { ...info, status: "unhealthy" },
    ]);

    // Second failure — triggers restart
    await watchdog.checkAll();
    // Verify docker restart was called
    expect(mockExecFile).toHaveBeenCalledWith(
      "docker",
      ["restart", "ctr001"],
      expect.any(Object),
      expect.any(Function),
    );
    // After successful restart, status should be ready
    expect(handle.status).toBe("ready");
  });

  it("marks as failed when restart fails", async () => {
    const handle = createMockHandle();
    const handles = new Map([["ctr001", handle]]);
    const info = createMockInfo();
    const manager = mockManager(handles, [info]);

    mockFetch.mockRejectedValue(new Error("fail"));
    mockExecFile.mockImplementation(
      (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null) => void,
      ) => {
        cb(new Error("restart failed"));
      },
    );

    const watchdog = new DesktopSandboxWatchdog(manager, {
      intervalMs: 5000,
      unhealthyThreshold: 1,
    });

    await watchdog.checkAll();
    expect(handle.status).toBe("failed");
  });

  it("skips containers not in ready or unhealthy state", async () => {
    const info = createMockInfo({ status: "creating" });
    const manager = mockManager(new Map(), [info]);

    const watchdog = new DesktopSandboxWatchdog(manager, {
      intervalMs: 5000,
    });

    await watchdog.checkAll();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("runs checks on interval", async () => {
    const info = createMockInfo();
    const handle = createMockHandle();
    const handles = new Map([["ctr001", handle]]);
    const manager = mockManager(handles, [info]);

    mockFetch.mockResolvedValue({ ok: true });

    const watchdog = new DesktopSandboxWatchdog(manager, {
      intervalMs: 5000,
    });
    watchdog.start();

    vi.advanceTimersByTime(5001);
    await vi.advanceTimersByTimeAsync(10);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5000);
    await vi.advanceTimersByTimeAsync(10);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    watchdog.stop();
  });
});
