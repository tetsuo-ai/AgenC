import { describe, it, expect, vi, beforeEach } from "vitest";
import { SkillRegistry } from "./registry.js";
import { SkillState } from "./types.js";
import type { Skill, SkillContext, SkillAction } from "./types.js";
import {
  SkillNotFoundError,
  SkillAlreadyRegisteredError,
  SkillInitializationError,
} from "./errors.js";
import { silentLogger } from "../utils/logger.js";
import { Keypair, Connection } from "@solana/web3.js";

function createMockSkill(
  name: string,
  options?: {
    capabilities?: bigint;
    tags?: string[];
    initFail?: boolean;
    shutdownFail?: boolean;
  },
): Skill {
  let state = SkillState.Created;
  return {
    metadata: {
      name,
      description: `Mock skill: ${name}`,
      version: "1.0.0",
      requiredCapabilities: options?.capabilities ?? 0n,
      tags: options?.tags,
    },
    get state() {
      return state;
    },
    initialize: vi.fn(async () => {
      if (options?.initFail) {
        state = SkillState.Error;
        throw new Error("init failed");
      }
      state = SkillState.Ready;
    }),
    shutdown: vi.fn(async () => {
      if (options?.shutdownFail) {
        throw new Error("shutdown failed");
      }
      state = SkillState.Stopped;
    }),
    getActions: vi.fn(() => []),
    getAction: vi.fn(() => undefined),
  };
}

function createMockContext(): SkillContext {
  return {
    connection: {} as Connection,
    wallet: {
      publicKey: Keypair.generate().publicKey,
      signTransaction: vi.fn(async (tx) => tx),
      signAllTransactions: vi.fn(async (txs) => txs),
    },
    logger: silentLogger,
  };
}

