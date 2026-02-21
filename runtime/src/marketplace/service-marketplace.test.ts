import { describe, expect, it } from "vitest";
import {
  MarketplaceAuthorizationError,
  MarketplaceStateError,
  MarketplaceValidationError,
} from "./errors.js";
import { TaskBidMarketplace } from "./engine.js";
import { ServiceMarketplace } from "./service-marketplace.js";
import type { ServiceRequest, ServiceMarketplaceConfig } from "./types.js";

function makeServiceMarketplace(
  config: Partial<ServiceMarketplaceConfig> = {},
) {
  let nowMs = 1_000;
  const bidMarketplace = new TaskBidMarketplace({
    now: () => nowMs,
    bidIdGenerator: (taskId, bidderId, seq) => `${taskId}:${bidderId}:${seq}`,
  });
  const marketplace = new ServiceMarketplace({
    now: () => nowMs,
    bidMarketplace,
    ...config,
  });

  return {
    marketplace,
    bidMarketplace,
    setNow: (nextNow: number) => {
      nowMs = nextNow;
    },
  };
}

function validRequest(overrides: Partial<ServiceRequest> = {}): ServiceRequest {
  return {
    title: "Monitor DeFi Positions",
    description: "Need an agent to monitor my DeFi positions 24/7",
    requiredCapabilities: 3n,
    budget: 1_000_000n,
    deliverables: ["daily report", "alert on significant changes"],
    ...overrides,
  };
}

