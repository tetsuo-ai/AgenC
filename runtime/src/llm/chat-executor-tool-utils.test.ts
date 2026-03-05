import { describe, expect, it } from "vitest";
import { didToolCallFail } from "./chat-executor-tool-utils.js";

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

    it("returns false for normal non-JSON output", () => {
      expect(didToolCallFail(false, "all good")).toBe(false);
    });
  });
});
