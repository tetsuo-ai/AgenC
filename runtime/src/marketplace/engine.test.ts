import { describe, expect, it } from "vitest";
import type { MatchingPolicyConfig } from "@agenc/sdk";
import {
  MarketplaceMatchingError,
  MarketplaceAuthorizationError,
  MarketplaceStateError,
  MarketplaceValidationError,
} from "./errors.js";
import { TaskBidMarketplace } from "./engine.js";

function makeMarketplace(
  config: ConstructorParameters<typeof TaskBidMarketplace>[0] = {},
) {
  let nowMs = 1_000;
  const marketplace = new TaskBidMarketplace({
    now: () => nowMs,
    bidIdGenerator: (taskId, bidderId, seq) => `${taskId}:${bidderId}:${seq}`,
    ...config,
  });

  return {
    marketplace,
    setNow: (nextNow: number) => {
      nowMs = nextNow;
    },
  };
}

describe("TaskBidMarketplace", () => {
  it("enforces create/update/cancel authorization", () => {
    const { marketplace } = makeMarketplace();

    expect(() =>
      marketplace.createBid({
        actorId: "intruder",
        bid: {
          taskId: "task-1",
          bidderId: "bidder-1",
          rewardLamports: 100n,
          etaSeconds: 60,
          confidenceBps: 7_000,
          expiresAtMs: 2_000,
        },
      }),
    ).toThrow(MarketplaceAuthorizationError);

    const created = marketplace.createBid({
      actorId: "bidder-1",
      bid: {
        taskId: "task-1",
        bidderId: "bidder-1",
        rewardLamports: 100n,
        etaSeconds: 60,
        confidenceBps: 7_000,
        expiresAtMs: 2_000,
      },
    });

    expect(() =>
      marketplace.updateBid({
        actorId: "someone-else",
        taskId: "task-1",
        bidId: created.bidId,
        patch: { rewardLamports: 90n },
      }),
    ).toThrow(MarketplaceAuthorizationError);

    expect(() =>
      marketplace.cancelBid({
        actorId: "someone-else",
        taskId: "task-1",
        bidId: created.bidId,
      }),
    ).toThrow(MarketplaceAuthorizationError);
  });

  it("supports lifecycle transitions and idempotent cancel", () => {
    const { marketplace } = makeMarketplace();

    const bid = marketplace.createBid({
      actorId: "b1",
      bid: {
        taskId: "task-2",
        bidderId: "b1",
        rewardLamports: 100n,
        etaSeconds: 40,
        confidenceBps: 8_000,
        expiresAtMs: 5_000,
      },
    });

    const updated = marketplace.updateBid({
      actorId: "b1",
      taskId: "task-2",
      bidId: bid.bidId,
      patch: {
        rewardLamports: 95n,
        etaSeconds: 35,
      },
    });

    expect(updated.rewardLamports).toBe(95n);
    expect(updated.etaSeconds).toBe(35);

    const cancelled = marketplace.cancelBid({
      actorId: "b1",
      taskId: "task-2",
      bidId: bid.bidId,
    });
    expect(cancelled.status).toBe("cancelled");

    const cancelledAgain = marketplace.cancelBid({
      actorId: "b1",
      taskId: "task-2",
      bidId: bid.bidId,
    });
    expect(cancelledAgain.status).toBe("cancelled");

    expect(() =>
      marketplace.updateBid({
        actorId: "b1",
        taskId: "task-2",
        bidId: bid.bidId,
        patch: { rewardLamports: 80n },
      }),
    ).toThrow(MarketplaceStateError);
  });

  it("enforces selection authorization and atomic acceptance", () => {
    const { marketplace } = makeMarketplace();

    marketplace.setTaskOwner({ taskId: "task-3", ownerId: "creator-1" });

    const a = marketplace.createBid({
      actorId: "b1",
      taskOwnerId: "creator-1",
      bid: {
        taskId: "task-3",
        bidderId: "b1",
        rewardLamports: 100n,
        etaSeconds: 50,
        confidenceBps: 7_000,
        expiresAtMs: 10_000,
      },
    });
    const b = marketplace.createBid({
      actorId: "b2",
      taskOwnerId: "creator-1",
      bid: {
        taskId: "task-3",
        bidderId: "b2",
        rewardLamports: 90n,
        etaSeconds: 60,
        confidenceBps: 7_100,
        expiresAtMs: 10_000,
      },
    });

    expect(() =>
      marketplace.acceptBid({
        actorId: "unauthorized",
        taskId: "task-3",
        bidId: a.bidId,
      }),
    ).toThrow(MarketplaceAuthorizationError);

    const accepted = marketplace.acceptBid({
      actorId: "creator-1",
      taskId: "task-3",
      bidId: b.bidId,
    });

    expect(accepted.acceptedBid.bidId).toBe(b.bidId);
    expect(accepted.rejectedBidIds).toEqual([a.bidId]);

    const allBids = marketplace.listBids({ taskId: "task-3" });
    const bidA = allBids.find((item) => item.bidId === a.bidId)!;
    const bidB = allBids.find((item) => item.bidId === b.bidId)!;
    expect(bidA.status).toBe("rejected");
    expect(bidB.status).toBe("accepted");
  });

  it("enforces OCC race protection on accept", () => {
    const { marketplace } = makeMarketplace();

    marketplace.setTaskOwner({ taskId: "task-4", ownerId: "creator" });

    const a = marketplace.createBid({
      actorId: "b1",
      taskOwnerId: "creator",
      bid: {
        taskId: "task-4",
        bidderId: "b1",
        rewardLamports: 100n,
        etaSeconds: 60,
        confidenceBps: 7_000,
        expiresAtMs: 20_000,
      },
    });
    const b = marketplace.createBid({
      actorId: "b2",
      taskOwnerId: "creator",
      bid: {
        taskId: "task-4",
        bidderId: "b2",
        rewardLamports: 120n,
        etaSeconds: 50,
        confidenceBps: 8_000,
        expiresAtMs: 20_000,
      },
    });

    const state = marketplace.getTaskState("task-4")!;

    const first = marketplace.acceptBid({
      actorId: "creator",
      taskId: "task-4",
      bidId: a.bidId,
      expectedVersion: state.taskVersion,
    });

    expect(first.acceptedBid.bidId).toBe(a.bidId);

    expect(() =>
      marketplace.acceptBid({
        actorId: "creator",
        taskId: "task-4",
        bidId: b.bidId,
        expectedVersion: state.taskVersion,
      }),
    ).toThrow("version mismatch");
  });

  it("handles lazy expiry projection and expiry boundary deterministically", () => {
    const { marketplace, setNow } = makeMarketplace();

    const created = marketplace.createBid({
      actorId: "bidder",
      bid: {
        taskId: "task-5",
        bidderId: "bidder",
        rewardLamports: 100n,
        etaSeconds: 30,
        confidenceBps: 8_000,
        expiresAtMs: 1_001,
      },
    });

    const stateBefore = marketplace.getTaskState("task-5")!;
    setNow(1_001);

    const projected = marketplace.listBids({
      taskId: "task-5",
      includeExpiredProjection: true,
    });
    expect(projected[0].status).toBe("expired");

    const stateAfterRead = marketplace.getTaskState("task-5")!;
    expect(stateAfterRead.taskVersion).toBe(stateBefore.taskVersion);

    expect(() =>
      marketplace.updateBid({
        actorId: "bidder",
        taskId: "task-5",
        bidId: created.bidId,
        patch: { etaSeconds: 20 },
      }),
    ).toThrow("cannot update bid");

    const persisted = marketplace.listBids({ taskId: "task-5" })[0];
    expect(persisted.status).toBe("expired");
  });

  it("supports deterministic policies and insertion-order invariance", () => {
    const policyWeighted: MatchingPolicyConfig = {
      policy: "weighted_score",
      weights: {
        priceWeightBps: 4_000,
        etaWeightBps: 3_000,
        confidenceWeightBps: 2_000,
        reliabilityWeightBps: 1_000,
      },
    };

    const m1 = makeMarketplace({
      bidIdGenerator: (taskId, bidderId) => `${taskId}:${bidderId}`,
    }).marketplace;
    const m2 = makeMarketplace({
      bidIdGenerator: (taskId, bidderId) => `${taskId}:${bidderId}`,
    }).marketplace;

    const bids = [
      {
        bidderId: "a",
        rewardLamports: 95n,
        etaSeconds: 80,
        confidenceBps: 8_300,
        reliabilityBps: 8_100,
      },
      {
        bidderId: "b",
        rewardLamports: 90n,
        etaSeconds: 100,
        confidenceBps: 9_200,
        reliabilityBps: 8_600,
      },
      {
        bidderId: "c",
        rewardLamports: 100n,
        etaSeconds: 60,
        confidenceBps: 7_500,
        reliabilityBps: 8_500,
      },
    ] as const;

    for (const bid of bids) {
      m1.createBid({
        actorId: bid.bidderId,
        bid: {
          taskId: "task-6",
          bidderId: bid.bidderId,
          rewardLamports: bid.rewardLamports,
          etaSeconds: bid.etaSeconds,
          confidenceBps: bid.confidenceBps,
          reliabilityBps: bid.reliabilityBps,
          expiresAtMs: 9_999,
        },
      });
    }

    for (const bid of [...bids].reverse()) {
      m2.createBid({
        actorId: bid.bidderId,
        bid: {
          taskId: "task-6",
          bidderId: bid.bidderId,
          rewardLamports: bid.rewardLamports,
          etaSeconds: bid.etaSeconds,
          confidenceBps: bid.confidenceBps,
          reliabilityBps: bid.reliabilityBps,
          expiresAtMs: 9_999,
        },
      });
    }

    expect(
      m1.selectWinner({ taskId: "task-6", policy: { policy: "best_price" } })
        ?.bid.bidderId,
    ).toBe("b");
    expect(
      m1.selectWinner({ taskId: "task-6", policy: { policy: "best_eta" } })?.bid
        .bidderId,
    ).toBe("c");

    const w1 = m1.selectWinner({ taskId: "task-6", policy: policyWeighted });
    const w2 = m2.selectWinner({ taskId: "task-6", policy: policyWeighted });

    expect(w1?.bid.bidderId).toBe(w2?.bid.bidderId);
    expect(w1?.weightedBreakdown?.totalScore).toBeDefined();
  });

  it("enforces anti-spam limits and bounded rate tracking", () => {
    const { marketplace, setNow } = makeMarketplace({
      antiSpam: {
        maxActiveBidsPerBidderPerTask: 1,
        createRateLimit: { maxCreates: 1, windowMs: 100 },
        maxTrackedBiddersPerTask: 1,
      },
    });

    marketplace.createBid({
      actorId: "b1",
      bid: {
        taskId: "task-7",
        bidderId: "b1",
        rewardLamports: 100n,
        etaSeconds: 50,
        confidenceBps: 8_000,
        expiresAtMs: 1_001,
      },
    });

    expect(() =>
      marketplace.createBid({
        actorId: "b1",
        bid: {
          taskId: "task-7",
          bidderId: "b1",
          rewardLamports: 99n,
          etaSeconds: 40,
          confidenceBps: 8_000,
          expiresAtMs: 2_000,
        },
      }),
    ).toThrow("max active bids per task");

    setNow(1_050);

    expect(() =>
      marketplace.createBid({
        actorId: "b1",
        bid: {
          taskId: "task-7",
          bidderId: "b1",
          rewardLamports: 99n,
          etaSeconds: 40,
          confidenceBps: 8_000,
          expiresAtMs: 3_000,
        },
      }),
    ).toThrow("rate limit");

    setNow(2_200);

    expect(() =>
      marketplace.createBid({
        actorId: "b2",
        bid: {
          taskId: "task-7",
          bidderId: "b2",
          rewardLamports: 90n,
          etaSeconds: 30,
          confidenceBps: 9_000,
          expiresAtMs: 3_000,
        },
      }),
    ).not.toThrow();
  });

  it("rejects generated bid id collisions and invalid weighted configs", () => {
    const { marketplace } = makeMarketplace({
      bidIdGenerator: () => "duplicate-bid-id",
    });

    marketplace.createBid({
      actorId: "b1",
      bid: {
        taskId: "task-8",
        bidderId: "b1",
        rewardLamports: 100n,
        etaSeconds: 10,
        confidenceBps: 8_000,
        expiresAtMs: 5_000,
      },
    });

    expect(() =>
      marketplace.createBid({
        actorId: "b2",
        bid: {
          taskId: "task-8",
          bidderId: "b2",
          rewardLamports: 90n,
          etaSeconds: 12,
          confidenceBps: 8_100,
          expiresAtMs: 5_000,
        },
      }),
    ).toThrow("collision");

    expect(() =>
      marketplace.selectWinner({
        taskId: "task-8",
        policy: {
          policy: "weighted_score",
          weights: {
            priceWeightBps: 5_000,
            etaWeightBps: 5_000,
            confidenceWeightBps: 5_000,
            reliabilityWeightBps: 0,
          },
        },
      }),
    ).toThrow(MarketplaceMatchingError);
  });

  it("handles bigint values in best-price comparisons", () => {
    const { marketplace } = makeMarketplace();

    marketplace.createBid({
      actorId: "large-a",
      bid: {
        taskId: "task-9",
        bidderId: "large-a",
        rewardLamports: 9_223_372_036_854_775_807n,
        etaSeconds: 10,
        confidenceBps: 7_000,
        expiresAtMs: 9_000,
      },
    });

    marketplace.createBid({
      actorId: "large-b",
      bid: {
        taskId: "task-9",
        bidderId: "large-b",
        rewardLamports: 9_223_372_036_854_775_000n,
        etaSeconds: 10,
        confidenceBps: 7_000,
        expiresAtMs: 9_000,
      },
    });

    const winner = marketplace.selectWinner({
      taskId: "task-9",
      policy: { policy: "best_price" },
    });

    expect(winner?.bid.bidderId).toBe("large-b");
  });

  it("validates bond minimum and non-negative fields", () => {
    const { marketplace } = makeMarketplace({
      antiSpam: { minBondLamports: 10n },
    });

    expect(() =>
      marketplace.createBid({
        actorId: "bidder",
        bid: {
          taskId: "task-10",
          bidderId: "bidder",
          rewardLamports: -1n,
          etaSeconds: 10,
          confidenceBps: 8_000,
          expiresAtMs: 2_000,
        },
      }),
    ).toThrow(MarketplaceValidationError);

    expect(() =>
      marketplace.createBid({
        actorId: "bidder",
        bid: {
          taskId: "task-10",
          bidderId: "bidder",
          rewardLamports: 100n,
          etaSeconds: 10,
          confidenceBps: 8_000,
          bondLamports: 1n,
          expiresAtMs: 2_000,
        },
      }),
    ).toThrow("below minimum");
  });
});
