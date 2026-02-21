import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import {
  createTaskScanAction,
  createSummaryAction,
  createPortfolioAction,
  createPollingAction,
  createDefaultHeartbeatActions,
} from "./heartbeat-actions.js";
import type { HeartbeatContext, HeartbeatResult } from "./heartbeat.js";
import type { TaskScanner } from "../autonomous/scanner.js";
import type { Task } from "../autonomous/types.js";
import type { MemoryBackend, MemoryEntry } from "../memory/types.js";
import type { LLMProvider, LLMResponse } from "../llm/types.js";
import type { Connection } from "@solana/web3.js";

// ============================================================================
// Shared mocks
// ============================================================================

function makeContext(): HeartbeatContext {
  return {
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    sendToChannels: vi
      .fn<(content: string) => Promise<void>>()
      .mockResolvedValue(undefined),
  };
}

function makeTask(overrides?: Partial<Task>): Task {
  return {
    pda: new PublicKey("11111111111111111111111111111112"),
    taskId: new Uint8Array(32),
    creator: new PublicKey("11111111111111111111111111111112"),
    requiredCapabilities: 1n,
    reward: 2_000_000_000n,
    description: new Uint8Array(64),
    constraintHash: new Uint8Array(32),
    deadline: 0,
    maxWorkers: 1,
    currentClaims: 0,
    status: 0,
    rewardMint: null,
    ...overrides,
  };
}

function makeScanner(tasks: Task[] = []): TaskScanner {
  return { scan: vi.fn().mockResolvedValue(tasks) } as unknown as TaskScanner;
}

function makeMemoryBackend(overrides?: Partial<MemoryBackend>): MemoryBackend {
  return {
    name: "mock",
    query: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
    addEntry: vi.fn(),
    getThread: vi.fn(),
    deleteThread: vi.fn(),
    listSessions: vi.fn(),
    delete: vi.fn(),
    has: vi.fn(),
    listKeys: vi.fn(),
    getDurability: vi.fn(),
    flush: vi.fn(),
    clear: vi.fn(),
    close: vi.fn(),
    healthCheck: vi.fn(),
    ...overrides,
  } as unknown as MemoryBackend;
}

function makeLLMResponse(content: string): LLMResponse {
  return {
    content,
    toolCalls: [],
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    model: "test-model",
    finishReason: "stop",
  };
}

function makeLLMProvider(content = "Test summary"): LLMProvider {
  return {
    name: "mock-llm",
    chat: vi.fn().mockResolvedValue(makeLLMResponse(content)),
    chatStream: vi.fn(),
    healthCheck: vi.fn().mockResolvedValue(true),
  };
}

function makeEntry(role: "user" | "assistant", content: string): MemoryEntry {
  return {
    id: crypto.randomUUID(),
    sessionId: "sess-1",
    role,
    content,
    timestamp: Date.now(),
  };
}

function makeConnection(balance = 5_000_000_000): Connection {
  return {
    getBalance: vi.fn().mockResolvedValue(balance),
  } as unknown as Connection;
}

// ============================================================================
// Task scan action
// ============================================================================

describe("createTaskScanAction", () => {
  it("returns quiet when scanner finds no tasks", async () => {
    const action = createTaskScanAction({ scanner: makeScanner([]) });
    const result = await action.execute(makeContext());
    expect(result.hasOutput).toBe(false);
    expect(result.quiet).toBe(true);
  });

  it("returns formatted output when tasks are found", async () => {
    const tasks = [makeTask({ reward: 1_500_000_000n })];
    const action = createTaskScanAction({ scanner: makeScanner(tasks) });
    const result = await action.execute(makeContext());

    expect(result.hasOutput).toBe(true);
    expect(result.quiet).toBe(false);
    expect(result.output).toContain("Found 1 claimable task(s)");
    expect(result.output).toContain("1.5000 SOL");
  });

  it("formats SPL token tasks with mint address", async () => {
    const mint = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    const tasks = [makeTask({ reward: 1_000_000n, rewardMint: mint })];
    const action = createTaskScanAction({ scanner: makeScanner(tasks) });
    const result = await action.execute(makeContext());

    expect(result.hasOutput).toBe(true);
    expect(result.output).toContain("1000000 lamports");
    expect(result.output).toContain(mint.toBase58());
  });

  it("returns quiet and logs on scanner error", async () => {
    const scanner = {
      scan: vi.fn().mockRejectedValue(new Error("rpc fail")),
    } as unknown as TaskScanner;
    const action = createTaskScanAction({ scanner });
    const ctx = makeContext();
    const result = await action.execute(ctx);

    expect(result.quiet).toBe(true);
    expect(ctx.logger.error).toHaveBeenCalled();
  });

  it('has name "task-scan" and enabled true', () => {
    const action = createTaskScanAction({ scanner: makeScanner() });
    expect(action.name).toBe("task-scan");
    expect(action.enabled).toBe(true);
  });

  it("includes truncated PDA in output", async () => {
    const pda = new PublicKey("9WzDXwBbmPdCBoccS9W9J4nAjBD2VBaRqmptzYTfBKSU");
    const tasks = [makeTask({ pda, reward: 1_000_000_000n })];
    const action = createTaskScanAction({ scanner: makeScanner(tasks) });
    const result = await action.execute(makeContext());

    expect(result.output).toContain(pda.toBase58().slice(0, 8));
  });
});

