import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { writeFile, mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  WORKSPACE_FILES,
  WorkspaceLoader,
  assembleSystemPrompt,
  generateTemplate,
  scaffoldWorkspace,
  getDefaultWorkspacePath,
  type WorkspaceFileName,
} from "./workspace-files.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "agenc-ws-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true });
});

describe("WORKSPACE_FILES", () => {
  it("contains all 11 file names", () => {
    const values = Object.values(WORKSPACE_FILES);
    expect(values).toHaveLength(11);
    expect(values).toContain("AGENT.md");
    expect(values).toContain("SOUL.md");
    expect(values).toContain("USER.md");
    expect(values).toContain("TOOLS.md");
    expect(values).toContain("HEARTBEAT.md");
    expect(values).toContain("BOOT.md");
    expect(values).toContain("IDENTITY.md");
    expect(values).toContain("MEMORY.md");
    expect(values).toContain("CAPABILITIES.md");
    expect(values).toContain("POLICY.md");
    expect(values).toContain("REPUTATION.md");
  });
});

describe("WorkspaceLoader.load", () => {
  it("reads all workspace files from directory", async () => {
    await writeFile(join(tmpDir, "AGENT.md"), "# Agent");
    await writeFile(join(tmpDir, "SOUL.md"), "# Soul");
    await writeFile(join(tmpDir, "USER.md"), "# User");
    await writeFile(join(tmpDir, "TOOLS.md"), "# Tools");
    await writeFile(join(tmpDir, "HEARTBEAT.md"), "# Heartbeat");
    await writeFile(join(tmpDir, "BOOT.md"), "# Boot");
    await writeFile(join(tmpDir, "IDENTITY.md"), "# Identity");
    await writeFile(join(tmpDir, "MEMORY.md"), "# Memory");
    await writeFile(join(tmpDir, "CAPABILITIES.md"), "# Capabilities");
    await writeFile(join(tmpDir, "POLICY.md"), "# Policy");
    await writeFile(join(tmpDir, "REPUTATION.md"), "# Reputation");

    const loader = new WorkspaceLoader(tmpDir);
    const files = await loader.load();

    expect(files.agent).toBe("# Agent");
    expect(files.soul).toBe("# Soul");
    expect(files.user).toBe("# User");
    expect(files.tools).toBe("# Tools");
    expect(files.heartbeat).toBe("# Heartbeat");
    expect(files.boot).toBe("# Boot");
    expect(files.identity).toBe("# Identity");
    expect(files.memory).toBe("# Memory");
    expect(files.capabilities).toBe("# Capabilities");
    expect(files.policy).toBe("# Policy");
    expect(files.reputation).toBe("# Reputation");
  });

  it("returns undefined for missing files", async () => {
    await writeFile(join(tmpDir, "AGENT.md"), "# Agent");

    const loader = new WorkspaceLoader(tmpDir);
    const files = await loader.load();

    expect(files.agent).toBe("# Agent");
    expect(files.soul).toBeUndefined();
    expect(files.user).toBeUndefined();
    expect(files.tools).toBeUndefined();
    expect(files.memory).toBeUndefined();
  });

  it("does not load subdirectory contents", async () => {
    await mkdir(join(tmpDir, "memory"), { recursive: true });
    await writeFile(join(tmpDir, "memory", "notes.md"), "# Notes");

    const loader = new WorkspaceLoader(tmpDir);
    const files = await loader.load();

    expect(files.memory).toBeUndefined();
  });
});

describe("WorkspaceLoader.loadFile", () => {
  it("reads a specific file", async () => {
    await writeFile(join(tmpDir, "SOUL.md"), "# My Soul");

    const loader = new WorkspaceLoader(tmpDir);
    const content = await loader.loadFile("SOUL");

    expect(content).toBe("# My Soul");
  });
});

describe("WorkspaceLoader.validate", () => {
  it("reports missing workspace directory", async () => {
    const loader = new WorkspaceLoader(join(tmpDir, "nonexistent"));
    const result = await loader.validate();

    expect(result.valid).toBe(false);
    expect(result.warnings).toContain("Workspace directory does not exist");
  });

  it("warns about missing AGENT.md", async () => {
    await writeFile(join(tmpDir, "SOUL.md"), "# Soul");

    const loader = new WorkspaceLoader(tmpDir);
    const result = await loader.validate();

    expect(result.valid).toBe(true);
    expect(result.warnings).toContain(
      "AGENT.md is missing — agent has no personality configuration",
    );
    expect(result.missing).toContain("AGENT.md");
  });

  it("reports no missing files when all are present", async () => {
    for (const fileName of Object.values(WORKSPACE_FILES)) {
      await writeFile(join(tmpDir, fileName), `# ${fileName}`);
    }

    const loader = new WorkspaceLoader(tmpDir);
    const result = await loader.validate();

    expect(result.valid).toBe(true);
    expect(result.missing).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });
});

