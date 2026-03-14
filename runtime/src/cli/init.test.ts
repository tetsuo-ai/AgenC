import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createContextCapture } from "./test-utils.js";
import { runInitCommand, type InitCommandDeps } from "./init.js";
import type { InitOptions } from "./types.js";

function baseOptions(): InitOptions {
  return {
    help: false,
    outputFormat: "json",
    strictMode: false,
    storeType: "sqlite",
    idempotencyWindow: 900,
    force: false,
    configPath: "/tmp/agenc-config.json",
    pidPath: "/tmp/agenc-test.pid",
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
    "- Keep strict typing enabled.",
    "",
    "## Testing Guidelines",
    "- npm test",
    "",
    "## Commit & Pull Request Guidelines",
    "- Use Conventional Commits.",
  ].join("\n");
}

function createDeps(overrides: Partial<InitCommandDeps> = {}): InitCommandDeps {
  return {
    readPidFile: vi.fn(),
    isProcessAlive: vi.fn(() => true),
    runStartCommand: vi.fn(async () => 0),
    requestInitRun: vi.fn(),
    readFile: vi.fn(async () => validGuideContent()),
    ...overrides,
  };
}

describe("init CLI command", () => {
  const workspaces: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const workspace of workspaces.splice(0)) {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("skips locally when AGENC.md already exists and force is not set", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "agenc-cli-init-skip-"));
    workspaces.push(workspace);
    const filePath = join(workspace, "AGENC.md");
    writeFileSync(filePath, validGuideContent(), "utf-8");
    const deps = createDeps();

    const { context, outputs, errors } = createContextCapture();
    const code = await runInitCommand(
      context,
      {
        ...baseOptions(),
        path: workspace,
      },
      deps,
    );

    expect(code).toBe(0);
    expect(errors).toHaveLength(0);
    expect(deps.requestInitRun).not.toHaveBeenCalled();
    expect(outputs[0]).toMatchObject({
      command: "init",
      projectRoot: workspace,
      filePath,
      result: "skipped",
      force: false,
    });
  });

  it("starts the daemon when needed and reports the model-backed result", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "agenc-cli-init-create-"));
    workspaces.push(workspace);
    const filePath = join(workspace, "AGENC.md");
    const readPidFile = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        pid: 4242,
        port: 4111,
        configPath: "/tmp/agenc-config.json",
      });
    const deps = createDeps({
      readPidFile,
      requestInitRun: vi.fn(async () => ({
        projectRoot: workspace,
        filePath,
        result: "created",
        delegatedInvestigations: 3,
        attempts: 1,
        modelBacked: true,
        provider: "grok",
        model: "grok-code-fast-1",
        usedFallback: false,
      })),
      readFile: vi.fn(async (path: string) => {
        if (path === filePath) {
          return validGuideContent();
        }
        throw new Error(`unexpected read: ${path}`);
      }),
    });

    const { context, outputs, errors } = createContextCapture();
    const code = await runInitCommand(
      context,
      {
        ...baseOptions(),
        path: workspace,
        force: true,
        controlPlanePort: 3222,
      },
      deps,
    );

    expect(code).toBe(0);
    expect(errors).toHaveLength(0);
    expect(deps.runStartCommand).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        configPath: "/tmp/agenc-config.json",
        pidPath: "/tmp/agenc-test.pid",
      }),
    );
    expect(deps.requestInitRun).toHaveBeenCalledWith({
      port: 3222,
      projectRoot: workspace,
      force: true,
      timeoutMs: 600000,
    });
    expect(outputs[0]).toMatchObject({
      command: "init",
      projectRoot: workspace,
      filePath,
      result: "created",
      delegatedInvestigations: 3,
      attempts: 1,
      modelBacked: true,
      provider: "grok",
      model: "grok-code-fast-1",
      usedFallback: false,
      force: true,
    });
  });

  it("returns an error when the target path does not exist", async () => {
    const missingPath = join(tmpdir(), "agenc-cli-init-missing", "repo");
    const deps = createDeps();
    const { context, outputs, errors } = createContextCapture();

    const code = await runInitCommand(
      context,
      {
        ...baseOptions(),
        path: missingPath,
      },
      deps,
    );

    expect(code).toBe(1);
    expect(outputs).toHaveLength(0);
    expect(deps.requestInitRun).not.toHaveBeenCalled();
    expect(errors[0]).toMatchObject({
      command: "init",
      status: "error",
      projectRoot: missingPath,
      message: `Target path does not exist: ${missingPath}`,
    });
  });

  it("returns an error when the target path is not a directory", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "agenc-cli-init-file-"));
    workspaces.push(workspace);
    const filePath = join(workspace, "not-a-dir.txt");
    writeFileSync(filePath, "demo", "utf-8");
    const deps = createDeps();
    const { context, outputs, errors } = createContextCapture();

    const code = await runInitCommand(
      context,
      {
        ...baseOptions(),
        path: filePath,
      },
      deps,
    );

    expect(code).toBe(1);
    expect(outputs).toHaveLength(0);
    expect(deps.requestInitRun).not.toHaveBeenCalled();
    expect(errors[0]).toMatchObject({
      command: "init",
      status: "error",
      projectRoot: filePath,
      message: `Target path is not a directory: ${filePath}`,
    });
  });

  it("surfaces daemon start failures before init.run is sent", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "agenc-cli-init-daemon-"));
    workspaces.push(workspace);
    const deps = createDeps({
      readPidFile: vi.fn().mockResolvedValue(null),
      runStartCommand: vi.fn(async (context) => {
        context.error({
          status: "error",
          command: "start",
          message: "Daemon is not running (no PID file found)",
        });
        return 1;
      }),
    });
    const { context, outputs, errors } = createContextCapture();

    const code = await runInitCommand(
      context,
      {
        ...baseOptions(),
        path: workspace,
        force: true,
      },
      deps,
    );

    expect(code).toBe(1);
    expect(outputs).toHaveLength(0);
    expect(deps.requestInitRun).not.toHaveBeenCalled();
    expect(errors[0]).toMatchObject({
      command: "init",
      status: "error",
      projectRoot: workspace,
      message: "Daemon is not running (no PID file found)",
    });
  });

  it("surfaces malformed daemon payloads", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "agenc-cli-init-invalid-"));
    workspaces.push(workspace);
    const deps = createDeps({
      readPidFile: vi.fn().mockResolvedValue({
        pid: 4242,
        port: 3100,
        configPath: "/tmp/agenc-config.json",
      }),
      requestInitRun: vi.fn(async () => {
        throw new Error("Daemon returned a malformed init.run payload");
      }),
    });
    const { context, outputs, errors } = createContextCapture();

    const code = await runInitCommand(
      context,
      {
        ...baseOptions(),
        path: workspace,
        force: true,
      },
      deps,
    );

    expect(code).toBe(1);
    expect(outputs).toHaveLength(0);
    expect(errors[0]).toMatchObject({
      command: "init",
      status: "error",
      projectRoot: workspace,
      message: "Daemon returned a malformed init.run payload",
    });
  });

  it("rejects daemon success when the generated guide is invalid", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "agenc-cli-init-invalid-guide-"));
    workspaces.push(workspace);
    const filePath = join(workspace, "AGENC.md");
    const deps = createDeps({
      readPidFile: vi.fn().mockResolvedValue({
        pid: 4242,
        port: 3100,
        configPath: "/tmp/agenc-config.json",
      }),
      requestInitRun: vi.fn(async () => ({
        projectRoot: workspace,
        filePath,
        result: "created",
        delegatedInvestigations: 3,
        attempts: 1,
        modelBacked: true,
      })),
      readFile: vi.fn(async () => "# Repository Guidelines\n"),
    });
    const { context, outputs, errors } = createContextCapture();

    const code = await runInitCommand(
      context,
      {
        ...baseOptions(),
        path: workspace,
        force: true,
      },
      deps,
    );

    expect(code).toBe(1);
    expect(outputs).toHaveLength(0);
    expect(errors[0]).toMatchObject({
      command: "init",
      status: "error",
      projectRoot: workspace,
    });
    expect((errors[0] as Record<string, unknown>).message).toMatch(
      /failed validation/i,
    );
  });
});
