import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, stat, mkdir, chmod } from "node:fs/promises";
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
    silentLogger: { debug: noop, info: noop, warn: noop, error: noop, setLevel: noop },
    createLogger: () => ({ debug: noop, info: noop, warn: noop, error: noop, setLevel: noop }),
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
  isCommandUnavailableError,
  sanitizeToolResultTextForTrace,
  resolveTraceLoggingConfig,
  summarizeToolFailureForLog,
  summarizeLLMFailureForSurface,
  formatEvalScriptReply,
  didEvalScriptPass,
  resolveBashToolEnv,
  resolveBashDenyExclusions,
  ensureChromiumCompatShims,
  ensureAgencRuntimeShim,
  DaemonManager,
  generateSystemdUnit,
  generateLaunchdPlist,
} from "./daemon.js";
import type { PidFileInfo } from "./daemon.js";
import { LLMTimeoutError, LLMAuthenticationError } from "../llm/errors.js";
import { loadGatewayConfig } from "./config-watcher.js";
import { WorkspaceValidationError } from "./workspace.js";

// ============================================================================
// Command availability classifier
// ============================================================================

describe("isCommandUnavailableError", () => {
  it("returns true for ENOENT error code", () => {
    const err = Object.assign(new Error("spawn tmux-mcp ENOENT"), {
      code: "ENOENT",
    });
    expect(isCommandUnavailableError(err)).toBe(true);
  });

  it("returns true for command-not-found messages", () => {
    expect(
      isCommandUnavailableError(new Error("/bin/sh: playwright-mcp: command not found")),
    ).toBe(true);
  });

  it("returns false for non-availability errors", () => {
    expect(isCommandUnavailableError(new Error("HTTP 500"))).toBe(false);
  });
});

describe("sanitizeToolResultTextForTrace", () => {
  it("scrubs embedded base64 blobs from mixed markdown tool output", () => {
    const hugeBase64 = "A".repeat(30_000);
    const raw = [
      "### Result",
      '- [Screenshot of viewport](../../tmp/screenshot.png)',
      `{"type":"image","data":"${hugeBase64}"}`,
    ].join("\n");

    const sanitized = sanitizeToolResultTextForTrace(raw);

    expect(sanitized).toContain('"data":"(base64 omitted)"');
    expect(sanitized).not.toContain(hugeBase64.slice(0, 256));
    expect(sanitized.length).toBeLessThan(raw.length);
  });

  it("scrubs inline data:image URLs", () => {
    const raw = `result data:image/png;base64,${"B".repeat(1024)}`;
    const sanitized = sanitizeToolResultTextForTrace(raw);

    expect(sanitized).toContain("(see image)");
    expect(sanitized).not.toContain("data:image/png;base64,");
  });
});

describe("summarizeToolFailureForLog", () => {
  it("summarizes JSON error responses", () => {
    const summary = summarizeToolFailureForLog({
      name: "desktop.bash",
      args: { command: "echo test" },
      result: JSON.stringify({ error: "fetch failed" }),
      isError: true,
      durationMs: 12,
    });

    expect(summary).not.toBeNull();
    expect(summary?.name).toBe("desktop.bash");
    expect(summary?.error).toContain("fetch failed");
    expect(summary?.args).toMatchObject({ command: "echo test" });
  });

  it("summarizes non-zero exitCode responses", () => {
    const summary = summarizeToolFailureForLog({
      name: "desktop.bash",
      args: { command: "npm run build" },
      result: JSON.stringify({ exitCode: 1, stderr: "npm ERR!" }),
      isError: false,
      durationMs: 85,
    });

    expect(summary).not.toBeNull();
    expect(summary?.error).toContain("exitCode 1");
    expect(summary?.error).toContain("npm ERR!");
  });

  it("returns null for successful tool output", () => {
    const summary = summarizeToolFailureForLog({
      name: "desktop.bash",
      args: { command: "echo ok" },
      result: JSON.stringify({ stdout: "ok\n", exitCode: 0 }),
      isError: false,
      durationMs: 5,
    });

    expect(summary).toBeNull();
  });
});

describe("summarizeLLMFailureForSurface", () => {
  it("uses annotated stop reason when present", () => {
    const err = new Error("provider blew up") as Error & {
      stopReason?: string;
      stopReasonDetail?: string;
    };
    err.stopReason = "timeout";
    err.stopReasonDetail = "tool follow-up timed out";

    const summary = summarizeLLMFailureForSurface(err);
    expect(summary.stopReason).toBe("timeout");
    expect(summary.stopReasonDetail).toBe("tool follow-up timed out");
    expect(summary.userMessage).toContain("Error (timeout)");
  });

  it("classifies unannotated errors into canonical stop reasons", () => {
    const timeout = summarizeLLMFailureForSurface(
      new LLMTimeoutError("grok", 1000),
    );
    expect(timeout.stopReason).toBe("timeout");

    const auth = summarizeLLMFailureForSurface(
      new LLMAuthenticationError("grok", 401),
    );
    expect(auth.stopReason).toBe("authentication_error");
  });
});

