import { describe, it, expect, vi } from "vitest";
import {
  SessionIsolationManager,
  type SessionIsolationManagerConfig,
  type AuthState,
} from "./session-isolation.js";
import type { AgentWorkspace } from "./workspace.js";
import type { WorkspaceManager } from "./workspace.js";
import { InMemoryBackend } from "../memory/in-memory/backend.js";
import { PolicyEngine } from "../policy/engine.js";
import type { Tool, ToolResult } from "../tools/types.js";
import type {
  LLMProvider,
  LLMResponse,
  LLMMessage,
  StreamProgressCallback,
} from "../llm/types.js";
import type { MarkdownSkill } from "../skills/markdown/types.js";

// ============================================================================
// Helpers
// ============================================================================

/** Lightweight mock for Keypair/PublicKey to avoid importing @solana/web3.js */
function makeMockKeypair(): { publicKey: { toBase58(): string } } {
  const pubkey = {
    toBase58: () => `mock-pubkey-${Math.random().toString(36).slice(2, 10)}`,
  };
  return { publicKey: pubkey };
}

function makeWorkspace(
  id: string,
  overrides?: Partial<AgentWorkspace>,
): AgentWorkspace {
  return {
    id,
    name: id,
    path: `/tmp/workspaces/${id}`,
    files: { agent: "", system: "", style: "", knowledge: "" },
    skills: [],
    memoryNamespace: `agenc:memory:${id}:`,
    capabilities: 0n,
    ...overrides,
  };
}

function makeMockWorkspaceManager(
  workspaces: Map<string, AgentWorkspace>,
): WorkspaceManager {
  return {
    basePath: "/tmp/workspaces",
    load: vi.fn(async (id: string) => {
      const ws = workspaces.get(id);
      if (!ws) throw new Error(`Workspace not found: ${id}`);
      return ws;
    }),
    listWorkspaces: vi.fn(async () => Array.from(workspaces.keys())),
    createWorkspace: vi.fn(),
    deleteWorkspace: vi.fn(),
    getDefault: vi.fn(() => "default"),
  } as unknown as WorkspaceManager;
}

function makeMockLLMProvider(name = "mock-llm"): LLMProvider {
  return {
    name,
    chat: vi.fn(
      async (_msgs: LLMMessage[]): Promise<LLMResponse> => ({
        content: "mock response",
        toolCalls: [],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        model: "mock",
        finishReason: "stop",
      }),
    ),
    chatStream: vi.fn(
      async (
        _msgs: LLMMessage[],
        _cb: StreamProgressCallback,
      ): Promise<LLMResponse> => ({
        content: "mock stream",
        toolCalls: [],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        model: "mock",
        finishReason: "stop",
      }),
    ),
    healthCheck: vi.fn(async () => true),
  };
}

function makeMockTool(name: string): Tool {
  return {
    name,
    description: `Mock tool: ${name}`,
    inputSchema: { type: "object", properties: {} },
    execute: vi.fn(
      async (): Promise<ToolResult> => ({
        content: `${name} result`,
      }),
    ),
  };
}

