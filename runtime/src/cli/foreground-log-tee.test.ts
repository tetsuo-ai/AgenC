import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installForegroundLogTee, type WritableWriteTarget } from "./foreground-log-tee.js";

describe("foreground-log-tee", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tees stdout and stderr into the configured log file", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "agenc-foreground-log-tee-"));
    tempDirs.push(tempDir);

    const logPath = join(tempDir, "daemon.log");
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const stdout: WritableWriteTarget = {
      write: vi.fn((chunk) => {
        stdoutChunks.push(String(chunk));
        return true;
      }),
    };
    const stderr: WritableWriteTarget = {
      write: vi.fn((chunk) => {
        stderrChunks.push(String(chunk));
        return true;
      }),
    };

    const tee = installForegroundLogTee({
      logPath,
      stdout,
      stderr,
    });

    expect(tee?.logPath).toBe(logPath);

    stdout.write("stdout-line\n");
    stderr.write("stderr-line\n");
    await tee?.dispose();

    const content = readFileSync(logPath, "utf8");
    expect(content).toContain("stdout-line");
    expect(content).toContain("stderr-line");
    expect(stdoutChunks).toEqual(["stdout-line\n"]);
    expect(stderrChunks).toEqual(["stderr-line\n"]);
  });

  it("warns and returns null when the log file cannot be opened", () => {
    const warn = vi.fn();
    const tee = installForegroundLogTee({
      logPath: "/dev/null/daemon.log",
      warn,
    });

    expect(tee).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Failed to install foreground daemon log tee"),
    );
  });
});
