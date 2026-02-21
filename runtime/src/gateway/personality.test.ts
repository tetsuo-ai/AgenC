import { describe, expect, it } from "vitest";
import {
  loadPersonalityTemplate,
  listPersonalityTemplates,
  mergePersonality,
  type PersonalityTemplate,
} from "./personality.js";
import type { WorkspaceFiles } from "./workspace-files.js";

describe("listPersonalityTemplates", () => {
  it("returns all 4 templates", () => {
    const templates = listPersonalityTemplates();
    expect(templates).toHaveLength(4);
    expect(templates).toContain("default");
    expect(templates).toContain("defi-analyst");
    expect(templates).toContain("developer");
    expect(templates).toContain("minimal");
  });

  it("returns a readonly array", () => {
    const a = listPersonalityTemplates();
    const b = listPersonalityTemplates();
    expect(a).toBe(b); // same reference
  });
});

describe("loadPersonalityTemplate", () => {
  it("default returns all workspace files", () => {
    const files = loadPersonalityTemplate("default");
    expect(files.agent).toBeDefined();
    expect(files.soul).toBeDefined();
    expect(files.user).toBeDefined();
    expect(files.tools).toBeDefined();
    expect(files.heartbeat).toBeDefined();
    expect(files.boot).toBeDefined();
    expect(files.capabilities).toBeDefined();
    expect(files.policy).toBeDefined();
    expect(files.reputation).toBeDefined();
  });

  it("defi-analyst has DeFi-specific content", () => {
    const files = loadPersonalityTemplate("defi-analyst");
    expect(files.agent).toContain("DeFi");
    expect(files.soul).toContain("data-driven");
    expect(files.tools).toContain("Jupiter");
    expect(files.capabilities).toContain("price feeds");
    expect(files.policy).toContain("slippage");
  });

  it("developer has development-specific content", () => {
    const files = loadPersonalityTemplate("developer");
    expect(files.agent).toContain("Developer");
    expect(files.agent).toContain("code analysis");
    expect(files.soul).toContain("rigorous");
    expect(files.capabilities).toContain("code execution");
  });

  it("minimal has minimal content", () => {
    const files = loadPersonalityTemplate("minimal");
    expect(files.agent).toBeDefined();
    expect(files.agent!.length).toBeLessThan(
      loadPersonalityTemplate("default").agent!.length,
    );
  });

  it("all templates have non-empty AGENT.md content", () => {
    for (const name of listPersonalityTemplates()) {
      const files = loadPersonalityTemplate(name);
      expect(files.agent).toBeDefined();
      expect(files.agent!.length).toBeGreaterThan(0);
    }
  });

  it("all templates have non-empty SOUL.md content", () => {
    for (const name of listPersonalityTemplates()) {
      const files = loadPersonalityTemplate(name);
      expect(files.soul).toBeDefined();
      expect(files.soul!.length).toBeGreaterThan(0);
    }
  });

  it("all template content is valid markdown (contains headings)", () => {
    for (const name of listPersonalityTemplates()) {
      const files = loadPersonalityTemplate(name);
      expect(files.agent).toContain("#");
      expect(files.soul).toContain("#");
    }
  });

  it("default returns a fresh copy each time", () => {
    const a = loadPersonalityTemplate("default");
    const b = loadPersonalityTemplate("default");
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  it("defi-analyst inherits non-overridden fields from default", () => {
    const defi = loadPersonalityTemplate("defi-analyst");
    const def = loadPersonalityTemplate("default");
    // heartbeat, boot, reputation are not overridden
    expect(defi.heartbeat).toBe(def.heartbeat);
    expect(defi.boot).toBe(def.boot);
    expect(defi.reputation).toBe(def.reputation);
  });

  it("developer inherits non-overridden fields from default", () => {
    const dev = loadPersonalityTemplate("developer");
    const def = loadPersonalityTemplate("default");
    expect(dev.heartbeat).toBe(def.heartbeat);
    expect(dev.boot).toBe(def.boot);
    expect(dev.reputation).toBe(def.reputation);
    expect(dev.policy).toBe(def.policy);
  });
});

describe("mergePersonality", () => {
  it("overrides specific fields", () => {
    const base = loadPersonalityTemplate("default");
    const merged = mergePersonality(base, { agent: "# Custom Agent" });
    expect(merged.agent).toBe("# Custom Agent");
  });

  it("preserves base fields not overridden", () => {
    const base = loadPersonalityTemplate("default");
    const merged = mergePersonality(base, { agent: "# Custom Agent" });
    expect(merged.soul).toBe(base.soul);
    expect(merged.tools).toBe(base.tools);
    expect(merged.heartbeat).toBe(base.heartbeat);
    expect(merged.boot).toBe(base.boot);
    expect(merged.capabilities).toBe(base.capabilities);
    expect(merged.policy).toBe(base.policy);
    expect(merged.reputation).toBe(base.reputation);
  });

  it("overrides multiple fields at once", () => {
    const base = loadPersonalityTemplate("default");
    const merged = mergePersonality(base, {
      agent: "# A",
      soul: "# S",
      tools: "# T",
    });
    expect(merged.agent).toBe("# A");
    expect(merged.soul).toBe("# S");
    expect(merged.tools).toBe("# T");
    expect(merged.user).toBe(base.user);
  });

  it("does not override with undefined", () => {
    const base = loadPersonalityTemplate("default");
    const merged = mergePersonality(base, { agent: undefined });
    expect(merged.agent).toBe(base.agent);
  });

  it("handles empty overrides", () => {
    const base = loadPersonalityTemplate("default");
    const merged = mergePersonality(base, {});
    expect(merged).toEqual(base);
  });

  it("handles identity and memory fields", () => {
    const base: WorkspaceFiles = {
      agent: "# A",
      identity: "# I",
      memory: "# M",
    };
    const merged = mergePersonality(base, { identity: "# New I" });
    expect(merged.identity).toBe("# New I");
    expect(merged.memory).toBe("# M");
  });
});
