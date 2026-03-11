import { describe, expect, it } from "vitest";

import { probeHostToolingProfile } from "./host-tooling.js";

describe("host-tooling", () => {
  it("records unsupported npm workspace protocol from an empirical install probe", async () => {
    const calls: Array<{
      command: string;
      args: readonly string[];
      cwd?: string;
    }> = [];

    const profile = await probeHostToolingProfile({
      runCommand: async ({ command, args, cwd }) => {
        calls.push({ command, args, cwd });
        if (command === "npm" && args[0] === "--version") {
          return {
            stdout: "11.7.0\n",
            stderr: "",
            exitCode: 0,
          };
        }
        return {
          stdout: "",
          stderr:
            'npm error code EUNSUPPORTEDPROTOCOL\nnpm error Unsupported URL Type "workspace:": workspace:*\n',
          exitCode: 1,
        };
      },
    });

    expect(profile.nodeVersion).toBe(process.version);
    expect(profile.npm).toEqual({
      version: "11.7.0",
      workspaceProtocolSupport: "unsupported",
      workspaceProtocolEvidence: "npm error code EUNSUPPORTEDPROTOCOL",
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.command).toBe("npm");
    expect(calls[1]?.args).toEqual([
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
    ]);
    expect(calls[1]?.cwd).toBeTruthy();
  });

  it("records supported npm workspace protocol when the empirical install succeeds", async () => {
    const profile = await probeHostToolingProfile({
      runCommand: async ({ command, args }) => {
        if (command === "npm" && args[0] === "--version") {
          return {
            stdout: "11.7.0\n",
            stderr: "",
            exitCode: 0,
          };
        }
        return {
          stdout: "",
          stderr: "",
          exitCode: 0,
        };
      },
    });

    expect(profile.npm).toEqual({
      version: "11.7.0",
      workspaceProtocolSupport: "supported",
    });
  });
});
