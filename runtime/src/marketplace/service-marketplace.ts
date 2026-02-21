/**
 * Service marketplace for human-posted service requests with agent bidding.
 *
 * Wraps {@link TaskBidMarketplace} — manages service-level lifecycle state
 * in its own Map and delegates all bid management to the existing engine.
 *
 * @module
 */

import {
  BPS_BASE,
  canonicalizeMarketplaceId,
  validateMarketplaceId,
} from "@agenc/sdk";
import {
  MarketplaceAuthorizationError,
  MarketplaceStateError,
  MarketplaceValidationError,
} from "./errors.js";
import { TaskBidMarketplace } from "./engine.js";
import type {
  ServiceMarketplaceConfig,
  ServiceRequestRecord,
  ServiceRequestSnapshot,
  ServiceRequestStatus,
  CreateServiceRequestInput,
  BidOnServiceInput,
  AcceptServiceBidInput,
  StartServiceInput,
  CompleteServiceInput,
  CancelServiceInput,
  DisputeServiceInput,
  ResolveServiceDisputeInput,
  ListServiceRequestsInput,
} from "./types.js";
import type { TaskBid } from "@agenc/sdk";

const DEFAULT_MAX_TITLE_LENGTH = 256;
const DEFAULT_MAX_DESCRIPTION_LENGTH = 4096;
const DEFAULT_MAX_DELIVERABLES = 50;
const DEFAULT_MAX_DELIVERABLE_LENGTH = 512;

function normalizeIdOrThrow(raw: string, label: string): string {
  const normalized = canonicalizeMarketplaceId(raw);
  const validationError = validateMarketplaceId(normalized);
  if (validationError) {
    throw new MarketplaceValidationError(`${label} ${validationError}`);
  }
  return normalized;
}

export class ServiceMarketplace {
  private readonly services = new Map<string, ServiceRequestRecord>();
  private readonly bidMarketplace: TaskBidMarketplace;
  private readonly now: () => number;
  private readonly authorizedResolvers: Set<string>;
  private readonly maxTitleLength: number;
  private readonly maxDescriptionLength: number;
  private readonly maxDeliverables: number;
  private readonly maxDeliverableLength: number;

  constructor(config: ServiceMarketplaceConfig = {}) {
    this.now = config.now ?? Date.now;
    this.bidMarketplace =
      config.bidMarketplace ?? new TaskBidMarketplace({ now: this.now });
    this.authorizedResolvers = new Set(
      (config.authorizedDisputeResolverIds ?? []).map((id) =>
        normalizeIdOrThrow(id, "resolver id"),
      ),
    );
    this.maxTitleLength = config.maxTitleLength ?? DEFAULT_MAX_TITLE_LENGTH;
    this.maxDescriptionLength =
      config.maxDescriptionLength ?? DEFAULT_MAX_DESCRIPTION_LENGTH;
    this.maxDeliverables = config.maxDeliverables ?? DEFAULT_MAX_DELIVERABLES;
    this.maxDeliverableLength =
      config.maxDeliverableLength ?? DEFAULT_MAX_DELIVERABLE_LENGTH;
  }

  createRequest(input: CreateServiceRequestInput): ServiceRequestSnapshot {
    const actorId = normalizeIdOrThrow(input.actorId, "actor id");
    const serviceId = normalizeIdOrThrow(input.serviceId, "service id");

    if (this.services.has(serviceId)) {
      throw new MarketplaceStateError(`service "${serviceId}" already exists`);
    }

    this.validateRequest(input.request);

    const nowMs = this.now();

    const record: ServiceRequestRecord = {
      serviceId,
      request: cloneRequest(input.request),
      requesterId: actorId,
      status: "open",
      acceptedBidId: null,
      awardedAgentId: null,
      completionProof: null,
      disputeReason: null,
      disputeOutcome: null,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      version: 0,
    };

    this.services.set(serviceId, record);

    this.bidMarketplace.setTaskOwner({ taskId: serviceId, ownerId: actorId });

    return this.toSnapshot(record);
  }

