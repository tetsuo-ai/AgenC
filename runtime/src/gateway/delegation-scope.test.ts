import { describe, expect, it } from "vitest";

import { assessDelegationScope } from "./delegation-scope.js";

describe("assessDelegationScope", () => {
  it("rejects implementation work that also includes browser validation", () => {
    const result = assessDelegationScope({
      task: "core_implementation",
      objective:
        "Create index.html and src/main.ts, implement the game loop, then open localhost in the browser and validate the flow in Chromium.",
      inputContract: "Return JSON with files and validation notes",
    });

    expect(result.ok).toBe(false);
    expect(result.decomposition?.code).toBe("needs_decomposition");
    expect(result.phases).toEqual(
      expect.arrayContaining(["implementation", "validation", "browser"]),
    );
  });

  it("does not classify explicitly negated browser automation as a browser phase", () => {
    const result = assessDelegationScope({
      task: "implement_web",
      objective:
        "Implement packages/web as a minimal Vite React app with SVG network viz and route display; no browser automation or runtime testing in this step.",
      inputContract:
        "Root workspaces, core/cli ready; include React components and Vite config.",
      acceptanceCriteria: [
        "Vite config and React app files created",
        "Visualizes sample network and routes via SVG",
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.phases).toEqual(
      expect.arrayContaining(["implementation"]),
    );
    expect(result.phases).not.toContain("browser");
  });

  it("does not classify browser-target product wording as a browser validation phase", () => {
    const result = assessDelegationScope({
      task: "implement_web",
      objective:
        "Build Vite TS app in packages/web with map editor, in-browser solver using core, and visualization of path plus cost. Keep code/build only in this step.",
      inputContract: "Core imported via file dep",
      acceptanceCriteria: [
        "Vite app with editable map and solve button",
        "Visual path rendering and cost display",
        "Web source files complete",
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.phases).toEqual(
      expect.arrayContaining(["implementation"]),
    );
    expect(result.phases).not.toContain("browser");
  });

  it("rejects research work that also asks the child to implement code", () => {
    const result = assessDelegationScope({
      task: "research_plus_build",
      objective:
        "Research Phaser vs Pixi from official docs, then scaffold src/main.ts and implement the selected stack.",
      inputContract: "Return JSON with framework choice and created files",
    });

    expect(result.ok).toBe(false);
    expect(result.decomposition?.code).toBe("needs_decomposition");
    expect(result.phases).toEqual(
      expect.arrayContaining(["research", "implementation"]),
    );
  });

  it("allows pure browser-grounded research steps", () => {
    const result = assessDelegationScope({
      task: "design_research",
      objective:
        "Research 3 reference games from official pages, navigate to each source, and return mechanics plus tuning targets.",
      inputContract: "Return JSON with references and tuning",
    });

    expect(result.ok).toBe(true);
    expect(result.phases).toEqual(
      expect.arrayContaining(["research", "browser"]),
    );
  });

  it("allows browser-only validation steps that edit app state in the UI", () => {
    const result = assessDelegationScope({
      task: "browser_verification",
      objective:
        "Verify main web flow using browser tools: load app, edit scenario, run simulation, confirm canvas viz/timeline/metrics.",
      inputContract: "Built web package",
      acceptanceCriteria: [
        "Browser-grounded evidence of working scenario editor, simulation, grid/route canvas, timeline, metrics",
      ],
      requiredToolCapabilities: ["system.browserSessionStart", "system.browserAction"],
    });

    expect(result.ok).toBe(true);
    expect(result.phases).toEqual(
      expect.arrayContaining(["validation", "browser"]),
    );
    expect(result.phases).not.toContain("implementation");
  });

  it("allows setup plus implementation without browser validation", () => {
    const result = assessDelegationScope({
      task: "core_implementation",
      objective:
        "Scaffold the project, create src/main.ts and src/Game.ts, and implement the core game loop and collision logic.",
      inputContract: "Return JSON with files_created and verification commands",
    });

    expect(result.ok).toBe(true);
    expect(result.phases).toEqual(
      expect.arrayContaining(["setup", "implementation"]),
    );
  });

  it("rejects oversized workspace scaffold phases that mix manifests, directories, and entry files", () => {
    const result = assessDelegationScope({
      task: "scaffold_structure",
      objective:
        "Author all package.json manifests, tsconfig.json, vite.config.ts and root config files with file: local deps only. Create directory structure and basic entry files.",
      inputContract: "none",
      acceptanceCriteria: [
        "Manifests and configs authored with file: deps, no workspace:*",
        "Directory structure and placeholder files present",
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.decomposition?.code).toBe("needs_decomposition");
    expect(result.phases).toEqual(
      expect.arrayContaining(["setup", "implementation"]),
    );
  });

  it("does not classify plain gameplay implementation as research", () => {
    const result = assessDelegationScope({
      task: "implement_gameplay",
      objective: "Implement the gameplay code only.",
      inputContract: "Return JSON with implementation summary and changed files",
      acceptanceCriteria: ["Implement the core gameplay loop"],
    });

    expect(result.ok).toBe(true);
    expect(result.phases).toEqual(["implementation"]);
  });

  it("does not classify research about a failing test as validation work", () => {
    const result = assessDelegationScope({
      task: "research_failure",
      objective: "Research flaky test root cause",
      inputContract: "Provide hypothesis and evidence",
      acceptanceCriteria: ["Pinpoint likely failure source", "Cite relevant logs"],
    });

    expect(result.ok).toBe(true);
    expect(result.phases).toEqual(["research"]);
  });

  it("allows implementation steps that include focused compile verification", () => {
    const result = assessDelegationScope({
      task: "implement_cli",
      objective:
        "Implement packages/cli with commander commands validate and route that use core; output cost, transfer count, and ordered steps.",
      inputContract: "Core implemented and built; cli/src ready.",
      acceptanceCriteria: ["CLI commands functional and compile; uses core package"],
    });

    expect(result.ok).toBe(true);
    expect(result.phases).toEqual(
      expect.arrayContaining(["implementation", "validation"]),
    );
  });

  it("does not classify source code mentions as research work", () => {
    const result = assessDelegationScope({
      task: "scaffold_monorepo_configs",
      objective:
        "Create root and per-package package.json/tsconfig/vite/vitest config files for workspaces monorepo; use file:../core links, add deps like typescript/vitest/commander/react/vite; no source code yet.",
      inputContract: "Root dir and empty package subdirs exist.",
      acceptanceCriteria: [
        "Root package.json has workspaces and scripts; per-package package.json and tsconfigs present; configs valid; no src implementation",
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.phases).not.toContain("research");
  });

  it("does not classify TypeScript project references as research work", () => {
    const result = assessDelegationScope({
      task: "scaffold_manifests",
      objective:
        "Author root package.json (workspaces+scripts), per-package package.json (using file:../core for local deps), tsconfig.json files with references, vite.config.ts+index.html for web, and minimal src entry points. Only file authoring and structure checks.",
      inputContract: "Root dir and package subdirs exist.",
      acceptanceCriteria: [
        "Root+package manifests created with file: local deps, no workspace:*",
        "TS/Vite configs present",
        "Basic src/index.ts stubs in each package",
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.phases).toEqual(
      expect.arrayContaining(["implementation"]),
    );
    expect(result.phases).not.toContain("research");
  });
});
