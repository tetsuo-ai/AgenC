import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createDesktopAwareToolHandler,
  destroySessionBridge,
} from "./session-router.js";
import type { DesktopSandboxManager } from "./manager.js";
import { DesktopRESTBridge } from "./rest-bridge.js";
import type { ToolHandler } from "../llm/types.js";
import { createMCPConnection } from "../mcp-client/connection.js";
import { createToolBridge } from "../mcp-client/tool-bridge.js";

const mockCreateMCPConnection = vi.mocked(createMCPConnection);
const mockCreateToolBridge = vi.mocked(createToolBridge);

// Mock the DesktopRESTBridge constructor and instances
vi.mock("./rest-bridge.js", () => {
  const mockTools = [
    {
      name: "desktop.screenshot",
      description: "Take a screenshot",
      inputSchema: {},
      execute: vi.fn().mockResolvedValue({
        content: '{"image":"abc","width":1024,"height":768,"dataUrl":"data:image/png;base64,abc"}',
      }),
    },
    {
      name: "desktop.mouse_click",
      description: "Click mouse",
      inputSchema: {},
      execute: vi.fn().mockResolvedValue({
        content: '{"clicked":true}',
      }),
    },
    {
      name: "desktop.bash",
      description: "Run bash command",
      inputSchema: {},
      execute: vi.fn().mockResolvedValue({
        content: '{"stdout":"hello","exitCode":0}',
      }),
    },
  ];

  return {
    DesktopRESTBridge: vi.fn().mockImplementation(() => ({
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      isConnected: vi.fn().mockReturnValue(true),
      getTools: vi.fn().mockReturnValue(mockTools),
    })),
  };
});

vi.mock("../mcp-client/connection.js", () => ({
  createMCPConnection: vi.fn(),
}));

vi.mock("../mcp-client/tool-bridge.js", () => ({
  createToolBridge: vi.fn(),
}));

function mockManager(overrides: Partial<DesktopSandboxManager> = {}): DesktopSandboxManager {
  return {
    getOrCreate: vi.fn().mockResolvedValue({
      containerId: "test-container",
      apiHostPort: 32769,
      vncHostPort: 32768,
    }),
    destroyBySession: vi.fn().mockResolvedValue(undefined),
    getHandleBySession: vi.fn().mockReturnValue({
      containerId: "test-container",
    }),
    touchActivity: vi.fn(),
    ...overrides,
  } as unknown as DesktopSandboxManager;
}

