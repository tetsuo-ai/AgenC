import { describe, it, expect, vi, beforeEach } from "vitest";
import { PublicKey, Keypair } from "@solana/web3.js";
import { SkillMonetizationManager } from "./manager.js";
import { SkillSubscriptionError } from "./errors.js";
import { SECONDS_PER_MONTH, SECONDS_PER_YEAR } from "./types.js";
import type {
  SkillMonetizationConfig,
  SubscriptionModel,
  SubscribeParams,
} from "./types.js";
import { silentLogger } from "../../utils/logger.js";
import { generateAgentId } from "../../utils/encoding.js";

// ============================================================================
// Test Helpers
// ============================================================================

function randomPubkey(): PublicKey {
  return Keypair.generate().publicKey;
}

function createMockPurchaseManager() {
  return {
    purchase: vi.fn().mockResolvedValue({
      skillId: "test-skill",
      paid: true,
      pricePaid: 1_000_000n,
      protocolFee: 20_000n,
      transactionSignature: "mock-tx-sig",
      contentPath: "/tmp/skill.md",
    }),
    isPurchased: vi.fn().mockResolvedValue(false),
    fetchPurchaseRecord: vi.fn().mockResolvedValue(null),
    getPurchaseHistory: vi.fn().mockResolvedValue([]),
  } as any;
}

function createManager(overrides: Partial<SkillMonetizationConfig> = {}): {
  manager: SkillMonetizationManager;
  purchaseManager: ReturnType<typeof createMockPurchaseManager>;
  clock: { now: number };
} {
  const purchaseManager = overrides.purchaseManager
    ? (overrides.purchaseManager as any)
    : createMockPurchaseManager();
  const clock = { now: 1700000000 };
  const config: SkillMonetizationConfig = {
    purchaseManager,
    agentId: overrides.agentId ?? generateAgentId("test-buyer"),
    logger: silentLogger,
    clockFn: () => clock.now,
    ...overrides,
  };
  const manager = new SkillMonetizationManager(config);
  return { manager, purchaseManager, clock };
}

const defaultModel: SubscriptionModel = {
  pricePerMonth: 1_000_000n,
  pricePerYear: 10_000_000n,
  freeTier: false,
};