  bidOnService(input: BidOnServiceInput): TaskBid {
    const actorId = normalizeIdOrThrow(input.actorId, "actor id");
    const serviceId = normalizeIdOrThrow(input.serviceId, "service id");

    const record = this.getRecordOrThrow(serviceId);
    this.applyLazyDeadlineExpiry(record);

    if (actorId === record.requesterId) {
      throw new MarketplaceAuthorizationError(
        "requester cannot bid on own service",
      );
    }

    if (record.status !== "open" && record.status !== "bidding") {
      throw new MarketplaceStateError(
        `cannot bid on service "${serviceId}" in status "${record.status}"`,
      );
    }

    this.validateBid(input.bid, record.request.budget);

    const bid = this.bidMarketplace.createBid({
      actorId,
      taskOwnerId: record.requesterId,
      bid: {
        taskId: serviceId,
        bidderId: actorId,
        rewardLamports: input.bid.price,
        etaSeconds: input.bid.deliveryTime,
        confidenceBps: BPS_BASE,
        expiresAtMs:
          record.request.deadline ?? this.now() + 365 * 24 * 60 * 60 * 1000,
        metadata: {
          proposal: input.bid.proposal.trim(),
          ...(input.bid.portfolioLinks
            ? { portfolioLinks: [...input.bid.portfolioLinks] }
            : {}),
        },
      },
    });

    if (record.status === "open") {
      record.status = "bidding";
    }
    record.updatedAtMs = this.now();
    record.version += 1;

    return bid;
  }

  acceptBid(input: AcceptServiceBidInput): ServiceRequestSnapshot {
    const actorId = normalizeIdOrThrow(input.actorId, "actor id");
    const serviceId = normalizeIdOrThrow(input.serviceId, "service id");
    const bidId = normalizeIdOrThrow(input.bidId, "bid id");

    const record = this.getRecordOrThrow(serviceId);
    this.applyLazyDeadlineExpiry(record);
    this.assertVersion(record, input.expectedVersion);

    if (actorId !== record.requesterId) {
      throw new MarketplaceAuthorizationError(
        `actor "${actorId}" is not the requester of service "${serviceId}"`,
      );
    }

    if (record.status !== "bidding") {
      throw new MarketplaceStateError(
        `cannot accept bid on service "${serviceId}" in status "${record.status}"`,
      );
    }

    const result = this.bidMarketplace.acceptBid({
      actorId,
      taskId: serviceId,
      bidId,
    });

    record.status = "awarded";
    record.acceptedBidId = result.acceptedBid.bidId;
    record.awardedAgentId = result.acceptedBid.bidderId;
    record.updatedAtMs = this.now();
    record.version += 1;

    return this.toSnapshot(record);
  }

  startService(input: StartServiceInput): ServiceRequestSnapshot {
    const actorId = normalizeIdOrThrow(input.actorId, "actor id");
    const serviceId = normalizeIdOrThrow(input.serviceId, "service id");

    const record = this.getRecordOrThrow(serviceId);
    this.applyLazyDeadlineExpiry(record);

    if (actorId !== record.awardedAgentId) {
      throw new MarketplaceAuthorizationError(
        `actor "${actorId}" is not the awarded agent for service "${serviceId}"`,
      );
    }

    if (record.status !== "awarded") {
      throw new MarketplaceStateError(
        `cannot start service "${serviceId}" in status "${record.status}"`,
      );
    }

    record.status = "active";
    record.updatedAtMs = this.now();
    record.version += 1;

    return this.toSnapshot(record);
  }

  completeService(input: CompleteServiceInput): ServiceRequestSnapshot {
    const actorId = normalizeIdOrThrow(input.actorId, "actor id");
    const serviceId = normalizeIdOrThrow(input.serviceId, "service id");

    const record = this.getRecordOrThrow(serviceId);

    if (actorId !== record.awardedAgentId) {
      throw new MarketplaceAuthorizationError(
        `actor "${actorId}" is not the awarded agent for service "${serviceId}"`,
      );
    }

    if (record.status !== "active") {
      throw new MarketplaceStateError(
        `cannot complete service "${serviceId}" in status "${record.status}"`,
      );
    }

    const proof = input.proof?.trim();
    if (!proof) {
      throw new MarketplaceValidationError(
        "completion proof must be non-empty",
      );
    }

    record.status = "completed";
    record.completionProof = proof;
    record.updatedAtMs = this.now();
    record.version += 1;

    return this.toSnapshot(record);
  }

  cancelService(input: CancelServiceInput): ServiceRequestSnapshot {
    const actorId = normalizeIdOrThrow(input.actorId, "actor id");
    const serviceId = normalizeIdOrThrow(input.serviceId, "service id");

    const record = this.getRecordOrThrow(serviceId);
    this.applyLazyDeadlineExpiry(record);

    if (actorId !== record.requesterId) {
      throw new MarketplaceAuthorizationError(
        `actor "${actorId}" is not the requester of service "${serviceId}"`,
      );
    }

    const cancellable: ServiceRequestStatus[] = ["open", "bidding", "awarded"];
    if (!cancellable.includes(record.status)) {
      throw new MarketplaceStateError(
        `cannot cancel service "${serviceId}" in status "${record.status}"`,
      );
    }

    record.status = "cancelled";
    record.updatedAtMs = this.now();
    record.version += 1;

    return this.toSnapshot(record);
  }

