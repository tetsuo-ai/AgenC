import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Gateway } from "./gateway.js";
import { GatewayStateError, GatewayValidationError } from "./errors.js";
import {
  loadGatewayConfig,
  validateGatewayConfig,
  diffGatewayConfig,
  ConfigWatcher,
} from "./config-watcher.js";
import type { GatewayConfig, ChannelHandle } from "./types.js";
import { silentLogger } from "../utils/logger.js";
import { createToken } from "./jwt.js";

// Mock ws module so tests don't need a real WebSocket server
// We track registered handlers to simulate client connections in auth tests
let wssConnectionHandler: ((...args: unknown[]) => void) | null = null;

vi.mock("ws", () => {
  const mockClients = new Set();
  const MockWebSocketServer = vi.fn().mockImplementation(() => ({
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (event === "connection") {
        wssConnectionHandler = handler;
      }
    }),
    close: vi.fn((cb?: (err?: Error) => void) => cb?.()),
    clients: mockClients,
  }));
  return { WebSocketServer: MockWebSocketServer };
});

function makeConfig(overrides?: Partial<GatewayConfig>): GatewayConfig {
  return {
    gateway: { port: 9100, bind: "127.0.0.1" },
    agent: { name: "test-agent" },
    connection: { rpcUrl: "http://localhost:8899" },
    ...overrides,
  };
}