function makeParams(overrides: Partial<SubscribeParams> = {}): SubscribeParams {
  return {
    skillId: "test-skill",
    skillPda: randomPubkey(),
    period: "monthly",
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("SkillMonetizationManager", () => {
  describe("model management", () => {
    it("registers and retrieves a subscription model", () => {
      const { manager } = createManager();
      manager.registerModel("skill-1", defaultModel);

      expect(manager.getModel("skill-1")).toEqual(defaultModel);
    });

    it("returns undefined for unregistered model", () => {
      const { manager } = createManager();
      expect(manager.getModel("unknown")).toBeUndefined();
    });
  });

  describe("subscribe", () => {
    it("throws when no model registered", async () => {
      const { manager } = createManager();

      await expect(manager.subscribe(makeParams())).rejects.toThrow(
        SkillSubscriptionError,
      );
    });

    it("free tier — instant access, no payment", async () => {
      const { manager, purchaseManager } = createManager();
      manager.registerModel("free-skill", { ...defaultModel, freeTier: true });

      const result = await manager.subscribe(
        makeParams({ skillId: "free-skill" }),
      );

      expect(result.status).toBe("active");
      expect(result.pricePaid).toBe(0n);
      expect(result.protocolFee).toBe(0n);
      expect(result.isRenewal).toBe(false);
      expect(purchaseManager.purchase).not.toHaveBeenCalled();
    });

    it("paid monthly subscription", async () => {
      const { manager, purchaseManager, clock } = createManager();
      manager.registerModel("test-skill", defaultModel);
      const params = makeParams();

      const result = await manager.subscribe(params);

      expect(result.status).toBe("active");
      expect(result.pricePaid).toBe(1_000_000n);
      expect(result.protocolFee).toBe(20_000n);
      expect(result.transactionSignature).toBe("mock-tx-sig");
      expect(result.isRenewal).toBe(false);
      expect(result.expiresAt).toBe(clock.now + SECONDS_PER_MONTH);
      expect(purchaseManager.purchase).toHaveBeenCalledWith(
        params.skillPda,
        "test-skill",
        "",
      );
    });

    it("paid yearly subscription", async () => {
      const { manager, clock } = createManager();
      manager.registerModel("test-skill", defaultModel);

      const result = await manager.subscribe(makeParams({ period: "yearly" }));

      expect(result.expiresAt).toBe(clock.now + SECONDS_PER_YEAR);
    });

    it("trial period — no payment", async () => {
      const { manager, purchaseManager, clock } = createManager();
      manager.registerModel("trial-skill", { ...defaultModel, trialDays: 7 });

      const result = await manager.subscribe(
        makeParams({ skillId: "trial-skill" }),
      );

      expect(result.status).toBe("trial");
      expect(result.pricePaid).toBe(0n);
      expect(result.expiresAt).toBe(clock.now + 7 * 86_400);
      expect(result.isRenewal).toBe(false);
      expect(purchaseManager.purchase).not.toHaveBeenCalled();
    });

    it("second subscribe after trial goes to paid", async () => {
      const { manager, purchaseManager, clock } = createManager();
      manager.registerModel("trial-skill", { ...defaultModel, trialDays: 7 });
      const params = makeParams({ skillId: "trial-skill" });

      // First: trial
      await manager.subscribe(params);

      // Expire the trial
      clock.now += 8 * 86_400;
      // Force status to expired by checking access
      await manager.checkAccess("trial-skill");

      // Second: paid (trial already used)
      const result = await manager.subscribe(params);
      expect(result.status).toBe("active");
      expect(purchaseManager.purchase).toHaveBeenCalled();
    });

    it("renewal extends time from current expiry", async () => {
      const { manager, clock } = createManager();
      manager.registerModel("test-skill", defaultModel);
      const params = makeParams();

      const first = await manager.subscribe(params);
      const originalExpiry = first.expiresAt;

      // Renew before expiry
      clock.now += 100;
      const renewal = await manager.subscribe(params);

      expect(renewal.isRenewal).toBe(true);
      expect(renewal.pricePaid).toBe(0n);
      expect(renewal.status).toBe("active");
      expect(renewal.expiresAt).toBe(originalExpiry + SECONDS_PER_MONTH);
    });

    it("renewal on expired subscription extends from now", async () => {
      const { manager, clock } = createManager();
      manager.registerModel("test-skill", defaultModel);
      const params = makeParams();

      await manager.subscribe(params);

      // Expire
      clock.now += SECONDS_PER_MONTH + 100;
      // Access check marks as expired
      await manager.checkAccess("test-skill");

      // Re-subscribe — not a renewal since expired, goes to purchase path
      // But since trialHistory is set, it'll try to purchase
      const result = await manager.subscribe(params);
      expect(result.pricePaid).toBe(1_000_000n);
      expect(result.isRenewal).toBe(false);
    });

    it("passes targetPath to purchase", async () => {
      const { manager, purchaseManager } = createManager();
      manager.registerModel("test-skill", defaultModel);

      await manager.subscribe(makeParams({ targetPath: "/my/path" }));

      expect(purchaseManager.purchase).toHaveBeenCalledWith(
        expect.any(PublicKey),
        "test-skill",
        "/my/path",
      );
    });

    it("cancelled subscription re-subscribe goes to paid purchase", async () => {
      const { manager, purchaseManager } = createManager();
      manager.registerModel("test-skill", defaultModel);
      const params = makeParams();

      await manager.subscribe(params);
      manager.unsubscribe("test-skill");

      // Clear mock call count from initial subscribe
      purchaseManager.purchase.mockClear();

      // Re-subscribe after cancel — cancelled status is not active/trial,
      // so falls through to paid purchase path
      const result = await manager.subscribe(params);
      expect(result.isRenewal).toBe(false);
      expect(result.pricePaid).toBe(1_000_000n);
      expect(purchaseManager.purchase).toHaveBeenCalled();
    });
  });

  describe("unsubscribe", () => {
    it("cancels an active subscription", async () => {
      const { manager, clock } = createManager();
      manager.registerModel("test-skill", defaultModel);
      await manager.subscribe(makeParams());

      manager.unsubscribe("test-skill");

      const sub = manager.getSubscription("test-skill");
      expect(sub).toBeDefined();
      expect(sub!.status).toBe("cancelled");
      expect(sub!.cancelledAt).toBe(clock.now);
    });

    it("throws for non-existent subscription", () => {
      const { manager } = createManager();

      expect(() => manager.unsubscribe("unknown")).toThrow(
        SkillSubscriptionError,
      );
    });
  });

  describe("checkAccess", () => {
    it("returns true for free tier", async () => {
      const { manager } = createManager();
      manager.registerModel("free-skill", { ...defaultModel, freeTier: true });

      expect(await manager.checkAccess("free-skill")).toBe(true);
    });

    it("returns true for active subscription", async () => {
      const { manager } = createManager();
      manager.registerModel("test-skill", defaultModel);
      await manager.subscribe(makeParams());

      expect(await manager.checkAccess("test-skill")).toBe(true);
    });

    it("returns false for expired subscription", async () => {
      const { manager, purchaseManager, clock } = createManager();
      manager.registerModel("test-skill", defaultModel);
      await manager.subscribe(makeParams());

      clock.now += SECONDS_PER_MONTH + 1;
      purchaseManager.isPurchased.mockResolvedValue(false);

      expect(await manager.checkAccess("test-skill")).toBe(false);

      // Status should have been lazily updated
      const sub = manager.getSubscription("test-skill");
      expect(sub!.status).toBe("expired");
    });

    it("falls back to isPurchased for expired subscription", async () => {
      const { manager, purchaseManager, clock } = createManager();
      manager.registerModel("test-skill", defaultModel);
      const params = makeParams();
      await manager.subscribe(params);

      clock.now += SECONDS_PER_MONTH + 1;
      purchaseManager.isPurchased.mockResolvedValue(true);

      expect(await manager.checkAccess("test-skill")).toBe(true);
      expect(purchaseManager.isPurchased).toHaveBeenCalledWith(params.skillPda);
    });

    it("returns false for unknown skill with no subscription", async () => {
      const { manager } = createManager();

      expect(await manager.checkAccess("unknown")).toBe(false);
    });

    it("returns true for trial subscription", async () => {
      const { manager } = createManager();
      manager.registerModel("trial-skill", { ...defaultModel, trialDays: 7 });
      await manager.subscribe(makeParams({ skillId: "trial-skill" }));

      expect(await manager.checkAccess("trial-skill")).toBe(true);
    });

    it("cancelled subscription retains access until expiresAt", async () => {
      const { manager, clock } = createManager();
      manager.registerModel("test-skill", defaultModel);
      await manager.subscribe(makeParams());

      manager.unsubscribe("test-skill");

      // Still within expiry window — access should remain
      expect(await manager.checkAccess("test-skill")).toBe(true);
    });

    it("cancelled subscription loses access after expiresAt", async () => {
      const { manager, purchaseManager, clock } = createManager();
      manager.registerModel("test-skill", defaultModel);
      await manager.subscribe(makeParams());

      manager.unsubscribe("test-skill");
      clock.now += SECONDS_PER_MONTH + 1;
      purchaseManager.isPurchased.mockResolvedValue(false);

      expect(await manager.checkAccess("test-skill")).toBe(false);
      // Status should be lazily set to expired
      expect(manager.getSubscription("test-skill")!.status).toBe("expired");
    });
  });

  describe("getActiveSubscriptions", () => {
    it("returns only active/trial subscriptions that are not expired", async () => {
      const { manager, clock } = createManager();

      manager.registerModel("active-skill", defaultModel);
      manager.registerModel("trial-skill", { ...defaultModel, trialDays: 7 });
      manager.registerModel("cancelled-skill", defaultModel);

      await manager.subscribe(makeParams({ skillId: "active-skill" }));
      await manager.subscribe(makeParams({ skillId: "trial-skill" }));
      await manager.subscribe(makeParams({ skillId: "cancelled-skill" }));
      manager.unsubscribe("cancelled-skill");

      const active = manager.getActiveSubscriptions();
      expect(active).toHaveLength(2);
      expect(active.map((s) => s.skillId).sort()).toEqual([
        "active-skill",
        "trial-skill",
      ]);
    });
  });

  describe("getAllSubscriptions", () => {
    it("returns all subscriptions regardless of status", async () => {
      const { manager } = createManager();

      manager.registerModel("skill-a", defaultModel);
      manager.registerModel("skill-b", defaultModel);

      await manager.subscribe(makeParams({ skillId: "skill-a" }));
      await manager.subscribe(makeParams({ skillId: "skill-b" }));
      manager.unsubscribe("skill-b");

      const all = manager.getAllSubscriptions();
      expect(all).toHaveLength(2);
    });
  });

  describe("revenue delegation", () => {
    it("delegates to computeRevenueShare", () => {
      const { manager } = createManager();

      const result = manager.computeRevenue({
        taskRewardLamports: 1_000_000n,
        skillAuthor: "author",
        protocolTreasury: "treasury",
      });

      expect(result.developerShare).toBe(800_000n);
      expect(result.protocolShare).toBe(200_000n);
    });
  });

  describe("usage analytics delegation", () => {
    it("records and retrieves usage", () => {
      const { manager } = createManager();

      manager.recordUsage({
        skillId: "skill-1",
        agentId: "agent-1",
        action: "execute",
        timestamp: 1000,
        durationMs: 50,
        success: true,
      });

      const analytics = manager.getAnalytics("skill-1");
      expect(analytics).not.toBeNull();
      expect(analytics!.totalInvocations).toBe(1);
    });

    it("getTopSkills delegates to tracker", () => {
      const { manager } = createManager();

      manager.recordUsage({
        skillId: "skill-1",
        agentId: "agent-1",
        action: "execute",
        timestamp: 1000,
        durationMs: 50,
        success: true,
      });

      const top = manager.getTopSkills(5);
      expect(top).toHaveLength(1);
      expect(top[0].skillId).toBe("skill-1");
    });

    it("usageTracker getter exposes tracker", () => {
      const { manager } = createManager();
      expect(manager.usageTracker).toBeDefined();
    });
  });

  describe("injectable clock", () => {
    it("uses clock for subscription timing", async () => {
      const { manager, clock } = createManager();
      manager.registerModel("test-skill", defaultModel);

      clock.now = 2000000000;
      const result = await manager.subscribe(makeParams());

      expect(result.expiresAt).toBe(2000000000 + SECONDS_PER_MONTH);
    });
  });
});
