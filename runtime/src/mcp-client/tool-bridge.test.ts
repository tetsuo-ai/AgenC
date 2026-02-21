import { describe, it, expect, vi } from "vitest";
import { createToolBridge } from "./tool-bridge.js";

function makeMockClient(tools: { name: string; description?: string; inputSchema?: object }[] = []) {
  return {
    listTools: vi.fn().mockResolvedValue({ tools }),
    callTool: vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      isError: false,
    }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe("createToolBridge", () => {
  // --------------------------------------------------------------------------
  // Tool discovery
  // --------------------------------------------------------------------------

  it("converts MCP tools to runtime Tool[] with namespaced names", async () => {
    const client = makeMockClient([
      { name: "takeScreenshot", description: "Capture the screen" },
      { name: "click", description: "Click an element" },
    ]);

    const bridge = await createToolBridge(client, "peekaboo");

    expect(bridge.serverName).toBe("peekaboo");
    expect(bridge.tools).toHaveLength(2);
    expect(bridge.tools[0].name).toBe("mcp.peekaboo.takeScreenshot");
    expect(bridge.tools[0].description).toBe("Capture the screen");
    expect(bridge.tools[1].name).toBe("mcp.peekaboo.click");
  });

  it("handles empty tool list", async () => {
    const client = makeMockClient([]);
    const bridge = await createToolBridge(client, "empty");

    expect(bridge.tools).toHaveLength(0);
  });

  it("uses default description when MCP tool has none", async () => {
    const client = makeMockClient([{ name: "doStuff" }]);
    const bridge = await createToolBridge(client, "srv");

    expect(bridge.tools[0].description).toBe("MCP tool: doStuff");
  });

  it("uses default inputSchema when MCP tool has none", async () => {
    const client = makeMockClient([{ name: "noSchema" }]);
    const bridge = await createToolBridge(client, "srv");

    expect(bridge.tools[0].inputSchema).toEqual({ type: "object", properties: {} });
  });

  it("preserves inputSchema from MCP tool", async () => {
    const schema = { type: "object", properties: { quality: { type: "string" } } };
    const client = makeMockClient([{ name: "tool1", inputSchema: schema }]);
    const bridge = await createToolBridge(client, "srv");

    expect(bridge.tools[0].inputSchema).toEqual(schema);
  });

  it("handles server returning no tools key", async () => {
    const client = {
      listTools: vi.fn().mockResolvedValue({}),
      callTool: vi.fn(),
      close: vi.fn(),
    };
    const bridge = await createToolBridge(client, "srv");

    expect(bridge.tools).toHaveLength(0);
  });

  // --------------------------------------------------------------------------
  // Tool execution
  // --------------------------------------------------------------------------

  it("execute calls client.callTool with original tool name", async () => {
    const client = makeMockClient([{ name: "takeScreenshot" }]);
    const bridge = await createToolBridge(client, "peekaboo");

    await bridge.tools[0].execute({ quality: "low" });

    expect(client.callTool).toHaveBeenCalledWith({
      name: "takeScreenshot",
      arguments: { quality: "low" },
    });
  });

  it("execute extracts text content from MCP content array", async () => {
    const client = makeMockClient([{ name: "tool1" }]);
    client.callTool.mockResolvedValue({
      content: [
        { type: "text", text: "line 1" },
        { type: "text", text: "line 2" },
      ],
      isError: false,
    });

    const bridge = await createToolBridge(client, "srv");
    const result = await bridge.tools[0].execute({});

    expect(result.content).toBe("line 1\nline 2");
    expect(result.isError).toBe(false);
  });

  it("execute JSON-stringifies non-text content items", async () => {
    const client = makeMockClient([{ name: "tool1" }]);
    client.callTool.mockResolvedValue({
      content: [{ type: "image", data: "base64..." }],
      isError: false,
    });

    const bridge = await createToolBridge(client, "srv");
    const result = await bridge.tools[0].execute({});

    expect(result.content).toContain('"type":"image"');
  });

  it("execute handles string content from MCP", async () => {
    const client = makeMockClient([{ name: "tool1" }]);
    client.callTool.mockResolvedValue({
      content: "plain string result",
      isError: false,
    });

    const bridge = await createToolBridge(client, "srv");
    const result = await bridge.tools[0].execute({});

    expect(result.content).toBe("plain string result");
  });

  it("execute propagates isError flag", async () => {
    const client = makeMockClient([{ name: "tool1" }]);
    client.callTool.mockResolvedValue({
      content: [{ type: "text", text: "bad" }],
      isError: true,
    });

    const bridge = await createToolBridge(client, "srv");
    const result = await bridge.tools[0].execute({});

    expect(result.isError).toBe(true);
  });

  it("execute catches callTool errors and returns isError result", async () => {
    const client = makeMockClient([{ name: "failTool" }]);
    client.callTool.mockRejectedValue(new Error("connection lost"));

    const bridge = await createToolBridge(client, "srv");
    const result = await bridge.tools[0].execute({});

    expect(result.isError).toBe(true);
    expect(result.content).toContain("failTool");
    expect(result.content).toContain("connection lost");
  });

  // --------------------------------------------------------------------------
  // Disposed guard
  // --------------------------------------------------------------------------

  it("execute returns error after dispose", async () => {
    const client = makeMockClient([{ name: "tool1" }]);
    const bridge = await createToolBridge(client, "srv");

    await bridge.dispose();
    const result = await bridge.tools[0].execute({});

    expect(result.isError).toBe(true);
    expect(result.content).toContain("disconnected");
    expect(client.callTool).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // Dispose
  // --------------------------------------------------------------------------

  it("dispose calls client.close", async () => {
    const client = makeMockClient([]);
    const bridge = await createToolBridge(client, "srv");

    await bridge.dispose();

    expect(client.close).toHaveBeenCalledOnce();
  });

  it("dispose swallows close errors", async () => {
    const client = makeMockClient([]);
    client.close.mockRejectedValue(new Error("already closed"));

    const bridge = await createToolBridge(client, "srv");

    // Should not throw
    await bridge.dispose();
  });
});