// ============================================================================
// Summary action
// ============================================================================

describe("createSummaryAction", () => {
  it("returns quiet when no memory entries", async () => {
    const action = createSummaryAction({
      memory: makeMemoryBackend(),
      llm: makeLLMProvider(),
      sessionId: "sess-1",
    });
    const result = await action.execute(makeContext());

    expect(result.hasOutput).toBe(false);
    expect(result.quiet).toBe(true);
  });

  it("calls LLM with correct system and user prompts", async () => {
    const entries = [
      makeEntry("user", "Hello"),
      makeEntry("assistant", "Hi there"),
    ];
    const memory = makeMemoryBackend({
      query: vi.fn().mockResolvedValue(entries),
    });
    const llm = makeLLMProvider("A concise summary.");
    const action = createSummaryAction({ memory, llm, sessionId: "sess-1" });
    const result = await action.execute(makeContext());

    expect(result.hasOutput).toBe(true);
    expect(result.output).toBe("A concise summary.");

    const chatCall = (llm.chat as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(chatCall[0].role).toBe("system");
    expect(chatCall[0].content).toContain("concise summarizer");
    expect(chatCall[1].role).toBe("user");
    expect(chatCall[1].content).toContain("Summarize this conversation");
    expect(chatCall[1].content).toContain("[user]: Hello");
    expect(chatCall[1].content).toContain("[assistant]: Hi there");
  });

  it("returns quiet on LLM error", async () => {
    const entries = [makeEntry("user", "Hello")];
    const memory = makeMemoryBackend({
      query: vi.fn().mockResolvedValue(entries),
    });
    const llm = {
      name: "mock-llm",
      chat: vi.fn().mockRejectedValue(new Error("LLM down")),
      chatStream: vi.fn(),
      healthCheck: vi.fn(),
    } as LLMProvider;
    const action = createSummaryAction({ memory, llm, sessionId: "sess-1" });
    const ctx = makeContext();
    const result = await action.execute(ctx);

    expect(result.quiet).toBe(true);
    expect(ctx.logger.error).toHaveBeenCalled();
  });

  it("returns quiet when LLM returns empty content", async () => {
    const entries = [makeEntry("user", "Hello")];
    const memory = makeMemoryBackend({
      query: vi.fn().mockResolvedValue(entries),
    });
    const llm = makeLLMProvider("");
    const action = createSummaryAction({ memory, llm, sessionId: "sess-1" });
    const result = await action.execute(makeContext());

    expect(result.quiet).toBe(true);
  });

  it("passes correct query params with defaults", async () => {
    const queryFn = vi.fn().mockResolvedValue([]);
    const memory = makeMemoryBackend({ query: queryFn });
    const action = createSummaryAction({
      memory,
      llm: makeLLMProvider(),
      sessionId: "sess-1",
    });

    vi.setSystemTime(1700000000000);
    await action.execute(makeContext());

    expect(queryFn).toHaveBeenCalledWith({
      sessionId: "sess-1",
      after: 1700000000000 - 86_400_000,
      limit: 50,
      order: "asc",
    });
  });

  it("respects custom lookbackMs and maxEntries", async () => {
    const queryFn = vi.fn().mockResolvedValue([]);
    const memory = makeMemoryBackend({ query: queryFn });
    const action = createSummaryAction({
      memory,
      llm: makeLLMProvider(),
      sessionId: "sess-1",
      lookbackMs: 3_600_000,
      maxEntries: 10,
    });

    vi.setSystemTime(1700000000000);
    await action.execute(makeContext());

    expect(queryFn).toHaveBeenCalledWith({
      sessionId: "sess-1",
      after: 1700000000000 - 3_600_000,
      limit: 10,
      order: "asc",
    });
  });

  it('has name "summary" and enabled true', () => {
    const action = createSummaryAction({
      memory: makeMemoryBackend(),
      llm: makeLLMProvider(),
      sessionId: "sess-1",
    });
    expect(action.name).toBe("summary");
    expect(action.enabled).toBe(true);
  });
});

// ============================================================================
// Portfolio action
// ============================================================================

describe("createPortfolioAction", () => {
  const wallet = new PublicKey("11111111111111111111111111111112");

  it("returns quiet on first run (no previous balance)", async () => {
    const memory = makeMemoryBackend();
    const action = createPortfolioAction({
      connection: makeConnection(5_000_000_000),
      wallet,
      memory,
    });
    const result = await action.execute(makeContext());

    expect(result.quiet).toBe(true);
    expect(memory.set).toHaveBeenCalled();
  });

  it("returns quiet when delta is below threshold", async () => {
    const memory = makeMemoryBackend({
      get: vi.fn().mockResolvedValue(5_000_000_000),
    });
    const action = createPortfolioAction({
      connection: makeConnection(5_500_000_000),
      wallet,
      memory,
    });
    const result = await action.execute(makeContext());

    expect(result.quiet).toBe(true);
  });

  it("alerts when delta exceeds threshold (positive)", async () => {
    const memory = makeMemoryBackend({
      get: vi.fn().mockResolvedValue(5_000_000_000),
    });
    const action = createPortfolioAction({
      connection: makeConnection(7_000_000_000),
      wallet,
      memory,
    });
    const result = await action.execute(makeContext());

    expect(result.hasOutput).toBe(true);
    expect(result.quiet).toBe(false);
    expect(result.output).toContain("+2.0000 SOL");
    expect(result.output).toContain("7.0000 SOL");
  });

  it("alerts when delta exceeds threshold (negative)", async () => {
    const memory = makeMemoryBackend({
      get: vi.fn().mockResolvedValue(5_000_000_000),
    });
    const action = createPortfolioAction({
      connection: makeConnection(3_000_000_000),
      wallet,
      memory,
    });
    const result = await action.execute(makeContext());

    expect(result.hasOutput).toBe(true);
    expect(result.output).toContain("-2.0000 SOL");
    expect(result.output).toContain("3.0000 SOL");
  });

  it("respects custom alertThresholdLamports", async () => {
    const memory = makeMemoryBackend({
      get: vi.fn().mockResolvedValue(5_000_000_000),
    });
    const action = createPortfolioAction({
      connection: makeConnection(5_100_000_000),
      wallet,
      memory,
      alertThresholdLamports: 50_000_000, // 0.05 SOL
    });
    const result = await action.execute(makeContext());

    expect(result.hasOutput).toBe(true);
    expect(result.quiet).toBe(false);
  });

  it("returns quiet and logs on connection error", async () => {
    const conn = {
      getBalance: vi.fn().mockRejectedValue(new Error("RPC timeout")),
    } as unknown as Connection;
    const action = createPortfolioAction({
      connection: conn,
      wallet,
      memory: makeMemoryBackend(),
    });
    const ctx = makeContext();
    const result = await action.execute(ctx);

    expect(result.quiet).toBe(true);
    expect(ctx.logger.error).toHaveBeenCalled();
  });

  it('has name "portfolio" and enabled true', () => {
    const action = createPortfolioAction({
      connection: makeConnection(),
      wallet,
      memory: makeMemoryBackend(),
    });
    expect(action.name).toBe("portfolio");
    expect(action.enabled).toBe(true);
  });

  it("always stores current balance", async () => {
    const memory = makeMemoryBackend({
      get: vi.fn().mockResolvedValue(5_000_000_000),
    });
    const action = createPortfolioAction({
      connection: makeConnection(5_100_000_000),
      wallet,
      memory,
    });
    await action.execute(makeContext());

    expect(memory.set).toHaveBeenCalledWith(
      `heartbeat:portfolio:${wallet.toBase58()}`,
      5_100_000_000,
    );
  });
});

// ============================================================================
// Polling action
// ============================================================================

describe("createPollingAction", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls checkFn with parsed JSON on success", async () => {
    const data = { status: "ok", value: 42 };
    const response = new Response(JSON.stringify(data), { status: 200 });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(response);

    const checkFn = vi.fn<(r: unknown) => HeartbeatResult>().mockReturnValue({
      hasOutput: true,
      output: "Value is 42",
      quiet: false,
    });

    const action = createPollingAction({
      name: "api-check",
      url: "https://api.example.com/status",
      checkFn,
    });
    const result = await action.execute(makeContext());

    expect(checkFn).toHaveBeenCalledWith(data);
    expect(result.hasOutput).toBe(true);
    expect(result.output).toBe("Value is 42");
  });

  it("returns quiet on HTTP error", async () => {
    const response = new Response("Internal Server Error", { status: 500 });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(response);

    const checkFn = vi.fn<(r: unknown) => HeartbeatResult>();
    const action = createPollingAction({
      name: "api-check",
      url: "https://api.example.com/status",
      checkFn,
    });
    const ctx = makeContext();
    const result = await action.execute(ctx);

    expect(result.quiet).toBe(true);
    expect(checkFn).not.toHaveBeenCalled();
    expect(ctx.logger.error).toHaveBeenCalled();
  });

  it("returns quiet on fetch error", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("network error"),
    );

    const checkFn = vi.fn<(r: unknown) => HeartbeatResult>();
    const action = createPollingAction({
      name: "api-check",
      url: "https://api.example.com/status",
      checkFn,
    });
    const ctx = makeContext();
    const result = await action.execute(ctx);

    expect(result.quiet).toBe(true);
    expect(ctx.logger.error).toHaveBeenCalled();
  });

  it("passes custom headers to fetch", async () => {
    const response = new Response("{}", { status: 200 });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(response);

    const checkFn = vi.fn().mockReturnValue({ hasOutput: false, quiet: true });
    const headers = { Authorization: "Bearer token123" };
    const action = createPollingAction({
      name: "auth-check",
      url: "https://api.example.com",
      checkFn,
      headers,
    });
    await action.execute(makeContext());

    expect(globalThis.fetch).toHaveBeenCalledWith("https://api.example.com", {
      headers,
    });
  });

  it("uses config name as action name", () => {
    const action = createPollingAction({
      name: "custom-poll",
      url: "https://example.com",
      checkFn: () => ({ hasOutput: false, quiet: true }),
    });
    expect(action.name).toBe("custom-poll");
    expect(action.enabled).toBe(true);
  });
});

