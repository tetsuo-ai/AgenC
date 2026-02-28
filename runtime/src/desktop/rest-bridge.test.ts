import { describe, it, expect, vi, beforeEach } from "vitest";
import { DesktopRESTBridge } from "./rest-bridge.js";
import { DesktopSandboxConnectionError } from "./errors.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const TOOL_DEFS = [
  {
    name: "screenshot",
    description: "Take a screenshot",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "mouse_click",
    description: "Click mouse",
    inputSchema: {
      type: "object",
      properties: { x: { type: "number" }, y: { type: "number" } },
      required: ["x", "y"],
    },
  },
  {
    name: "bash",
    description: "Run bash command",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
];

function mockHealthAndTools(): void {
  mockFetch.mockImplementation(async (url: string) => {
    if (url.includes("/health")) {
      return { ok: true, json: async () => ({ status: "ok" }) };
    }
    if (url.endsWith("/tools") && !url.includes("/tools/")) {
      return { ok: true, json: async () => TOOL_DEFS };
    }
    return { ok: false, status: 404, json: async () => ({ error: "not found" }) };
  });
}

describe("DesktopRESTBridge", () => {
  let bridge: DesktopRESTBridge;

  beforeEach(() => {
    mockFetch.mockReset();
    bridge = new DesktopRESTBridge({
      apiHostPort: 32769,
      containerId: "abc123",
    });
  });

  describe("connect()", () => {
    it("fetches tools and becomes connected", async () => {
      mockHealthAndTools();
      await bridge.connect();
      expect(bridge.isConnected()).toBe(true);
      expect(bridge.getTools().length).toBe(3);
    });

    it("namespaces tools with desktop. prefix", async () => {
      mockHealthAndTools();
      await bridge.connect();
      const names = bridge.getTools().map((t) => t.name);
      expect(names).toEqual([
        "desktop.screenshot",
        "desktop.mouse_click",
        "desktop.bash",
      ]);
    });

    it("throws ConnectionError on health check failure", async () => {
      mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));
      await expect(bridge.connect()).rejects.toThrow(
        DesktopSandboxConnectionError,
      );
    });

    it("throws ConnectionError on unhealthy response", async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 503 });
      await expect(bridge.connect()).rejects.toThrow(
        DesktopSandboxConnectionError,
      );
    });

    it("throws ConnectionError when tool list fails", async () => {
      mockFetch.mockImplementation(async (url: string) => {
        if (url.includes("/health")) {
          return { ok: true, json: async () => ({ status: "ok" }) };
        }
        throw new Error("tool fetch failed");
      });
      await expect(bridge.connect()).rejects.toThrow(
        DesktopSandboxConnectionError,
      );
    });
  });

  describe("disconnect()", () => {
    it("makes getTools return empty", async () => {
      mockHealthAndTools();
      await bridge.connect();
      expect(bridge.getTools().length).toBe(3);

      bridge.disconnect();
      expect(bridge.isConnected()).toBe(false);
      expect(bridge.getTools().length).toBe(0);
    });
  });

  describe("tool execution", () => {
    it("routes tool calls to the REST API", async () => {
      mockHealthAndTools();
      await bridge.connect();

      // Mock the tool execution call
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ clicked: true, x: 100, y: 200, button: 1 }),
      });

      const clickTool = bridge.getTools().find((t) => t.name === "desktop.mouse_click")!;
      const result = await clickTool.execute({ x: 100, y: 200 });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content);
      expect(parsed.clicked).toBe(true);

      // Verify correct URL was called
      const lastCall = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
      expect(lastCall[0]).toBe("http://localhost:32769/tools/mouse_click");
    });

    it("screenshot includes dataUrl field", async () => {
      mockHealthAndTools();
      await bridge.connect();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          image: "iVBORw0KGgoAAAAN",
          width: 1024,
          height: 768,
        }),
      });

      const ssTool = bridge.getTools().find((t) => t.name === "desktop.screenshot")!;
      const result = await ssTool.execute({});
      const parsed = JSON.parse(result.content);
      expect(parsed.dataUrl).toBe("data:image/png;base64,iVBORw0KGgoAAAAN");
      expect(parsed.image).toBeUndefined();
      expect(parsed.width).toBe(1024);
      expect(parsed.height).toBe(768);
    });

    it("returns isError on execution failure", async () => {
      mockHealthAndTools();
      await bridge.connect();

      mockFetch.mockResolvedValueOnce({
        ok: false,
        json: async () => ({
          error: "xdotool not found",
          isError: true,
        }),
      });

      const tool = bridge.getTools().find((t) => t.name === "desktop.mouse_click")!;
      const result = await tool.execute({ x: 0, y: 0 });
      expect(result.isError).toBe(true);
    });

    it("handles fetch errors gracefully", async () => {
      mockHealthAndTools();
      await bridge.connect();

      mockFetch.mockRejectedValueOnce(new Error("ECONNRESET"));

      const tool = bridge.getTools().find((t) => t.name === "desktop.bash")!;
      const result = await tool.execute({ command: "ls" });
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content);
      expect(parsed.error).toContain("ECONNRESET");
    });
  });

  describe("getTools() before connect", () => {
    it("returns empty array", () => {
      expect(bridge.getTools()).toEqual([]);
    });
  });
});
