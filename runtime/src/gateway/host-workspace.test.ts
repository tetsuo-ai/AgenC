import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildAllowedFilesystemPaths,
  resolveHostWorkspacePath,
  resolveSessionWorkspaceRoot,
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

describe("resolveSessionWorkspaceRoot", () => {
  it("accepts existing non-root absolute workspace paths", () => {
    const root = mkdtempSync(join(tmpdir(), "agenc-session-root-"));
    const homePath = join(root, "home");
    const projectPath = join(homePath, "git", "other-project");
    mkdirSync(projectPath, { recursive: true });

    try {
      expect(
        resolveSessionWorkspaceRoot(projectPath, {
          homePath,
        }),
      ).toBe(projectPath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects filesystem root, relative paths, and missing directories", () => {
    const root = mkdtempSync(join(tmpdir(), "agenc-session-root-invalid-"));
    const homePath = join(root, "home");
    mkdirSync(homePath, { recursive: true });

    try {
      expect(
        resolveSessionWorkspaceRoot("/", {
          homePath,
        }),
      ).toBeNull();
      expect(
        resolveSessionWorkspaceRoot("relative/project", {
          homePath,
        }),
      ).toBeNull();
      expect(
        resolveSessionWorkspaceRoot(join(homePath, "missing-project"), {
          homePath,
        }),
      ).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects sensitive roots, descendants, and broad ancestors that would include them", () => {
    const root = mkdtempSync(join(tmpdir(), "agenc-session-root-sensitive-"));
    const homePath = join(root, "home");
    mkdirSync(join(homePath, ".ssh"), { recursive: true });
    mkdirSync(join(homePath, ".config", "solana", "mainnet"), {
      recursive: true,
    });

    try {
      expect(
        resolveSessionWorkspaceRoot(join(homePath, ".ssh"), {
          homePath,
        }),
      ).toBeNull();
      expect(
        resolveSessionWorkspaceRoot(
          join(homePath, ".config", "solana", "mainnet"),
          {
            homePath,
          },
        ),
      ).toBeNull();
      expect(
        resolveSessionWorkspaceRoot(homePath, {
          homePath,
        }),
      ).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("canonicalizes symlinked workspace roots and rejects files", () => {
    const root = mkdtempSync(join(tmpdir(), "agenc-session-root-realpath-"));
    const homePath = join(root, "home");
    const realProjectPath = join(homePath, "git", "project");
    const linkPath = join(homePath, "links", "project-link");
    const filePath = join(homePath, "git", "notes.txt");
    mkdirSync(realProjectPath, { recursive: true });
    mkdirSync(join(homePath, "links"), { recursive: true });
    symlinkSync(realProjectPath, linkPath, "dir");
    writeFileSync(filePath, "not a directory", "utf8");

    try {
      expect(
        resolveSessionWorkspaceRoot(linkPath, {
          homePath,
        }),
      ).toBe(realProjectPath);
      expect(
        resolveSessionWorkspaceRoot(filePath, {
          homePath,
        }),
      ).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