// ============================================================================
// Default actions factory
// ============================================================================

describe("createDefaultHeartbeatActions", () => {
  it("returns 3 actions", () => {
    const actions = createDefaultHeartbeatActions({
      scanner: makeScanner(),
      memory: makeMemoryBackend(),
      llm: makeLLMProvider(),
      connection: makeConnection(),
      wallet: new PublicKey("11111111111111111111111111111112"),
      sessionId: "sess-1",
    });

    expect(actions).toHaveLength(3);
  });

  it("returns actions with correct names", () => {
    const actions = createDefaultHeartbeatActions({
      scanner: makeScanner(),
      memory: makeMemoryBackend(),
      llm: makeLLMProvider(),
      connection: makeConnection(),
      wallet: new PublicKey("11111111111111111111111111111112"),
      sessionId: "sess-1",
    });

    expect(actions.map((a) => a.name)).toEqual([
      "task-scan",
      "summary",
      "portfolio",
    ]);
  });

  it("all actions are enabled", () => {
    const actions = createDefaultHeartbeatActions({
      scanner: makeScanner(),
      memory: makeMemoryBackend(),
      llm: makeLLMProvider(),
      connection: makeConnection(),
      wallet: new PublicKey("11111111111111111111111111111112"),
      sessionId: "sess-1",
    });

    expect(actions.every((a) => a.enabled)).toBe(true);
  });
});
