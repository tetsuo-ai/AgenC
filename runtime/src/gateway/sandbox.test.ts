import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  SandboxManager,
  SandboxExecutionError,
  SandboxUnavailableError,
  defaultSandboxConfig,
  checkDockerAvailable,
  DEFAULT_IMAGE,
  DEFAULT_MAX_MEMORY,
  DEFAULT_MAX_CPU,
  DEFAULT_MAX_OUTPUT_BYTES,
  CONTAINER_PREFIX,
} from "./sandbox.js";
import type { SandboxConfig } from "./sandbox.js";
import { RuntimeError, RuntimeErrorCodes } from "../types/errors.js";
import type { Logger } from "../utils/logger.js";

// Mock execFile from node:child_process
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import { execFile } from "node:child_process";

const mockExecFile = vi.mocked(execFile);

/** Simulate a successful execFile callback. */
function mockSuccess(stdout = "", stderr = "") {
  mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
    (callback as Function)(null, stdout, stderr);
    return {} as ReturnType<typeof execFile>;
  });
}

/** Simulate an error execFile callback. */
function mockError(
  error: Partial<
    Error & {
      killed?: boolean;
      code?: unknown;
      stdout?: string;
      stderr?: string;
    }
  >,
  stdout = "",
  stderr = "",
) {
  mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
    const err = Object.assign(new Error(error.message ?? "command failed"), {
      stdout: error.stdout ?? stdout,
      stderr: error.stderr ?? stderr,
      ...error,
    });
    (callback as Function)(err, stdout, stderr);
    return {} as ReturnType<typeof execFile>;
  });
}

/** Simulate ENOENT (Docker not installed). */
function mockEnoent() {
  mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
    const err = Object.assign(new Error("spawn docker ENOENT"), {
      code: "ENOENT",
    });
    (callback as Function)(err, "", "");
    return {} as ReturnType<typeof execFile>;
  });
}

function createMockLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** Helper to create a basic sandbox config. */
function createConfig(overrides: Partial<SandboxConfig> = {}): SandboxConfig {
  return { ...defaultSandboxConfig(), mode: "all", ...overrides };
}

/**
 * Helper that configures mockExecFile to return different results based on
 * the first argument (docker subcommand). Handles the rm/run/exec flow for
 * container creation and command execution.
 */
function mockDockerFlow(
  opts: {
    containerId?: string;
    execStdout?: string;
    execStderr?: string;
    execError?: Partial<
      Error & {
        code?: unknown;
        stdout?: string;
        stderr?: string;
        killed?: boolean;
      }
    >;
  } = {},
) {
  const containerId = opts.containerId ?? "abc123container";

  mockExecFile.mockImplementation((_cmd, args, _opts, callback) => {
    const subcommand = (args as string[])?.[0];

    if (subcommand === "info") {
      (callback as Function)(null, "Docker info output", "");
    } else if (subcommand === "rm") {
      // Stale container cleanup — always succeed
      (callback as Function)(null, "", "");
    } else if (subcommand === "run") {
      (callback as Function)(null, `${containerId}\n`, "");
    } else if (subcommand === "exec") {
      if (opts.execError) {
        const err = Object.assign(
          new Error(opts.execError.message ?? "exec failed"),
          opts.execError,
        );
        (callback as Function)(
          err,
          opts.execStdout ?? "",
          opts.execStderr ?? "",
        );
      } else {
        (callback as Function)(
          null,
          opts.execStdout ?? "",
          opts.execStderr ?? "",
        );
      }
    } else {
      (callback as Function)(null, "", "");
    }

    return {} as ReturnType<typeof execFile>;
  });
}

