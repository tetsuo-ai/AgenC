import { describe, expect, it } from "vitest";

import {
  blockUntilDoomStopTool,
  isDoomStopRequest,
} from "./doom-stop-guard.js";

describe("doom-stop-guard", () => {
  it("detects explicit Doom stop requests", () => {
    expect(isDoomStopRequest("Stop Doom now.")).toBe(true);
    expect(isDoomStopRequest("Please kill vizdoom.")).toBe(true);
    expect(isDoomStopRequest("doom stop")).toBe(true);
    expect(isDoomStopRequest("Start Doom defend_the_center.")).toBe(false);
    expect(
      isDoomStopRequest(
        "start doom in god mode and play until i tell you to stop",
      ),
    ).toBe(false);
  });

  it("blocks non-MCP tools until Doom stop is issued", () => {
    const blocked = blockUntilDoomStopTool("desktop.bash", false);
    expect(blocked).toContain("mcp.doom.stop_game");

    expect(blockUntilDoomStopTool("mcp.doom.stop_game", false)).toBeUndefined();
    expect(blockUntilDoomStopTool("mcp.doom.get_state", true)).toBeUndefined();
  });
});