describe("SkillRegistry", () => {
  let registry: SkillRegistry;

  beforeEach(() => {
    registry = new SkillRegistry({ logger: silentLogger });
  });

  describe("register", () => {
    it("registers a skill by name", () => {
      const skill = createMockSkill("test-skill");
      registry.register(skill);
      expect(registry.size).toBe(1);
      expect(registry.get("test-skill")).toBe(skill);
    });

    it("throws on duplicate name", () => {
      registry.register(createMockSkill("dup"));
      expect(() => registry.register(createMockSkill("dup"))).toThrow(
        SkillAlreadyRegisteredError,
      );
    });

    it("registers multiple skills", () => {
      registry.register(createMockSkill("a"));
      registry.register(createMockSkill("b"));
      registry.register(createMockSkill("c"));
      expect(registry.size).toBe(3);
    });
  });

  describe("unregister", () => {
    it("removes a registered skill", () => {
      registry.register(createMockSkill("rem"));
      expect(registry.unregister("rem")).toBe(true);
      expect(registry.size).toBe(0);
    });

    it("returns false for unknown skill", () => {
      expect(registry.unregister("unknown")).toBe(false);
    });
  });

  describe("get / getOrThrow", () => {
    it("returns undefined for unknown skill", () => {
      expect(registry.get("nope")).toBeUndefined();
    });

    it("throws SkillNotFoundError for unknown skill via getOrThrow", () => {
      expect(() => registry.getOrThrow("nope")).toThrow(SkillNotFoundError);
    });

    it("returns the skill if registered", () => {
      const skill = createMockSkill("found");
      registry.register(skill);
      expect(registry.getOrThrow("found")).toBe(skill);
    });
  });

  describe("findByCapability", () => {
    it("finds skills matching capability bitmask", () => {
      const compute = createMockSkill("compute", { capabilities: 1n }); // COMPUTE
      const network = createMockSkill("network", { capabilities: 8n }); // NETWORK
      const both = createMockSkill("both", { capabilities: 1n | 8n }); // COMPUTE | NETWORK

      registry.register(compute);
      registry.register(network);
      registry.register(both);

      // Agent with COMPUTE | NETWORK capabilities
      const results = registry.findByCapability(1n | 8n);
      expect(results).toHaveLength(3);

      // Agent with only COMPUTE
      const computeOnly = registry.findByCapability(1n);
      expect(computeOnly).toHaveLength(1);
      expect(computeOnly[0].metadata.name).toBe("compute");
    });

    it("returns empty array if no skills match", () => {
      registry.register(createMockSkill("a", { capabilities: 1n }));
      expect(registry.findByCapability(8n)).toHaveLength(0);
    });
  });

  describe("findByTag", () => {
    it("finds skills by tag", () => {
      registry.register(createMockSkill("a", { tags: ["defi", "swap"] }));
      registry.register(createMockSkill("b", { tags: ["nft"] }));
      registry.register(createMockSkill("c", { tags: ["defi", "staking"] }));

      const defiSkills = registry.findByTag("defi");
      expect(defiSkills).toHaveLength(2);
      expect(defiSkills.map((s) => s.metadata.name)).toEqual(["a", "c"]);
    });

    it("returns empty array for unknown tag", () => {
      registry.register(createMockSkill("a", { tags: ["x"] }));
      expect(registry.findByTag("nope")).toHaveLength(0);
    });
  });

  describe("listNames / listAll", () => {
    it("lists all registered names", () => {
      registry.register(createMockSkill("alpha"));
      registry.register(createMockSkill("beta"));
      expect(registry.listNames()).toEqual(["alpha", "beta"]);
    });

    it("listAll returns all skill instances", () => {
      const a = createMockSkill("a");
      const b = createMockSkill("b");
      registry.register(a);
      registry.register(b);
      expect(registry.listAll()).toEqual([a, b]);
    });
  });

  describe("initializeAll", () => {
    it("initializes all registered skills", async () => {
      const a = createMockSkill("a");
      const b = createMockSkill("b");
      registry.register(a);
      registry.register(b);

      await registry.initializeAll(createMockContext());

      expect(a.initialize).toHaveBeenCalledOnce();
      expect(b.initialize).toHaveBeenCalledOnce();
      expect(a.state).toBe(SkillState.Ready);
      expect(b.state).toBe(SkillState.Ready);
    });

    it("throws if any skill fails to initialize", async () => {
      registry.register(createMockSkill("ok"));
      registry.register(createMockSkill("bad", { initFail: true }));

      await expect(registry.initializeAll(createMockContext())).rejects.toThrow(
        SkillInitializationError,
      );
    });

    it("still initializes other skills even if one fails", async () => {
      const ok = createMockSkill("ok");
      registry.register(ok);
      registry.register(createMockSkill("bad", { initFail: true }));

      try {
        await registry.initializeAll(createMockContext());
      } catch {
        // expected
      }

      expect(ok.initialize).toHaveBeenCalledOnce();
      expect(ok.state).toBe(SkillState.Ready);
    });
  });

  describe("shutdownAll", () => {
    it("shuts down all ready skills", async () => {
      const a = createMockSkill("a");
      const b = createMockSkill("b");
      registry.register(a);
      registry.register(b);

      await registry.initializeAll(createMockContext());
      await registry.shutdownAll();

      expect(a.shutdown).toHaveBeenCalledOnce();
      expect(b.shutdown).toHaveBeenCalledOnce();
      expect(a.state).toBe(SkillState.Stopped);
      expect(b.state).toBe(SkillState.Stopped);
    });

    it("does not throw if a skill fails to shut down", async () => {
      const bad = createMockSkill("bad", { shutdownFail: true });
      registry.register(bad);

      await registry.initializeAll(createMockContext());
      // Should not throw
      await registry.shutdownAll();
    });

    it("skips skills not in Ready or Error state", async () => {
      const skill = createMockSkill("created");
      registry.register(skill);

      // skill is in Created state, never initialized
      await registry.shutdownAll();
      expect(skill.shutdown).not.toHaveBeenCalled();
    });
  });

  describe("isReady", () => {
    it("returns false when empty", () => {
      expect(registry.isReady()).toBe(false);
    });

    it("returns true when all skills are Ready", async () => {
      registry.register(createMockSkill("a"));
      registry.register(createMockSkill("b"));
      await registry.initializeAll(createMockContext());

      expect(registry.isReady()).toBe(true);
    });

    it("returns false if any skill is not Ready", async () => {
      registry.register(createMockSkill("ok"));
      registry.register(createMockSkill("not-init"));

      // Only initialize the first one manually
      const ctx = createMockContext();
      const ok = registry.get("ok")!;
      await ok.initialize(ctx);

      expect(registry.isReady()).toBe(false);
    });
  });
});