  disputeService(input: DisputeServiceInput): ServiceRequestSnapshot {
    const actorId = normalizeIdOrThrow(input.actorId, "actor id");
    const serviceId = normalizeIdOrThrow(input.serviceId, "service id");

    const record = this.getRecordOrThrow(serviceId);

    if (actorId !== record.requesterId && actorId !== record.awardedAgentId) {
      throw new MarketplaceAuthorizationError(
        `actor "${actorId}" is not a party to service "${serviceId}"`,
      );
    }

    if (record.status !== "active") {
      throw new MarketplaceStateError(
        `cannot dispute service "${serviceId}" in status "${record.status}"`,
      );
    }

    const reason = input.reason?.trim();
    if (!reason) {
      throw new MarketplaceValidationError("dispute reason must be non-empty");
    }

    record.status = "disputed";
    record.disputeReason = reason;
    record.updatedAtMs = this.now();
    record.version += 1;

    return this.toSnapshot(record);
  }

  resolveDispute(input: ResolveServiceDisputeInput): ServiceRequestSnapshot {
    const actorId = normalizeIdOrThrow(input.actorId, "actor id");
    const serviceId = normalizeIdOrThrow(input.serviceId, "service id");

    const record = this.getRecordOrThrow(serviceId);

    if (!this.authorizedResolvers.has(actorId)) {
      throw new MarketplaceAuthorizationError(
        `actor "${actorId}" is not an authorized dispute resolver`,
      );
    }

    if (record.status !== "disputed") {
      throw new MarketplaceStateError(
        `cannot resolve service "${serviceId}" in status "${record.status}"`,
      );
    }

    const validOutcomes = ["refund", "pay_agent", "split"] as const;
    if (!validOutcomes.includes(input.outcome)) {
      throw new MarketplaceValidationError(
        `invalid outcome "${input.outcome as string}", expected one of: ${validOutcomes.join(", ")}`,
      );
    }

    record.status = "resolved";
    record.disputeOutcome = input.outcome;
    record.updatedAtMs = this.now();
    record.version += 1;

    return this.toSnapshot(record);
  }

  getService(serviceIdRaw: string): ServiceRequestSnapshot | null {
    const serviceId = normalizeIdOrThrow(serviceIdRaw, "service id");
    const record = this.services.get(serviceId);
    if (!record) return null;

    this.applyLazyDeadlineExpiry(record);
    return this.toSnapshot(record);
  }

  listServices(input?: ListServiceRequestsInput): ServiceRequestSnapshot[] {
    const results: ServiceRequestSnapshot[] = [];

    for (const record of this.services.values()) {
      this.applyLazyDeadlineExpiry(record);

      if (input?.status !== undefined && record.status !== input.status)
        continue;
      if (
        input?.requesterId !== undefined &&
        record.requesterId !== input.requesterId
      )
        continue;
      if (
        input?.requiredCapabilities !== undefined &&
        (record.request.requiredCapabilities & input.requiredCapabilities) !==
          input.requiredCapabilities
      )
        continue;
      if (
        input?.minBudget !== undefined &&
        record.request.budget < input.minBudget
      )
        continue;
      if (
        input?.maxBudget !== undefined &&
        record.request.budget > input.maxBudget
      )
        continue;

      results.push(this.toSnapshot(record));
    }

    return results.sort((a, b) => a.createdAtMs - b.createdAtMs);
  }

  listBids(serviceIdRaw: string): TaskBid[] {
    const serviceId = normalizeIdOrThrow(serviceIdRaw, "service id");
    return this.bidMarketplace.listBids({ taskId: serviceId });
  }

  getBidMarketplace(): TaskBidMarketplace {
    return this.bidMarketplace;
  }

  private getRecordOrThrow(serviceId: string): ServiceRequestRecord {
    const record = this.services.get(serviceId);
    if (!record) {
      throw new MarketplaceStateError(`service "${serviceId}" not found`);
    }
    return record;
  }

  private assertVersion(
    record: ServiceRequestRecord,
    expectedVersion: number | undefined,
  ): void {
    if (expectedVersion === undefined) return;

    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
      throw new MarketplaceValidationError(
        "expectedVersion must be a non-negative integer",
      );
    }

