/**
 * Marketplace tools — exposes ServiceMarketplace operations as LLM-callable tools.
 *
 * Tools receive a lazy getter because the marketplace is initialized
 * after tool registration (wireMarketplace runs after createToolRegistry).
 *
 * @module
 */

import type { Tool, ToolResult } from "../types.js";
import { safeStringify } from "../types.js";
import type { ServiceMarketplace } from "../../marketplace/service-marketplace.js";
import type { Logger } from "../../utils/logger.js";

// ============================================================================
// Context
// ============================================================================

export interface MarketplaceToolsContext {
  getMarketplace: () => ServiceMarketplace | null;
  actorId: string;
  logger: Logger;
}

// ============================================================================
// Helpers
// ============================================================================

function errorResult(message: string): ToolResult {
  return { content: safeStringify({ error: message }), isError: true };
}

function safeBigInt(
  value: unknown,
  fieldName: string,
): [bigint, null] | [null, ToolResult] {
  try {
    return [BigInt(value as string), null];
  } catch {
    return [null, errorResult(`Invalid ${fieldName}: must be a numeric string`)];
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create marketplace tools for LLM consumption.
 *
 * Returns 4 tools: marketplace.createService, marketplace.bidOnService,
 * marketplace.listServices, marketplace.listBids.
 */
export function createMarketplaceTools(ctx: MarketplaceToolsContext): Tool[] {
  return [
    // ------------------------------------------------------------------
    // marketplace.createService
    // ------------------------------------------------------------------
    {
      name: "marketplace.createService",
      description:
        "Create a new service request on the marketplace for agents to bid on.",
      inputSchema: {
        type: "object",
        properties: {
          serviceId: {
            type: "string",
            description: "Unique service identifier",
          },
          title: {
            type: "string",
            description: "Service title",
          },
          description: {
            type: "string",
            description: "Detailed service description",
          },
          requiredCapabilities: {
            type: "string",
            description: "Required capability bitmask as integer string",
          },
          budget: {
            type: "string",
            description: "Budget in lamports",
          },
          deadline: {
            type: "number",
            description: "Optional deadline (Unix seconds)",
          },
          deliverables: {
            type: "array",
            items: { type: "string" },
            description: "List of expected deliverables",
          },
        },
        required: ["serviceId", "title", "budget"],
      },
      async execute(args: Record<string, unknown>): Promise<ToolResult> {
        const marketplace = ctx.getMarketplace();
        if (!marketplace) return errorResult("Marketplace not enabled");

        if (
          typeof args.serviceId !== "string" ||
          args.serviceId.length === 0
        ) {
          return errorResult("serviceId must be a non-empty string");
        }
        if (typeof args.title !== "string" || args.title.length === 0) {
          return errorResult("title must be a non-empty string");
        }

        const [budget, budgetErr] = safeBigInt(args.budget, "budget");
        if (budgetErr) return budgetErr;

        let requiredCapabilities = 0n;
        if (args.requiredCapabilities !== undefined) {
          const [caps, capsErr] = safeBigInt(
            args.requiredCapabilities,
            "requiredCapabilities",
          );
          if (capsErr) return capsErr;
          requiredCapabilities = caps;
        }

        try {
          const snapshot = marketplace.createRequest({
            actorId: ctx.actorId,
            serviceId: args.serviceId,
            request: {
              title: args.title,
              description:
                typeof args.description === "string" ? args.description : "",
              requiredCapabilities,
              budget,
              deadline:
                typeof args.deadline === "number" ? args.deadline : undefined,
              deliverables: Array.isArray(args.deliverables)
                ? (args.deliverables as string[])
                : [],
            },
          });
          return { content: safeStringify(snapshot) };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.logger.error?.(`marketplace.createService failed: ${msg}`);
          return errorResult(msg);
        }
      },
    },

    // ------------------------------------------------------------------
    // marketplace.bidOnService
    // ------------------------------------------------------------------
    {
      name: "marketplace.bidOnService",
      description:
        "Submit a bid on a marketplace service request.",
      inputSchema: {
        type: "object",
        properties: {
          serviceId: {
            type: "string",
            description: "Service identifier to bid on",
          },
          price: {
            type: "string",
            description: "Bid price in lamports",
          },
          deliveryTime: {
            type: "number",
            description: "Estimated delivery time in seconds",
          },
          proposal: {
            type: "string",
            description: "Optional proposal text",
          },
        },
        required: ["serviceId", "price", "deliveryTime"],
      },
      async execute(args: Record<string, unknown>): Promise<ToolResult> {
        const marketplace = ctx.getMarketplace();
        if (!marketplace) return errorResult("Marketplace not enabled");

        if (
          typeof args.serviceId !== "string" ||
          args.serviceId.length === 0
        ) {
          return errorResult("serviceId must be a non-empty string");
        }

        const [price, priceErr] = safeBigInt(args.price, "price");
        if (priceErr) return priceErr;

        if (
          typeof args.deliveryTime !== "number" ||
          args.deliveryTime <= 0
        ) {
          return errorResult("deliveryTime must be a positive number");
        }

        try {
          const bid = marketplace.bidOnService({
            actorId: ctx.actorId,
            serviceId: args.serviceId,
            bid: {
              price,
              deliveryTime: args.deliveryTime,
              proposal:
                typeof args.proposal === "string" ? args.proposal : "",
            },
          });
          return { content: safeStringify(bid) };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.logger.error?.(`marketplace.bidOnService failed: ${msg}`);
          return errorResult(msg);
        }
      },
    },

    // ------------------------------------------------------------------
    // marketplace.listServices
    // ------------------------------------------------------------------
    {
      name: "marketplace.listServices",
      description:
        "List service requests on the marketplace with optional filters.",
      inputSchema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            description:
              "Filter by status (open, bidding, awarded, active, completed, etc.)",
          },
          minBudget: {
            type: "string",
            description: "Minimum budget in lamports",
          },
          maxBudget: {
            type: "string",
            description: "Maximum budget in lamports",
          },
        },
      },
      async execute(args: Record<string, unknown>): Promise<ToolResult> {
        const marketplace = ctx.getMarketplace();
        if (!marketplace) return errorResult("Marketplace not enabled");

        try {
          const filters: Record<string, unknown> = {};

          if (typeof args.status === "string") {
            filters.status = args.status;
          }
          if (args.minBudget !== undefined) {
            const [min, minErr] = safeBigInt(args.minBudget, "minBudget");
            if (minErr) return minErr;
            filters.minBudget = min;
          }
          if (args.maxBudget !== undefined) {
            const [max, maxErr] = safeBigInt(args.maxBudget, "maxBudget");
            if (maxErr) return maxErr;
            filters.maxBudget = max;
          }

          const services = marketplace.listServices(
            Object.keys(filters).length > 0 ? (filters as any) : undefined,
          );

          return {
            content: safeStringify({
              count: services.length,
              services,
            }),
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.logger.error?.(`marketplace.listServices failed: ${msg}`);
          return errorResult(msg);
        }
      },
    },

    // ------------------------------------------------------------------
    // marketplace.listBids
    // ------------------------------------------------------------------
    {
      name: "marketplace.listBids",
      description:
        "List bids for a specific marketplace service request.",
      inputSchema: {
        type: "object",
        properties: {
          serviceId: {
            type: "string",
            description: "Service identifier",
          },
        },
        required: ["serviceId"],
      },
      async execute(args: Record<string, unknown>): Promise<ToolResult> {
        const marketplace = ctx.getMarketplace();
        if (!marketplace) return errorResult("Marketplace not enabled");

        if (
          typeof args.serviceId !== "string" ||
          args.serviceId.length === 0
        ) {
          return errorResult("serviceId must be a non-empty string");
        }

        try {
          const bids = marketplace.listBids(args.serviceId);

          return {
            content: safeStringify({
              serviceId: args.serviceId,
              count: bids.length,
              bids,
            }),
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.logger.error?.(`marketplace.listBids failed: ${msg}`);
          return errorResult(msg);
        }
      },
    },
  ];
}
