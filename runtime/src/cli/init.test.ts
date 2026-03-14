import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createContextCapture } from "./test-utils.js";
import { runInitCommand } from "./init.js";
import type { InitOptions } from "./types.js";

function baseOptions(): InitOptions {
  return {
    help: false,
    outputFormat: "json",
    strictMode: false,
    storeType: "sqlite",
    idempotencyWindow: 900,
    force: false,
  };
}

describe("init CLI command", () => {
  const workspaces: string[] = [];

  afterEach(() => {
    for (const workspace of workspaces.splice(0)) {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("creates AGENC.md for the target project root", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "agenc-cli-init-"));
    workspaces.push(workspace);
    writeFileSync(
      join(workspace, "package.json"),
      JSON.stringify({ scripts: { build: "tsc -b" } }, null, 2),
      "utf-8",
    );

    const { context, outputs, errors } = createContextCapture();
    const code = await runInitCommand(context, {
      ...baseOptions(),
      path: workspace,
    });

    expect(code).toBe(0);
    expect(errors).toHaveLength(0);
    expect(existsSync(join(workspace, "AGENC.md"))).toBe(true);
    expect(outputs[0]).toMatchObject({
      command: "init",
      result: "created",
      projectRoot: workspace,
    });
  });

  it("reports skipped when AGENC.md already exists and force is not set", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "agenc-cli-init-skip-"));
    workspaces.push(workspace);
    writeFileSync(join(workspace, "AGENC.md"), "# Existing\n", "utf-8");

    const { context, outputs, errors } = createContextCapture();
    const code = await runInitCommand(context, {
      ...baseOptions(),
      path: workspace,
    });

    expect(code).toBe(0);
    expect(errors).toHaveLength(0);
    expect(outputs[0]).toMatchObject({
      command: "init",
      result: "skipped",
    });
  });

  it("returns an error when the target path does not exist", async () => {
    const { context, outputs, errors } = createContextCapture();
    const missingPath = join(tmpdir(), "agenc-cli-init-missing", "repo");
    const code = await runInitCommand(context, {
      ...baseOptions(),
      path: missingPath,
    });

    expect(code).toBe(1);
    expect(outputs).toHaveLength(0);
    expect(errors[0]).toMatchObject({
      command: "init",
      status: "error",
      projectRoot: missingPath,
    });
  });
});