describe("formatEvalScriptReply", () => {
  it("formats successful eval runs", () => {
    const message = formatEvalScriptReply({
      exitCode: 0,
      stdout: "all good",
      stderr: "",
      timedOut: false,
      durationMs: 321,
    });

    expect(message).toContain("passed in 321ms");
    expect(message).toContain("stdout:");
    expect(message).toContain("all good");
  });

  it("formats timed out eval runs", () => {
    const message = formatEvalScriptReply({
      exitCode: null,
      stdout: "",
      stderr: "killed",
      timedOut: true,
      durationMs: 600000,
    });

    expect(message).toContain("timed out");
    expect(message).toContain("stderr:");
    expect(message).toContain("killed");
  });

  it("formats failed eval runs with exit code", () => {
    const message = formatEvalScriptReply({
      exitCode: 1,
      stdout: "partial output",
      stderr: "assertion failed",
      timedOut: false,
      durationMs: 913,
    });

    expect(message).toContain("failed (exit 1)");
    expect(message).toContain("stderr:");
    expect(message).toContain("assertion failed");
    expect(message).toContain("stdout:");
  });
});

describe("didEvalScriptPass", () => {
  it("returns true only when stdout reports Overall: pass", () => {
    const pass = didEvalScriptPass({
      exitCode: 0,
      stdout: "Overall: pass",
      stderr: "",
      timedOut: false,
      durationMs: 42,
    });
    expect(pass).toBe(true);
  });

  it("returns false for missing or non-pass overall markers", () => {
    const missing = didEvalScriptPass({
      exitCode: 0,
      stdout: "Overall: undefined",
      stderr: "",
      timedOut: false,
      durationMs: 42,
    });
    expect(missing).toBe(false);

    const fail = didEvalScriptPass({
      exitCode: 0,
      stdout: "Overall: fail",
      stderr: "",
      timedOut: false,
      durationMs: 42,
    });
    expect(fail).toBe(false);
  });

  it("returns false when process exit code is non-zero", () => {
    const failed = didEvalScriptPass({
      exitCode: 1,
      stdout: "Overall: pass",
      stderr: "failed",
      timedOut: false,
      durationMs: 42,
    });
    expect(failed).toBe(false);
  });
});

describe("resolveTraceLoggingConfig", () => {
  it("returns disabled defaults when trace logging is not configured", () => {
    const resolved = resolveTraceLoggingConfig(undefined);
    expect(resolved.enabled).toBe(false);
    expect(resolved.includeHistory).toBe(true);
    expect(resolved.includeSystemPrompt).toBe(true);
    expect(resolved.includeToolArgs).toBe(true);
    expect(resolved.includeToolResults).toBe(true);
    expect(resolved.maxChars).toBe(20_000);
  });

  it("applies configured values and maxChars bounds", () => {
    const low = resolveTraceLoggingConfig({
      trace: { enabled: true, maxChars: 10 },
    });
    expect(low.enabled).toBe(true);
    expect(low.maxChars).toBe(256);

    const high = resolveTraceLoggingConfig({
      trace: { enabled: true, maxChars: 9_999_999 },
    });
    expect(high.maxChars).toBe(200_000);
  });
});

describe("resolveBashToolEnv", () => {
  const hostEnv = {
    PATH: "/usr/bin:/bin",
    HOME: "/home/tester",
    USER: "tester",
    SHELL: "/bin/zsh",
    LANG: "en_US.UTF-8",
    TERM: "xterm-256color",
    SOLANA_RPC_URL: "https://rpc.example.com",
    DOCKER_HOST: "unix:///var/run/docker.sock",
    CARGO_HOME: "/home/tester/.cargo",
    GOPATH: "/home/tester/go",
    DISPLAY: ":0",
    GITHUB_TOKEN: "ghs_secret",
    GH_TOKEN: "ghp_secret",
    NPM_TOKEN: "npm_secret",
  } as NodeJS.ProcessEnv;

  it("never forwards token-like keys by default", () => {
    const env = resolveBashToolEnv({ desktop: { enabled: true } }, hostEnv);
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.NPM_TOKEN).toBeUndefined();
  });

  it("includes desktop runtime keys only when desktop mode is enabled", () => {
    const desktopEnv = resolveBashToolEnv({ desktop: { enabled: true } }, hostEnv);
    expect(desktopEnv.DOCKER_HOST).toBe("unix:///var/run/docker.sock");
    expect(desktopEnv.CARGO_HOME).toBe("/home/tester/.cargo");
    expect(desktopEnv.GOPATH).toBe("/home/tester/go");
    expect(desktopEnv.DISPLAY).toBe(":0");

    const nonDesktopEnv = resolveBashToolEnv({ desktop: { enabled: false } }, hostEnv);
    expect(nonDesktopEnv.DOCKER_HOST).toBeUndefined();
    expect(nonDesktopEnv.CARGO_HOME).toBeUndefined();
    expect(nonDesktopEnv.GOPATH).toBeUndefined();
    expect(nonDesktopEnv.DISPLAY).toBeUndefined();
  });
});