    if (record.version !== expectedVersion) {
      throw new MarketplaceStateError(
        `version mismatch for service "${record.serviceId}": expected ${expectedVersion}, current ${record.version}`,
      );
    }
  }

  private applyLazyDeadlineExpiry(record: ServiceRequestRecord): void {
    if (record.request.deadline === undefined) return;

    const expirable: ServiceRequestStatus[] = ["open", "bidding"];
    if (!expirable.includes(record.status)) return;

    if (this.now() >= record.request.deadline) {
      record.status = "cancelled";
      record.updatedAtMs = this.now();
      record.version += 1;
    }
  }

  private validateRequest(request: {
    title: string;
    description: string;
    requiredCapabilities: bigint;
    budget: bigint;
    deliverables: string[];
  }): void {
    const title = request.title?.trim();
    if (!title || title.length === 0) {
      throw new MarketplaceValidationError("title must be non-empty");
    }
    if (title.length > this.maxTitleLength) {
      throw new MarketplaceValidationError(
        `title exceeds max length of ${this.maxTitleLength}`,
      );
    }

    const description = request.description?.trim();
    if (!description || description.length === 0) {
      throw new MarketplaceValidationError("description must be non-empty");
    }
    if (description.length > this.maxDescriptionLength) {
      throw new MarketplaceValidationError(
        `description exceeds max length of ${this.maxDescriptionLength}`,
      );
    }

    if (request.requiredCapabilities <= 0n) {
      throw new MarketplaceValidationError("requiredCapabilities must be > 0");
    }

    if (request.budget <= 0n) {
      throw new MarketplaceValidationError("budget must be > 0");
    }

    if (
      !Array.isArray(request.deliverables) ||
      request.deliverables.length === 0
    ) {
      throw new MarketplaceValidationError(
        "deliverables must be a non-empty array",
      );
    }
    if (request.deliverables.length > this.maxDeliverables) {
      throw new MarketplaceValidationError(
        `deliverables exceeds max count of ${this.maxDeliverables}`,
      );
    }
    for (const d of request.deliverables) {
      const trimmed = typeof d === "string" ? d.trim() : "";
      if (!trimmed) {
        throw new MarketplaceValidationError(
          "each deliverable must be non-empty",
        );
      }
      if (trimmed.length > this.maxDeliverableLength) {
        throw new MarketplaceValidationError(
          `deliverable exceeds max length of ${this.maxDeliverableLength}`,
        );
      }
    }
  }

  private validateBid(
    bid: { price: bigint; deliveryTime: number; proposal: string },
    budget: bigint,
  ): void {
    if (bid.price <= 0n) {
      throw new MarketplaceValidationError("bid price must be > 0");
    }
    if (bid.price > budget) {
      throw new MarketplaceValidationError(
        `bid price ${bid.price.toString()} exceeds service budget ${budget.toString()}`,
      );
    }

    if (!Number.isInteger(bid.deliveryTime) || bid.deliveryTime <= 0) {
      throw new MarketplaceValidationError(
        "deliveryTime must be a positive integer",
      );
    }

    const proposal = bid.proposal?.trim();
    if (!proposal) {
      throw new MarketplaceValidationError("proposal must be non-empty");
    }
  }

  private toSnapshot(record: ServiceRequestRecord): ServiceRequestSnapshot {
    const bookState = this.bidMarketplace.getTaskState(record.serviceId);

    return {
      serviceId: record.serviceId,
      request: cloneRequest(record.request),
      requesterId: record.requesterId,
      status: record.status,
      acceptedBidId: record.acceptedBidId,
      awardedAgentId: record.awardedAgentId,
      completionProof: record.completionProof,
      disputeReason: record.disputeReason,
      disputeOutcome: record.disputeOutcome,
      activeBids: bookState?.activeBids ?? 0,
      totalBids: bookState?.totalBids ?? 0,
      version: record.version,
      createdAtMs: record.createdAtMs,
      updatedAtMs: record.updatedAtMs,
    };
  }
}

function cloneRequest(request: {
  title: string;
  description: string;
  requiredCapabilities: bigint;
  budget: bigint;
  budgetMint?: string;
  deadline?: number;
  deliverables: string[];
}): typeof request {
  return {
    title: request.title,
    description: request.description,
    requiredCapabilities: request.requiredCapabilities,
    budget: request.budget,
    budgetMint: request.budgetMint,
    deadline: request.deadline,
    deliverables: [...request.deliverables],
  };
}
