import { describe, expect, it, vi, beforeEach } from "vitest";
import { createBashTool, isCommandAllowed } from "./bash.js";
import { DEFAULT_DENY_LIST, DEFAULT_DENY_PREFIXES } from "./types.js";
import type { Logger } from "../../utils/logger.js";

// Mock execFile from node:child_process
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import { execFile } from "node:child_process";

const mockExecFile = vi.mocked(execFile);

function parseContent(result: { content: string }): Record<string, unknown> {
  return JSON.parse(result.content) as Record<string, unknown>;
}

/** Simulate a successful execFile callback. */
function mockSuccess(stdout = "", stderr = "") {
  mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
    (callback as Function)(null, stdout, stderr);
    return {} as ReturnType<typeof execFile>;
  });
}

/** Simulate an error execFile callback. */
function mockError(
  error: Partial<Error & { killed?: boolean; code?: unknown }>,
  stdout = "",
  stderr = "",
) {
  mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
    const err = Object.assign(
      new Error(error.message ?? "command failed"),
      error,
    );
    (callback as Function)(err, stdout, stderr);
    return {} as ReturnType<typeof execFile>;
  });
}

function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("system.bash tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---- Basic execution ----

  it("executes allowed command and returns stdout/stderr/exitCode", async () => {
    const tool = createBashTool();
    mockSuccess("hello world\n", "");

    const result = await tool.execute({
      command: "echo",
      args: ["hello", "world"],
    });
    const parsed = parseContent(result);

    expect(result.isError).toBeUndefined();
    expect(parsed.exitCode).toBe(0);
    expect(parsed.stdout).toBe("hello world\n");
    expect(parsed.stderr).toBe("");
  });

  it("passes command and args to execFile correctly", async () => {
    const tool = createBashTool({ cwd: "/tmp" });
    mockSuccess();

    await tool.execute({ command: "git", args: ["status", "--short"] });

    expect(mockExecFile).toHaveBeenCalledOnce();
    const [cmd, args, opts] = mockExecFile.mock.calls[0];
    expect(cmd).toBe("git");
    expect(args).toEqual(["status", "--short"]);
    expect((opts as Record<string, unknown>).cwd).toBe("/tmp");
    expect((opts as Record<string, unknown>).shell).toBe(false);
  });

  it("returns durationMs and truncated fields", async () => {
    const tool = createBashTool();
    mockSuccess("hello");

    const result = await tool.execute({ command: "echo" });
    const parsed = parseContent(result);

    expect(typeof parsed.durationMs).toBe("number");
    expect(parsed.truncated).toBe(false);
  });

  // ---- Deny list ----

  it("rejects command on default deny list", async () => {
    const tool = createBashTool();

    for (const cmd of DEFAULT_DENY_LIST) {
      const result = await tool.execute({ command: cmd });
      expect(result.isError).toBe(true);
      const parsed = parseContent(result);
      expect(parsed.error).toContain("denied");
    }

    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("rejects command on custom deny list", async () => {
    const tool = createBashTool({ denyList: ["custom-bad"] });

    const result = await tool.execute({ command: "custom-bad" });
    expect(result.isError).toBe(true);
    expect(parseContent(result).error).toContain("denied");
  });

  it("merges custom deny list with default deny list", async () => {
    const tool = createBashTool({ denyList: ["custom-bad"] });

    // Default deny list still works
    const result1 = await tool.execute({ command: "rm" });
    expect(result1.isError).toBe(true);

    // Custom deny list also works
    const result2 = await tool.execute({ command: "custom-bad" });
    expect(result2.isError).toBe(true);
  });

  // ---- Deny list: absolute path bypass prevention ----

  it("blocks /bin/rm via basename check", async () => {
    const tool = createBashTool();

    const result = await tool.execute({
      command: "/bin/rm",
      args: ["-rf", "/"],
    });
    expect(result.isError).toBe(true);
    expect(parseContent(result).error).toContain("denied");
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("blocks /usr/bin/bash via basename check", async () => {
    const tool = createBashTool();

    const result = await tool.execute({
      command: "/usr/bin/bash",
      args: ["-c", "echo test"],
    });
    expect(result.isError).toBe(true);
    expect(parseContent(result).error).toContain("denied");
  });

  it("blocks /usr/local/bin/python3 via basename check", async () => {
    const tool = createBashTool();

    const result = await tool.execute({ command: "/usr/local/bin/python3" });
    expect(result.isError).toBe(true);
    expect(parseContent(result).error).toContain("denied");
  });

  // ---- Shell re-invocation prevention ----

  it("blocks bash, sh, zsh, dash shell invocation", async () => {
    const tool = createBashTool();

    for (const shell of ["bash", "sh", "zsh", "dash"]) {
      const result = await tool.execute({
        command: shell,
        args: ["-c", "echo test"],
      });
      expect(result.isError).toBe(true);
      expect(parseContent(result).error).toContain("denied");
    }

    expect(mockExecFile).not.toHaveBeenCalled();
  });

  // ---- Privilege escalation prevention ----

  it("blocks sudo and su", async () => {
    const tool = createBashTool();

    for (const cmd of ["sudo", "su"]) {
      const result = await tool.execute({ command: cmd, args: ["ls"] });
      expect(result.isError).toBe(true);
      expect(parseContent(result).error).toContain("denied");
    }
  });

  // ---- Download-and-execute prevention ----

  it("blocks curl and wget", async () => {
    const tool = createBashTool();

    for (const cmd of ["curl", "wget"]) {
      const result = await tool.execute({
        command: cmd,
        args: ["https://example.com"],
      });
      expect(result.isError).toBe(true);
      expect(parseContent(result).error).toContain("denied");
    }
  });

  // ---- Environment exfiltration prevention ----

  it("blocks env and printenv", async () => {
    const tool = createBashTool();

    for (const cmd of ["env", "printenv"]) {
      const result = await tool.execute({ command: cmd });
      expect(result.isError).toBe(true);
      expect(parseContent(result).error).toContain("denied");
    }
  });

  // ---- Script interpreter prevention ----

  it("blocks python, node, perl, ruby interpreters", async () => {
    const tool = createBashTool();

    for (const cmd of [
      "python",
      "python3",
      "node",
      "nodejs",
      "perl",
      "ruby",
      "php",
      "lua",
      "deno",
      "bun",
      "tclsh",
    ]) {
      const result = await tool.execute({ command: cmd });
      expect(result.isError).toBe(true);
      expect(parseContent(result).error).toContain("denied");
    }
  });

  // ---- Version-specific interpreter prevention (prefix matching) ----

  it("blocks version-specific python binaries via prefix matching", async () => {
    const tool = createBashTool();

    for (const cmd of [
      "python3.11",
      "python3.12",
      "python2.7",
      "pypy3",
      "pypy",
    ]) {
      const result = await tool.execute({ command: cmd });
      expect(result.isError).toBe(true);
      expect(parseContent(result).error).toContain("denied");
    }

    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("blocks version-specific node/ruby/perl/php/lua via prefix matching", async () => {
    const tool = createBashTool();

    for (const cmd of ["nodejs18", "ruby3.2", "perl5.38", "php8.2", "lua5.4"]) {
      const result = await tool.execute({ command: cmd });
      expect(result.isError).toBe(true);
      expect(parseContent(result).error).toContain("denied");
    }

    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("blocks absolute-path version-specific binaries via prefix matching", async () => {
    const tool = createBashTool();

    const result = await tool.execute({ command: "/usr/bin/python3.11" });
    expect(result.isError).toBe(true);
    expect(parseContent(result).error).toContain("denied");
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  // ---- Command execution wrapper prevention ----

  it("blocks xargs, nohup, and awk", async () => {
    const tool = createBashTool();

    for (const cmd of ["xargs", "nohup", "awk", "gawk", "nawk"]) {
      const result = await tool.execute({ command: cmd });
      expect(result.isError).toBe(true);
      expect(parseContent(result).error).toContain("denied");
    }
  });

  // ---- Network access prevention ----

  it("blocks ssh, scp, sftp, rsync, telnet, socat", async () => {
    const tool = createBashTool();

    for (const cmd of ["ssh", "scp", "sftp", "rsync", "telnet", "socat"]) {
      const result = await tool.execute({ command: cmd });
      expect(result.isError).toBe(true);
      expect(parseContent(result).error).toContain("denied");
    }
  });

  // ---- File writing / system tools prevention ----

  it("blocks tee, install, mount, crontab, at", async () => {
    const tool = createBashTool();

    for (const cmd of ["tee", "install", "mount", "umount", "crontab", "at"]) {
      const result = await tool.execute({ command: cmd });
      expect(result.isError).toBe(true);
      expect(parseContent(result).error).toContain("denied");
    }
  });

  // ---- Debugging tool prevention ----

  it("blocks strace, ltrace, gdb", async () => {
    const tool = createBashTool();

    for (const cmd of ["strace", "ltrace", "gdb"]) {
      const result = await tool.execute({ command: cmd });
      expect(result.isError).toBe(true);
      expect(parseContent(result).error).toContain("denied");
    }
  });

  // ---- Allow list ----

  it("allows command on allow list", async () => {
    const tool = createBashTool({ allowList: ["ls", "cat"] });
    mockSuccess("file.txt\n");

    const result = await tool.execute({ command: "ls" });
    expect(result.isError).toBeUndefined();
    expect(parseContent(result).exitCode).toBe(0);
  });

  it("rejects command not on allow list when allow list is non-empty", async () => {
    const tool = createBashTool({ allowList: ["ls", "cat"] });

    const result = await tool.execute({ command: "git" });
    expect(result.isError).toBe(true);
    expect(parseContent(result).error).toContain("not in the allow list");
  });

  // ---- Deny-over-allow precedence ----

  it("deny list takes precedence over allow list", async () => {
    const tool = createBashTool({ allowList: ["rm", "ls"], denyList: [] });

    const result = await tool.execute({ command: "rm" });
    expect(result.isError).toBe(true);
    expect(parseContent(result).error).toContain("denied");
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  // ---- Environment control ----

  it("passes minimal environment by default (PATH + HOME only)", async () => {
    const tool = createBashTool();
    mockSuccess();

    await tool.execute({ command: "ls" });

    const opts = mockExecFile.mock.calls[0][2] as Record<string, unknown>;
    const passedEnv = opts.env as Record<string, string>;
    expect(passedEnv).toBeDefined();
    expect(passedEnv.PATH).toBeDefined();
    expect(passedEnv.HOME).toBeDefined();
    // Should NOT contain arbitrary env vars from parent process
    const keys = Object.keys(passedEnv);
    expect(keys.length).toBeLessThanOrEqual(2);
  });

  it("uses custom env when provided in config", async () => {
    const tool = createBashTool({
      env: { PATH: "/custom/path", CUSTOM_VAR: "value" },
    });
    mockSuccess();

    await tool.execute({ command: "ls" });

    const opts = mockExecFile.mock.calls[0][2] as Record<string, unknown>;
    const passedEnv = opts.env as Record<string, string>;
    expect(passedEnv.PATH).toBe("/custom/path");
    expect(passedEnv.CUSTOM_VAR).toBe("value");
  });

  // ---- Working directory ----

  it("uses config cwd when no per-call cwd", async () => {
    const tool = createBashTool({ cwd: "/home/test" });
    mockSuccess();

    await tool.execute({ command: "ls" });

    const opts = mockExecFile.mock.calls[0][2] as Record<string, unknown>;
    expect(opts.cwd).toBe("/home/test");
  });

  it("uses per-call cwd override", async () => {
    const tool = createBashTool({ cwd: "/home/test" });
    mockSuccess();

    await tool.execute({ command: "ls", cwd: "/var/log" });

    const opts = mockExecFile.mock.calls[0][2] as Record<string, unknown>;
    expect(opts.cwd).toBe("/var/log");
  });

  it("rejects per-call cwd override when lockCwd is enabled", async () => {
    const tool = createBashTool({ cwd: "/home/test", lockCwd: true });

    const result = await tool.execute({ command: "ls", cwd: "/var/log" });
    expect(result.isError).toBe(true);
    expect(parseContent(result).error).toContain("lockCwd");
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("allows execution with default cwd when lockCwd is enabled and no per-call override", async () => {
    const tool = createBashTool({ cwd: "/home/test", lockCwd: true });
    mockSuccess();

    await tool.execute({ command: "ls" });

    const opts = mockExecFile.mock.calls[0][2] as Record<string, unknown>;
    expect(opts.cwd).toBe("/home/test");
  });

  // ---- Timeout ----

  it("enforces timeout on execFile error with killed flag", async () => {
    const tool = createBashTool({ timeoutMs: 1000 });
    mockError({ message: "Command timed out", killed: true });

    const result = await tool.execute({ command: "sleep", args: ["60"] });
    expect(result.isError).toBe(true);
    const parsed = parseContent(result);
    expect(parsed.timedOut).toBe(true);
  });

  it("uses default timeout when none specified", async () => {
    const tool = createBashTool();
    mockSuccess();

    await tool.execute({ command: "ls" });

    const opts = mockExecFile.mock.calls[0][2] as Record<string, unknown>;
    expect(opts.timeout).toBe(30_000);
  });

  it("uses per-call timeout override when within maxTimeoutMs", async () => {
    const tool = createBashTool({ timeoutMs: 5000, maxTimeoutMs: 15000 });
    mockSuccess();

    await tool.execute({ command: "ls", timeoutMs: 10000 });

    const opts = mockExecFile.mock.calls[0][2] as Record<string, unknown>;
    expect(opts.timeout).toBe(10000);
  });

  it("caps per-call timeout at maxTimeoutMs", async () => {
    const tool = createBashTool({ timeoutMs: 5000, maxTimeoutMs: 8000 });
    mockSuccess();

    await tool.execute({ command: "ls", timeoutMs: 60000 });

    const opts = mockExecFile.mock.calls[0][2] as Record<string, unknown>;
    expect(opts.timeout).toBe(8000);
  });

  it("caps default timeout at maxTimeoutMs when maxTimeoutMs equals timeoutMs", async () => {
    const tool = createBashTool({ timeoutMs: 5000 });
    mockSuccess();

    // maxTimeoutMs defaults to timeoutMs, so per-call override beyond it is capped
    await tool.execute({ command: "ls", timeoutMs: 60000 });

    const opts = mockExecFile.mock.calls[0][2] as Record<string, unknown>;
    expect(opts.timeout).toBe(5000);
  });

  // ---- Output truncation ----

  it("truncates stdout exceeding maxOutputBytes and sets truncated flag", async () => {
    const tool = createBashTool({ maxOutputBytes: 20 });
    const longOutput = "a".repeat(100);
    mockSuccess(longOutput);

    const result = await tool.execute({ command: "cat" });
    const parsed = parseContent(result);
    const stdout = parsed.stdout as string;
    expect(stdout).toContain("[truncated]");
    expect(stdout.length).toBeLessThan(longOutput.length);
    expect(parsed.truncated).toBe(true);
  });

  it("truncates stderr exceeding maxOutputBytes", async () => {
    const tool = createBashTool({ maxOutputBytes: 20 });
    const longStderr = "e".repeat(100);
    mockSuccess("", longStderr);

    const result = await tool.execute({ command: "cat" });
    const parsed = parseContent(result);
    const stderr = parsed.stderr as string;
    expect(stderr).toContain("[truncated]");
    expect(stderr.length).toBeLessThan(longStderr.length);
  });

  // ---- Input validation ----

  it("returns error for empty command", async () => {
    const tool = createBashTool();

    const result = await tool.execute({ command: "" });
    expect(result.isError).toBe(true);
    expect(parseContent(result).error).toContain("non-empty string");
  });

  it("returns error for non-string command", async () => {
    const tool = createBashTool();

    const result = await tool.execute({ command: 123 as unknown as string });
    expect(result.isError).toBe(true);
    expect(parseContent(result).error).toContain("non-empty string");
  });

  it("returns error for non-array args", async () => {
    const tool = createBashTool();

    const result = await tool.execute({
      command: "ls",
      args: "not-an-array" as unknown as string[],
    });
    expect(result.isError).toBe(true);
    expect(parseContent(result).error).toContain("array of strings");
  });

  it("returns error for non-string elements in args array", async () => {
    const tool = createBashTool();

    const result = await tool.execute({
      command: "ls",
      args: ["ok", 123 as unknown as string],
    });
    expect(result.isError).toBe(true);
    expect(parseContent(result).error).toContain("must be a string");
  });

  // ---- Schema ----

  it("returns correct inputSchema", () => {
    const tool = createBashTool();

    expect(tool.name).toBe("system.bash");
    expect(tool.inputSchema).toBeDefined();
    const schema = tool.inputSchema as Record<string, unknown>;
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["command"]);
    const props = schema.properties as Record<string, unknown>;
    expect(props.command).toBeDefined();
    expect(props.args).toBeDefined();
    expect(props.cwd).toBeDefined();
    expect(props.timeoutMs).toBeDefined();
  });

  // ---- Error execution ----

  it("returns isError true with exit code on command failure", async () => {
    const tool = createBashTool();
    mockError(
      { message: "command not found", code: 127 as unknown as string },
      "",
      "command not found",
    );

    const result = await tool.execute({ command: "nonexistent" });
    expect(result.isError).toBe(true);
    const parsed = parseContent(result);
    expect(parsed.exitCode).toBe(127);
    expect(parsed.timedOut).toBe(false);
  });

  // ---- Logging ----

  it("logs denials via warn", async () => {
    const logger = createMockLogger();
    const tool = createBashTool({ logger });

    await tool.execute({ command: "rm", args: ["-rf", "/"] });

    expect(logger.warn).toHaveBeenCalledOnce();
    expect(
      (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0][0],
    ).toContain("denied");
  });

  it("logs successful execution via debug", async () => {
    const logger = createMockLogger();
    const tool = createBashTool({ logger });
    mockSuccess("ok");

    await tool.execute({ command: "echo", args: ["ok"] });

    expect(logger.debug).toHaveBeenCalled();
    const debugCalls = (
      logger.debug as ReturnType<typeof vi.fn>
    ).mock.calls.map((c: unknown[]) => c[0] as string);
    expect(debugCalls.some((msg: string) => msg.includes("success"))).toBe(
      true,
    );
  });

  it("logs timeout via warn", async () => {
    const logger = createMockLogger();
    const tool = createBashTool({ logger, timeoutMs: 100 });
    mockError({ message: "timed out", killed: true });

    await tool.execute({ command: "sleep", args: ["60"] });

    expect(logger.warn).toHaveBeenCalledOnce();
    expect(
      (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0][0],
    ).toContain("timed out");
  });
});

// ---- isCommandAllowed standalone function tests ----

describe("isCommandAllowed", () => {
  const denySet = new Set(["rm", "bash", "sudo"]);
  const allowSet = new Set(["ls", "cat", "git"]);

  it("allows command not in deny list and no allow list", () => {
    const result = isCommandAllowed("ls", denySet, null);
    expect(result.allowed).toBe(true);
  });

  it("denies command in deny list", () => {
    const result = isCommandAllowed("rm", denySet, null);
    expect(result.allowed).toBe(false);
  });

  it("denies command by basename when given absolute path", () => {
    const result = isCommandAllowed("/bin/rm", denySet, null);
    expect(result.allowed).toBe(false);
  });

  it("denies /usr/bin/bash by basename", () => {
    const result = isCommandAllowed("/usr/bin/bash", denySet, null);
    expect(result.allowed).toBe(false);
  });

  it("allows command on allow list", () => {
    const result = isCommandAllowed("git", denySet, allowSet);
    expect(result.allowed).toBe(true);
  });

  it("denies command not on allow list", () => {
    const result = isCommandAllowed("python", denySet, allowSet);
    expect(result.allowed).toBe(false);
  });

  it("deny list takes precedence over allow list", () => {
    const bothSet = new Set(["rm", "ls"]);
    const result = isCommandAllowed("rm", new Set(["rm"]), bothSet);
    expect(result.allowed).toBe(false);
  });

  it("denies version-specific python via prefix matching", () => {
    const result = isCommandAllowed("python3.11", new Set(), null);
    expect(result.allowed).toBe(false);
    expect((result as { reason: string }).reason).toContain("deny prefix");
  });

  it("denies pypy3 via prefix matching", () => {
    const result = isCommandAllowed("pypy3", new Set(), null);
    expect(result.allowed).toBe(false);
  });

  it("denies absolute path to version-specific binary via prefix matching", () => {
    const result = isCommandAllowed("/usr/bin/ruby3.2", new Set(), null);
    expect(result.allowed).toBe(false);
  });

  it("allows commands that do not match any deny prefix", () => {
    const result = isCommandAllowed("git", new Set(), null);
    expect(result.allowed).toBe(true);
  });

  it('allows ls even though it starts with "l" (no prefix match)', () => {
    const result = isCommandAllowed("ls", new Set(), null);
    expect(result.allowed).toBe(true);
  });
});