describe("resolveBashDenyExclusions", () => {
  it("includes Linux desktop workflow exclusions", () => {
    const exclusions = resolveBashDenyExclusions(
      { desktop: { enabled: true } },
      "linux",
    );
    expect(exclusions).toEqual([
      "killall",
      "pkill",
      "gdb",
      "curl",
      "wget",
      "node",
      "nodejs",
    ]);
  });

  it("keeps desktop-only exclusions off for non-desktop Linux", () => {
    const exclusions = resolveBashDenyExclusions(
      { desktop: { enabled: false } },
      "linux",
    );
    expect(exclusions).toBeUndefined();
  });

  it("preserves mac desktop exclusions", () => {
    const exclusions = resolveBashDenyExclusions(
      { desktop: { enabled: true } },
      "darwin",
    );
    expect(exclusions).toEqual(["killall", "pkill", "curl", "wget"]);
  });
});

describe("ensureChromiumCompatShims", () => {
  it("creates chromium and chromium-browser shims when only google-chrome exists", async () => {
    const tempHome = await mkdtemp(join(tmpdir(), "agenc-chromium-shim-"));
    try {
      const fakeBin = join(tempHome, "fake-bin");
      await mkdir(fakeBin, { recursive: true });

      const chromePath = join(fakeBin, "google-chrome");
      await writeFile(
        chromePath,
        "#!/usr/bin/env bash\nexit 0\n",
        "utf-8",
      );
      await chmod(chromePath, 0o755);

      const shimDir = await ensureChromiumCompatShims(
        { desktop: { enabled: true } },
        fakeBin,
        undefined,
        "linux",
        tempHome,
      );

      expect(shimDir).toBe(join(tempHome, ".agenc", "bin"));

      const chromiumShim = await readFile(join(shimDir!, "chromium"), "utf-8");
      const chromiumBrowserShim = await readFile(
        join(shimDir!, "chromium-browser"),
        "utf-8",
      );

      expect(chromiumShim).toContain(`exec "${chromePath}" "$@"`);
      expect(chromiumBrowserShim).toContain(`exec "${chromePath}" "$@"`);
    } finally {
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  it("does not create shims when chromium commands already exist", async () => {
    const tempHome = await mkdtemp(join(tmpdir(), "agenc-chromium-shim-"));
    try {
      const fakeBin = join(tempHome, "fake-bin");
      await mkdir(fakeBin, { recursive: true });

      for (const cmd of ["chromium", "chromium-browser"]) {
        const cmdPath = join(fakeBin, cmd);
        await writeFile(cmdPath, "#!/usr/bin/env bash\nexit 0\n", "utf-8");
        await chmod(cmdPath, 0o755);
      }

      const shimDir = await ensureChromiumCompatShims(
        { desktop: { enabled: true } },
        fakeBin,
        undefined,
        "linux",
        tempHome,
      );
      expect(shimDir).toBeUndefined();
    } finally {
      await rm(tempHome, { recursive: true, force: true });
    }
  });
});

describe("ensureAgencRuntimeShim", () => {
  it("creates agenc-runtime shim when runtime dist binary exists", async () => {
    const tempHome = await mkdtemp(join(tmpdir(), "agenc-runtime-shim-"));
    try {
      const fakeRepoRoot = join(tempHome, "repo");
      const runtimeDistBin = join(fakeRepoRoot, "runtime", "dist", "bin");
      await mkdir(runtimeDistBin, { recursive: true });

      const runtimeEntry = join(runtimeDistBin, "agenc-runtime.js");
      await writeFile(
        runtimeEntry,
        "#!/usr/bin/env node\nconsole.log('ok')\n",
        "utf-8",
      );
      await chmod(runtimeEntry, 0o755);

      const shimDir = await ensureAgencRuntimeShim(
        { desktop: { enabled: true } },
        "/usr/bin:/bin",
        undefined,
        tempHome,
        fakeRepoRoot,
        join(tempHome, "nonexistent", "daemon.js"),
      );

      expect(shimDir).toBe(join(tempHome, ".agenc", "bin"));
      const shim = await readFile(join(shimDir!, "agenc-runtime"), "utf-8");
      expect(shim).toContain(`exec "${runtimeEntry}" "$@"`);
    } finally {
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  it("does not create shim when runtime binary cannot be resolved", async () => {
    const tempHome = await mkdtemp(join(tmpdir(), "agenc-runtime-shim-"));
    try {
      const shimDir = await ensureAgencRuntimeShim(
        { desktop: { enabled: true } },
        "/usr/bin:/bin",
        undefined,
        tempHome,
        join(tempHome, "empty-repo"),
        join(tempHome, "nonexistent", "daemon.js"),
      );
      expect(shimDir).toBeUndefined();
    } finally {
      await rm(tempHome, { recursive: true, force: true });
    }
  });
});

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
    vi.mocked(loadGatewayConfig).mockResolvedValue({
      gateway: { port: 9000 },
      agent: { name: "test" },
      connection: { rpcUrl: "http://localhost:8899" },
    } as any);
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

  it("enables sub-agent orchestration by default when llm.subagents is omitted", async () => {
    const pidPath = join(tempDir, "default-subagents.pid");
    const dm = new DaemonManager({ configPath: "/tmp/config.json", pidPath });
    vi.spyOn(dm, "setupSignalHandlers").mockImplementation(() => {});

    await dm.start();

    expect((dm as any)._subAgentRuntimeConfig).toMatchObject({
      enabled: true,
    });
    expect((dm as any)._subAgentManager).not.toBeNull();
    expect((dm as any)._sessionIsolationManager).not.toBeNull();

    await dm.stop();
  });

  it("start initializes sub-agent infrastructure when llm.subagents is enabled", async () => {
    vi.mocked(loadGatewayConfig).mockResolvedValueOnce({
      gateway: { port: 9000 },
      agent: { name: "test" },
      connection: { rpcUrl: "http://localhost:8899" },
      llm: {
        provider: "grok",
        subagents: {
          enabled: true,
          mode: "hybrid",
          maxConcurrent: 5,
          maxDepth: 3,
          maxFanoutPerTurn: 4,
          maxTotalSubagentsPerRequest: 12,
          maxCumulativeToolCallsPerRequestTree: 120,
          maxCumulativeTokensPerRequestTree: 180_000,
          defaultTimeoutMs: 30_000,
          spawnDecisionThreshold: 0.7,
          forceVerifier: true,
          allowParallelSubtasks: false,
          childToolAllowlistStrategy: "explicit_only",
          fallbackBehavior: "fail_request",
        },
      },
    } as any);

    const pidPath = join(tempDir, "subagent.pid");
    const dm = new DaemonManager({ configPath: "/tmp/config.json", pidPath });
    vi.spyOn(dm, "setupSignalHandlers").mockImplementation(() => {});

    await dm.start();

    expect((dm as any)._sessionIsolationManager).not.toBeNull();
    expect((dm as any)._subAgentManager).not.toBeNull();
    expect((dm as any)._subAgentRuntimeConfig).toMatchObject({
      enabled: true,
      mode: "hybrid",
      maxConcurrent: 5,
      maxDepth: 3,
      maxFanoutPerTurn: 4,
      maxTotalSubagentsPerRequest: 12,
      maxCumulativeToolCallsPerRequestTree: 120,
      maxCumulativeTokensPerRequestTree: 180_000,
      defaultTimeoutMs: 30_000,
    });

    await dm.stop();
  });

  it("registers execute_with_agent in the runtime tool registry", async () => {
    const dm = new DaemonManager({ configPath: "/tmp/config.json" });
    const registry = await (dm as any).createToolRegistry({
      desktop: { enabled: false },
    });

    expect(registry.listNames()).toContain("execute_with_agent");
    const llmToolNames = registry
      .toLLMTools()
      .map((tool: { function: { name: string } }) => tool.function.name);
    expect(llmToolNames).toContain("execute_with_agent");

    const directResult = await registry.createToolHandler()(
      "execute_with_agent",
      { task: "test" },
    );
    expect(directResult).toContain("session-scoped tool handler");
  });

  it("hotSwapLLMProvider refreshes the cached provider list", async () => {
    const dm = new DaemonManager({ configPath: "/tmp/config.json" });
    const providers = [
      {
        name: "fresh-grok",
        chat: vi.fn(async () => ({
          content: "ok",
          finishReason: "stop",
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        })),
      },
    ] as any;

    (dm as any)._llmTools = [];
    (dm as any)._baseToolHandler = vi.fn(async () => "");
    vi.spyOn(dm as any, "createLLMProviders").mockResolvedValue(providers);
    vi.spyOn(dm as any, "resolveLlmContextWindowTokens").mockResolvedValue(120_000);

    await (dm as any).hotSwapLLMProvider(
      { llm: { provider: "grok" } },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );

    expect((dm as any)._llmProviders).toBe(providers);
    expect((dm as any)._chatExecutor).not.toBeNull();
  });

  it("registers marketplace and social tools when enabled", async () => {
    const dm = new DaemonManager({ configPath: "/tmp/config.json" });
    const registry = await (dm as any).createToolRegistry({
      desktop: { enabled: false },
      marketplace: { enabled: true },
      social: { enabled: true },
    });

    expect(registry.listNames()).toContain("marketplace.createService");
    expect(registry.listNames()).toContain("social.searchAgents");

    const toolHandler = registry.createToolHandler();
    const marketplaceResult = await toolHandler("marketplace.createService", {
      serviceId: "svc-1",
      title: "Test service",
      budget: "1",
    });
    const socialResult = await toolHandler("social.searchAgents", {});

    expect(marketplaceResult).toContain("Marketplace not enabled");
    expect(socialResult).toContain("Social module not enabled");
  });

  it("auto-creates missing default workspace for sub-agent isolation", async () => {
    const dm = new DaemonManager({ configPath: "/tmp/config.json" });
    const workspaceManager = {
      basePath: "/tmp/agenc-workspace-test",
      getDefault: vi.fn(() => "default"),
      load: vi.fn(async () => {
        throw new WorkspaceValidationError(
          "path",
          "Workspace directory not found: /tmp/agenc-workspace-test/default",
        );
      }),
      createWorkspace: vi.fn(async () => ({})),
    };

    await (dm as any).ensureSubAgentDefaultWorkspace(workspaceManager as any);

    expect(workspaceManager.getDefault).toHaveBeenCalledTimes(1);
    expect(workspaceManager.load).toHaveBeenCalledWith("default");
    expect(workspaceManager.createWorkspace).toHaveBeenCalledWith("default");
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

  it("stop destroys sub-agent manager lifecycle", async () => {
    vi.mocked(loadGatewayConfig).mockResolvedValueOnce({
      gateway: { port: 9000 },
      agent: { name: "test" },
      connection: { rpcUrl: "http://localhost:8899" },
      llm: {
        provider: "grok",
        subagents: { enabled: true },
      },
    } as any);

    const pidPath = join(tempDir, "subagent-stop.pid");
    const dm = new DaemonManager({ configPath: "/tmp/config.json", pidPath });
    vi.spyOn(dm, "setupSignalHandlers").mockImplementation(() => {});

    await dm.start();

    const subAgentManager = (dm as any)._subAgentManager as {
      destroyAll: () => Promise<void>;
    };
    const destroyAllSpy = vi.spyOn(subAgentManager, "destroyAll");

    await dm.stop();

    expect(destroyAllSpy).toHaveBeenCalledTimes(1);
    expect((dm as any)._subAgentManager).toBeNull();
    expect((dm as any)._sessionIsolationManager).toBeNull();
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

  it("logs sub-agent startup diagnostics with hard caps", async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      setLevel: vi.fn(),
    };

    vi.mocked(loadGatewayConfig).mockResolvedValueOnce({
      gateway: { port: 9000 },
      agent: { name: "test" },
      connection: { rpcUrl: "http://localhost:8899" },
      llm: {
        provider: "grok",
        subagents: {
          enabled: true,
          maxConcurrent: 7,
        },
      },
    } as any);

    const pidPath = join(tempDir, "subagent-diag.pid");
    const dm = new DaemonManager({
      configPath: "/tmp/config.json",
      pidPath,
      logger: logger as any,
    });
    vi.spyOn(dm, "setupSignalHandlers").mockImplementation(() => {});

    await dm.start();
    await dm.stop();

    const diagnosticCall = logger.info.mock.calls.find(
      (call) => call[0] === "Sub-agent orchestration config",
    );
    expect(diagnosticCall).toBeDefined();
    expect(diagnosticCall?.[1]).toMatchObject({
      enabled: true,
      maxConcurrent: 7,
      hardCaps: {
        maxConcurrent: 64,
        maxDepth: 16,
        maxFanoutPerTurn: 64,
        maxTotalSubagentsPerRequest: 1024,
        defaultTimeoutMs: 3_600_000,
      },
    });
  });

  it("start wires delegation policy/verifier/lifecycle dependencies", async () => {
    vi.mocked(loadGatewayConfig).mockResolvedValueOnce({
      gateway: { port: 9000 },
      agent: { name: "test" },
      connection: { rpcUrl: "http://localhost:8899" },
      llm: {
        provider: "grok",
        subagents: { enabled: true, spawnDecisionThreshold: 0.61 },
      },
    } as any);

    const pidPath = join(tempDir, "subagent-delegation-deps.pid");
    const dm = new DaemonManager({ configPath: "/tmp/config.json", pidPath });
    vi.spyOn(dm, "setupSignalHandlers").mockImplementation(() => {});

    await dm.start();

    expect(dm.subAgentRuntimeConfig?.enabled).toBe(true);
    expect(dm.delegationPolicyEngine).not.toBeNull();
    expect(dm.delegationVerifierService).not.toBeNull();
    expect(dm.subAgentLifecycleEmitter).not.toBeNull();
    expect(dm.delegationPolicyEngine?.snapshot().spawnDecisionThreshold).toBe(0.61);

    await dm.stop();
  });

  it("resolves delegation controls for aggressiveness, handoff confidence, provider strategy, and hard blocks", async () => {
    vi.mocked(loadGatewayConfig).mockResolvedValueOnce({
      gateway: { port: 9000 },
      agent: { name: "test" },
      connection: { rpcUrl: "http://localhost:8899" },
      llm: {
        provider: "grok",
        subagents: {
          enabled: true,
          mode: "handoff",
          spawnDecisionThreshold: 0.65,
          delegationAggressiveness: "conservative",
          handoffMinPlannerConfidence: 0.9,
          childProviderStrategy: "capability_matched",
          hardBlockedTaskClasses: [
            "wallet_transfer",
            "stake_or_rewards",
          ],
        },
      },
    } as any);

    const pidPath = join(tempDir, "subagent-controls.pid");
    const dm = new DaemonManager({ configPath: "/tmp/config.json", pidPath });
    vi.spyOn(dm, "setupSignalHandlers").mockImplementation(() => {});

    await dm.start();

    expect(dm.subAgentRuntimeConfig?.mode).toBe("handoff");
    expect(dm.subAgentRuntimeConfig?.delegationAggressiveness).toBe(
      "conservative",
    );
    expect(dm.subAgentRuntimeConfig?.handoffMinPlannerConfidence).toBe(0.9);
    expect(dm.subAgentRuntimeConfig?.childProviderStrategy).toBe(
      "capability_matched",
    );
    expect(dm.subAgentRuntimeConfig?.hardBlockedTaskClasses).toEqual([
      "wallet_transfer",
      "stake_or_rewards",
    ]);
    expect(dm.subAgentRuntimeConfig?.baseSpawnDecisionThreshold).toBe(0.65);
    expect(dm.delegationPolicyEngine?.snapshot().spawnDecisionThreshold).toBe(
      0.77,
    );

    await dm.stop();
  });

  it("start configures delegation learning runtime (trajectory sink + bandit tuner)", async () => {
    vi.mocked(loadGatewayConfig).mockResolvedValueOnce({
      gateway: { port: 9000 },
      agent: { name: "test" },
      connection: { rpcUrl: "http://localhost:8899" },
      llm: {
        provider: "grok",
        subagents: {
          enabled: true,
          policyLearning: {
            enabled: true,
            epsilon: 0.2,
            explorationBudget: 123,
            minSamplesPerArm: 3,
            ucbExplorationScale: 1.5,
            arms: [
              { id: "conservative", thresholdOffset: 0.1 },
              { id: "balanced", thresholdOffset: 0 },
              { id: "aggressive", thresholdOffset: -0.1 },
            ],
          },
        },
      },
    } as any);

    const pidPath = join(tempDir, "subagent-learning.pid");
    const dm = new DaemonManager({ configPath: "/tmp/config.json", pidPath });
    vi.spyOn(dm, "setupSignalHandlers").mockImplementation(() => {});

    await dm.start();

    expect(dm.delegationTrajectorySink).not.toBeNull();
    expect(dm.delegationBanditTuner).not.toBeNull();
    expect(dm.subAgentRuntimeConfig?.policyLearningEnabled).toBe(true);
    expect(dm.subAgentRuntimeConfig?.policyLearningExplorationBudget).toBe(123);
    expect(dm.subAgentRuntimeConfig?.policyLearningMinSamplesPerArm).toBe(3);
    expect(dm.subAgentRuntimeConfig?.policyLearningUcbExplorationScale).toBe(1.5);
    expect(dm.subAgentRuntimeConfig?.policyLearningArms).toHaveLength(3);

    await dm.stop();
  });

  it("reconfigures delegation thresholds in place without recreating manager", async () => {
    vi.mocked(loadGatewayConfig).mockResolvedValueOnce({
      gateway: { port: 9000 },
      agent: { name: "test" },
      connection: { rpcUrl: "http://localhost:8899" },
      llm: {
        provider: "grok",
        subagents: {
          enabled: true,
          maxConcurrent: 4,
          spawnDecisionThreshold: 0.55,
          forceVerifier: false,
        },
      },
    } as any);

    const pidPath = join(tempDir, "subagent-threshold-reload.pid");
    const dm = new DaemonManager({ configPath: "/tmp/config.json", pidPath });
    vi.spyOn(dm, "setupSignalHandlers").mockImplementation(() => {});

    await dm.start();

    const managerBefore = (dm as any)._subAgentManager;
    const policyBefore = dm.delegationPolicyEngine;
    const verifierBefore = dm.delegationVerifierService;

    await (dm as any).configureSubAgentInfrastructure({
      gateway: { port: 9000 },
      agent: { name: "test" },
      connection: { rpcUrl: "http://localhost:8899" },
      llm: {
        provider: "grok",
        subagents: {
          enabled: true,
          maxConcurrent: 4,
          spawnDecisionThreshold: 0.91,
          forceVerifier: true,
          maxDepth: 10,
          maxFanoutPerTurn: 12,
          maxTotalSubagentsPerRequest: 24,
          maxCumulativeToolCallsPerRequestTree: 333,
          maxCumulativeTokensPerRequestTree: 444_000,
        },
      },
    });

    expect((dm as any)._subAgentManager).toBe(managerBefore);
    expect(dm.delegationPolicyEngine).toBe(policyBefore);
    expect(dm.delegationVerifierService).toBe(verifierBefore);
    expect(dm.delegationPolicyEngine?.snapshot().spawnDecisionThreshold).toBe(0.91);
    expect(dm.delegationVerifierService?.snapshot().forceVerifier).toBe(true);
    expect(dm.subAgentRuntimeConfig?.maxDepth).toBe(10);
    expect(dm.subAgentRuntimeConfig?.maxFanoutPerTurn).toBe(12);
    expect(dm.subAgentRuntimeConfig?.maxCumulativeToolCallsPerRequestTree).toBe(
      333,
    );
    expect(dm.subAgentRuntimeConfig?.maxCumulativeTokensPerRequestTree).toBe(
      444_000,
    );

    await dm.stop();
  });

  it("applies runtime delegation aggressiveness override to policy threshold", async () => {
    vi.mocked(loadGatewayConfig).mockResolvedValueOnce({
      gateway: { port: 9000 },
      agent: { name: "test" },
      connection: { rpcUrl: "http://localhost:8899" },
      llm: {
        provider: "grok",
        subagents: {
          enabled: true,
          spawnDecisionThreshold: 0.6,
          delegationAggressiveness: "balanced",
        },
      },
    } as any);

    const pidPath = join(tempDir, "subagent-override.pid");
    const dm = new DaemonManager({ configPath: "/tmp/config.json", pidPath });
    vi.spyOn(dm, "setupSignalHandlers").mockImplementation(() => {});

    await dm.start();
    expect(dm.delegationPolicyEngine?.snapshot().spawnDecisionThreshold).toBe(0.6);

    (dm as any)._delegationAggressivenessOverride = "aggressive";
    (dm as any).configureDelegationRuntimeServices(dm.subAgentRuntimeConfig);
    expect(dm.delegationPolicyEngine?.snapshot().spawnDecisionThreshold).toBe(0.48);

    (dm as any)._delegationAggressivenessOverride = null;
    (dm as any).configureDelegationRuntimeServices(dm.subAgentRuntimeConfig);
    expect(dm.delegationPolicyEngine?.snapshot().spawnDecisionThreshold).toBe(0.6);

    await dm.stop();
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

  it("relays subagent lifecycle events to parent chat/activity with trace correlation and sanitized payloads", () => {
    const dm = new DaemonManager({ configPath: "/tmp/config.json" });
    const webChat = {
      pushToSession: vi.fn(),
      broadcastEvent: vi.fn(),
    } as unknown as {
      pushToSession: (sessionId: string, response: unknown) => void;
      broadcastEvent: (eventType: string, data: Record<string, unknown>) => void;
    };
    const base64Image = `data:image/png;base64,${"A".repeat(2048)}`;

    (dm as any)._activeSessionTraceIds.set("session-parent", "trace-parent");
    (dm as any)._subAgentManager = {
      getInfo: vi.fn().mockReturnValue({
        sessionId: "subagent:child",
        parentSessionId: "session-parent",
        status: "running",
        startedAt: 1,
        task: "test",
      }),
    };

    (dm as any).relaySubAgentLifecycleEvent(webChat as any, {
      type: "subagents.tool.result",
      timestamp: 1_234,
      sessionId: "subagent:child",
      subagentSessionId: "subagent:child",
      toolName: "desktop.screenshot",
      payload: {
        result: base64Image,
        durationMs: 12,
      },
    });

    expect(webChat.pushToSession).toHaveBeenCalledTimes(1);
    const pushPayload = (webChat.pushToSession as any).mock.calls[0][1] as {
      type: string;
      payload: Record<string, unknown>;
    };
    expect(pushPayload.type).toBe("subagents.tool.result");
    expect(pushPayload.payload.sessionId).toBe("session-parent");
    expect(pushPayload.payload.parentSessionId).toBe("session-parent");
    expect(pushPayload.payload.subagentSessionId).toBe("subagent:child");
    expect(typeof pushPayload.payload.traceId).toBe("string");
    expect(pushPayload.payload.parentTraceId).toBe("trace-parent");
    expect(pushPayload.payload.data).toMatchObject({
      durationMs: 12,
      result: {
        artifactType: "image_data_url",
        externalized: true,
      },
    });

    expect(webChat.broadcastEvent).toHaveBeenCalledTimes(1);
    const [eventType, eventData] = (webChat.broadcastEvent as any).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(eventType).toBe("subagents.tool.result");
    expect(eventData.sessionId).toBe("session-parent");
    expect(eventData.subagentSessionId).toBe("subagent:child");
    expect(eventData.parentTraceId).toBe("trace-parent");
    expect(typeof eventData.traceId).toBe("string");
    expect((eventData.result as Record<string, unknown>).artifactType).toBe(
      "image_data_url",
    );
  });

  it("routes delegated approval requests to parent webchat and text channels", async () => {
    const dm = new DaemonManager({ configPath: "/tmp/config.json" });
    const pushToSession = vi.fn();
    (dm as any)._webChatChannel = {
      pushToSession,
      broadcastEvent: vi.fn(),
    };
    const textSend = vi.fn(async () => {});
    (dm as any)._textApprovalDispatchBySession.set("parent-1", {
      channelName: "telegram",
      send: textSend,
    });

    const forwardSpy = vi.spyOn(dm as any, "forwardControlToTextChannel");

    (dm as any).routeSubagentControlResponseToParent({
      parentSessionId: "parent-1",
      subagentSessionId: "subagent:child-1",
      response: {
        type: "approval.request",
        payload: {
          requestId: "req-1",
          action: "system.delete",
          message: "Approval required",
        },
      },
    });

    expect(pushToSession).toHaveBeenCalledWith(
      "parent-1",
      expect.objectContaining({
        type: "approval.request",
        payload: expect.objectContaining({
          requestId: "req-1",
          parentSessionId: "parent-1",
          subagentSessionId: "subagent:child-1",
        }),
      }),
    );
    expect(forwardSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "parent-1",
        channelName: "telegram",
      }),
    );
  });

  it("allows parent sessions on text channels to list and resolve delegated approvals", async () => {
    const dm = new DaemonManager({ configPath: "/tmp/config.json" });
    const resolve = vi.fn();
    const getPending = vi.fn(() => [
      {
        id: "req-parent",
        toolName: "system.delete",
        args: {},
        sessionId: "subagent:child-9",
        parentSessionId: "parent-9",
        subagentSessionId: "subagent:child-9",
        message: "Approval required",
        createdAt: Date.now() - 1_000,
        rule: { tool: "system.delete" },
      },
    ]);
    (dm as any)._approvalEngine = {
      getPending,
      resolve,
    };

    const send = vi.fn(async (_content: string) => {});
    const msgBase = {
      sessionId: "parent-9",
      senderId: "operator-1",
      senderName: "operator",
      channel: "telegram",
      content: "",
    };

    const listed = await (dm as any).handleTextChannelApprovalCommand({
      msg: {
        ...msgBase,
        content: "approve list",
      },
      send,
    });

    expect(listed).toBe(true);
    expect(send).toHaveBeenCalledWith(
      expect.stringContaining("delegated:subagent:child-9"),
    );

    const resolved = await (dm as any).handleTextChannelApprovalCommand({
      msg: {
        ...msgBase,
        content: "approve req-parent yes",
      },
      send,
    });

    expect(resolved).toBe(true);
    expect(resolve).toHaveBeenCalledWith("req-parent", {
      requestId: "req-parent",
      disposition: "yes",
      approvedBy: "operator-1",
    });
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
