import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runAgencCli } from "./agenc.js";

function captureStream(): { stream: Writable; data: () => string } {
  let data = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      data += chunk.toString();
      callback();
    },
  });
  return {
    stream,
    data: () => data,
  };
}

describe("agenc launcher CLI", () => {
  it("launches the operator console by default", async () => {
    const runOperatorConsole = vi.fn().mockResolvedValue(0);
    const runCli = vi.fn().mockResolvedValue(1);

    const code = await runAgencCli(
      {
        argv: [],
      },
      {
        runOperatorConsole,
        runCli,
      },
    );

    expect(code).toBe(0);
    expect(runOperatorConsole).toHaveBeenCalledWith({
      configPath: undefined,
      pidPath: undefined,
      logLevel: undefined,
      yolo: undefined,
      cwd: undefined,
      env: undefined,
    });
    expect(runCli).not.toHaveBeenCalled();
  });

  it("passes console flags through to the operator console launcher", async () => {
    const runOperatorConsole = vi.fn().mockResolvedValue(0);
    const runCli = vi.fn().mockResolvedValue(1);

    await runAgencCli(
      {
        argv: [
          "--config",
          "/tmp/agenc.json",
          "--pid-path",
          "/tmp/agenc.pid",
          "--log-level",
          "info",
          "--yolo",
        ],
        cwd: "/workspace/demo",
        env: {
          DEMO: "1",
        },
      },
      {
        runOperatorConsole,
        runCli,
      },
    );

    expect(runOperatorConsole).toHaveBeenCalledWith({
      configPath: "/tmp/agenc.json",
      pidPath: "/tmp/agenc.pid",
      logLevel: "info",
      yolo: true,
      cwd: "/workspace/demo",
      env: {
        DEMO: "1",
      },
    });
    expect(runCli).not.toHaveBeenCalled();
  });

  it("forwards explicit runtime subcommands to agenc-runtime", async () => {
    const runOperatorConsole = vi.fn().mockResolvedValue(0);
    const runCli = vi.fn().mockResolvedValue(0);
    const stdout = captureStream();
    const stderr = captureStream();

    const code = await runAgencCli(
      {
        argv: ["status", "--pid-path", "/tmp/agenc.pid"],
        stdout: stdout.stream,
        stderr: stderr.stream,
      },
      {
        runOperatorConsole,
        runCli,
      },
    );

    expect(code).toBe(0);
    expect(runCli).toHaveBeenCalledWith({
      argv: ["status", "--pid-path", "/tmp/agenc.pid"],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    expect(runOperatorConsole).not.toHaveBeenCalled();
  });

  it("shows launcher help without touching the daemon path", async () => {
    const runOperatorConsole = vi.fn().mockResolvedValue(0);
    const runCli = vi.fn().mockResolvedValue(0);
    const stdout = captureStream();

    const code = await runAgencCli(
      {
        argv: ["--help"],
        stdout: stdout.stream,
      },
      {
        runOperatorConsole,
        runCli,
      },
    );

    expect(code).toBe(0);
    expect(stdout.data()).toContain("agenc [console]");
    expect(stdout.data()).toContain("agenc status");
    expect(runOperatorConsole).not.toHaveBeenCalled();
    expect(runCli).not.toHaveBeenCalled();
  });

  it("rejects unexpected console positional arguments", async () => {
    const runOperatorConsole = vi.fn().mockResolvedValue(0);
    const runCli = vi.fn().mockResolvedValue(0);
    const stderr = captureStream();

    const code = await runAgencCli(
      {
        argv: ["console", "extra"],
        stderr: stderr.stream,
      },
      {
        runOperatorConsole,
        runCli,
      },
    );

    expect(code).toBe(2);
    expect(stderr.data()).toContain(
      "agenc console does not accept positional arguments",
    );
    expect(runOperatorConsole).not.toHaveBeenCalled();
    expect(runCli).not.toHaveBeenCalled();
  });
});
