import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MarkdownSkillInjector,
  estimateTokens,
  scoreRelevance,
  type SkillInjectorConfig,
} from "./injector.js";
import type { MarkdownSkill } from "./types.js";
import type { DiscoveredSkill } from "./discovery.js";
import { SkillDiscovery } from "./discovery.js";

// ============================================================================
// Helpers
// ============================================================================

function makeSkill(overrides?: Partial<MarkdownSkill>): MarkdownSkill {
  return {
    name: overrides?.name ?? "test-skill",
    description: overrides?.description ?? "A test skill",
    version: "1.0.0",
    metadata: {
      requires: { binaries: [], env: [], channels: [], os: [] },
      install: [],
      tags: [],
      ...overrides?.metadata,
    },
    body: overrides?.body ?? "Test skill body content.",
    sourcePath: overrides?.sourcePath,
  };
}

function makeDiscovered(
  skill: MarkdownSkill,
  tier: "agent" | "user" | "project" | "builtin" = "builtin",
): DiscoveredSkill {
  return { skill, available: true, tier };
}

function makeMockDiscovery(skills: DiscoveredSkill[]): SkillDiscovery {
  const discovery = Object.create(SkillDiscovery.prototype) as SkillDiscovery;
  discovery.getAvailable = vi
    .fn<() => Promise<DiscoveredSkill[]>>()
    .mockResolvedValue(skills);
  return discovery;
}

function makeInjector(
  skills: DiscoveredSkill[],
  overrides?: Partial<SkillInjectorConfig>,
): MarkdownSkillInjector {
  return new MarkdownSkillInjector({
    discovery: makeMockDiscovery(skills),
    ...overrides,
  });
}

const silentLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

// ============================================================================
// Tests
// ============================================================================

describe("estimateTokens", () => {
  it("returns ceil(length / 4)", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("a")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("a".repeat(16))).toBe(4);
    expect(estimateTokens("a".repeat(17))).toBe(5);
  });
});

describe("scoreRelevance", () => {
  it("returns higher score for matching tags", () => {
    const skill = makeSkill({
      name: "github",
      description: "GitHub integration",
      metadata: {
        requires: { binaries: [], env: [], channels: [], os: [] },
        install: [],
        tags: ["github", "git", "repository", "pull-request"],
      },
    });

    const highScore = scoreRelevance("create a github pull request", skill);
    const lowScore = scoreRelevance("check solana balance", skill);

    expect(highScore).toBeGreaterThan(lowScore);
    expect(highScore).toBeGreaterThan(0);
  });

  it("returns 1.0 for explicit /skill command", () => {
    const skill = makeSkill({ name: "github" });
    expect(scoreRelevance("/skill github", skill)).toBe(1.0);
    expect(scoreRelevance("please /skill github now", skill)).toBe(1.0);
  });

  it("returns 0 for no match", () => {
    const skill = makeSkill({
      name: "github",
      description: "GitHub integration",
      metadata: {
        requires: { binaries: [], env: [], channels: [], os: [] },
        install: [],
        tags: ["github"],
      },
    });

    expect(scoreRelevance("solana blockchain defi", skill)).toBe(0);
  });

  it("returns 0 for empty message", () => {
    const skill = makeSkill({ name: "github" });
    expect(scoreRelevance("", skill)).toBe(0);
  });

  it("is case-insensitive", () => {
    const skill = makeSkill({
      name: "GitHub",
      metadata: {
        requires: { binaries: [], env: [], channels: [], os: [] },
        install: [],
        tags: ["GitHub"],
      },
    });

    expect(scoreRelevance("/skill GitHub", skill)).toBe(1.0);
    expect(scoreRelevance("use GITHUB", skill)).toBeGreaterThan(0);
  });
});

