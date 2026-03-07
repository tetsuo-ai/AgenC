import { describe, expect, it } from "vitest";
import {
  didToolCallFail,
  normalizeDoomScreenResolution,
  normalizeToolCallArguments,
} from "./chat-executor-tool-utils.js";

describe("chat-executor-tool-utils", () => {
  describe("didToolCallFail", () => {
    it("returns true when execution is marked isError", () => {
      expect(didToolCallFail(true, "ok")).toBe(true);
    });

    it("returns true for JSON error payloads", () => {
      expect(didToolCallFail(false, '{"error":"boom"}')).toBe(true);
    });

    it("returns true for non-zero JSON exitCode", () => {
      expect(didToolCallFail(false, '{"exitCode":1}')).toBe(true);
    });

    it("returns true for MCP plain-text failure signatures", () => {
      expect(
        didToolCallFail(
          false,
          'MCP tool "launch" failed: MCP tool "launch" callTool timed out after 30000ms',
        ),
      ).toBe(true);
    });

    it("returns true for plain-text tool execution errors", () => {
      expect(
        didToolCallFail(
          false,
          "Error executing tool send_text: Instance 'terminal1' not found",
        ),
      ).toBe(true);
    });

    it("returns true for plain-text tool-not-found failures", () => {
      expect(didToolCallFail(false, 'Tool not found: "desktop.bash"')).toBe(true);
    });

    it("returns true for desktop-session requirement failures", () => {
      expect(
        didToolCallFail(false, "Container MCP tool — requires desktop session"),
      ).toBe(true);
    });

    it("returns true for plain-text Doom validation failures", () => {
      expect(
        didToolCallFail(
          false,
          "Unknown resolution '1920x1080'. Valid: ['RES_1920X1080']",
        ),
      ).toBe(true);
    });

    it("returns true for plain-text Doom runtime-state failures", () => {
      expect(
        didToolCallFail(
          false,
          "Executor not running. Start game with async_player=True.",
        ),
      ).toBe(true);
      expect(
        didToolCallFail(
          false,
          "No game is running. Call start_game first.",
        ),
      ).toBe(true);
    });

    it("returns false for normal non-JSON output", () => {
      expect(didToolCallFail(false, "all good")).toBe(false);
    });
  });

  describe("normalizeDoomScreenResolution", () => {
    it("normalizes user-style Doom resolution strings into ViZDoom enums", () => {
      expect(normalizeDoomScreenResolution("1920x1080")).toBe("RES_1920X1080");
      expect(normalizeDoomScreenResolution("RES_1920x1080")).toBe("RES_1920X1080");
      expect(normalizeDoomScreenResolution("RES_1920X1080")).toBe("RES_1920X1080");
    });
  });

  describe("normalizeToolCallArguments", () => {
    it("normalizes Doom launch args before execution", () => {
      expect(
        normalizeToolCallArguments("mcp.doom.start_game", {
          screen_resolution: "1280x720",
          recording_path: "null",
          async_player: true,
        }),
      ).toEqual({
        screen_resolution: "RES_1280X720",
        async_player: true,
        window_visible: true,
        render_hud: true,
      });
    });

    it("defaults visible Doom launches to a non-tiny window with HUD", () => {
      expect(
        normalizeToolCallArguments("mcp.doom.start_game", {
          god_mode: true,
        }),
      ).toEqual({
        god_mode: true,
        screen_resolution: "RES_1280X720",
        window_visible: true,
        render_hud: true,
      });
    });
  });
});