describe("sandbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ==========================================================================
  // defaultSandboxConfig()
  // ==========================================================================

  describe("defaultSandboxConfig", () => {
    it("returns safe defaults", () => {
      const config = defaultSandboxConfig();
      expect(config.mode).toBe("off");
      expect(config.scope).toBe("session");
      expect(config.workspaceAccess).toBe("none");
      expect(config.networkAccess).toBe(false);
    });
  });

  // ==========================================================================
  // checkDockerAvailable()
  // ==========================================================================

  describe("checkDockerAvailable", () => {
    it("returns true when Docker responds", async () => {
      mockSuccess("Docker version info");
      expect(await checkDockerAvailable()).toBe(true);
    });

    it("returns false when Docker command fails", async () => {
      mockError({ message: "Cannot connect to Docker daemon" });
      expect(await checkDockerAvailable()).toBe(false);
    });

    it("returns false when Docker is not installed (ENOENT)", async () => {
      mockEnoent();
      expect(await checkDockerAvailable()).toBe(false);
    });
  });

  // ==========================================================================
  // shouldSandbox()
  // ==========================================================================

  describe("shouldSandbox", () => {
    it("returns false for all scopes when mode is off", () => {
      const mgr = new SandboxManager(createConfig({ mode: "off" }));
      expect(mgr.shouldSandbox("dm")).toBe(false);
      expect(mgr.shouldSandbox("group")).toBe(false);
      expect(mgr.shouldSandbox("thread")).toBe(false);
    });

    it("returns true for all scopes when mode is all", () => {
      const mgr = new SandboxManager(createConfig({ mode: "all" }));
      expect(mgr.shouldSandbox("dm")).toBe(true);
      expect(mgr.shouldSandbox("group")).toBe(true);
      expect(mgr.shouldSandbox("thread")).toBe(true);
    });

    it("returns false for dm and true for group/thread when mode is non-main", () => {
      const mgr = new SandboxManager(createConfig({ mode: "non-main" }));
      expect(mgr.shouldSandbox("dm")).toBe(false);
      expect(mgr.shouldSandbox("group")).toBe(true);
      expect(mgr.shouldSandbox("thread")).toBe(true);
    });
  });

  // ==========================================================================
  // isAvailable()
  // ==========================================================================

  describe("isAvailable", () => {
    it("returns true when Docker daemon responds", async () => {
      mockSuccess("Docker info");
      const mgr = new SandboxManager(createConfig());
      expect(await mgr.isAvailable()).toBe(true);
    });

    it("returns false when Docker daemon is unreachable", async () => {
      mockError({ message: "Cannot connect" });
      const mgr = new SandboxManager(createConfig());
      expect(await mgr.isAvailable()).toBe(false);
    });

    it("returns false when Docker is not installed", async () => {
      mockEnoent();
      const mgr = new SandboxManager(createConfig());
      expect(await mgr.isAvailable()).toBe(false);
    });

    it("caches the result after first check", async () => {
      mockSuccess("Docker info");
      const mgr = new SandboxManager(createConfig());

      await mgr.isAvailable();
      await mgr.isAvailable();

      // Only called once for `docker info` despite two isAvailable() calls
      const infoCalls = mockExecFile.mock.calls.filter(
        (c) => (c[1] as string[])?.[0] === "info",
      );
      expect(infoCalls.length).toBe(1);
    });
  });

  // ==========================================================================
  // getContainer / container creation
  // ==========================================================================

  describe("container creation", () => {
    it("creates a new container with correct docker run args", async () => {
      mockDockerFlow({ containerId: "new-container-id" });

      const mgr = new SandboxManager(createConfig(), {
        logger: createMockLogger(),
      });
      await mgr.execute("echo hello", { sessionId: "test-session" });

      // Find the `docker run` call
      const runCall = mockExecFile.mock.calls.find(
        (c) => (c[1] as string[])?.[0] === "run",
      );
      expect(runCall).toBeDefined();
      const args = runCall![1] as string[];
      expect(args).toContain("--detach");
      expect(args).toContain("--memory");
      expect(args).toContain(DEFAULT_MAX_MEMORY);
      expect(args).toContain("--cpus");
      expect(args).toContain(DEFAULT_MAX_CPU);
      expect(args).toContain("--label");
      expect(args).toContain("managed-by=agenc");
      expect(args).toContain(DEFAULT_IMAGE);
      expect(args).toContain("tail");
    });

    it("passes --network none when networkAccess is false", async () => {
      mockDockerFlow();

      const mgr = new SandboxManager(createConfig({ networkAccess: false }));
      await mgr.execute("echo hi");

      const runCall = mockExecFile.mock.calls.find(
        (c) => (c[1] as string[])?.[0] === "run",
      );
      const args = runCall![1] as string[];
      expect(args).toContain("--network");
      expect(args).toContain("none");
    });

    it("omits --network none when networkAccess is true", async () => {
      mockDockerFlow();

      const mgr = new SandboxManager(createConfig({ networkAccess: true }));
      await mgr.execute("echo hi");

      const runCall = mockExecFile.mock.calls.find(
        (c) => (c[1] as string[])?.[0] === "run",
      );
      const args = runCall![1] as string[];
      expect(args).not.toContain("--network");
    });

    it("mounts workspace as readonly when configured", async () => {
      mockDockerFlow();

      const mgr = new SandboxManager(
        createConfig({ workspaceAccess: "readonly" }),
        { workspacePath: "/home/user/workspace" },
      );
      await mgr.execute("ls");

      const runCall = mockExecFile.mock.calls.find(
        (c) => (c[1] as string[])?.[0] === "run",
      );
      const args = runCall![1] as string[];
      expect(args).toContain("--volume");
      expect(args).toContain("/home/user/workspace:/workspace:ro");
    });

    it("mounts workspace as readwrite when configured", async () => {
      mockDockerFlow();

      const mgr = new SandboxManager(
        createConfig({ workspaceAccess: "readwrite" }),
        { workspacePath: "/home/user/workspace" },
      );
      await mgr.execute("ls");

      const runCall = mockExecFile.mock.calls.find(
        (c) => (c[1] as string[])?.[0] === "run",
      );
      const args = runCall![1] as string[];
      expect(args).toContain("--volume");
      expect(args).toContain("/home/user/workspace:/workspace:rw");
    });

    it("does not mount workspace when workspaceAccess is none", async () => {
      mockDockerFlow();

      const mgr = new SandboxManager(createConfig({ workspaceAccess: "none" }));
      await mgr.execute("ls");

      const runCall = mockExecFile.mock.calls.find(
        (c) => (c[1] as string[])?.[0] === "run",
      );
      const args = runCall![1] as string[];
      expect(args).not.toContain("--volume");
    });

    it("uses custom image and resource limits", async () => {
      mockDockerFlow();

      const mgr = new SandboxManager(
        createConfig({ image: "ubuntu:22.04", maxMemory: "1g", maxCpu: "2.0" }),
      );
      await mgr.execute("echo test");

      const runCall = mockExecFile.mock.calls.find(
        (c) => (c[1] as string[])?.[0] === "run",
      );
      const args = runCall![1] as string[];
      expect(args).toContain("ubuntu:22.04");
      expect(args).toContain("1g");
      expect(args).toContain("2.0");
    });

    it("runs setup script after container creation", async () => {
      mockDockerFlow({ containerId: "setup-container" });

      const mgr = new SandboxManager(
        createConfig({ setupScript: "apt-get update" }),
        { logger: createMockLogger() },
      );
      await mgr.execute("echo hello");

      // Find exec calls — one for setup, one for the actual command
      const execCalls = mockExecFile.mock.calls.filter(
        (c) => (c[1] as string[])?.[0] === "exec",
      );
      expect(execCalls.length).toBe(2);

      // First exec = setup script
      const setupArgs = execCalls[0][1] as string[];
      expect(setupArgs).toContain("setup-container");
      expect(setupArgs).toContain("apt-get update");
    });

    it("attempts stale container recovery before docker run", async () => {
      mockDockerFlow();

      const mgr = new SandboxManager(createConfig());
      await mgr.execute("echo hello");

      // docker rm -f should be called before docker run
      const rmCall = mockExecFile.mock.calls.find(
        (c) => (c[1] as string[])?.[0] === "rm",
      );
      expect(rmCall).toBeDefined();
      const rmArgs = rmCall![1] as string[];
      expect(rmArgs).toContain("-f");
    });

    it("reuses existing container for same session", async () => {
      mockDockerFlow({ containerId: "reused-container" });

      const mgr = new SandboxManager(createConfig(), {
        logger: createMockLogger(),
      });
      await mgr.execute("echo first", { sessionId: "same" });
      await mgr.execute("echo second", { sessionId: "same" });

      // Only one docker run call
      const runCalls = mockExecFile.mock.calls.filter(
        (c) => (c[1] as string[])?.[0] === "run",
      );
      expect(runCalls.length).toBe(1);
    });

    it("coalesces concurrent getContainer calls (race condition prevention)", async () => {
      mockDockerFlow({ containerId: "coalesced" });

      const mgr = new SandboxManager(createConfig(), {
        logger: createMockLogger(),
      });

      // Launch two execute calls concurrently with the same session
      const [r1, r2] = await Promise.all([
        mgr.execute("echo a", { sessionId: "race" }),
        mgr.execute("echo b", { sessionId: "race" }),
      ]);

      // Both should succeed
      expect(r1.exitCode).toBe(0);
      expect(r2.exitCode).toBe(0);

      // Only one docker run
      const runCalls = mockExecFile.mock.calls.filter(
        (c) => (c[1] as string[])?.[0] === "run",
      );
      expect(runCalls.length).toBe(1);
    });

    it("uses correct container naming for session scope", async () => {
      mockDockerFlow();

      const mgr = new SandboxManager(createConfig({ scope: "session" }));
      await mgr.execute("echo hi", { sessionId: "my-session" });

      const runCall = mockExecFile.mock.calls.find(
        (c) => (c[1] as string[])?.[0] === "run",
      );
      const args = runCall![1] as string[];
      expect(args).toContain(`${CONTAINER_PREFIX}-my-session`);
    });

    it("uses correct container naming for agent scope", async () => {
      mockDockerFlow();

      const mgr = new SandboxManager(createConfig({ scope: "agent" }));
      await mgr.execute("echo hi", { sessionId: "agent-1" });

      const runCall = mockExecFile.mock.calls.find(
        (c) => (c[1] as string[])?.[0] === "run",
      );
      const args = runCall![1] as string[];
      expect(args).toContain(`${CONTAINER_PREFIX}-agent-agent-1`);
    });

    it("uses correct container naming for shared scope", async () => {
      mockDockerFlow();

      const mgr = new SandboxManager(createConfig({ scope: "shared" }));
      await mgr.execute("echo hi", { sessionId: "any-session" });

      const runCall = mockExecFile.mock.calls.find(
        (c) => (c[1] as string[])?.[0] === "run",
      );
      const args = runCall![1] as string[];
      expect(args).toContain(`${CONTAINER_PREFIX}-shared`);
    });
  });

  // ==========================================================================
  // execute()
  // ==========================================================================

  describe("execute", () => {
    it("returns stdout, stderr, exitCode 0 on success", async () => {
      mockDockerFlow({ execStdout: "hello world\n", execStderr: "" });

      const mgr = new SandboxManager(createConfig(), {
        logger: createMockLogger(),
      });
      const result = await mgr.execute("echo hello world");

      expect(result.stdout).toBe("hello world\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.truncated).toBe(false);
    });

    it("returns non-zero exit code without throwing", async () => {
      mockDockerFlow({
        execError: { code: 1 },
        execStdout: "",
        execStderr: "not found\n",
      });

      const mgr = new SandboxManager(createConfig(), {
        logger: createMockLogger(),
      });
      const result = await mgr.execute("false");

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe("not found\n");
      expect(result.truncated).toBe(false);
    });

    it("forwards env vars via --env flags", async () => {
      mockDockerFlow({ execStdout: "bar" });

      const mgr = new SandboxManager(createConfig(), {
        logger: createMockLogger(),
      });
      await mgr.execute("echo $FOO", { env: { FOO: "bar", BAZ: "qux" } });

      const execCall = mockExecFile.mock.calls.find((c) => {
        const args = c[1] as string[];
        return args?.[0] === "exec" && args.includes("echo $FOO");
      });
      expect(execCall).toBeDefined();
      const args = execCall![1] as string[];
      expect(args).toContain("--env");
      expect(args).toContain("FOO=bar");
      expect(args).toContain("BAZ=qux");
    });

    it("forwards cwd via --workdir flag", async () => {
      mockDockerFlow();

      const mgr = new SandboxManager(createConfig(), {
        logger: createMockLogger(),
      });
      await mgr.execute("ls", { cwd: "/workspace/src" });

      const execCall = mockExecFile.mock.calls.find((c) => {
        const args = c[1] as string[];
        return args?.[0] === "exec" && args.includes("ls");
      });
      const args = execCall![1] as string[];
      expect(args).toContain("--workdir");
      expect(args).toContain("/workspace/src");
    });

    it("reports truncation when maxBuffer is exceeded", async () => {
      mockDockerFlow({
        execError: {
          message: "stdout maxBuffer length exceeded",
          killed: true,
          code: undefined,
        },
        execStdout: "partial output",
        execStderr: "",
      });

      const mgr = new SandboxManager(createConfig(), {
        logger: createMockLogger(),
      });
      const result = await mgr.execute("cat /dev/urandom");

      expect(result.truncated).toBe(true);
      expect(result.stdout).toBe("partial output");
    });

    it("uses default sessionId when not provided", async () => {
      mockDockerFlow();

      const mgr = new SandboxManager(createConfig({ scope: "session" }));
      await mgr.execute("echo test");

      const runCall = mockExecFile.mock.calls.find(
        (c) => (c[1] as string[])?.[0] === "run",
      );
      const args = runCall![1] as string[];
      expect(args).toContain(`${CONTAINER_PREFIX}-default`);
    });
  });

  // ==========================================================================
  // destroyContainer / destroyAll / listContainers
  // ==========================================================================

  describe("destroyContainer", () => {
    it("removes tracked container", async () => {
      mockDockerFlow({ containerId: "to-destroy" });

      const mgr = new SandboxManager(createConfig(), {
        logger: createMockLogger(),
      });
      await mgr.execute("echo hi", { sessionId: "sess1" });

      // Reset mocks to track the rm call
      vi.clearAllMocks();
      mockSuccess();

      await mgr.destroyContainer("sess1");

      const rmCall = mockExecFile.mock.calls.find(
        (c) => (c[1] as string[])?.[0] === "rm",
      );
      expect(rmCall).toBeDefined();
      const args = rmCall![1] as string[];
      expect(args).toContain("-f");
      expect(args).toContain("to-destroy");
    });

    it("is idempotent when container does not exist", async () => {
      const mgr = new SandboxManager(createConfig());
      // Should not throw
      await mgr.destroyContainer("nonexistent");
    });
  });

  describe("destroyAll", () => {
    it("destroys all tracked containers", async () => {
      mockDockerFlow({ containerId: "c1" });
      const mgr = new SandboxManager(createConfig({ scope: "session" }), {
        logger: createMockLogger(),
      });
      await mgr.execute("echo 1", { sessionId: "s1" });

      // We can't easily create two containers with different IDs due to the mock,
      // so just verify destroyAll clears the tracked set
      vi.clearAllMocks();
      mockSuccess();

      await mgr.destroyAll();

      const containers = await mgr.listContainers();
      expect(containers).toEqual([]);
    });
  });

  describe("listContainers", () => {
    it("returns empty array when no containers exist", async () => {
      const mgr = new SandboxManager(createConfig());
      expect(await mgr.listContainers()).toEqual([]);
    });

    it("returns container IDs for tracked containers", async () => {
      mockDockerFlow({ containerId: "listed-container" });
      const mgr = new SandboxManager(createConfig(), {
        logger: createMockLogger(),
      });
      await mgr.execute("echo test", { sessionId: "list-test" });

      const containers = await mgr.listContainers();
      expect(containers).toContain("listed-container");
    });
  });

  // ==========================================================================
  // Error classes
  // ==========================================================================

  describe("error classes", () => {
    it("SandboxExecutionError has correct code and properties", () => {
      const cause = new Error("permission denied");
      const err = new SandboxExecutionError("rm -rf /", cause);

      expect(err).toBeInstanceOf(SandboxExecutionError);
      expect(err.code).toBe(RuntimeErrorCodes.SANDBOX_EXECUTION_ERROR);
      expect(err.command).toBe("rm -rf /");
      expect(err.cause).toBe(cause);
      expect(err.name).toBe("SandboxExecutionError");
      expect(err.message).toContain("rm -rf /");
      expect(err.message).toContain("permission denied");
    });

    it("SandboxUnavailableError has correct code", () => {
      const err = new SandboxUnavailableError(new Error("daemon offline"));

      expect(err).toBeInstanceOf(SandboxUnavailableError);
      expect(err.code).toBe(RuntimeErrorCodes.SANDBOX_UNAVAILABLE);
      expect(err.name).toBe("SandboxUnavailableError");
      expect(err.message).toContain("daemon offline");
    });

    it("SandboxUnavailableError works without cause", () => {
      const err = new SandboxUnavailableError();
      expect(err.message).toBe("Docker is not available");
      expect(err.cause).toBeUndefined();
    });

    it("error classes extend RuntimeError", () => {
      expect(new SandboxExecutionError("cmd", "err")).toBeInstanceOf(
        RuntimeError,
      );
      expect(new SandboxUnavailableError()).toBeInstanceOf(RuntimeError);
    });
  });
});