describe("MarkdownSkillInjector", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1700000000000);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // --------------------------------------------------------------------------
  // inject
  // --------------------------------------------------------------------------

  describe("inject", () => {
    it("returns formatted <skill> blocks for matching skills", async () => {
      const skill = makeSkill({
        name: "github",
        description: "GitHub integration",
        body: "Use `gh` CLI for GitHub.",
        metadata: {
          requires: { binaries: [], env: [], channels: [], os: [] },
          install: [],
          tags: ["github", "repository"],
        },
      });

      const injector = makeInjector([makeDiscovered(skill)], {
        logger: silentLogger,
      });
      const result = await injector.inject(
        "open a github repository",
        "session-1",
      );

      expect(result).toContain('<skill name="github">');
      expect(result).toContain("Use `gh` CLI for GitHub.");
      expect(result).toContain("</skill>");
    });

    it("returns undefined when no skills match", async () => {
      const skill = makeSkill({
        name: "github",
        metadata: {
          requires: { binaries: [], env: [], channels: [], os: [] },
          install: [],
          tags: ["github"],
        },
      });

      const injector = makeInjector([makeDiscovered(skill)], {
        logger: silentLogger,
      });
      const result = await injector.inject(
        "solana blockchain defi",
        "session-1",
      );

      expect(result).toBeUndefined();
    });

    it("filters by capability bitmask", async () => {
      const skill = makeSkill({
        name: "inference-skill",
        description: "ML inference skill",
        metadata: {
          requires: { binaries: [], env: [], channels: [], os: [] },
          install: [],
          tags: ["inference", "ml"],
          requiredCapabilities: "2", // INFERENCE = 1n << 1n = 2n
        },
      });

      // Agent has no capabilities → skill filtered out
      const injector1 = makeInjector([makeDiscovered(skill)], {
        agentCapabilities: 0n,
        logger: silentLogger,
      });
      const result1 = await injector1.inject(
        "/skill inference-skill",
        "session-1",
      );
      expect(result1).toBeUndefined();

      // Agent has INFERENCE capability → skill included
      const injector2 = makeInjector([makeDiscovered(skill)], {
        agentCapabilities: 2n,
        logger: silentLogger,
      });
      const result2 = await injector2.inject(
        "/skill inference-skill",
        "session-1",
      );
      expect(result2).toContain('<skill name="inference-skill">');
    });

    it("requires ALL capability bits, not just any overlap", async () => {
      const skill = makeSkill({
        name: "multi-cap",
        description: "Needs compute and inference",
        metadata: {
          requires: { binaries: [], env: [], channels: [], os: [] },
          install: [],
          tags: ["multi"],
          requiredCapabilities: "0x03", // COMPUTE | INFERENCE = 3
        },
      });

      // Agent has only INFERENCE (2n) — missing COMPUTE → excluded
      const injector1 = makeInjector([makeDiscovered(skill)], {
        agentCapabilities: 2n,
        logger: silentLogger,
      });
      const result1 = await injector1.inject("/skill multi-cap", "session-1");
      expect(result1).toBeUndefined();

      // Agent has both COMPUTE | INFERENCE (3n) → included
      const injector2 = makeInjector([makeDiscovered(skill)], {
        agentCapabilities: 3n,
        logger: silentLogger,
      });
      const result2 = await injector2.inject("/skill multi-cap", "session-1");
      expect(result2).toContain('<skill name="multi-cap">');

      // Agent has COMPUTE | INFERENCE | STORAGE (7n) — superset → included
      const injector3 = makeInjector([makeDiscovered(skill)], {
        agentCapabilities: 7n,
        logger: silentLogger,
      });
      const result3 = await injector3.inject("/skill multi-cap", "session-1");
      expect(result3).toContain('<skill name="multi-cap">');
    });

    it("handles hex requiredCapabilities strings", async () => {
      const skill = makeSkill({
        name: "hex-skill",
        description: "Hex caps skill",
        metadata: {
          requires: { binaries: [], env: [], channels: [], os: [] },
          install: [],
          tags: ["hex"],
          requiredCapabilities: "0xFF", // all 8 lower bits
        },
      });

      const injector = makeInjector([makeDiscovered(skill)], {
        agentCapabilities: 0xffn,
        logger: silentLogger,
      });
      const result = await injector.inject("/skill hex-skill", "session-1");
      expect(result).toContain('<skill name="hex-skill">');
    });

    it("skills with no requiredCapabilities always pass filter", async () => {
      const skill = makeSkill({
        name: "basic",
        description: "Basic skill",
        metadata: {
          requires: { binaries: [], env: [], channels: [], os: [] },
          install: [],
          tags: ["basic"],
        },
      });

      const injector = makeInjector([makeDiscovered(skill)], {
        agentCapabilities: 0n,
        logger: silentLogger,
      });
      const result = await injector.inject("/skill basic", "session-1");
      expect(result).toContain('<skill name="basic">');
    });

    it("respects token budget", async () => {
      // Budget = 100 tokens = ~400 chars. Big skill ~360 chars body + wrapper fills it.
      const bigSkill = makeSkill({
        name: "big",
        description: "Big skill",
        body: "x".repeat(350),
        metadata: {
          requires: { binaries: [], env: [], channels: [], os: [] },
          install: [],
          tags: ["big"],
        },
      });
      const smallSkill = makeSkill({
        name: "small",
        description: "Small skill",
        body: "Small body.",
        metadata: {
          requires: { binaries: [], env: [], channels: [], os: [] },
          install: [],
          tags: ["small"],
        },
      });

      const injector = makeInjector(
        [makeDiscovered(bigSkill), makeDiscovered(smallSkill)],
        { maxTokenBudget: 100, logger: silentLogger },
      );

      // Both match via /skill
      const result = await injector.injectDetailed(
        "/skill big /skill small",
        "session-1",
      );

      // Big skill fills budget, small should be excluded
      expect(result.injectedSkills).toContain("big");
      expect(result.excludedSkills).toContain("small");
    });

    it("prioritizes higher-scoring skills", async () => {
      const githubSkill = makeSkill({
        name: "github",
        description: "GitHub integration",
        metadata: {
          requires: { binaries: [], env: [], channels: [], os: [] },
          install: [],
          tags: ["github", "repository", "pull-request"],
        },
      });
      const genericSkill = makeSkill({
        name: "generic",
        description: "Generic tool",
        metadata: {
          requires: { binaries: [], env: [], channels: [], os: [] },
          install: [],
          tags: ["tool"],
        },
      });

      const injector = makeInjector(
        [makeDiscovered(genericSkill), makeDiscovered(githubSkill)],
        { logger: silentLogger },
      );
      const result = await injector.injectDetailed(
        "create github pull request",
        "session-1",
      );

      // github skill should be first (higher relevance)
      if (result.injectedSkills.length >= 1) {
        expect(result.injectedSkills[0]).toBe("github");
      }
    });
  });

  // --------------------------------------------------------------------------
  // Cache
  // --------------------------------------------------------------------------

  describe("cache", () => {
    it("caches discovery results per session", async () => {
      const skill = makeSkill({
        name: "cached",
        metadata: {
          requires: { binaries: [], env: [], channels: [], os: [] },
          install: [],
          tags: ["cached"],
        },
      });
      const discovery = makeMockDiscovery([makeDiscovered(skill)]);
      const injector = new MarkdownSkillInjector({
        discovery,
        logger: silentLogger,
      });

      await injector.inject("/skill cached", "session-1");
      await injector.inject("/skill cached", "session-1");

      expect(discovery.getAvailable).toHaveBeenCalledOnce();
    });

    it("refreshes cache after TTL expires", async () => {
      const skill = makeSkill({
        name: "cached",
        metadata: {
          requires: { binaries: [], env: [], channels: [], os: [] },
          install: [],
          tags: ["cached"],
        },
      });
      const discovery = makeMockDiscovery([makeDiscovered(skill)]);
      const injector = new MarkdownSkillInjector({
        discovery,
        sessionCacheTtlMs: 1000,
        logger: silentLogger,
      });

      await injector.inject("/skill cached", "session-1");
      vi.advanceTimersByTime(1500);
      await injector.inject("/skill cached", "session-1");

      expect(discovery.getAvailable).toHaveBeenCalledTimes(2);
    });

    it("clearCache invalidates specific session", async () => {
      const skill = makeSkill({
        name: "cached",
        metadata: {
          requires: { binaries: [], env: [], channels: [], os: [] },
          install: [],
          tags: ["cached"],
        },
      });
      const discovery = makeMockDiscovery([makeDiscovered(skill)]);
      const injector = new MarkdownSkillInjector({
        discovery,
        logger: silentLogger,
      });

      await injector.inject("/skill cached", "session-1");
      injector.clearCache("session-1");
      await injector.inject("/skill cached", "session-1");

      expect(discovery.getAvailable).toHaveBeenCalledTimes(2);
    });

    it("clearCache with no arg clears all sessions", async () => {
      const skill = makeSkill({
        name: "cached",
        metadata: {
          requires: { binaries: [], env: [], channels: [], os: [] },
          install: [],
          tags: ["cached"],
        },
      });
      const discovery = makeMockDiscovery([makeDiscovered(skill)]);
      const injector = new MarkdownSkillInjector({
        discovery,
        logger: silentLogger,
      });

      await injector.inject("/skill cached", "session-1");
      await injector.inject("/skill cached", "session-2");
      injector.clearCache();
      await injector.inject("/skill cached", "session-1");
      await injector.inject("/skill cached", "session-2");

      // Initial 2 + 2 after clear
      expect(discovery.getAvailable).toHaveBeenCalledTimes(4);
    });
  });

  // --------------------------------------------------------------------------
  // injectDetailed
  // --------------------------------------------------------------------------

  describe("injectDetailed", () => {
    it("returns injected/excluded lists and token count", async () => {
      const skill1 = makeSkill({
        name: "skill-a",
        description: "Alpha skill",
        body: "Alpha body content here.",
        metadata: {
          requires: { binaries: [], env: [], channels: [], os: [] },
          install: [],
          tags: ["alpha"],
        },
      });
      const skill2 = makeSkill({
        name: "skill-b",
        description: "Beta skill",
        body: "Beta body.",
        metadata: {
          requires: { binaries: [], env: [], channels: [], os: [] },
          install: [],
          tags: ["beta"],
        },
      });

      const injector = makeInjector(
        [makeDiscovered(skill1), makeDiscovered(skill2)],
        { logger: silentLogger },
      );

      const result = await injector.injectDetailed(
        "/skill skill-a /skill skill-b",
        "session-1",
      );

      expect(result.injectedSkills).toContain("skill-a");
      expect(result.injectedSkills).toContain("skill-b");
      expect(result.estimatedTokens).toBeGreaterThan(0);
      expect(result.content).toBeDefined();
    });

    it("returns empty result when nothing matches", async () => {
      const injector = makeInjector([], { logger: silentLogger });
      const result = await injector.injectDetailed("hello world", "session-1");

      expect(result.content).toBeUndefined();
      expect(result.injectedSkills).toEqual([]);
      expect(result.excludedSkills).toEqual([]);
      expect(result.estimatedTokens).toBe(0);
    });
  });
});