describe("assembleSystemPrompt", () => {
  it("concatenates files in correct order", () => {
    const result = assembleSystemPrompt({
      agent: "# Agent",
      soul: "# Soul",
      identity: "# Identity",
      capabilities: "# Caps",
      policy: "# Policy",
      reputation: "# Reputation",
      user: "# User",
      tools: "# Tools",
      memory: "# Memory",
    });

    const agentIdx = result.indexOf("# Agent");
    const soulIdx = result.indexOf("# Soul");
    const identityIdx = result.indexOf("# Identity");
    const capsIdx = result.indexOf("# Caps");
    const policyIdx = result.indexOf("# Policy");
    const reputationIdx = result.indexOf("# Reputation");
    const userIdx = result.indexOf("# User");
    const toolsIdx = result.indexOf("# Tools");
    const memoryIdx = result.indexOf("# Memory");

    expect(agentIdx).toBeLessThan(soulIdx);
    expect(soulIdx).toBeLessThan(identityIdx);
    expect(identityIdx).toBeLessThan(capsIdx);
    expect(capsIdx).toBeLessThan(policyIdx);
    expect(policyIdx).toBeLessThan(reputationIdx);
    expect(reputationIdx).toBeLessThan(userIdx);
    expect(userIdx).toBeLessThan(toolsIdx);
    expect(toolsIdx).toBeLessThan(memoryIdx);
  });

  it("skips undefined files", () => {
    const result = assembleSystemPrompt({
      agent: "# Agent",
      // soul is undefined
      user: "# User",
    });

    expect(result).toBe("# Agent\n\n# User");
  });

  it("appends additional context", () => {
    const result = assembleSystemPrompt(
      { agent: "# Agent" },
      { additionalContext: "Extra context here" },
    );

    expect(result).toContain("# Agent");
    expect(result).toContain("Extra context here");
    expect(result.indexOf("# Agent")).toBeLessThan(
      result.indexOf("Extra context here"),
    );
  });

  it("respects maxLength truncation", () => {
    const result = assembleSystemPrompt(
      { agent: "A".repeat(100) },
      { maxLength: 50 },
    );

    expect(result).toHaveLength(50);
    expect(result.endsWith("\u2026")).toBe(true);
  });

  it("returns empty string when maxLength is 0", () => {
    const result = assembleSystemPrompt(
      { agent: "A".repeat(100) },
      { maxLength: 0 },
    );

    expect(result).toBe("");
  });
});

describe("generateTemplate", () => {
  it("returns non-empty template for each file", () => {
    for (const fileName of Object.values(WORKSPACE_FILES)) {
      const template = generateTemplate(fileName);
      expect(template.length).toBeGreaterThan(0);
      expect(template).toContain("#");
    }
  });
});

describe("scaffoldWorkspace", () => {
  it("creates all template files", async () => {
    const wsDir = join(tmpDir, "workspace");
    const created = await scaffoldWorkspace(wsDir);

    expect(created).toHaveLength(11);
    for (const fileName of Object.values(WORKSPACE_FILES)) {
      expect(created).toContain(fileName);
    }

    const loader = new WorkspaceLoader(wsDir);
    const files = await loader.load();
    expect(files.agent).toBeDefined();
    expect(files.soul).toBeDefined();
  });

  it("does not overwrite existing files", async () => {
    const wsDir = join(tmpDir, "workspace");
    await mkdir(wsDir, { recursive: true });
    await writeFile(join(wsDir, "AGENT.md"), "# My Custom Agent");

    const created = await scaffoldWorkspace(wsDir);

    expect(created).not.toContain("AGENT.md");
    expect(created).toHaveLength(10);

    const loader = new WorkspaceLoader(wsDir);
    const agentContent = await loader.loadFile("AGENT");
    expect(agentContent).toBe("# My Custom Agent");
  });
});

describe("getDefaultWorkspacePath", () => {
  it("returns a path under home directory", () => {
    const path = getDefaultWorkspacePath();
    expect(path).toContain(".agenc");
    expect(path).toContain("workspace");
  });
});
