import { describe, expect, it } from "vitest";
import {
  buildAllowedFilesystemPaths,
  resolveHostWorkspacePath,
} from "./host-workspace.js";
import type { GatewayConfig } from "./types.js";

function makeConfig(workspace?: Record<string, unknown>): GatewayConfig {
  return {
    gateway: { port: 3100 },
    agent: { name: "test-agent" },
    connection: { rpcUrl: "http://127.0.0.1:8899" },
    ...(workspace ? { workspace } : {}),
  };
}

describe("resolveHostWorkspacePath", () => {
  it("defaults to the daemon cwd when workspace.hostPath is unset", () => {
    expect(
      resolveHostWorkspacePath({
        config: makeConfig(),
        configPath: "/configs/agenc.json",
        daemonCwd: "/repo/runtime",
      }),
    ).toBe("/repo/runtime");
  });

  it("resolves workspace.hostPath relative to the config file directory", () => {
    expect(
      resolveHostWorkspacePath({
        config: makeConfig({ hostPath: "./agent-test" }),
        configPath: "/home/tetsuo/agenc/agenc-host.json",
      }),
    ).toBe("/home/tetsuo/agenc/agent-test");
  });

  it("keeps absolute workspace.hostPath values", () => {
    expect(
      resolveHostWorkspacePath({
        config: makeConfig({ hostPath: "/home/tetsuo/agent-test" }),
        configPath: "/home/tetsuo/agenc/agenc-host.json",
      }),
    ).toBe("/home/tetsuo/agent-test");
  });

  it("rejects workspace.hostPath when it resolves to filesystem root", () => {
    expect(() =>
      resolveHostWorkspacePath({
        config: makeConfig({ hostPath: "/" }),
        configPath: "/home/tetsuo/agenc/agenc-host.json",
      }),
    ).toThrow("workspace.hostPath must not resolve to the filesystem root");
  });
});

describe("buildAllowedFilesystemPaths", () => {
  it("includes the configured host workspace root once alongside standard safe roots", () => {
    expect(
      buildAllowedFilesystemPaths({
        hostWorkspacePath: "/home/tetsuo/agent-test",
        homePath: "/home/tetsuo",
      }),
    ).toEqual([
      "/home/tetsuo/.agenc/workspace",
      "/home/tetsuo/Desktop",
      "/tmp",
      "/home/tetsuo/agent-test",
    ]);
  });

  it("does not duplicate built-in safe roots", () => {
    expect(
      buildAllowedFilesystemPaths({
        hostWorkspacePath: "/tmp",
        homePath: "/home/tetsuo",
      }),
    ).toEqual([
      "/home/tetsuo/.agenc/workspace",
      "/home/tetsuo/Desktop",
      "/tmp",
    ]);
  });
});
