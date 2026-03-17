import { describe, expect, it } from "vitest";
import {
  getEvalScriptPathCandidates,
  resolveEvalScriptPathCandidates,
} from "./daemon-command-registry.js";

describe("eval script path resolution", () => {
  it("resolves only the tool-owned eval harness path candidates", () => {
    const candidates = getEvalScriptPathCandidates({
      cwd: "/repo",
      workspacePath: "/workspace",
    });

    expect(candidates).toEqual([
      "/repo/tools/eval/agenc-eval-test.cjs",
      "/workspace/tools/eval/agenc-eval-test.cjs",
    ]);
  });

  it("deduplicates candidates when cwd and workspace paths are the same", () => {
    const candidates = getEvalScriptPathCandidates({
      cwd: "/repo",
      workspacePath: "/repo",
    });

    expect(candidates).toEqual(["/repo/tools/eval/agenc-eval-test.cjs"]);
  });

  it("returns the first readable candidate", async () => {
    const scriptPath = await resolveEvalScriptPathCandidates({
      cwd: "/repo",
      workspacePath: "/workspace",
      canRead: async (candidate) => candidate === "/workspace/tools/eval/agenc-eval-test.cjs",
    });

    expect(scriptPath).toBe("/workspace/tools/eval/agenc-eval-test.cjs");
  });
});
