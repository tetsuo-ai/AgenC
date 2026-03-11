import { describe, expect, it } from "vitest";
import {
  createExecuteWithAgentTool,
  EXECUTE_WITH_AGENT_TOOL_NAME,
  extractDelegatedWorkingDirectory,
  parseExecuteWithAgentInput,
  resolveDelegatedWorkingDirectory,
} from "./delegation-tool.js";

describe("delegation-tool", () => {
  it("parses execute_with_agent input with task and scoped options", () => {
    const parsed = parseExecuteWithAgentInput({
      task: "inspect runtime planner flow",
      tools: ["system.readFile", "system.readFile", " system.listDir "],
      requiredToolCapabilities: ["system.readFile", "system.listDir"],
      timeoutMs: 25_000,
      acceptanceCriteria: ["return findings", "include one risk"],
      spawnDecisionScore: 0.77,
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.task).toBe("inspect runtime planner flow");
    expect(parsed.value.tools).toEqual(["system.readFile", "system.listDir"]);
    expect(parsed.value.requiredToolCapabilities).toEqual([
      "system.readFile",
      "system.listDir",
    ]);
    expect(parsed.value.timeoutMs).toBe(25_000);
    expect(parsed.value.acceptanceCriteria).toEqual([
      "return findings",
      "include one risk",
    ]);
    expect(parsed.value.spawnDecisionScore).toBe(0.77);
  });

  it("accepts objective as task fallback", () => {
    const parsed = parseExecuteWithAgentInput({
      objective: "compare three modules",
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.task).toBe("compare three modules");
    expect(parsed.value.objective).toBe("compare three modules");
  });

  it("preserves explicit task scope when task and objective are both provided", () => {
    const parsed = parseExecuteWithAgentInput({
      task: "Inspect docs/RUNTIME_API.md sections 4b and 8",
      objective: "Extract one autonomy-validation risk with a direct reference",
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.task).toBe("Inspect docs/RUNTIME_API.md sections 4b and 8");
    expect(parsed.value.objective).toBe(
      "Extract one autonomy-validation risk with a direct reference",
    );
  });

  it("parses internal continuation session identifiers without exposing them in the tool schema", () => {
    const parsed = parseExecuteWithAgentInput({
      task: "continue the previous child",
      continuationSessionId: "subagent:child-7",
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.continuationSessionId).toBe("subagent:child-7");
  });

  it("parses delegated context requirements and extracts a cwd directive", () => {
    const parsed = parseExecuteWithAgentInput({
      task: "implement files in the project workspace",
      context_requirements: [
        " repo_context ",
        "cwd = /home/tetsuo/agent-test/grid-router-ts ",
      ],
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.contextRequirements).toEqual([
      "repo_context",
      "cwd = /home/tetsuo/agent-test/grid-router-ts",
    ]);
    expect(extractDelegatedWorkingDirectory(parsed.value.contextRequirements)).toBe(
      "/home/tetsuo/agent-test/grid-router-ts",
    );
  });

  it("accepts snake_case delegation fields from planner-shaped payloads", () => {
    const parsed = parseExecuteWithAgentInput({
      task: "implement_core",
      input_contract: "Project scaffold already exists",
      acceptance_criteria: ["Write the core TypeScript files"],
      required_tool_capabilities: ["system.writeFile", "system.readFile"],
      context_requirements: ["cwd:/tmp/grid-router-ts"],
      spawn_decision_score: 0.42,
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.inputContract).toBe("Project scaffold already exists");
    expect(parsed.value.acceptanceCriteria).toEqual([
      "Write the core TypeScript files",
    ]);
    expect(parsed.value.requiredToolCapabilities).toEqual([
      "system.writeFile",
      "system.readFile",
    ]);
    expect(parsed.value.contextRequirements).toEqual(["cwd:/tmp/grid-router-ts"]);
    expect(parsed.value.spawnDecisionScore).toBe(0.42);
  });

  it("extracts delegated working directories from working_directory context requirements", () => {
    expect(
      extractDelegatedWorkingDirectory([
        "repo_context",
        "working_directory:/home/tetsuo/agent-test/grid-router-ts",
      ]),
    ).toBe("/home/tetsuo/agent-test/grid-router-ts");
    expect(
      extractDelegatedWorkingDirectory([
        "working-directory = /tmp/project-root",
      ]),
    ).toBe("/tmp/project-root");
  });

  it("infers a delegated working directory from workspace-oriented objective text", () => {
    expect(
      resolveDelegatedWorkingDirectory({
        task: "scaffold",
        objective:
          "Create the npm workspace structure in /home/tetsuo/agent-test/terrain-router-ts-1 from scratch.",
      }),
    ).toEqual({
      path: "/home/tetsuo/agent-test/terrain-router-ts-1",
      source: "task_text",
    });
  });

  it("infers a delegated working directory from change-directory phrasing", () => {
    expect(
      resolveDelegatedWorkingDirectory({
        task: "run",
        objective:
          "Change to /home/tetsuo/agent-test/terrain-router-ts-1 directory and execute npm run build.",
      }),
    ).toEqual({
      path: "/home/tetsuo/agent-test/terrain-router-ts-1",
      source: "task_text",
    });
  });

  it("normalizes file-oriented path mentions to their parent directory", () => {
    expect(
      resolveDelegatedWorkingDirectory({
        task: "inspect doc",
        objective:
          "Read docs from /workspace/docs/RUNTIME_API.md and extract one risk with a citation.",
      }),
    ).toEqual({
      path: "/workspace/docs",
      source: "task_text",
    });
  });

  it("rejects missing task/objective", () => {
    const parsed = parseExecuteWithAgentInput({});
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("non-empty");
  });

  it("creates a canonical execute_with_agent tool definition", async () => {
    const tool = createExecuteWithAgentTool();
    expect(tool.name).toBe(EXECUTE_WITH_AGENT_TOOL_NAME);
    expect(tool.inputSchema.properties).not.toHaveProperty(
      "continuationSessionId",
    );
    const direct = await tool.execute({ task: "do work" });
    expect(direct.isError).toBe(true);
    expect(direct.content).toContain("session-scoped tool handler");
  });
});