describe("createDesktopAwareToolHandler", () => {
  let baseHandler: ToolHandler;
  let bridges: Map<string, DesktopRESTBridge>;

  beforeEach(() => {
    baseHandler = vi.fn().mockResolvedValue('{"result":"from base"}');
    bridges = new Map();
    vi.clearAllMocks();
  });

  it("delegates non-desktop tools to base handler", async () => {
    const manager = mockManager();
    const handler = createDesktopAwareToolHandler(baseHandler, "sess1", {
      desktopManager: manager,
      bridges,
    });

    const result = await handler("agenc.listTasks", {});
    expect(result).toBe('{"result":"from base"}');
    expect(baseHandler).toHaveBeenCalledWith("agenc.listTasks", {});
    expect(manager.getOrCreate).not.toHaveBeenCalled();
  });

  it("routes desktop.* tools to sandbox bridge", async () => {
    const manager = mockManager();
    const handler = createDesktopAwareToolHandler(baseHandler, "sess1", {
      desktopManager: manager,
      bridges,
    });

    const result = await handler("desktop.mouse_click", { x: 100, y: 200 });
    expect(baseHandler).not.toHaveBeenCalled();
    expect(manager.getOrCreate).toHaveBeenCalledWith("sess1");
    expect(result).toContain("clicked");
  });

  it("creates sandbox lazily on first desktop tool call", async () => {
    const manager = mockManager();
    const handler = createDesktopAwareToolHandler(baseHandler, "sess1", {
      desktopManager: manager,
      bridges,
    });

    expect(bridges.size).toBe(0);
    await handler("desktop.mouse_click", { x: 10, y: 10 });
    expect(bridges.size).toBe(1);
    expect(bridges.has("sess1")).toBe(true);
  });

  it("reuses existing bridge on subsequent calls", async () => {
    const manager = mockManager();
    const handler = createDesktopAwareToolHandler(baseHandler, "sess1", {
      desktopManager: manager,
      bridges,
    });

    await handler("desktop.mouse_click", { x: 0, y: 0 });
    await handler("desktop.bash", { command: "echo hi" });

    // getOrCreate called only once (lazy init)
    expect(manager.getOrCreate).toHaveBeenCalledTimes(1);
  });

  it("resets idle timer on each tool call", async () => {
    const manager = mockManager();
    const handler = createDesktopAwareToolHandler(baseHandler, "sess1", {
      desktopManager: manager,
      bridges,
    });

    await handler("desktop.mouse_click", { x: 10, y: 10 });
    expect(manager.touchActivity).toHaveBeenCalledWith("test-container");
  });

  it("returns error when sandbox creation fails", async () => {
    const manager = mockManager({
      getOrCreate: vi.fn().mockRejectedValue(new Error("pool exhausted")),
    } as unknown as Partial<DesktopSandboxManager>);
    const handler = createDesktopAwareToolHandler(baseHandler, "sess1", {
      desktopManager: manager,
      bridges,
    });

    const result = await handler("desktop.mouse_click", { x: 1, y: 2 });
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("Desktop sandbox unavailable");
  });

  it("returns error for desktop.screenshot (disabled)", async () => {
    const manager = mockManager();
    const handler = createDesktopAwareToolHandler(baseHandler, "sess1", {
      desktopManager: manager,
      bridges,
    });

    const result = await handler("desktop.screenshot", {});
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("desktop.screenshot is disabled");
    expect(manager.getOrCreate).not.toHaveBeenCalled();
  });

  it("returns error for unknown desktop tool", async () => {
    const manager = mockManager();
    const handler = createDesktopAwareToolHandler(baseHandler, "sess1", {
      desktopManager: manager,
      bridges,
    });

    const result = await handler("desktop.nonexistent", {});
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("Unknown desktop tool");
  });

  it("guards desktop.bash against interactive REPL commands", async () => {
    const manager = mockManager();
    const handler = createDesktopAwareToolHandler(baseHandler, "sess1", {
      desktopManager: manager,
      bridges,
    });

    const result = await handler("desktop.bash", { command: "python3" });
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("interactive shell/REPL");
  });

  it("guards desktop.bash against incomplete single-word commands", async () => {
    const manager = mockManager();
    const handler = createDesktopAwareToolHandler(baseHandler, "sess1", {
      desktopManager: manager,
      bridges,
    });

    const result = await handler("desktop.bash", { command: "which" });
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("incomplete");
    expect(parsed.error).toContain("which python3");
  });

  it("guards browser launch commands without a URL target", async () => {
    const manager = mockManager();
    const handler = createDesktopAwareToolHandler(baseHandler, "sess1", {
      desktopManager: manager,
      bridges,
    });

    const result = await handler("desktop.bash", { command: "chromium-browser" });
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("chromium-browser http://localhost:8000");
    expect(parsed.error).toContain("playwright.browser_navigate");
  });

  it("guards browser launch commands that are not backgrounded", async () => {
    const manager = mockManager();
    const handler = createDesktopAwareToolHandler(baseHandler, "sess1", {
      desktopManager: manager,
      bridges,
    });

    const result = await handler("desktop.bash", {
      command: "chromium-browser http://localhost:8000",
    });
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("run in background");
    expect(parsed.error).toContain("playwright.browser_navigate");
  });

  it("guards backgrounded browser launches without explicit stdout/stderr redirection", async () => {
    const manager = mockManager();
    const handler = createDesktopAwareToolHandler(baseHandler, "sess1", {
      desktopManager: manager,
      bridges,
    });

    const result = await handler("desktop.bash", {
      command: "chromium-browser http://localhost:8000 &",
    });
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("missing explicit stdout/stderr redirection");
    expect(parsed.error).toContain(">/tmp/browser.log 2>&1 &");
  });

  it("rewrites chromium launch commands with an isolated user-data-dir", async () => {
    const manager = mockManager();
    const bridgeCtor = vi.mocked(DesktopRESTBridge);
    const bashExecute = vi.fn().mockResolvedValue({
      content: '{"stdout":"","stderr":"","exitCode":0}',
      isError: false,
    });

    bridgeCtor.mockImplementationOnce(
      () =>
        ({
          connect: vi.fn().mockResolvedValue(undefined),
          disconnect: vi.fn(),
          isConnected: vi.fn().mockReturnValue(true),
          getTools: vi.fn().mockReturnValue([
            {
              name: "desktop.bash",
              description: "Run bash command",
              inputSchema: {},
              execute: bashExecute,
            },
          ]),
        }) as unknown as DesktopRESTBridge,
    );

    const handler = createDesktopAwareToolHandler(baseHandler, "sess1", {
      desktopManager: manager,
      bridges,
    });

    await handler("desktop.bash", {
      command: "chromium-browser http://localhost:8000 >/dev/null 2>&1 &",
    });

    expect(bashExecute).toHaveBeenCalledTimes(1);
    const callArgs = bashExecute.mock.calls[0][0] as { command?: string };
    expect(callArgs.command).toContain("--new-window");
    expect(callArgs.command).toContain("--incognito");
    expect(callArgs.command).toContain("--no-first-run");
    expect(callArgs.command).toContain("--no-default-browser-check");
    expect(callArgs.command).toContain("--disable-default-apps");
    expect(callArgs.command).toContain("--disable-sync");
    expect(callArgs.command).toContain("--user-data-dir=/tmp/agenc-chrome-");
    expect(callArgs.command).toContain("http://localhost:8000");
  });

  it("strips unsupported chromium sandbox flags from desktop.bash launch commands", async () => {
    const manager = mockManager();
    const bridgeCtor = vi.mocked(DesktopRESTBridge);
    const bashExecute = vi.fn().mockResolvedValue({
      content: '{"stdout":"","stderr":"","exitCode":0}',
      isError: false,
    });

    bridgeCtor.mockImplementationOnce(
      () =>
        ({
          connect: vi.fn().mockResolvedValue(undefined),
          disconnect: vi.fn(),
          isConnected: vi.fn().mockReturnValue(true),
          getTools: vi.fn().mockReturnValue([
            {
              name: "desktop.bash",
              description: "Run bash command",
              inputSchema: {},
              execute: bashExecute,
            },
          ]),
        }) as unknown as DesktopRESTBridge,
    );

    const handler = createDesktopAwareToolHandler(baseHandler, "sess1", {
      desktopManager: manager,
      bridges,
    });

    await handler("desktop.bash", {
      command:
        "chromium-browser --disable-setuid-sandbox --no-sandbox http://localhost:8000 >/tmp/browser.log 2>&1 &",
    });

    const callArgs = bashExecute.mock.calls[0][0] as { command?: string };
    expect(callArgs.command).not.toContain("--disable-setuid-sandbox");
    expect(callArgs.command).not.toContain("--no-sandbox");
  });

  it("guards long-running foreground server commands with short timeout", async () => {
    const manager = mockManager();
    const handler = createDesktopAwareToolHandler(baseHandler, "sess1", {
      desktopManager: manager,
      bridges,
    });

    const result = await handler("desktop.bash", {
      command: "python3 -m http.server 8000",
      timeoutMs: 5_000,
    });
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("long-running server process");
    expect(parsed.error).toContain("append `&`");
  });

  it("guards long-running server commands even when prefixed with cd &&", async () => {
    const manager = mockManager();
    const handler = createDesktopAwareToolHandler(baseHandler, "sess1", {
      desktopManager: manager,
      bridges,
    });

    const result = await handler("desktop.bash", {
      command: "cd /home/agenc && python3 -m http.server 8000",
      timeoutMs: 5_000,
    });
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("long-running server process");
    expect(parsed.error).toContain("append `&`");
  });

  it("allows long-running server commands when already backgrounded", async () => {
    const manager = mockManager();
    const handler = createDesktopAwareToolHandler(baseHandler, "sess1", {
      desktopManager: manager,
      bridges,
    });

    const result = await handler("desktop.bash", {
      command: "python3 -m http.server 8000 >/tmp/server.log 2>&1 &",
      timeoutMs: 5_000,
    });
    expect(JSON.parse(result)).toMatchObject({ stdout: "hello", exitCode: 0 });
  });

  it("allows backgrounded long-running servers when command ends with '& echo $!'", async () => {
    const manager = mockManager();
    const handler = createDesktopAwareToolHandler(baseHandler, "sess1", {
      desktopManager: manager,
      bridges,
    });

    const result = await handler("desktop.bash", {
      command: "python3 -m http.server 8000 >/tmp/server.log 2>&1 & echo $!",
      timeoutMs: 5_000,
    });
    expect(JSON.parse(result)).toMatchObject({ stdout: "hello", exitCode: 0 });
  });

  it("guards backgrounded long-running servers without output redirection", async () => {
    const manager = mockManager();
    const handler = createDesktopAwareToolHandler(baseHandler, "sess1", {
      desktopManager: manager,
      bridges,
    });

    const result = await handler("desktop.bash", {
      command: "python3 -m http.server 8000 &",
      timeoutMs: 5_000,
    });
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("does not redirect both stdout/stderr");
    expect(parsed.error).toContain(">/tmp/server.log 2>&1 &");
  });

  it("adds low-token verification guidance to successful browser launch results", async () => {
    const manager = mockManager();
    const handler = createDesktopAwareToolHandler(baseHandler, "sess1", {
      desktopManager: manager,
      bridges,
    });

    const result = await handler("desktop.bash", {
      command: "chromium-browser http://localhost:8000 >/tmp/browser.log 2>&1 &",
    });

    const parsed = JSON.parse(result) as { verification?: { strategy?: string; checks?: string[] } };
    expect(parsed.verification?.strategy).toBe("low_token_first");
    expect(parsed.verification?.checks?.length).toBeGreaterThan(0);
  });

  it("does not flag pgrep checks as long-running server launches", async () => {
    const manager = mockManager();
    const handler = createDesktopAwareToolHandler(baseHandler, "sess1", {
      desktopManager: manager,
      bridges,
    });

    const result = await handler("desktop.bash", {
      command: "pgrep -fa 'python3 -m http.server 8000'",
      timeoutMs: 5_000,
    });
    expect(JSON.parse(result)).toMatchObject({ stdout: "hello", exitCode: 0 });
  });

  it("does not flag pkill teardown checks as long-running server launches", async () => {
    const manager = mockManager();
    const handler = createDesktopAwareToolHandler(baseHandler, "sess1", {
      desktopManager: manager,
      bridges,
    });

    const result = await handler("desktop.bash", {
      command:
        "pkill -f 'python3 -m http.server 8000' || true\nsleep 1\nss -ltn '( sport = :8000 )' | tail -n +2 | wc -l || true",
      timeoutMs: 5_000,
    });
    expect(JSON.parse(result)).toMatchObject({ stdout: "hello", exitCode: 0 });
  });

  it("infers window_focus title from window_list when title is omitted", async () => {
    const manager = mockManager();
    const bridgeCtor = vi.mocked(DesktopRESTBridge);
    const windowListExecute = vi.fn().mockResolvedValue({
      content:
        '{"windows":[{"id":"11","title":"Chromium - http://localhost:8000"}],"totalWindows":1}',
      isError: false,
    });
    const windowFocusExecute = vi.fn().mockResolvedValue({
      content: '{"focused":true,"windowId":"11"}',
      isError: false,
    });

    bridgeCtor.mockImplementationOnce(
      () =>
        ({
          connect: vi.fn().mockResolvedValue(undefined),
          disconnect: vi.fn(),
          isConnected: vi.fn().mockReturnValue(true),
          getTools: vi.fn().mockReturnValue([
            {
              name: "desktop.window_list",
              description: "List windows",
              inputSchema: {},
              execute: windowListExecute,
            },
            {
              name: "desktop.window_focus",
              description: "Focus window",
              inputSchema: {},
              execute: windowFocusExecute,
            },
          ]),
        }) as unknown as DesktopRESTBridge,
    );

    const handler = createDesktopAwareToolHandler(baseHandler, "sess1", {
      desktopManager: manager,
      bridges,
    });
    const result = await handler("desktop.window_focus", {});

    expect(JSON.parse(result)).toMatchObject({ focused: true, windowId: "11" });
    expect(windowFocusExecute).toHaveBeenCalledWith({
      title: "Chromium - http://localhost:8000",
    });
  });

  it("recycles sandbox and retries once when desktop tool reports transient fetch failure", async () => {
    const manager = mockManager();
    const bridgeCtor = vi.mocked(DesktopRESTBridge);

    const failingBridge = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      isConnected: vi.fn().mockReturnValue(true),
      getTools: vi.fn().mockReturnValue([
        {
          name: "desktop.bash",
          description: "Run bash command",
          inputSchema: {},
          execute: vi.fn().mockResolvedValue({
            content: '{"error":"Tool execution failed: fetch failed"}',
            isError: true,
          }),
        },
      ]),
    } as unknown as DesktopRESTBridge;

    const recoveredBridge = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      isConnected: vi.fn().mockReturnValue(true),
      getTools: vi.fn().mockReturnValue([
        {
          name: "desktop.bash",
          description: "Run bash command",
          inputSchema: {},
          execute: vi.fn().mockResolvedValue({
            content: '{"stdout":"recovered","exitCode":0}',
            isError: false,
          }),
        },
      ]),
    } as unknown as DesktopRESTBridge;

    bridgeCtor
      .mockImplementationOnce(() => failingBridge)
      .mockImplementationOnce(() => recoveredBridge);

    const handler = createDesktopAwareToolHandler(baseHandler, "sess1", {
      desktopManager: manager,
      bridges,
    });

    const result = await handler("desktop.bash", { command: "echo hi" });

    expect(JSON.parse(result)).toMatchObject({ stdout: "recovered", exitCode: 0 });
    expect((manager.destroyBySession as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("sess1");
    expect(bridgeCtor).toHaveBeenCalledTimes(2);
  });

  it("runs a desktop pipeline flow (start, navigate, input, verify, teardown) without hanging", async () => {
    const manager = mockManager();
    const bridgeCtor = vi.mocked(DesktopRESTBridge);
    const bashExecute = vi.fn().mockImplementation(
      async ({ command }: { command?: string }) => {
        const cmd = command ?? "";
        if (cmd.includes("python3 -m http.server")) {
          return {
            content: '{"stdout":"","stderr":"","exitCode":0,"backgrounded":true,"pid":1234}',
            isError: false,
          };
        }
        if (cmd.includes("curl -sSf")) {
          return {
            content: '{"stdout":"HTTP_OK\\n","stderr":"","exitCode":0}',
            isError: false,
          };
        }
        if (cmd.includes("pkill -f")) {
          return {
            content: '{"stdout":"0\\n","stderr":"","exitCode":0}',
            isError: false,
          };
        }
        return {
          content: '{"stdout":"","stderr":"","exitCode":0}',
          isError: false,
        };
      },
    );
    const keyboardExecute = vi.fn().mockResolvedValue({
      content: '{"typed":true,"length":12}',
      isError: false,
    });

    bridgeCtor.mockImplementationOnce(
      () =>
        ({
          connect: vi.fn().mockResolvedValue(undefined),
          disconnect: vi.fn(),
          isConnected: vi.fn().mockReturnValue(true),
          getTools: vi.fn().mockReturnValue([
            {
              name: "desktop.bash",
              description: "Run bash command",
              inputSchema: {},
              execute: bashExecute,
            },
            {
              name: "desktop.keyboard_type",
              description: "Type text",
              inputSchema: {},
              execute: keyboardExecute,
            },
          ]),
        }) as unknown as DesktopRESTBridge,
    );

    const navigateExecute = vi.fn().mockResolvedValue({
      content: '{"ok":true}',
    });
    mockCreateMCPConnection.mockResolvedValue({
      close: vi.fn(),
    } as any);
    mockCreateToolBridge.mockResolvedValue({
      tools: [
        {
          name: "playwright.browser_navigate",
          description: "Navigate to URL",
          inputSchema: {},
          execute: navigateExecute,
        },
      ],
      dispose: vi.fn(),
    } as any);

    const playwrightBridges = new Map<string, never>();
    const handler = createDesktopAwareToolHandler(baseHandler, "sess1", {
      desktopManager: manager,
      bridges,
      playwrightBridges,
    });

    const fixture = await handler("desktop.bash", {
      command:
        "rm -rf /tmp/agenc-pipeline-test && mkdir -p /tmp/agenc-pipeline-test && echo ok >/tmp/agenc-pipeline-test/index.html",
    });
    expect(JSON.parse(fixture)).toMatchObject({ exitCode: 0 });

    const started = await handler("desktop.bash", {
      command:
        "cd /tmp/agenc-pipeline-test && python3 -m http.server 8123 >/tmp/agenc-http.log 2>&1 & echo $!",
      timeoutMs: 60_000,
    });
    expect(JSON.parse(started)).toMatchObject({ exitCode: 0, backgrounded: true });

    const navigated = await handler("playwright.browser_navigate", {
      url: "http://127.0.0.1:8123",
    });
    expect(JSON.parse(navigated)).toMatchObject({ ok: true });

    const typed = await handler("desktop.keyboard_type", { text: "pipeline ok" });
    expect(JSON.parse(typed)).toMatchObject({ typed: true });

    const verified = await handler("desktop.bash", {
      command: "curl -sSf http://127.0.0.1:8123 | grep -q 'ok' && echo HTTP_OK",
    });
    expect(JSON.parse(verified)).toMatchObject({ stdout: "HTTP_OK\n", exitCode: 0 });

    const teardown = await handler("desktop.bash", {
      command: "pkill -f 'python3 -m http.server 8123' || true",
    });
    expect(JSON.parse(teardown)).toMatchObject({ exitCode: 0 });
  });

  describe("auto-screenshot", () => {
    it("does not append screenshots even when autoScreenshot is true", async () => {
      const manager = mockManager();
      const handler = createDesktopAwareToolHandler(baseHandler, "sess1", {
        desktopManager: manager,
        bridges,
        autoScreenshot: true,
      });

      const result = await handler("desktop.mouse_click", { x: 100, y: 200 });
      const parsed = JSON.parse(result);
      expect(parsed.clicked).toBe(true);
      expect(parsed._screenshot).toBeUndefined();
    });

    it("does not delay bash responses for screenshot capture", async () => {
      const manager = mockManager();
      const handler = createDesktopAwareToolHandler(baseHandler, "sess1", {
        desktopManager: manager,
        bridges,
        autoScreenshot: true,
      });

      const start = Date.now();
      const result = await handler("desktop.bash", { command: "ls" });
      const elapsed = Date.now() - start;
      const parsed = JSON.parse(result);
      expect(parsed.stdout).toBe("hello");
      expect(parsed._screenshot).toBeUndefined();
      expect(elapsed).toBeLessThan(1000);
    });
  });

  describe("playwright bridge", () => {
    it("launches the expected Playwright MCP package and browser cache path", async () => {
      const manager = mockManager();
      const playwrightBridges = new Map<string, never>();
      const execute = vi.fn().mockResolvedValue({
        content: '{"ok":true}',
      });
      mockCreateMCPConnection.mockResolvedValue({
        close: vi.fn(),
      } as any);
      mockCreateToolBridge.mockResolvedValue({
        tools: [
          {
            name: "playwright.browser_navigate",
            description: "Navigate to URL",
            inputSchema: {},
            execute,
          },
        ],
        dispose: vi.fn(),
      } as any);

      const handler = createDesktopAwareToolHandler(baseHandler, "sess1", {
        desktopManager: manager,
        bridges,
        playwrightBridges,
      });

      const result = await handler("playwright.browser_navigate", { url: "https://example.com" });

      expect(result).toBe('{"ok":true}');
      expect(execute).toHaveBeenCalledWith({ url: "https://example.com" });
      expect(mockCreateMCPConnection).toHaveBeenCalledTimes(1);
      const config = mockCreateMCPConnection.mock.calls[0]?.[0];
      const args = config?.args as string[] | undefined;
      expect(config?.command).toBe("docker");
      expect(args).toContain("PLAYWRIGHT_BROWSERS_PATH=/home/agenc/.cache/ms-playwright");
      expect(args).not.toContain("--headless=false");
      expect(args).toEqual(
        expect.arrayContaining([
          "playwright-mcp",
        ]),
      );
    });
  });

  describe("container MCP bridge", () => {
    it("injects browser cache path and forwards env for container MCP", async () => {
      const manager = mockManager();
      const containerMCPConfigs = [
        {
          name: "browser",
          command: "npx",
          args: ["-y", "@playwright/mcp@0.0.68"],
          env: { FOO: "bar" },
        },
      ];
      const containerMCPBridges = new Map<string, never[]>();
      const execute = vi.fn().mockResolvedValue({
        content: '{"ok":true}',
      });
      mockCreateMCPConnection.mockResolvedValue({
        close: vi.fn(),
      } as any);
      mockCreateToolBridge.mockResolvedValue({
        tools: [
          {
            name: "mcp.browser.browser_navigate",
            description: "Navigate in container MCP browser",
            inputSchema: {},
            execute,
          },
        ],
        dispose: vi.fn(),
      } as any);

      const handler = createDesktopAwareToolHandler(baseHandler, "sess1", {
        desktopManager: manager,
        bridges,
        containerMCPConfigs,
        containerMCPBridges,
      });

      const result = await handler("mcp.browser.browser_navigate", {
        url: "https://example.com",
      });

      expect(result).toBe('{"ok":true}');
      expect(execute).toHaveBeenCalledWith({ url: "https://example.com" });
      expect(mockCreateMCPConnection).toHaveBeenCalledTimes(1);
      const config = mockCreateMCPConnection.mock.calls[0]?.[0];
      expect(config?.command).toBe("docker");
      const args = config?.args as string[] | undefined;
      const envIndex = (needle: string): number => args?.indexOf(needle) ?? -1;
      expect(args?.includes("PLAYWRIGHT_BROWSERS_PATH=/home/agenc/.cache/ms-playwright")).toBe(true);
      expect(args?.[envIndex("PLAYWRIGHT_BROWSERS_PATH=/home/agenc/.cache/ms-playwright") - 1]).toBe("-e");
      expect(args?.includes("FOO=bar")).toBe(true);
      expect(args?.[envIndex("FOO=bar") - 1]).toBe("-e");
      expect(args?.includes("DISPLAY=:1")).toBe(true);
      expect(args?.[envIndex("DISPLAY=:1") - 1]).toBe("-e");
      expect(args).toEqual(
        expect.arrayContaining([
          "playwright-mcp",
        ]),
      );
    });
  });
});

describe("destroySessionBridge", () => {
  it("disconnects and removes bridge", () => {
    const mockBridge = {
      disconnect: vi.fn(),
      isConnected: vi.fn().mockReturnValue(true),
      getTools: vi.fn().mockReturnValue([]),
      connect: vi.fn(),
    } as unknown as DesktopRESTBridge;

    const bridges = new Map<string, DesktopRESTBridge>();
    bridges.set("sess1", mockBridge);

    destroySessionBridge("sess1", bridges);
    expect(mockBridge.disconnect).toHaveBeenCalled();
    expect(bridges.has("sess1")).toBe(false);
  });

  it("is idempotent for unknown sessions", () => {
    const bridges = new Map<string, DesktopRESTBridge>();
    destroySessionBridge("unknown", bridges);
    expect(bridges.size).toBe(0);
  });
});
