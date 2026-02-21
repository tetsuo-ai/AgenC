import { describe, it, expect, vi, beforeEach } from "vitest";
import { MCPManager } from "./manager.js";
import type { MCPServerConfig } from "./types.js";

// Mock the connection and tool-bridge modules
vi.mock("./connection.js", () => ({
  createMCPConnection: vi.fn(),
}));
vi.mock("./tool-bridge.js", () => ({
  createToolBridge: vi.fn(),
}));

import { createMCPConnection } from "./connection.js";
import { createToolBridge } from "./tool-bridge.js";

const mockCreateMCPConnection = vi.mocked(createMCPConnection);
const mockCreateToolBridge = vi.mocked(createToolBridge);

function makeConfig(name: string, overrides?: Partial<MCPServerConfig>): MCPServerConfig {
  return { name, command: "npx", args: ["-y", `@test/${name}`], ...overrides };
}

function makeMockBridge(serverName: string, toolNames: string[]) {
  return {
    serverName,
    tools: toolNames.map((n) => ({
      name: `mcp.${serverName}.${n}`,
      description: `Tool ${n}`,
      inputSchema: { type: "object" as const, properties: {} },
      execute: vi.fn().mockResolvedValue({ content: "ok" }),
    })),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
}

describe("MCPManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // start()
  // --------------------------------------------------------------------------

  it("connects to all enabled servers", async () => {
    const bridge1 = makeMockBridge("srv1", ["toolA"]);
    const bridge2 = makeMockBridge("srv2", ["toolB", "toolC"]);

    mockCreateMCPConnection.mockResolvedValueOnce("client1").mockResolvedValueOnce("client2");
    mockCreateToolBridge.mockResolvedValueOnce(bridge1).mockResolvedValueOnce(bridge2);

    const manager = new MCPManager([makeConfig("srv1"), makeConfig("srv2")]);
    await manager.start();

    expect(mockCreateMCPConnection).toHaveBeenCalledTimes(2);
    expect(mockCreateToolBridge).toHaveBeenCalledTimes(2);
    expect(manager.getTools()).toHaveLength(3);
    expect(manager.getConnectedServers()).toEqual(["srv1", "srv2"]);
  });

  it("skips disabled servers", async () => {
    const bridge = makeMockBridge("srv1", ["toolA"]);
    mockCreateMCPConnection.mockResolvedValueOnce("client1");
    mockCreateToolBridge.mockResolvedValueOnce(bridge);

    const manager = new MCPManager([
      makeConfig("srv1"),
      makeConfig("srv2", { enabled: false }),
    ]);
    await manager.start();

    expect(mockCreateMCPConnection).toHaveBeenCalledTimes(1);
    expect(manager.getConnectedServers()).toEqual(["srv1"]);
  });

  it("does nothing with empty config", async () => {
    const manager = new MCPManager([]);
    await manager.start();

    expect(mockCreateMCPConnection).not.toHaveBeenCalled();
    expect(manager.getTools()).toHaveLength(0);
  });

  it("logs and continues when one server fails to connect", async () => {
    const bridge = makeMockBridge("srv2", ["toolB"]);
    mockCreateMCPConnection
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValueOnce("client2");
    mockCreateToolBridge.mockResolvedValueOnce(bridge);

    const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };
    const manager = new MCPManager(
      [makeConfig("srv1"), makeConfig("srv2")],
      logger as any,
    );
    await manager.start();

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("srv1"),
      expect.any(Error),
    );
    expect(manager.getConnectedServers()).toEqual(["srv2"]);
    expect(manager.getTools()).toHaveLength(1);
  });

  it("closes client when createToolBridge fails", async () => {
    const mockClient = { close: vi.fn().mockResolvedValue(undefined) };
    mockCreateMCPConnection.mockResolvedValueOnce(mockClient);
    mockCreateToolBridge.mockRejectedValueOnce(new Error("listTools failed"));

    const manager = new MCPManager([makeConfig("srv1")]);
    await manager.start();

    expect(mockClient.close).toHaveBeenCalledOnce();
    expect(manager.getConnectedServers()).toEqual([]);
  });

  // --------------------------------------------------------------------------
  // stop()
  // --------------------------------------------------------------------------

  it("disposes all bridges then clears", async () => {
    const bridge1 = makeMockBridge("srv1", ["a"]);
    const bridge2 = makeMockBridge("srv2", ["b"]);

    mockCreateMCPConnection.mockResolvedValueOnce("c1").mockResolvedValueOnce("c2");
    mockCreateToolBridge.mockResolvedValueOnce(bridge1).mockResolvedValueOnce(bridge2);

    const manager = new MCPManager([makeConfig("srv1"), makeConfig("srv2")]);
    await manager.start();
    await manager.stop();

    expect(bridge1.dispose).toHaveBeenCalledOnce();
    expect(bridge2.dispose).toHaveBeenCalledOnce();
    expect(manager.getTools()).toHaveLength(0);
    expect(manager.getConnectedServers()).toEqual([]);
  });

  it("stop is safe to call when no bridges exist", async () => {
    const manager = new MCPManager([]);
    await manager.stop(); // should not throw
  });

  it("stop swallows dispose errors", async () => {
    const bridge = makeMockBridge("srv1", ["a"]);
    bridge.dispose.mockRejectedValueOnce(new Error("close failed"));

    mockCreateMCPConnection.mockResolvedValueOnce("c1");
    mockCreateToolBridge.mockResolvedValueOnce(bridge);

    const manager = new MCPManager([makeConfig("srv1")]);
    await manager.start();
    await manager.stop(); // should not throw
  });

  // --------------------------------------------------------------------------
  // getTools / getToolsByServer / getConnectedServers
  // --------------------------------------------------------------------------

  it("getTools returns flattened tools from all bridges", async () => {
    const bridge1 = makeMockBridge("srv1", ["a", "b"]);
    const bridge2 = makeMockBridge("srv2", ["c"]);

    mockCreateMCPConnection.mockResolvedValueOnce("c1").mockResolvedValueOnce("c2");
    mockCreateToolBridge.mockResolvedValueOnce(bridge1).mockResolvedValueOnce(bridge2);

    const manager = new MCPManager([makeConfig("srv1"), makeConfig("srv2")]);
    await manager.start();

    const tools = manager.getTools();
    expect(tools).toHaveLength(3);
    expect(tools.map((t) => t.name)).toEqual([
      "mcp.srv1.a",
      "mcp.srv1.b",
      "mcp.srv2.c",
    ]);
  });

  it("getToolsByServer returns tools for a specific server", async () => {
    const bridge = makeMockBridge("srv1", ["toolA", "toolB"]);
    mockCreateMCPConnection.mockResolvedValueOnce("c1");
    mockCreateToolBridge.mockResolvedValueOnce(bridge);

    const manager = new MCPManager([makeConfig("srv1")]);
    await manager.start();

    expect(manager.getToolsByServer("srv1")).toHaveLength(2);
    expect(manager.getToolsByServer("unknown")).toEqual([]);
  });

  it("getConnectedServers returns server names", async () => {
    const bridge1 = makeMockBridge("alpha", []);
    const bridge2 = makeMockBridge("beta", []);

    mockCreateMCPConnection.mockResolvedValueOnce("c1").mockResolvedValueOnce("c2");
    mockCreateToolBridge.mockResolvedValueOnce(bridge1).mockResolvedValueOnce(bridge2);

    const manager = new MCPManager([makeConfig("alpha"), makeConfig("beta")]);
    await manager.start();

    expect(manager.getConnectedServers()).toEqual(["alpha", "beta"]);
  });
});
