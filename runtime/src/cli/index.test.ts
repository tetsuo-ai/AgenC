import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

const { runInitCommand } = vi.hoisted(() => ({
  runInitCommand: vi.fn(async () => 0),
}));

vi.mock("./init.js", () => ({
  runInitCommand,
}));

import { runCli } from "./index.js";

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

describe("runtime root CLI", () => {
  it("includes init in root help output", async () => {
    const stdout = captureStream();
    const stderr = captureStream();

    const code = await runCli({
      argv: ["--help"],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(code).toBe(0);
    expect(stderr.data()).toBe("");
    expect(stdout.data()).toContain("init [--help] [options]");
    expect(stdout.data()).toContain(
      "init      Generate an AGENC.md contributor guide for the current repo",
    );
    expect(stdout.data()).toContain("agenc-runtime init");
  });

  it("routes init flags through the root CLI command surface", async () => {
    const stdout = captureStream();
    const stderr = captureStream();

    const code = await runCli({
      argv: [
        "init",
        "--path",
        "/tmp/demo",
        "--force",
        "--pid-path",
        "/tmp/agenc.pid",
        "--port",
        "3222",
        "--config",
        "/tmp/agenc-config.json",
        "--output",
        "json",
      ],
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(code).toBe(0);
    expect(stderr.data()).toBe("");
    expect(runInitCommand).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        path: "/tmp/demo",
        force: true,
        pidPath: "/tmp/agenc.pid",
        controlPlanePort: 3222,
        configPath: "/tmp/agenc-config.json",
      }),
    );
  });
});
