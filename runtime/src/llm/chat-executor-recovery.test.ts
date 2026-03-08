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
});
