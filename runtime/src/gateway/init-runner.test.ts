import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ChatExecuteParams,
  ChatExecutorResult,
  ToolCallRecord,
} from "../llm/chat-executor.js";
import {
  buildModelBackedInitPrompt,
  runModelBackedProjectGuide,
  validateInitGuideContent,
} from "./init-runner.js";

function createToolCallRecord(
  name: string,
  result: string,
  overrides: Partial<ToolCallRecord> = {},
): ToolCallRecord {
  return {
    name,
    args: {},
    result,
    isError: false,
    durationMs: 1,
    ...overrides,
  };
}

function createResult(toolCalls: readonly ToolCallRecord[]): ChatExecutorResult {
  return {
    content: "init complete",
    provider: "grok",
    model: "grok-code-fast-1",
    usedFallback: false,
    toolCalls: [...toolCalls],
    providerEvidence: undefined,
    tokenUsage: {
      inputTokens: 10,
      outputTokens: 10,
      totalTokens: 20,
    },
    callUsage: [],
    durationMs: 5,
    compacted: false,
    stopReason: "completed",
  };
}

function validGuideContent(): string {
  return [
    "# Repository Guidelines",
    "",
    "## Project Structure & Module Organization",
    "- runtime/",
    "",
    "## Build, Test, and Development Commands",
    "- npm run build",
    "",
    "## Coding Style & Naming Conventions",
    "- TypeScript uses strict typing.",
    "",
    "## Testing Guidelines",
    "- npm test",
    "",
    "## Commit & Pull Request Guidelines",
    "- Use Conventional Commits.",
  ].join("\n");
}

describe("init-runner", () => {
  const workspaces: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const workspace of workspaces.splice(0)) {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("requires the canonical init headings", () => {
    expect(validateInitGuideContent("# Repository Guidelines\n")).toContain(
      "Project Structure",
    );
    expect(validateInitGuideContent(validGuideContent())).toBeNull();
  });

  it("builds a prompt that requires bounded delegated investigations", () => {
    const prompt = buildModelBackedInitPrompt({
      workspaceRoot: "/repo",
      filePath: "/repo/AGENC.md",
      force: true,
      minimumDelegatedInvestigations: 3,
    });

    expect(prompt).toContain("execute_with_agent for at least 3");
    expect(prompt).toContain("## Project Structure & Module Organization");
    expect(prompt).toContain("Read /repo/AGENC.md back after writing");
  });

  it("skips when AGENC.md already exists and force is false", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "agenc-init-runner-skip-"));
    workspaces.push(workspace);
    writeFileSync(join(workspace, "AGENC.md"), validGuideContent(), "utf-8");
    const execute = vi.fn<
      (params: ChatExecuteParams) => Promise<ChatExecutorResult>
    >();

    const result = await runModelBackedProjectGuide({
      workspaceRoot: workspace,
      systemPrompt: "system",
      sessionId: "init-session",
      toolHandler: vi.fn(),
      chatExecutor: { execute },
    });

    expect(result.status).toBe("skipped");
    expect(result.attempts).toBe(0);
    expect(execute).not.toHaveBeenCalled();
  });

  it("writes the guide after enough discovery and delegated investigations", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "agenc-init-runner-ok-"));
    workspaces.push(workspace);
    const filePath = join(workspace, "AGENC.md");
    const execute = vi.fn<
      (params: ChatExecuteParams) => Promise<ChatExecutorResult>
    >(async () => {
      writeFileSync(filePath, validGuideContent(), "utf-8");
      return createResult([
        createToolCallRecord("system.listDir", '{"entries":["runtime","sdk"]}'),
        createToolCallRecord("system.readFile", '{"content":"# README"}'),
        createToolCallRecord("system.stat", '{"exists":true}'),
        createToolCallRecord("system.bash", '{"stdout":"feat(runtime): add init"}'),
        createToolCallRecord("execute_with_agent", '{"summary":"runtime mapped"}'),
        createToolCallRecord("execute_with_agent", '{"summary":"tests mapped"}'),
        createToolCallRecord("execute_with_agent", '{"summary":"docs mapped"}'),
        createToolCallRecord("system.writeFile", '{"written":true}'),
      ]);
    });

    const result = await runModelBackedProjectGuide({
      workspaceRoot: workspace,
      systemPrompt: "system",
      sessionId: "init-session",
      toolHandler: vi.fn(),
      chatExecutor: { execute },
    });

    expect(result.status).toBe("created");
    expect(result.attempts).toBe(1);
    expect(result.delegatedInvestigations).toBe(3);
    expect(result.filePath).toBe(filePath);
    expect(result.content).toContain("# Repository Guidelines");
    const call = execute.mock.calls[0]?.[0];
    expect(call?.toolRouting?.routedToolNames).toContain("execute_with_agent");
    expect(call?.toolRouting?.expandOnMiss).toBe(false);
  });

  it("retries when the first attempt does not delegate enough work", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "agenc-init-runner-retry-"));
    workspaces.push(workspace);
    const filePath = join(workspace, "AGENC.md");
    const execute = vi.fn<
      (params: ChatExecuteParams) => Promise<ChatExecutorResult>
    >();

    execute.mockImplementationOnce(async () => {
      writeFileSync(filePath, validGuideContent(), "utf-8");
      return createResult([
        createToolCallRecord("system.listDir", '{"entries":["runtime"]}'),
        createToolCallRecord("system.readFile", '{"content":"# README"}'),
        createToolCallRecord("system.stat", '{"exists":true}'),
        createToolCallRecord("system.bash", '{"stdout":"feat(runtime): add init"}'),
        createToolCallRecord("execute_with_agent", '{"summary":"only one child"}'),
        createToolCallRecord("system.writeFile", '{"written":true}'),
      ]);
    });

    execute.mockImplementationOnce(async () => {
      writeFileSync(filePath, validGuideContent(), "utf-8");
      return createResult([
        createToolCallRecord("system.listDir", '{"entries":["runtime","sdk"]}'),
        createToolCallRecord("system.readFile", '{"content":"# README"}'),
        createToolCallRecord("system.stat", '{"exists":true}'),
        createToolCallRecord("system.bash", '{"stdout":"feat(runtime): add init"}'),
        createToolCallRecord("execute_with_agent", '{"summary":"runtime mapped"}'),
        createToolCallRecord("execute_with_agent", '{"summary":"tests mapped"}'),
        createToolCallRecord("execute_with_agent", '{"summary":"docs mapped"}'),
        createToolCallRecord("system.writeFile", '{"written":true}'),
      ]);
    });

    const result = await runModelBackedProjectGuide({
      workspaceRoot: workspace,
      systemPrompt: "system",
      sessionId: "init-session",
      toolHandler: vi.fn(),
      chatExecutor: { execute },
    });

    expect(result.status).toBe("created");
    expect(result.attempts).toBe(2);
    const retryCall = execute.mock.calls[1]?.[0];
    expect(retryCall?.message.content).toContain(
      "Previous attempt failed validation",
    );
  });
});