function makeMockSkill(name: string): MarkdownSkill {
  return {
    name,
    description: `Skill ${name}`,
    version: "1.0.0",
    metadata: {
      requires: { binaries: [], env: [], channels: [], os: [] },
      install: [],
      tags: [],
    },
    body: `# ${name}`,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("SessionIsolationManager", () => {
  function makeManager(
    overrides?: Partial<SessionIsolationManagerConfig>,
    workspaces?: Map<string, AgentWorkspace>,
  ): SessionIsolationManager {
    const wsMap =
      workspaces ??
      new Map([
        ["ws-a", makeWorkspace("ws-a")],
        ["ws-b", makeWorkspace("ws-b")],
      ]);
    return new SessionIsolationManager({
      workspaceManager: makeMockWorkspaceManager(wsMap),
      ...overrides,
    });
  }

  // --- Isolation -----------------------------------------------------------

  it("different workspaces get different memory backends", async () => {
    const mgr = makeManager();
    const ctxA = await mgr.getContext("ws-a");
    const ctxB = await mgr.getContext("ws-b");
    expect(ctxA.memoryBackend).not.toBe(ctxB.memoryBackend);
  });

  it("different workspaces get different policy engines", async () => {
    const mgr = makeManager();
    const ctxA = await mgr.getContext("ws-a");
    const ctxB = await mgr.getContext("ws-b");
    expect(ctxA.policyEngine).not.toBe(ctxB.policyEngine);
  });

  it("memory writes in workspace A not visible in workspace B", async () => {
    const mgr = makeManager();
    const ctxA = await mgr.getContext("ws-a");
    const ctxB = await mgr.getContext("ws-b");

    await ctxA.memoryBackend.addEntry({
      sessionId: "test-session",
      role: "user",
      content: "secret message from A",
    });

    const threadA = await ctxA.memoryBackend.getThread("test-session");
    const threadB = await ctxB.memoryBackend.getThread("test-session");

    expect(threadA).toHaveLength(1);
    expect(threadA[0].content).toBe("secret message from A");
    expect(threadB).toHaveLength(0);
  });

  // --- Caching -------------------------------------------------------------

  it("getContext returns cached context on second call", async () => {
    const mgr = makeManager();
    const first = await mgr.getContext("ws-a");
    const second = await mgr.getContext("ws-a");
    expect(first).toBe(second);
  });

  // --- Destroy -------------------------------------------------------------

  it("destroyContext removes from cache and closes memory backend", async () => {
    const mgr = makeManager();
    const ctx = await mgr.getContext("ws-a");
    const closeSpy = vi.spyOn(ctx.memoryBackend, "close");

    await mgr.destroyContext("ws-a");

    expect(closeSpy).toHaveBeenCalledOnce();
    expect(mgr.listActiveContexts()).not.toContain("ws-a");
  });

  it("destroyContext for non-existent workspace is no-op", async () => {
    const mgr = makeManager();
    await expect(mgr.destroyContext("nonexistent")).resolves.toBeUndefined();
  });

  // --- Active contexts tracking --------------------------------------------

  it("listActiveContexts tracks created and destroyed", async () => {
    const mgr = makeManager();
    expect(mgr.listActiveContexts()).toEqual([]);

    await mgr.getContext("ws-a");
    expect(mgr.listActiveContexts()).toEqual(["ws-a"]);

    await mgr.getContext("ws-b");
    expect(mgr.listActiveContexts()).toContain("ws-a");
    expect(mgr.listActiveContexts()).toContain("ws-b");

    await mgr.destroyContext("ws-a");
    expect(mgr.listActiveContexts()).toEqual(["ws-b"]);
  });

  // --- LLM provider -------------------------------------------------------

  it("default LLM provider inherited when no createLLMProvider", async () => {
    const defaultProvider = makeMockLLMProvider("default-llm");
    const mgr = makeManager({ defaultLLMProvider: defaultProvider });
    const ctx = await mgr.getContext("ws-a");
    expect(ctx.llmProvider).toBe(defaultProvider);
  });

  it("custom createLLMProvider factory called when provided", async () => {
    const customProvider = makeMockLLMProvider("custom-llm");
    const factory = vi.fn(() => customProvider);
    const mgr = makeManager({ createLLMProvider: factory });
    const ctx = await mgr.getContext("ws-a");
    expect(ctx.llmProvider).toBe(customProvider);
    expect(factory).toHaveBeenCalledOnce();
  });

  it("NoopLLMProvider throws with workspace ID in error message", async () => {
    const mgr = makeManager();
    const ctx = await mgr.getContext("ws-a");
    await expect(ctx.llmProvider.chat([])).rejects.toThrow(
      "No LLM provider configured for workspace 'ws-a'",
    );
  });

  // --- Tool permissions ----------------------------------------------------

  it("workspace toolPermissions deny filters out tools from registry", async () => {
    const toolA = makeMockTool("tool-a");
    const toolB = makeMockTool("tool-b");
    const toolC = makeMockTool("tool-c");

    const wsMap = new Map([
      [
        "ws-a",
        makeWorkspace("ws-a", {
          toolPermissions: [{ tool: "tool-b", allow: false }],
        }),
      ],
    ]);

    const mgr = makeManager({ defaultTools: [toolA, toolB, toolC] }, wsMap);
    const ctx = await mgr.getContext("ws-a");

    expect(ctx.toolRegistry.listNames()).toContain("tool-a");
    expect(ctx.toolRegistry.listNames()).not.toContain("tool-b");
    expect(ctx.toolRegistry.listNames()).toContain("tool-c");
  });

  // --- Skills --------------------------------------------------------------

  it("resolves skills via resolveSkills factory", async () => {
    const skill = makeMockSkill("search");
    const wsMap = new Map([
      ["ws-a", makeWorkspace("ws-a", { skills: ["search"] })],
    ]);
    const resolveSkills = vi.fn(async () => [skill]);
    const mgr = makeManager({ resolveSkills }, wsMap);
    const ctx = await mgr.getContext("ws-a");

    expect(resolveSkills).toHaveBeenCalledWith(["search"]);
    expect(ctx.skills).toEqual([skill]);
  });

  it("falls back to defaultSkills when no resolveSkills factory", async () => {
    const defaultSkill = makeMockSkill("default-skill");
    const mgr = makeManager({ defaultSkills: [defaultSkill] });
    const ctx = await mgr.getContext("ws-a");
    expect(ctx.skills).toEqual([defaultSkill]);
  });

  // --- Keypair -------------------------------------------------------------

  it("resolves keypair via resolveKeypair factory", async () => {
    const kp = makeMockKeypair();
    const resolveKeypair = vi.fn(() => kp);
    const mgr = makeManager({
      resolveKeypair:
        resolveKeypair as SessionIsolationManagerConfig["resolveKeypair"],
    });
    const ctx = await mgr.getContext("ws-a");
    expect(ctx.keypair).toBe(kp);
    expect(resolveKeypair).toHaveBeenCalledWith("ws-a");
  });

  // --- Error propagation ---------------------------------------------------

  it("getContext propagates error for nonexistent workspace", async () => {
    const mgr = makeManager();
    await expect(mgr.getContext("nonexistent")).rejects.toThrow(
      "Workspace not found: nonexistent",
    );
  });

  // --- Concurrent access ---------------------------------------------------

  it("concurrent getContext calls for same workspace return same context", async () => {
    const mgr = makeManager();
    const [ctx1, ctx2, ctx3] = await Promise.all([
      mgr.getContext("ws-a"),
      mgr.getContext("ws-a"),
      mgr.getContext("ws-a"),
    ]);
    expect(ctx1).toBe(ctx2);
    expect(ctx2).toBe(ctx3);
  });

  // --- Auth state ----------------------------------------------------------

  it("default auth when no resolver", async () => {
    const mgr = makeManager();
    const ctx = await mgr.getContext("ws-a");
    expect(ctx.authState.authenticated).toBe(false);
    expect(ctx.authState.permissions.size).toBe(0);
    expect(ctx.authState.walletAddress).toBeUndefined();
  });

  it("default auth uses keypair publicKey as walletAddress", async () => {
    const kp = makeMockKeypair();
    const mgr = makeManager({
      resolveKeypair: () =>
        kp as ReturnType<
          NonNullable<SessionIsolationManagerConfig["resolveKeypair"]>
        >,
    });
    const ctx = await mgr.getContext("ws-a");
    expect(ctx.authState.walletAddress).toBe(kp.publicKey);
  });

  it("custom resolveAuth provides per-workspace auth", async () => {
    const mockPubkey = makeMockKeypair().publicKey;
    const customAuth: AuthState = {
      authenticated: true,
      permissions: new Set(["admin", "read"]),
      walletAddress: mockPubkey as AuthState["walletAddress"],
    };
    const resolveAuth = vi.fn(() => customAuth);
    const mgr = makeManager({ resolveAuth });
    const ctx = await mgr.getContext("ws-a");
    expect(ctx.authState).toBe(customAuth);
    expect(ctx.authState.authenticated).toBe(true);
    expect(ctx.authState.permissions.has("admin")).toBe(true);
  });

  // --- Custom factory overrides -------------------------------------------

  it("custom createMemoryBackend factory is used", async () => {
    const customBackend = new InMemoryBackend();
    const factory = vi.fn(() => customBackend);
    const mgr = makeManager({ createMemoryBackend: factory });
    const ctx = await mgr.getContext("ws-a");
    expect(ctx.memoryBackend).toBe(customBackend);
    expect(factory).toHaveBeenCalledOnce();
  });

  it("custom createPolicyEngine factory is used", async () => {
    const customEngine = new PolicyEngine();
    const factory = vi.fn(() => customEngine);
    const mgr = makeManager({ createPolicyEngine: factory });
    const ctx = await mgr.getContext("ws-a");
    expect(ctx.policyEngine).toBe(customEngine);
    expect(factory).toHaveBeenCalledOnce();
  });
});