describe("ServiceMarketplace", () => {
  it("creates a service request with status open and registers owner in bid marketplace", () => {
    const { marketplace, bidMarketplace } = makeServiceMarketplace();

    const snapshot = marketplace.createRequest({
      actorId: "requester-1",
      serviceId: "svc-1",
      request: validRequest(),
    });

    expect(snapshot.serviceId).toBe("svc-1");
    expect(snapshot.requesterId).toBe("requester-1");
    expect(snapshot.status).toBe("open");
    expect(snapshot.version).toBe(0);
    expect(snapshot.acceptedBidId).toBeNull();
    expect(snapshot.awardedAgentId).toBeNull();
    expect(snapshot.completionProof).toBeNull();
    expect(snapshot.disputeReason).toBeNull();
    expect(snapshot.disputeOutcome).toBeNull();
    expect(snapshot.activeBids).toBe(0);
    expect(snapshot.totalBids).toBe(0);
    expect(snapshot.request.title).toBe("Monitor DeFi Positions");
    expect(snapshot.request.deliverables).toEqual([
      "daily report",
      "alert on significant changes",
    ]);

    const bookState = bidMarketplace.getTaskState("svc-1");
    expect(bookState).not.toBeNull();
    expect(bookState!.ownerId).toBe("requester-1");
  });

  it("rejects duplicate serviceId", () => {
    const { marketplace } = makeServiceMarketplace();

    marketplace.createRequest({
      actorId: "requester-1",
      serviceId: "svc-dup",
      request: validRequest(),
    });

    expect(() =>
      marketplace.createRequest({
        actorId: "requester-1",
        serviceId: "svc-dup",
        request: validRequest(),
      }),
    ).toThrow(MarketplaceStateError);
  });

  it("validates request inputs", () => {
    const { marketplace } = makeServiceMarketplace();

    expect(() =>
      marketplace.createRequest({
        actorId: "r1",
        serviceId: "svc-bad-1",
        request: validRequest({ title: "" }),
      }),
    ).toThrow("title must be non-empty");

    expect(() =>
      marketplace.createRequest({
        actorId: "r1",
        serviceId: "svc-bad-2",
        request: validRequest({ title: "x".repeat(257) }),
      }),
    ).toThrow("title exceeds max length");

    expect(() =>
      marketplace.createRequest({
        actorId: "r1",
        serviceId: "svc-bad-3",
        request: validRequest({ budget: 0n }),
      }),
    ).toThrow("budget must be > 0");

    expect(() =>
      marketplace.createRequest({
        actorId: "r1",
        serviceId: "svc-bad-4",
        request: validRequest({ deliverables: [] }),
      }),
    ).toThrow("deliverables must be a non-empty array");

    expect(() =>
      marketplace.createRequest({
        actorId: "r1",
        serviceId: "svc-bad-5",
        request: validRequest({ requiredCapabilities: 0n }),
      }),
    ).toThrow("requiredCapabilities must be > 0");

    expect(() =>
      marketplace.createRequest({
        actorId: "r1",
        serviceId: "svc-bad-6",
        request: validRequest({ deliverables: ["valid", "  "] }),
      }),
    ).toThrow("each deliverable must be non-empty");
  });

  it("agent bids on service, transitions open to bidding, maps bid fields correctly", () => {
    const { marketplace } = makeServiceMarketplace();

    marketplace.createRequest({
      actorId: "requester-1",
      serviceId: "svc-bid-1",
      request: validRequest(),
    });

    const bid = marketplace.bidOnService({
      actorId: "agent-1",
      serviceId: "svc-bid-1",
      bid: {
        price: 500_000n,
        deliveryTime: 3600,
        proposal: "I will monitor using my DeFi toolkit",
        portfolioLinks: ["https://example.com/portfolio"],
      },
    });

    expect(bid.rewardLamports).toBe(500_000n);
    expect(bid.etaSeconds).toBe(3600);
    expect(bid.metadata?.proposal).toBe("I will monitor using my DeFi toolkit");
    expect(bid.metadata?.portfolioLinks).toEqual([
      "https://example.com/portfolio",
    ]);

    const snapshot = marketplace.getService("svc-bid-1");
    expect(snapshot!.status).toBe("bidding");
    expect(snapshot!.activeBids).toBe(1);
    expect(snapshot!.totalBids).toBe(1);
  });

  it("rejects self-bidding", () => {
    const { marketplace } = makeServiceMarketplace();

    marketplace.createRequest({
      actorId: "requester-1",
      serviceId: "svc-self",
      request: validRequest(),
    });

    expect(() =>
      marketplace.bidOnService({
        actorId: "requester-1",
        serviceId: "svc-self",
        bid: { price: 100n, deliveryTime: 60, proposal: "self bid" },
      }),
    ).toThrow(MarketplaceAuthorizationError);
  });

  it("rejects bid on cancelled service, bid with price > budget, and empty proposal", () => {
    const { marketplace } = makeServiceMarketplace();

    marketplace.createRequest({
      actorId: "r1",
      serviceId: "svc-cancelled",
      request: validRequest(),
    });
    marketplace.cancelService({ actorId: "r1", serviceId: "svc-cancelled" });

    expect(() =>
      marketplace.bidOnService({
        actorId: "agent-1",
        serviceId: "svc-cancelled",
        bid: { price: 100n, deliveryTime: 60, proposal: "ok" },
      }),
    ).toThrow(MarketplaceStateError);

    marketplace.createRequest({
      actorId: "r1",
      serviceId: "svc-over-budget",
      request: validRequest({ budget: 100n }),
    });

    expect(() =>
      marketplace.bidOnService({
        actorId: "agent-1",
        serviceId: "svc-over-budget",
        bid: { price: 200n, deliveryTime: 60, proposal: "too expensive" },
      }),
    ).toThrow("exceeds service budget");

    marketplace.createRequest({
      actorId: "r1",
      serviceId: "svc-empty-proposal",
      request: validRequest(),
    });

    expect(() =>
      marketplace.bidOnService({
        actorId: "agent-1",
        serviceId: "svc-empty-proposal",
        bid: { price: 100n, deliveryTime: 60, proposal: "  " },
      }),
    ).toThrow("proposal must be non-empty");
  });

  it("requester accepts bid, transitions bidding to awarded, rejects other bids", () => {
    const { marketplace } = makeServiceMarketplace();

    marketplace.createRequest({
      actorId: "r1",
      serviceId: "svc-accept",
      request: validRequest(),
    });

    marketplace.bidOnService({
      actorId: "agent-1",
      serviceId: "svc-accept",
      bid: { price: 500_000n, deliveryTime: 3600, proposal: "bid-a" },
    });

    const bidB = marketplace.bidOnService({
      actorId: "agent-2",
      serviceId: "svc-accept",
      bid: { price: 400_000n, deliveryTime: 1800, proposal: "bid-b" },
    });

    const snapshot = marketplace.acceptBid({
      actorId: "r1",
      serviceId: "svc-accept",
      bidId: bidB.bidId,
    });

    expect(snapshot.status).toBe("awarded");
    expect(snapshot.acceptedBidId).toBe(bidB.bidId);
    expect(snapshot.awardedAgentId).toBe("agent-2");

    const bids = marketplace.listBids("svc-accept");
    const bidAStatus = bids.find((b) => b.bidderId === "agent-1")?.status;
    const bidBStatus = bids.find((b) => b.bidderId === "agent-2")?.status;
    expect(bidAStatus).toBe("rejected");
    expect(bidBStatus).toBe("accepted");
  });

  it("rejects accept by non-requester and enforces OCC versioning", () => {
    const { marketplace } = makeServiceMarketplace();

    marketplace.createRequest({
      actorId: "r1",
      serviceId: "svc-occ",
      request: validRequest(),
    });

    const bid = marketplace.bidOnService({
      actorId: "agent-1",
      serviceId: "svc-occ",
      bid: { price: 500_000n, deliveryTime: 3600, proposal: "my proposal" },
    });

    expect(() =>
      marketplace.acceptBid({
        actorId: "intruder",
        serviceId: "svc-occ",
        bidId: bid.bidId,
      }),
    ).toThrow(MarketplaceAuthorizationError);

    const snapshot = marketplace.getService("svc-occ")!;

    marketplace.bidOnService({
      actorId: "agent-2",
      serviceId: "svc-occ",
      bid: { price: 300_000n, deliveryTime: 1200, proposal: "another" },
    });

    expect(() =>
      marketplace.acceptBid({
        actorId: "r1",
        serviceId: "svc-occ",
        bidId: bid.bidId,
        expectedVersion: snapshot.version,
      }),
    ).toThrow("version mismatch");
  });

  it("awarded agent starts service, rejects non-agent and wrong state", () => {
    const { marketplace } = makeServiceMarketplace();

    marketplace.createRequest({
      actorId: "r1",
      serviceId: "svc-start",
      request: validRequest(),
    });

    const bid = marketplace.bidOnService({
      actorId: "agent-1",
      serviceId: "svc-start",
      bid: { price: 500_000n, deliveryTime: 3600, proposal: "i will deliver" },
    });

    marketplace.acceptBid({
      actorId: "r1",
      serviceId: "svc-start",
      bidId: bid.bidId,
    });

    expect(() =>
      marketplace.startService({ actorId: "r1", serviceId: "svc-start" }),
    ).toThrow(MarketplaceAuthorizationError);

    expect(() =>
      marketplace.startService({ actorId: "agent-2", serviceId: "svc-start" }),
    ).toThrow(MarketplaceAuthorizationError);

    const snapshot = marketplace.startService({
      actorId: "agent-1",
      serviceId: "svc-start",
    });
    expect(snapshot.status).toBe("active");

    expect(() =>
      marketplace.startService({ actorId: "agent-1", serviceId: "svc-start" }),
    ).toThrow(MarketplaceStateError);
  });

  it("agent completes service with proof, rejects non-agent", () => {
    const { marketplace } = makeServiceMarketplace();

    marketplace.createRequest({
      actorId: "r1",
      serviceId: "svc-complete",
      request: validRequest(),
    });

    const bid = marketplace.bidOnService({
      actorId: "agent-1",
      serviceId: "svc-complete",
      bid: { price: 500_000n, deliveryTime: 3600, proposal: "will do" },
    });

    marketplace.acceptBid({
      actorId: "r1",
      serviceId: "svc-complete",
      bidId: bid.bidId,
    });
    marketplace.startService({ actorId: "agent-1", serviceId: "svc-complete" });

    expect(() =>
      marketplace.completeService({
        actorId: "r1",
        serviceId: "svc-complete",
        proof: "proof",
      }),
    ).toThrow(MarketplaceAuthorizationError);

    const snapshot = marketplace.completeService({
      actorId: "agent-1",
      serviceId: "svc-complete",
      proof: "task-output-hash-abc123",
    });

    expect(snapshot.status).toBe("completed");
    expect(snapshot.completionProof).toBe("task-output-hash-abc123");
  });

  it("requester cancels from open, bidding, awarded but not active; rejects non-requester", () => {
    const { marketplace } = makeServiceMarketplace();

    marketplace.createRequest({
      actorId: "r1",
      serviceId: "svc-cancel-open",
      request: validRequest(),
    });
    const s1 = marketplace.cancelService({
      actorId: "r1",
      serviceId: "svc-cancel-open",
    });
    expect(s1.status).toBe("cancelled");

    marketplace.createRequest({
      actorId: "r1",
      serviceId: "svc-cancel-bidding",
      request: validRequest(),
    });
    marketplace.bidOnService({
      actorId: "agent-1",
      serviceId: "svc-cancel-bidding",
      bid: { price: 100n, deliveryTime: 60, proposal: "hi" },
    });
    const s2 = marketplace.cancelService({
      actorId: "r1",
      serviceId: "svc-cancel-bidding",
    });
    expect(s2.status).toBe("cancelled");

    marketplace.createRequest({
      actorId: "r1",
      serviceId: "svc-cancel-awarded",
      request: validRequest(),
    });
    const bid = marketplace.bidOnService({
      actorId: "agent-1",
      serviceId: "svc-cancel-awarded",
      bid: { price: 100n, deliveryTime: 60, proposal: "hi" },
    });
    marketplace.acceptBid({
      actorId: "r1",
      serviceId: "svc-cancel-awarded",
      bidId: bid.bidId,
    });
    const s3 = marketplace.cancelService({
      actorId: "r1",
      serviceId: "svc-cancel-awarded",
    });
    expect(s3.status).toBe("cancelled");

    marketplace.createRequest({
      actorId: "r1",
      serviceId: "svc-cancel-active",
      request: validRequest(),
    });
    const bid2 = marketplace.bidOnService({
      actorId: "agent-1",
      serviceId: "svc-cancel-active",
      bid: { price: 100n, deliveryTime: 60, proposal: "hi" },
    });
    marketplace.acceptBid({
      actorId: "r1",
      serviceId: "svc-cancel-active",
      bidId: bid2.bidId,
    });
    marketplace.startService({
      actorId: "agent-1",
      serviceId: "svc-cancel-active",
    });

    expect(() =>
      marketplace.cancelService({
        actorId: "r1",
        serviceId: "svc-cancel-active",
      }),
    ).toThrow(MarketplaceStateError);

    expect(() =>
      marketplace.cancelService({
        actorId: "agent-1",
        serviceId: "svc-cancel-active",
      }),
    ).toThrow(MarketplaceAuthorizationError);
  });

  it("dispute lifecycle: requester or agent disputes, resolver resolves", () => {
    const { marketplace } = makeServiceMarketplace({
      authorizedDisputeResolverIds: ["resolver-1"],
    });

    marketplace.createRequest({
      actorId: "r1",
      serviceId: "svc-dispute",
      request: validRequest(),
    });
    const bid = marketplace.bidOnService({
      actorId: "agent-1",
      serviceId: "svc-dispute",
      bid: { price: 500_000n, deliveryTime: 3600, proposal: "deliver" },
    });
    marketplace.acceptBid({
      actorId: "r1",
      serviceId: "svc-dispute",
      bidId: bid.bidId,
    });
    marketplace.startService({ actorId: "agent-1", serviceId: "svc-dispute" });

    const disputed = marketplace.disputeService({
      actorId: "r1",
      serviceId: "svc-dispute",
      reason: "agent not delivering",
    });
    expect(disputed.status).toBe("disputed");
    expect(disputed.disputeReason).toBe("agent not delivering");

    const resolved = marketplace.resolveDispute({
      actorId: "resolver-1",
      serviceId: "svc-dispute",
      outcome: "refund",
    });
    expect(resolved.status).toBe("resolved");
    expect(resolved.disputeOutcome).toBe("refund");
  });

  it("rejects dispute by unauthorized actor and resolve by non-resolver", () => {
    const { marketplace } = makeServiceMarketplace({
      authorizedDisputeResolverIds: ["resolver-1"],
    });

    marketplace.createRequest({
      actorId: "r1",
      serviceId: "svc-dispute-auth",
      request: validRequest(),
    });
    const bid = marketplace.bidOnService({
      actorId: "agent-1",
      serviceId: "svc-dispute-auth",
      bid: { price: 500_000n, deliveryTime: 3600, proposal: "deliver" },
    });
    marketplace.acceptBid({
      actorId: "r1",
      serviceId: "svc-dispute-auth",
      bidId: bid.bidId,
    });
    marketplace.startService({
      actorId: "agent-1",
      serviceId: "svc-dispute-auth",
    });

    expect(() =>
      marketplace.disputeService({
        actorId: "random-bystander",
        serviceId: "svc-dispute-auth",
        reason: "none of my business",
      }),
    ).toThrow(MarketplaceAuthorizationError);

    marketplace.disputeService({
      actorId: "agent-1",
      serviceId: "svc-dispute-auth",
      reason: "requester unreasonable",
    });

    expect(() =>
      marketplace.resolveDispute({
        actorId: "r1",
        serviceId: "svc-dispute-auth",
        outcome: "pay_agent",
      }),
    ).toThrow(MarketplaceAuthorizationError);
  });

  it("getService returns null for non-existent and returns snapshot with bid counts", () => {
    const { marketplace } = makeServiceMarketplace();

    expect(marketplace.getService("non-existent")).toBeNull();

    marketplace.createRequest({
      actorId: "r1",
      serviceId: "svc-get",
      request: validRequest(),
    });

    marketplace.bidOnService({
      actorId: "agent-1",
      serviceId: "svc-get",
      bid: { price: 100n, deliveryTime: 60, proposal: "proposal-1" },
    });
    marketplace.bidOnService({
      actorId: "agent-2",
      serviceId: "svc-get",
      bid: { price: 200n, deliveryTime: 120, proposal: "proposal-2" },
    });

    const snapshot = marketplace.getService("svc-get")!;
    expect(snapshot.activeBids).toBe(2);
    expect(snapshot.totalBids).toBe(2);
    expect(snapshot.status).toBe("bidding");
  });

  it("listServices filters by status, requester, capabilities, and budget range", () => {
    const { marketplace } = makeServiceMarketplace();

    marketplace.createRequest({
      actorId: "r1",
      serviceId: "svc-list-1",
      request: validRequest({ budget: 100n, requiredCapabilities: 1n }),
    });
    marketplace.createRequest({
      actorId: "r2",
      serviceId: "svc-list-2",
      request: validRequest({ budget: 500n, requiredCapabilities: 3n }),
    });
    marketplace.createRequest({
      actorId: "r1",
      serviceId: "svc-list-3",
      request: validRequest({ budget: 1000n, requiredCapabilities: 7n }),
    });
    marketplace.cancelService({ actorId: "r1", serviceId: "svc-list-3" });

    const all = marketplace.listServices();
    expect(all).toHaveLength(3);

    const openOnly = marketplace.listServices({ status: "open" });
    expect(openOnly).toHaveLength(2);

    const byRequester = marketplace.listServices({ requesterId: "r1" });
    expect(byRequester).toHaveLength(2);

    const byCap = marketplace.listServices({
      requiredCapabilities: 3n,
      status: "open",
    });
    expect(byCap).toHaveLength(1);
    expect(byCap[0].serviceId).toBe("svc-list-2");

    const byBudget = marketplace.listServices({
      minBudget: 200n,
      maxBudget: 600n,
    });
    expect(byBudget).toHaveLength(1);
    expect(byBudget[0].serviceId).toBe("svc-list-2");
  });

  it("lazy deadline expiry transitions to cancelled on read", () => {
    const { marketplace, setNow } = makeServiceMarketplace();

    marketplace.createRequest({
      actorId: "r1",
      serviceId: "svc-expiry",
      request: validRequest({ deadline: 5_000 }),
    });

    const before = marketplace.getService("svc-expiry")!;
    expect(before.status).toBe("open");

    setNow(5_000);

    const after = marketplace.getService("svc-expiry")!;
    expect(after.status).toBe("cancelled");

    expect(() =>
      marketplace.bidOnService({
        actorId: "agent-1",
        serviceId: "svc-expiry",
        bid: { price: 100n, deliveryTime: 60, proposal: "too late" },
      }),
    ).toThrow(MarketplaceStateError);
  });
});
