import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createMarketplaceTools,
  type MarketplaceToolsContext,
} from "./tools.js";
import type { Tool } from "../types.js";

function mockMarketplace() {
  return {
    createRequest: vi.fn(),
    bidOnService: vi.fn(),
    listServices: vi.fn(),
    listBids: vi.fn(),
  };
}

function byName(tools: Tool[], name: string): Tool {
  const t = tools.find((t) => t.name === name);
  if (!t) throw new Error(`Tool not found: ${name}`);
  return t;
}

describe("Marketplace Tools", () => {
  let ctx: MarketplaceToolsContext;
  let marketplace: ReturnType<typeof mockMarketplace>;
  let tools: Tool[];

  beforeEach(() => {
    marketplace = mockMarketplace();
    ctx = {
      getMarketplace: () => marketplace as any,
      actorId: "test-agent",
      logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
    };
    tools = createMarketplaceTools(ctx);
  });

  it("creates 4 tools", () => {
    expect(tools).toHaveLength(4);
    expect(tools.map((t) => t.name).sort()).toEqual([
      "marketplace.bidOnService",
      "marketplace.createService",
      "marketplace.listBids",
      "marketplace.listServices",
    ]);
  });

  describe("marketplace.createService", () => {
    it("returns not-enabled when marketplace is null", async () => {
      ctx.getMarketplace = () => null;
      const tool = byName(
        createMarketplaceTools(ctx),
        "marketplace.createService",
      );
      const result = await tool.execute({
        serviceId: "svc-1",
        title: "Test",
        budget: "1000000000",
      });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("not enabled");
    });

    it("calls createRequest with BigInt budget", async () => {
      marketplace.createRequest.mockReturnValue({ serviceId: "svc-1" });
      const tool = byName(tools, "marketplace.createService");
      await tool.execute({
        serviceId: "svc-1",
        title: "Build a thing",
        description: "Detailed desc",
        budget: "1000000000",
        requiredCapabilities: "3",
      });
      expect(marketplace.createRequest).toHaveBeenCalledTimes(1);
      const callArgs = marketplace.createRequest.mock.calls[0][0];
      expect(callArgs.actorId).toBe("test-agent");
      expect(callArgs.request.budget).toBe(1000000000n);
      expect(callArgs.request.requiredCapabilities).toBe(3n);
    });

    it("returns error for invalid budget string", async () => {
      const tool = byName(tools, "marketplace.createService");
      const result = await tool.execute({
        serviceId: "svc-1",
        title: "Test",
        budget: "not-a-number",
      });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Invalid budget");
    });
  });

  describe("marketplace.bidOnService", () => {
    it("returns not-enabled when marketplace is null", async () => {
      ctx.getMarketplace = () => null;
      const tool = byName(
        createMarketplaceTools(ctx),
        "marketplace.bidOnService",
      );
      const result = await tool.execute({
        serviceId: "svc-1",
        price: "500000000",
        deliveryTime: 3600,
      });
      expect(result.isError).toBe(true);
    });

    it("calls bidOnService with actorId from context", async () => {
      marketplace.bidOnService.mockReturnValue({ bidId: "bid-1" });
      const tool = byName(tools, "marketplace.bidOnService");
      await tool.execute({
        serviceId: "svc-1",
        price: "500000000",
        deliveryTime: 3600,
        proposal: "I can do this",
      });
      expect(marketplace.bidOnService).toHaveBeenCalledWith({
        actorId: "test-agent",
        serviceId: "svc-1",
        bid: {
          price: 500000000n,
          deliveryTime: 3600,
          proposal: "I can do this",
        },
      });
    });
  });

  describe("marketplace.listServices", () => {
    it("returns not-enabled when marketplace is null", async () => {
      ctx.getMarketplace = () => null;
      const tool = byName(
        createMarketplaceTools(ctx),
        "marketplace.listServices",
      );
      const result = await tool.execute({});
      expect(result.isError).toBe(true);
    });

    it("passes optional filters correctly", async () => {
      marketplace.listServices.mockReturnValue([]);
      const tool = byName(tools, "marketplace.listServices");
      await tool.execute({ status: "open", minBudget: "100" });
      expect(marketplace.listServices).toHaveBeenCalledWith({
        status: "open",
        minBudget: 100n,
      });
    });

    it("calls without filters when none provided", async () => {
      marketplace.listServices.mockReturnValue([]);
      const tool = byName(tools, "marketplace.listServices");
      await tool.execute({});
      expect(marketplace.listServices).toHaveBeenCalledWith(undefined);
    });
  });

  describe("marketplace.listBids", () => {
    it("returns serialized bid list", async () => {
      marketplace.listBids.mockReturnValue([
        { bidId: "bid-1", bidderId: "agent-1" },
        { bidId: "bid-2", bidderId: "agent-2" },
      ]);
      const tool = byName(tools, "marketplace.listBids");
      const result = await tool.execute({ serviceId: "svc-1" });
      const parsed = JSON.parse(result.content);
      expect(parsed.serviceId).toBe("svc-1");
      expect(parsed.count).toBe(2);
      expect(parsed.bids).toHaveLength(2);
    });
  });
});