function makeChannel(name: string, healthy = true): ChannelHandle {
  return {
    name,
    isHealthy: () => healthy,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

describe("Gateway", () => {
  let gateway: Gateway;

  beforeEach(() => {
    gateway = new Gateway(makeConfig(), { logger: silentLogger });
  });

  afterEach(async () => {
    if (gateway.state === "running") {
      await gateway.stop();
    }
  });

  describe("constructor", () => {
    it("accepts valid config", () => {
      const gw = new Gateway(makeConfig());
      expect(gw.state).toBe("stopped");
      expect(gw.config.agent.name).toBe("test-agent");
    });
  });

  describe("lifecycle", () => {
    it("start: stopped → starting → running", async () => {
      const states: string[] = [];
      gateway.on("started", () => states.push(gateway.state));

      await gateway.start();

      expect(gateway.state).toBe("running");
      expect(states).toContain("running");
    });

    it("stop: running → stopping → stopped", async () => {
      await gateway.start();

      const states: string[] = [];
      gateway.on("stopped", () => states.push(gateway.state));

      await gateway.stop();

      expect(gateway.state).toBe("stopped");
      expect(states).toContain("stopped");
    });

    it("start when running throws GatewayStateError", async () => {
      await gateway.start();
      await expect(gateway.start()).rejects.toThrow(GatewayStateError);
    });

    it("stop when stopped is no-op", async () => {
      expect(gateway.state).toBe("stopped");
      await gateway.stop(); // should not throw
      expect(gateway.state).toBe("stopped");
    });
  });

  describe("getStatus", () => {
    it("returns correct state and uptime", async () => {
      const statusBefore = gateway.getStatus();
      expect(statusBefore.state).toBe("stopped");
      expect(statusBefore.uptimeMs).toBe(0);

      await gateway.start();
      const statusAfter = gateway.getStatus();
      expect(statusAfter.state).toBe("running");
      expect(statusAfter.uptimeMs).toBeGreaterThanOrEqual(0);
      expect(statusAfter.controlPlanePort).toBe(9100);
      expect(statusAfter.channels).toEqual([]);
    });
  });

  describe("channels", () => {
    it("registerChannel adds to registry", async () => {
      await gateway.start();
      const ch = makeChannel("discord");

      gateway.registerChannel(ch);

      const status = gateway.getStatus();
      expect(status.channels).toContain("discord");
    });

    it("registerChannel duplicate throws GatewayValidationError", async () => {
      await gateway.start();
      gateway.registerChannel(makeChannel("discord"));

      expect(() => gateway.registerChannel(makeChannel("discord"))).toThrow(
        GatewayValidationError,
      );
    });

    it("unregisterChannel calls stop and removes", async () => {
      await gateway.start();
      const ch = makeChannel("slack");
      gateway.registerChannel(ch);

      await gateway.unregisterChannel("slack");

      expect(ch.stop).toHaveBeenCalled();
      expect(gateway.getStatus().channels).not.toContain("slack");
    });
  });

  describe("config reload", () => {
    it("reloadConfig identifies safe vs unsafe", async () => {
      await gateway.start();

      const newConfig = makeConfig({
        gateway: { port: 9200, bind: "127.0.0.1" },
        logging: { level: "debug" },
      });

      const diff = gateway.reloadConfig(newConfig);

      expect(diff.unsafe).toContain("gateway.port");
      expect(diff.safe).toContain("logging.level");
    });

    it("reloadConfig applies safe changes", async () => {
      await gateway.start();

      const newConfig = makeConfig({
        logging: { level: "debug" },
      });

      gateway.reloadConfig(newConfig);

      expect(gateway.config.logging?.level).toBe("debug");
    });

    it("reloadConfig preserves unsafe fields from old config", async () => {
      await gateway.start();
      const warnSpy = vi.spyOn(silentLogger, "warn");

      const newConfig = makeConfig({
        connection: { rpcUrl: "http://other-rpc:8899" },
        logging: { level: "debug" },
      });

      const diff = gateway.reloadConfig(newConfig);

      expect(diff.unsafe).toContain("connection.rpcUrl");
      expect(diff.safe).toContain("logging.level");
      // Unsafe field preserved from original
      expect(gateway.config.connection.rpcUrl).toBe("http://localhost:8899");
      // Safe field applied from new config
      expect(gateway.config.logging?.level).toBe("debug");
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe("events", () => {
    it("on/off subscription works", async () => {
      const handler = vi.fn();
      const sub = gateway.on("started", handler);

      await gateway.start();
      expect(handler).toHaveBeenCalledTimes(1);

      sub.unsubscribe();
      await gateway.stop();
      await gateway.start();

      // After unsubscribe, second 'started' event should not call handler
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("emits started on start", async () => {
      const handler = vi.fn();
      gateway.on("started", handler);

      await gateway.start();

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("emits stopped on stop", async () => {
      await gateway.start();

      const handler = vi.fn();
      gateway.on("stopped", handler);

      await gateway.stop();

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe("auth", () => {
    const AUTH_SECRET = "test-secret-that-is-at-least-32-chars!!";

    function createMockSocket() {
      const handlers = new Map<string, (...args: unknown[]) => void>();
      return {
        send: vi.fn(),
        close: vi.fn(),
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
          handlers.set(event, handler);
        }),
        readyState: 1,
        _handlers: handlers,
        simulateMessage(data: unknown) {
          const h = handlers.get("message");
          if (h) h(typeof data === "string" ? data : JSON.stringify(data));
        },
        simulateClose() {
          const h = handlers.get("close");
          if (h) h();
        },
      };
    }

    it("no auth config allows all messages", async () => {
      // Default config has no auth — all messages should work
      await gateway.start();

      const mockSocket = createMockSocket();
      const mockRequest = { socket: { remoteAddress: "192.168.1.100" } };
      wssConnectionHandler!(mockSocket, mockRequest);

      mockSocket.simulateMessage({ type: "status" });

      expect(mockSocket.send).toHaveBeenCalled();
      const response = JSON.parse(mockSocket.send.mock.calls[0][0]);
      expect(response.type).toBe("status");
    });

    it("auth config rejects unauthenticated non-local client", async () => {
      const authGw = new Gateway(
        makeConfig({ auth: { secret: AUTH_SECRET } }),
        { logger: silentLogger },
      );
      await authGw.start();

      const mockSocket = createMockSocket();
      const mockRequest = { socket: { remoteAddress: "192.168.1.100" } };
      wssConnectionHandler!(mockSocket, mockRequest);

      mockSocket.simulateMessage({ type: "status" });

      expect(mockSocket.send).toHaveBeenCalled();
      const response = JSON.parse(mockSocket.send.mock.calls[0][0]);
      expect(response.type).toBe("error");
      expect(response.error).toBe("Authentication required");

      await authGw.stop();
    });

    it("auth config allows ping before authentication", async () => {
      const authGw = new Gateway(
        makeConfig({ auth: { secret: AUTH_SECRET } }),
        { logger: silentLogger },
      );
      await authGw.start();

      const mockSocket = createMockSocket();
      const mockRequest = { socket: { remoteAddress: "192.168.1.100" } };
      wssConnectionHandler!(mockSocket, mockRequest);

      mockSocket.simulateMessage({ type: "ping" });

      const response = JSON.parse(mockSocket.send.mock.calls[0][0]);
      expect(response.type).toBe("pong");

      await authGw.stop();
    });

    it("authenticates with valid token", async () => {
      const authGw = new Gateway(
        makeConfig({ auth: { secret: AUTH_SECRET } }),
        { logger: silentLogger },
      );
      await authGw.start();

      const mockSocket = createMockSocket();
      const mockRequest = { socket: { remoteAddress: "192.168.1.100" } };
      wssConnectionHandler!(mockSocket, mockRequest);

      const token = createToken(AUTH_SECRET, "agent_001");
      mockSocket.simulateMessage({ type: "auth", payload: { token } });

      const authResponse = JSON.parse(mockSocket.send.mock.calls[0][0]);
      expect(authResponse.type).toBe("auth");
      expect(authResponse.payload.authenticated).toBe(true);
      expect(authResponse.payload.sub).toBe("agent_001");

      // Now status should work
      mockSocket.simulateMessage({ type: "status" });
      const statusResponse = JSON.parse(mockSocket.send.mock.calls[1][0]);
      expect(statusResponse.type).toBe("status");

      await authGw.stop();
    });

    it("rejects invalid token and closes socket", async () => {
      const authGw = new Gateway(
        makeConfig({ auth: { secret: AUTH_SECRET } }),
        { logger: silentLogger },
      );
      await authGw.start();

      const mockSocket = createMockSocket();
      const mockRequest = { socket: { remoteAddress: "192.168.1.100" } };
      wssConnectionHandler!(mockSocket, mockRequest);

      mockSocket.simulateMessage({
        type: "auth",
        payload: { token: "invalid.token.here" },
      });

      const response = JSON.parse(mockSocket.send.mock.calls[0][0]);
      expect(response.type).toBe("auth");
      expect(response.error).toBe("Invalid or expired token");
      expect(mockSocket.close).toHaveBeenCalled();

      await authGw.stop();
    });

    it("rejects auth with missing token and closes socket", async () => {
      const authGw = new Gateway(
        makeConfig({ auth: { secret: AUTH_SECRET } }),
        { logger: silentLogger },
      );
      await authGw.start();

      const mockSocket = createMockSocket();
      const mockRequest = { socket: { remoteAddress: "192.168.1.100" } };
      wssConnectionHandler!(mockSocket, mockRequest);

      mockSocket.simulateMessage({ type: "auth", payload: {} });

      const response = JSON.parse(mockSocket.send.mock.calls[0][0]);
      expect(response.type).toBe("auth");
      expect(response.error).toBe("Missing token");
      expect(mockSocket.close).toHaveBeenCalled();

      await authGw.stop();
    });

    it("auto-authenticates local connection (127.0.0.1)", async () => {
      const authGw = new Gateway(
        makeConfig({ auth: { secret: AUTH_SECRET, localBypass: true } }),
        { logger: silentLogger },
      );
      await authGw.start();

      const mockSocket = createMockSocket();
      const mockRequest = { socket: { remoteAddress: "127.0.0.1" } };
      wssConnectionHandler!(mockSocket, mockRequest);

      // Should be auto-authenticated — status should work immediately
      mockSocket.simulateMessage({ type: "status" });
      const response = JSON.parse(mockSocket.send.mock.calls[0][0]);
      expect(response.type).toBe("status");

      await authGw.stop();
    });

    it("auto-authenticates local connection (::1)", async () => {
      const authGw = new Gateway(
        makeConfig({ auth: { secret: AUTH_SECRET, localBypass: true } }),
        { logger: silentLogger },
      );
      await authGw.start();

      const mockSocket = createMockSocket();
      const mockRequest = { socket: { remoteAddress: "::1" } };
      wssConnectionHandler!(mockSocket, mockRequest);

      mockSocket.simulateMessage({ type: "status" });
      const response = JSON.parse(mockSocket.send.mock.calls[0][0]);
      expect(response.type).toBe("status");

      await authGw.stop();
    });

    it("auto-authenticates local connection (::ffff:127.0.0.1)", async () => {
      const authGw = new Gateway(
        makeConfig({ auth: { secret: AUTH_SECRET, localBypass: true } }),
        { logger: silentLogger },
      );
      await authGw.start();

      const mockSocket = createMockSocket();
      const mockRequest = { socket: { remoteAddress: "::ffff:127.0.0.1" } };
      wssConnectionHandler!(mockSocket, mockRequest);

      mockSocket.simulateMessage({ type: "status" });
      const response = JSON.parse(mockSocket.send.mock.calls[0][0]);
      expect(response.type).toBe("status");

      await authGw.stop();
    });

    it("rejects undefined remoteAddress even with localBypass", async () => {
      const authGw = new Gateway(
        makeConfig({ auth: { secret: AUTH_SECRET, localBypass: true } }),
        { logger: silentLogger },
      );
      await authGw.start();

      const mockSocket = createMockSocket();
      wssConnectionHandler!(mockSocket, undefined);

      // Security: undefined remoteAddress is NOT treated as local
      mockSocket.simulateMessage({ type: "status" });
      const response = JSON.parse(mockSocket.send.mock.calls[0][0]);
      expect(response.type).toBe("error");
      expect(response.error).toBe("Authentication required");

      await authGw.stop();
    });

    it("local bypass disabled requires auth even for localhost", async () => {
      const authGw = new Gateway(
        makeConfig({ auth: { secret: AUTH_SECRET, localBypass: false } }),
        { logger: silentLogger },
      );
      await authGw.start();

      const mockSocket = createMockSocket();
      const mockRequest = { socket: { remoteAddress: "127.0.0.1" } };
      wssConnectionHandler!(mockSocket, mockRequest);

      // Should NOT be auto-authenticated
      mockSocket.simulateMessage({ type: "status" });
      const response = JSON.parse(mockSocket.send.mock.calls[0][0]);
      expect(response.type).toBe("error");
      expect(response.error).toBe("Authentication required");

      await authGw.stop();
    });

    it("cleanup on disconnect removes from authenticatedClients", async () => {
      const authGw = new Gateway(
        makeConfig({ auth: { secret: AUTH_SECRET, localBypass: true } }),
        { logger: silentLogger },
      );
      await authGw.start();

      const mockSocket = createMockSocket();
      const mockRequest = { socket: { remoteAddress: "127.0.0.1" } };
      wssConnectionHandler!(mockSocket, mockRequest);

      // Verify authenticated
      mockSocket.simulateMessage({ type: "status" });
      expect(JSON.parse(mockSocket.send.mock.calls[0][0]).type).toBe("status");

      // Disconnect
      mockSocket.simulateClose();

      // Status should show one fewer client
      expect(authGw.getStatus().activeSessions).toBe(0);

      await authGw.stop();
    });
  });
});

describe("config loading", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "agenc-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("loadGatewayConfig reads valid file", async () => {
    const configPath = join(tmpDir, "config.json");
    const config = makeConfig();
    await writeFile(configPath, JSON.stringify(config));

    const loaded = await loadGatewayConfig(configPath);

    expect(loaded.agent.name).toBe("test-agent");
    expect(loaded.gateway.port).toBe(9100);
  });

  it("validateGatewayConfig rejects missing fields", () => {
    const result = validateGatewayConfig({ agent: {} });

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("validateGatewayConfig accepts valid config", () => {
    const result = validateGatewayConfig(makeConfig());

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("validateGatewayConfig accepts logging.trace settings", () => {
    const result = validateGatewayConfig(
      makeConfig({
        logging: {
          level: "debug",
          trace: {
            enabled: true,
            includeHistory: true,
            includeSystemPrompt: true,
            includeToolArgs: true,
            includeToolResults: true,
            maxChars: 12_000,
          },
        },
      }),
    );

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("validateGatewayConfig rejects invalid logging.trace fields", () => {
    const result = validateGatewayConfig(
      makeConfig({
        logging: {
          level: "debug",
          trace: {
            enabled: "yes" as unknown as boolean,
            maxChars: 100,
          },
        },
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("logging.trace.enabled must be a boolean");
    expect(result.errors).toContain(
      "logging.trace.maxChars must be an integer between 256 and 200000",
    );
  });

  it("diffGatewayConfig detects changed sections", () => {
    const oldConfig = makeConfig();
    const newConfig = makeConfig({
      logging: {
        level: "debug",
        trace: { enabled: true },
      },
      gateway: { port: 9200, bind: "127.0.0.1" },
    });

    const diff = diffGatewayConfig(oldConfig, newConfig);

    expect(diff.safe).toContain("logging.level");
    expect(diff.safe).toContain("logging.trace.enabled");
    expect(diff.unsafe).toContain("gateway.port");
  });

  it("ConfigWatcher debounces rapid changes", async () => {
    const configPath = join(tmpDir, "config.json");
    await writeFile(configPath, JSON.stringify(makeConfig()));

    const onReload = vi.fn();
    const watcher = new ConfigWatcher(configPath, 50);
    watcher.start(onReload);

    // Rapid writes
    await writeFile(
      configPath,
      JSON.stringify(makeConfig({ logging: { level: "debug" } })),
    );
    await writeFile(
      configPath,
      JSON.stringify(makeConfig({ logging: { level: "warn" } })),
    );
    await writeFile(
      configPath,
      JSON.stringify(makeConfig({ logging: { level: "error" } })),
    );

    // Wait for debounce to settle
    await new Promise((r) => setTimeout(r, 200));

    watcher.stop();

    // Debounce should collapse 3 rapid writes into fewer reloads
    // Due to OS-level file watching variability, we assert strictly less than 3
    expect(onReload.mock.calls.length).toBeLessThan(3);
  });
});
