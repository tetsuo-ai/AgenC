import { describe, expect, it } from "vitest";

import {
  buildRecoveryHints,
  inferRecoveryHint,
} from "./chat-executor-recovery.js";

describe("chat-executor-recovery", () => {
  it("suggests the correct Doom resolution enum after invalid start_game input", () => {
    const hint = inferRecoveryHint({
      name: "mcp.doom.start_game",
      args: {
        screen_resolution: "1920x1080",
      },
      result: "Unknown resolution '1920x1080'. Valid: ['RES_1920X1080']",
      isError: false,
      durationMs: 18,
    });

    expect(hint).toBeDefined();
    expect(hint?.key).toBe("doom-start-game-invalid-resolution");
    expect(hint?.message).toContain("RES_1920X1080");
  });

  it("requires verification after a successful async Doom launch", () => {
    const hint = inferRecoveryHint({
      name: "mcp.doom.start_game",
      args: {
        async_player: true,
        screen_resolution: "RES_1920X1080",
      },
      result: JSON.stringify({ status: "running" }),
      isError: false,
      durationMs: 812,
    });

    expect(hint).toBeDefined();
    expect(hint?.key).toBe("doom-async-start-verify");
    expect(hint?.message).toContain("mcp.doom.get_situation_report");
    expect(hint?.message).toContain("hold_position");
  });

  it("redirects long-running desktop shell work to structured process tools", () => {
    const hint = inferRecoveryHint({
      name: "desktop.bash",
      args: {
        command: "npm run dev",
      },
      result: JSON.stringify({
        error:
          'Command "npm run dev" is a long-running server process and is likely to timeout in foreground mode. Start it in background (append `&`) and then verify with curl or logs.',
      }),
      isError: false,
      durationMs: 22,
    });

    expect(hint).toBeDefined();
    expect(hint?.key).toBe("desktop-bash-background-process-shape");
    expect(hint?.message).toContain("desktop.process_start");
    expect(hint?.message).toContain("desktop.process_status");
    expect(hint?.message).toContain("desktop.process_stop");
  });

  it("redirects Doom stop attempts to mcp.doom.stop_game", () => {
    const hints = buildRecoveryHints(
      [
        {
          name: "desktop.bash",
          args: {
            command: "ps aux | grep -i doom",
          },
          result: JSON.stringify({
            stdout: "root 234 vizdoom\n",
            stderr: "",
            exitCode: 0,
          }),
          isError: false,
          durationMs: 9,
        },
        {
          name: "desktop.process_stop",
          args: {
            pid: 234,
          },
          result: JSON.stringify({
            error: "process_stop failed: Managed process not found",
          }),
          isError: true,
          durationMs: 3,
        },
      ],
      new Set(),
    );

    expect(hints.some((hint) => hint.key === "doom-stop-via-mcp")).toBe(true);
    expect(
      hints.some((hint) => hint.message.includes("mcp.doom.stop_game")),
    ).toBe(true);
  });

  it("redirects failed raw docker shell attempts to durable sandbox handles", () => {
    const hint = inferRecoveryHint({
      name: "system.bash",
      args: {
        command: "docker run node:20-slim npm test",
      },
      result: JSON.stringify({
        error: "Command docker is not allowlisted on system.bash.",
      }),
      isError: true,
      durationMs: 7,
    });

    expect(hint).toBeDefined();
    expect(hint?.key).toBe("system-bash-sandbox-handle");
    expect(hint?.message).toContain("system.sandboxStart");
    expect(hint?.message).toContain("system.sandboxJobStart");
  });

  it("flags heredoc commands that put a conjunction on a fresh line", () => {
    const hint = inferRecoveryHint({
      name: "system.bash",
      args: {
        command:
          "cd /tmp/demo && cat > package.json << 'EOF'\n" +
          "{\n  \"name\": \"demo\"\n}\n" +
          "EOF\n" +
          " && cat package.json\n",
      },
      result: JSON.stringify({
        exitCode: 2,
        stderr:
          "/tmp/agenc-sh-1234.sh: line 5: syntax error near unexpected token `&&'\n" +
          "/tmp/agenc-sh-1234.sh: line 5: ` && cat package.json'\n",
      }),
      isError: true,
      durationMs: 18,
    });

    expect(hint).toBeDefined();
    expect(hint?.key).toBe("system-bash-heredoc-conjunction-shape");
    expect(hint?.message).toContain("system.writeFile");
    expect(hint?.message).toContain("separate tool call");
  });

  it("redirects timed-out Vitest watch mode to single-run execution", () => {
    const hint = inferRecoveryHint({
      name: "system.bash",
      args: {
        command: "npm",
        args: ["test"],
      },
      result: JSON.stringify({
        exitCode: null,
        timedOut: true,
        stdout:
          "> vitest\n\n FAIL  Tests failed. Watching for file changes...\n       press h to show help, press q to quit\n",
        stderr: "Error: No path found",
      }),
      isError: false,
      durationMs: 30_000,
    });

    expect(hint).toBeDefined();
    expect(hint?.key).toBe("system.bash-test-runner-watch-mode");
    expect(hint?.message).toContain("vitest run");
    expect(hint?.message).toContain("CI=1 npm test");
  });

  it("redirects timed-out non-watch tests to source inspection instead of retry flailing", () => {
    const hint = inferRecoveryHint({
      name: "system.bash",
      args: {
        command: "npm run test --workspace=@signal-cartography/core",
      },
      result: JSON.stringify({
        exitCode: null,
        timedOut: true,
        stdout:
          "\n> @signal-cartography/core@1.0.0 test\n> vitest run\n\n\n RUN  v1.6.1 /workspace/signal-cartography/packages/core\n\n",
        stderr: 'Command "npm run test --workspace=@signal-cartography/core" failed',
      }),
      isError: true,
      durationMs: 30_053,
    });

    expect(hint).toBeDefined();
    expect(hint?.key).toBe("system.bash-test-runner-timeout");
    expect(hint?.message).toContain("likely hung");
    expect(hint?.message).toContain("Inspect the authored source and tests");
    expect(hint?.message).toContain("Do not keep retrying");
  });

  it("treats direct node execution of compiled test artifacts as a timed-out test run", () => {
    const hint = inferRecoveryHint({
      name: "system.bash",
      args: {
        command: "node",
        args: ["packages/core/dist/test/index.test.js"],
      },
      result: JSON.stringify({
        exitCode: null,
        timedOut: true,
        stdout:
          "Running core tests...\nBFS test passed, cost: 3\nUnreachable test passed\n",
        stderr: "Command failed: node packages/core/dist/test/index.test.js\n",
      }),
      isError: true,
      durationMs: 30_006,
    });

    expect(hint).toBeDefined();
    expect(hint?.key).toBe("system.bash-test-runner-timeout");
    expect(hint?.message).toContain("likely hung");
    expect(hint?.message).toContain("Inspect the authored source and tests");
  });

  it("flags unsupported Vitest threads flags and points to the supported pool option", () => {
    const hint = inferRecoveryHint({
      name: "system.bash",
      args: {
        command: "npx vitest run packages/core/src/index.test.ts --no-threads",
      },
      result: JSON.stringify({
        exitCode: 1,
        stdout: "",
        stderr:
          "CACError: Unknown option `--threads`\n    at Command.checkUnknownOptions (...)",
      }),
      isError: true,
      durationMs: 203,
    });

    expect(hint).toBeDefined();
    expect(hint?.key).toBe("system.bash-vitest-unsupported-threads-flag");
    expect(hint?.message).toContain("--no-threads");
    expect(hint?.message).toContain("--pool=<threads|forks>");
    expect(hint?.message).toContain("vitest run");
  });

  it("flags missing project-local binaries without misclassifying them as shell builtins", () => {
    const hint = inferRecoveryHint({
      name: "system.bash",
      args: {
        command: "tsc",
        args: ["--noEmit"],
      },
      result: JSON.stringify({
        exitCode: 1,
        stdout: "",
        stderr: "spawn tsc ENOENT",
      }),
      isError: true,
      durationMs: 9,
    });

    expect(hint).toBeDefined();
    expect(hint?.key).toBe("system-bash-missing-command:tsc");
    expect(hint?.message).toContain("`npx tsc`");
    expect(hint?.message).not.toContain("Shell builtins");
  });

  it("flags unsupported workspace protocol failures as host tooling constraints", () => {
    const hint = inferRecoveryHint({
      name: "system.bash",
      args: {
        command: "npm",
        args: ["install"],
      },
      result: JSON.stringify({
        exitCode: 1,
        stdout: "",
        stderr:
          'npm error code EUNSUPPORTEDPROTOCOL\nnpm error Unsupported URL Type "workspace:": workspace:*\n',
      }),
      isError: true,
      durationMs: 412,
    });

    expect(hint).toBeDefined();
    expect(hint?.key).toBe("system-bash-workspace-protocol-unsupported");
    expect(hint?.message).toContain("workspace:*");
    expect(hint?.message).toContain("rerun `npm install`");
  });

  it("flags recursive npm install lifecycle scripts before they burn the turn budget", () => {
    const hint = inferRecoveryHint({
      name: "system.bash",
      args: {
        command: "npm",
        args: ["install"],
      },
      result: JSON.stringify({
        exitCode: null,
        timedOut: true,
        stdout:
          "\n> maze-forge-ts@0.1.0 install\n> npm install\n\n" +
          "\n> maze-forge-ts@0.1.0 install\n> npm install\n",
        stderr: "Command failed: npm install\n",
      }),
      isError: true,
      durationMs: 30_000,
    });

    expect(hint).toBeDefined();
    expect(hint?.key).toBe("system-bash-recursive-npm-install-lifecycle");
    expect(hint?.message).toContain("recursive `install` script");
    expect(hint?.message).toContain("rerun `npm install`");
  });

  it("flags local package imports that point at missing dist output", () => {
    const hint = inferRecoveryHint({
      name: "system.bash",
      args: {
        command: "npx",
        args: ["tsx", "packages/cli/src/cli.ts", "demo-map.txt"],
      },
      result: JSON.stringify({
        exitCode: 1,
        stdout: "",
        stderr:
          "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '/workspace/demo/node_modules/@terrain-router/core/dist/index.js' imported from /workspace/demo/packages/cli/src/cli.ts\n",
      }),
      isError: true,
      durationMs: 209,
    });

    expect(hint).toBeDefined();
    expect(hint?.key).toBe("system-bash-local-package-dist-missing");
    expect(hint?.message).toContain("dist/*");
    expect(hint?.message).toContain("Build the dependency package first");
  });

  it("flags direct-mode wildcard operands that rely on shell glob expansion", () => {
    const hint = inferRecoveryHint({
      name: "system.bash",
      args: {
        command: "ls",
        args: ["packages/core/dist/*.d.ts"],
      },
      result: JSON.stringify({
        exitCode: 2,
        stdout: "",
        stderr:
          "ls: cannot access 'packages/core/dist/*.d.ts': No such file or directory\n",
      }),
      isError: true,
      durationMs: 6,
    });

    expect(hint).toBeDefined();
    expect(hint?.key).toBe("system-bash-literal-glob-operand");
    expect(hint?.message).toContain("does not expand shell globs");
    expect(hint?.message).toContain("find");
    expect(hint?.message).toContain("shell mode");
  });
});
