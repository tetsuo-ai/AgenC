/**
 * In-memory runtime marketplace for autonomous task bidding and matching.
 *
 * @module
 */

import {
  BPS_BASE,
  canonicalizeMarketplaceId,
  isValidBps,
  validateMarketplaceId,
} from '@agenc/sdk';
import type {
  BidAntiSpamConfig,
  MatchingPolicyConfig,
  TaskBid,
  TaskBidUpdateInput,
} from '@agenc/sdk';
import {
  MarketplaceAuthorizationError,
  MarketplaceMatchingError,
  MarketplaceStateError,
  MarketplaceValidationError,
} from './errors.js';
import { selectWinningBid } from './scoring.js';
import type {
  AcceptTaskBidRequest,
  AcceptTaskBidResult,
  AutoMatchTaskBidRequest,
  CancelTaskBidRequest,
  CreateTaskBidRequest,
  ListTaskBidsRequest,
  SelectTaskBidRequest,
  SetTaskOwnerRequest,
  TaskBidBookSnapshot,
  TaskBidMarketplaceConfig,
  UpdateTaskBidRequest,
} from './types.js';

interface TaskBidBook {
  taskId: string;
  ownerId: string | null;
  taskVersion: number;
  acceptedBidId: string | null;
  bids: Map<string, TaskBid>;
  nextSequence: number;
  rateBuckets: Map<string, number[]>;
}

const DEFAULT_POLICY: MatchingPolicyConfig = {
  policy: 'best_price',
};

const DEFAULT_ANTI_SPAM: Required<
  Pick<BidAntiSpamConfig, 'maxActiveBidsPerBidderPerTask' | 'maxBidsPerTask' | 'maxTrackedBiddersPerTask'>
> & {
  createRateLimit?: BidAntiSpamConfig['createRateLimit'];
  minBondLamports?: bigint;
} = {
  maxActiveBidsPerBidderPerTask: 3,
  maxBidsPerTask: 5_000,
  maxTrackedBiddersPerTask: 2_000,
};

export class TaskBidMarketplace {
  private readonly books = new Map<string, TaskBidBook>();
  private readonly now: () => number;
  private readonly defaultPolicy: MatchingPolicyConfig;
  private readonly antiSpam: typeof DEFAULT_ANTI_SPAM;
  private readonly bidIdGenerator: (taskId: string, bidderId: string, sequence: number) => string;
  private readonly authorizedSelectors: Set<string>;

  constructor(config: TaskBidMarketplaceConfig = {}) {
    this.now = config.now ?? Date.now;
    this.defaultPolicy = config.defaultPolicy ?? DEFAULT_POLICY;
    this.bidIdGenerator = config.bidIdGenerator ?? defaultBidIdGenerator;
    this.antiSpam = {
      ...DEFAULT_ANTI_SPAM,
      ...(config.antiSpam ?? {}),
    };
    this.authorizedSelectors = new Set(
      (config.authorizedSelectorIds ?? []).map((id) => normalizeIdOrThrow(id, 'authorized selector id')),
    );
  }

  setTaskOwner(input: SetTaskOwnerRequest): TaskBidBookSnapshot {
    const taskId = normalizeIdOrThrow(input.taskId, 'task id');
    const ownerId = normalizeIdOrThrow(input.ownerId, 'owner id');

    const book = this.getOrCreateBook(taskId);
    this.applyLazyExpiryMutation(book, this.now());
    this.assertExpectedVersion(book, input.expectedVersion);

    if (book.ownerId === ownerId) {
      return this.toBookSnapshot(book);
    }

    if (book.ownerId && book.ownerId !== ownerId) {
      throw new MarketplaceStateError(
        `task "${taskId}" already has owner "${book.ownerId}"`,
      );
    }

    book.ownerId = ownerId;
    book.taskVersion += 1;
    return this.toBookSnapshot(book);
  }

  createBid(input: CreateTaskBidRequest): TaskBid {
    const actorId = normalizeIdOrThrow(input.actorId, 'actor id');
    const normalized = this.normalizeCreateInput(input, actorId);

    const book = this.getOrCreateBook(normalized.taskId);

    this.applyLazyExpiryMutation(book, normalized.nowMs);
    this.assertExpectedVersion(book, input.expectedVersion);

    if (book.ownerId === null && normalized.taskOwnerId) {
      book.ownerId = normalized.taskOwnerId;
    } else if (normalized.taskOwnerId && book.ownerId !== normalized.taskOwnerId) {
      throw new MarketplaceValidationError(
        `provided task owner "${normalized.taskOwnerId}" does not match registered owner "${book.ownerId}"`,
      );
    }

    this.enforceCreateLimits(book, normalized.taskId, normalized.bidderId, normalized.bondLamports, normalized.nowMs);

    const generatedId = this.bidIdGenerator(normalized.taskId, normalized.bidderId, book.nextSequence);
    const bidId = normalizeIdOrThrow(generatedId, 'bid id');

    if (book.bids.has(bidId)) {
      throw new MarketplaceValidationError(
        `bid id collision for task "${normalized.taskId}": "${bidId}"`,
      );
    }

    const created: TaskBid = {
      bidId,
      taskId: normalized.taskId,
      bidderId: normalized.bidderId,
      rewardLamports: normalized.rewardLamports,
      etaSeconds: normalized.etaSeconds,
      confidenceBps: normalized.confidenceBps,
      reliabilityBps: normalized.reliabilityBps,
      qualityGuarantee: normalized.qualityGuarantee,
      bondLamports: normalized.bondLamports,
      expiresAtMs: normalized.expiresAtMs,
      metadata: cloneMetadata(normalized.metadata),
      createdAtMs: normalized.nowMs,
      updatedAtMs: normalized.nowMs,
      status: 'active',
    };

    book.nextSequence += 1;
    book.bids.set(created.bidId, created);
    this.recordCreateRate(book, normalized.bidderId, normalized.nowMs);
    book.taskVersion += 1;

    return cloneBid(created);
  }

  updateBid(input: UpdateTaskBidRequest): TaskBid {
    const actorId = normalizeIdOrThrow(input.actorId, 'actor id');
    const taskId = normalizeIdOrThrow(input.taskId, 'task id');
    const bidId = normalizeIdOrThrow(input.bidId, 'bid id');

    const book = this.getExistingBook(taskId);
    const now = this.now();

    this.applyLazyExpiryMutation(book, now);
    this.assertExpectedVersion(book, input.expectedVersion);

    const bid = this.getBid(book, bidId);
    this.assertBidOwner(actorId, bid);

    if (bid.status !== 'active') {
      throw new MarketplaceStateError(
        `cannot update bid "${bidId}" from status "${bid.status}"`,
      );
    }

    const patch = this.normalizePatch(input.patch, now);

    bid.rewardLamports = patch.rewardLamports ?? bid.rewardLamports;
    bid.etaSeconds = patch.etaSeconds ?? bid.etaSeconds;
    bid.confidenceBps = patch.confidenceBps ?? bid.confidenceBps;
    bid.reliabilityBps = patch.reliabilityBps ?? bid.reliabilityBps;
    if (patch.qualityGuarantee !== undefined) {
      bid.qualityGuarantee = patch.qualityGuarantee;
    }
    if (patch.bondLamports !== undefined) {
      bid.bondLamports = patch.bondLamports;
    }
    if (patch.expiresAtMs !== undefined) {
      bid.expiresAtMs = patch.expiresAtMs;
    }
    if (patch.metadata !== undefined) {
      bid.metadata = cloneMetadata(patch.metadata);
    }

    if (bid.expiresAtMs <= now) {
      bid.status = 'expired';
    }

    bid.updatedAtMs = now;
    book.taskVersion += 1;

    return cloneBid(bid);
  }

  cancelBid(input: CancelTaskBidRequest): TaskBid {
    const actorId = normalizeIdOrThrow(input.actorId, 'actor id');
    const taskId = normalizeIdOrThrow(input.taskId, 'task id');
    const bidId = normalizeIdOrThrow(input.bidId, 'bid id');

    const book = this.getExistingBook(taskId);
    const now = this.now();

    this.applyLazyExpiryMutation(book, now);
    this.assertExpectedVersion(book, input.expectedVersion);

    const bid = this.getBid(book, bidId);
    this.assertBidOwner(actorId, bid);

    if (bid.status === 'cancelled') {
      return cloneBid(bid);
    }

    if (bid.status !== 'active') {
      throw new MarketplaceStateError(
        `cannot cancel bid "${bidId}" from status "${bid.status}"`,
      );
    }

    bid.status = 'cancelled';
    bid.rejectedReason = input.reason?.trim() || 'cancelled_by_bidder';
    bid.updatedAtMs = now;

    book.taskVersion += 1;
    return cloneBid(bid);
  }

  listBids(input: ListTaskBidsRequest): TaskBid[] {
    const taskId = normalizeIdOrThrow(input.taskId, 'task id');
    const book = this.books.get(taskId);
    if (!book) return [];

    const now = this.now();
    const includeExpiredProjection = input.includeExpiredProjection ?? true;
    const statuses = input.statuses ? new Set(input.statuses) : null;

    const out = Array.from(book.bids.values())
      .map((bid) => projectBidForRead(bid, now, includeExpiredProjection))
      .filter((bid) => (statuses ? statuses.has(bid.status) : true))
      .sort(compareByCreatedThenBidId);

    return out;
  }

  getTaskState(taskIdRaw: string): TaskBidBookSnapshot | null {
    const taskId = normalizeIdOrThrow(taskIdRaw, 'task id');
    const book = this.books.get(taskId);
    if (!book) return null;

    return this.toBookSnapshot(book);
  }

  selectWinner(input: SelectTaskBidRequest) {
    const taskId = normalizeIdOrThrow(input.taskId, 'task id');
    const book = this.books.get(taskId);
    if (!book) return null;

    const policy = input.policy ?? this.defaultPolicy;
    const now = this.now();
    const active = this.getActiveProjectedBids(book, now);
    if (active.length === 0) {
      return null;
    }

    try {
      return selectWinningBid(active, policy);
    } catch (error) {
      throw new MarketplaceMatchingError(toError(error).message);
    }
  }

  acceptBid(input: AcceptTaskBidRequest): AcceptTaskBidResult {
    const actorId = normalizeIdOrThrow(input.actorId, 'actor id');
    const taskId = normalizeIdOrThrow(input.taskId, 'task id');
    const bidId = normalizeIdOrThrow(input.bidId, 'bid id');

    const book = this.getExistingBook(taskId);
    const now = this.now();

    this.applyLazyExpiryMutation(book, now);
    this.assertExpectedVersion(book, input.expectedVersion);
    this.assertSelectorAuthorized(book, actorId);

    return this.acceptBidInternal(book, bidId, now);
  }

  autoMatch(input: AutoMatchTaskBidRequest): AcceptTaskBidResult | null {
    const actorId = normalizeIdOrThrow(input.actorId, 'actor id');
    const taskId = normalizeIdOrThrow(input.taskId, 'task id');

    const book = this.getExistingBook(taskId);
    const now = this.now();

    this.applyLazyExpiryMutation(book, now);
    this.assertExpectedVersion(book, input.expectedVersion);
    this.assertSelectorAuthorized(book, actorId);

    if (book.acceptedBidId) {
      return this.acceptBidInternal(book, book.acceptedBidId, now);
    }

    const candidates = this.getActiveProjectedBids(book, now);
    if (candidates.length === 0) {
      return null;
    }

    const policy = input.policy ?? this.defaultPolicy;

    const winner = selectWinningBid(candidates, policy);
    if (!winner) {
      return null;
    }

    return this.acceptBidInternal(book, winner.bid.bidId, now);
  }

  sweepExpiredBids(taskIdRaw?: string): number {
    const now = this.now();

    if (taskIdRaw) {
      const taskId = normalizeIdOrThrow(taskIdRaw, 'task id');
      const book = this.books.get(taskId);
      if (!book) return 0;
      return this.applyLazyExpiryMutation(book, now);
    }

    let total = 0;
    for (const book of this.books.values()) {
      total += this.applyLazyExpiryMutation(book, now);
    }
    return total;
  }

  private acceptBidInternal(book: TaskBidBook, bidId: string, now: number): AcceptTaskBidResult {
    if (book.acceptedBidId) {
      if (book.acceptedBidId !== bidId) {
        throw new MarketplaceStateError(
          `task "${book.taskId}" already accepted bid "${book.acceptedBidId}"`,
        );
      }

      const accepted = this.getBid(book, bidId);
      return {
        taskId: book.taskId,
        taskVersion: book.taskVersion,
        acceptedBid: cloneBid(accepted),
        rejectedBidIds: [],
      };
    }

    const target = this.getBid(book, bidId);

    if (target.status !== 'active') {
      throw new MarketplaceStateError(
        `cannot accept bid "${bidId}" from status "${target.status}"`,
      );
    }

    target.status = 'accepted';
    target.updatedAtMs = now;

    const rejectedBidIds: string[] = [];
    for (const candidate of book.bids.values()) {
      if (candidate.bidId === bidId) continue;
      if (candidate.status !== 'active') continue;

      candidate.status = 'rejected';
      candidate.rejectedReason = 'another_bid_accepted';
      candidate.updatedAtMs = now;
      rejectedBidIds.push(candidate.bidId);
    }

    rejectedBidIds.sort((a, b) => a.localeCompare(b));

    book.acceptedBidId = bidId;
    book.taskVersion += 1;

    return {
      taskId: book.taskId,
      taskVersion: book.taskVersion,
      acceptedBid: cloneBid(target),
      rejectedBidIds,
    };
  }

  private assertSelectorAuthorized(book: TaskBidBook, actorId: string): void {
    if (this.authorizedSelectors.has(actorId)) {
      return;
    }

    if (book.ownerId && book.ownerId === actorId) {
      return;
    }

    throw new MarketplaceAuthorizationError(
      `actor "${actorId}" is not authorized to select bids for task "${book.taskId}"`,
    );
  }

  private assertBidOwner(actorId: string, bid: TaskBid): void {
    if (actorId !== bid.bidderId) {
      throw new MarketplaceAuthorizationError(
        `actor "${actorId}" is not the owner of bid "${bid.bidId}"`,
      );
    }
  }

  private assertExpectedVersion(book: TaskBidBook, expectedVersion: number | undefined): void {
    if (expectedVersion === undefined) return;

    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
      throw new MarketplaceValidationError('expectedVersion must be a non-negative integer');
    }

    if (book.taskVersion !== expectedVersion) {
      throw new MarketplaceStateError(
        `version mismatch for task "${book.taskId}": expected ${expectedVersion}, current ${book.taskVersion}`,
      );
    }
  }

  private getOrCreateBook(taskId: string): TaskBidBook {
    const existing = this.books.get(taskId);
    if (existing) return existing;

    const created: TaskBidBook = {
      taskId,
      ownerId: null,
      taskVersion: 0,
      acceptedBidId: null,
      bids: new Map<string, TaskBid>(),
      nextSequence: 1,
      rateBuckets: new Map<string, number[]>(),
    };
    this.books.set(taskId, created);
    return created;
  }

  private getExistingBook(taskId: string): TaskBidBook {
    const book = this.books.get(taskId);
    if (!book) {
      throw new MarketplaceStateError(`task "${taskId}" does not have a bid book`);
    }
    return book;
  }

  private getBid(book: TaskBidBook, bidId: string): TaskBid {
    const bid = book.bids.get(bidId);
    if (!bid) {
      throw new MarketplaceStateError(`bid "${bidId}" not found for task "${book.taskId}"`);
    }
    return bid;
  }

  private applyLazyExpiryMutation(book: TaskBidBook, now: number): number {
    let expiredCount = 0;

    for (const bid of book.bids.values()) {
      if (bid.status !== 'active') continue;
      if (now < bid.expiresAtMs) continue;

      bid.status = 'expired';
      bid.updatedAtMs = now;
      expiredCount += 1;
    }

    if (expiredCount > 0) {
      book.taskVersion += 1;
    }

    return expiredCount;
  }

  private getActiveProjectedBids(book: TaskBidBook, now: number): TaskBid[] {
    return Array.from(book.bids.values())
      .filter((bid) => bid.status === 'active' && bid.expiresAtMs > now)
      .map((bid) => cloneBid(bid));
  }

  private normalizeCreateInput(input: CreateTaskBidRequest, actorId: string): {
    taskId: string;
    bidderId: string;
    taskOwnerId?: string;
    rewardLamports: bigint;
    etaSeconds: number;
    confidenceBps: number;
    reliabilityBps: number;
    qualityGuarantee?: string;
    bondLamports: bigint;
    expiresAtMs: number;
    metadata?: Record<string, unknown>;
    nowMs: number;
  } {
    const nowMs = this.now();

    const taskId = normalizeIdOrThrow(input.bid.taskId, 'task id');
    const bidderId = normalizeIdOrThrow(input.bid.bidderId, 'bidder id');
    const taskOwnerId = input.taskOwnerId
      ? normalizeIdOrThrow(input.taskOwnerId, 'task owner id')
      : undefined;

    if (actorId !== bidderId) {
      throw new MarketplaceAuthorizationError(
        `actor "${actorId}" cannot create bids for bidder "${bidderId}"`,
      );
    }

    validateRewardLamports(input.bid.rewardLamports);
    validateEtaSeconds(input.bid.etaSeconds);

    if (!isValidBps(input.bid.confidenceBps)) {
      throw new MarketplaceValidationError(
        `confidenceBps must be an integer between 0 and ${BPS_BASE}`,
      );
    }

    const reliabilityBps = input.bid.reliabilityBps ?? input.bid.confidenceBps;
    if (!isValidBps(reliabilityBps)) {
      throw new MarketplaceValidationError(
        `reliabilityBps must be an integer between 0 and ${BPS_BASE}`,
      );
    }

    const bondLamports = input.bid.bondLamports ?? 0n;
    validateBondLamports(bondLamports);

    const expiresAtMs = normalizeTimestamp(input.bid.expiresAtMs, 'expiresAtMs');
    if (expiresAtMs <= nowMs) {
      throw new MarketplaceValidationError('expiresAtMs must be in the future');
    }

    return {
      taskId,
      bidderId,
      taskOwnerId,
      rewardLamports: input.bid.rewardLamports,
      etaSeconds: input.bid.etaSeconds,
      confidenceBps: input.bid.confidenceBps,
      reliabilityBps,
      qualityGuarantee: normalizeOptionalText(input.bid.qualityGuarantee),
      bondLamports,
      expiresAtMs,
      metadata: cloneMetadata(input.bid.metadata),
      nowMs,
    };
  }

  private normalizePatch(patch: TaskBidUpdateInput, nowMs: number): TaskBidUpdateInput {
    const out: TaskBidUpdateInput = {};

    if (patch.rewardLamports !== undefined) {
      validateRewardLamports(patch.rewardLamports);
      out.rewardLamports = patch.rewardLamports;
    }

    if (patch.etaSeconds !== undefined) {
      validateEtaSeconds(patch.etaSeconds);
      out.etaSeconds = patch.etaSeconds;
    }

    if (patch.confidenceBps !== undefined) {
      if (!isValidBps(patch.confidenceBps)) {
        throw new MarketplaceValidationError(
          `confidenceBps must be an integer between 0 and ${BPS_BASE}`,
        );
      }
      out.confidenceBps = patch.confidenceBps;
    }

    if (patch.reliabilityBps !== undefined) {
      if (!isValidBps(patch.reliabilityBps)) {
        throw new MarketplaceValidationError(
          `reliabilityBps must be an integer between 0 and ${BPS_BASE}`,
        );
      }
      out.reliabilityBps = patch.reliabilityBps;
    }

    if (patch.bondLamports !== undefined) {
      validateBondLamports(patch.bondLamports);
      out.bondLamports = patch.bondLamports;
    }

    if (patch.expiresAtMs !== undefined) {
      out.expiresAtMs = normalizeTimestamp(patch.expiresAtMs, 'expiresAtMs');
      if (out.expiresAtMs < 0) {
        throw new MarketplaceValidationError('expiresAtMs must be non-negative');
      }
    }

    if (patch.qualityGuarantee !== undefined) {
      out.qualityGuarantee = normalizeOptionalText(patch.qualityGuarantee);
    }

    if (patch.metadata !== undefined) {
      out.metadata = cloneMetadata(patch.metadata);
    }

    // Allow setting expiresAtMs to <= now for immediate expiration on update.
    if (out.expiresAtMs !== undefined && out.expiresAtMs <= nowMs) {
      out.expiresAtMs = nowMs;
    }

    return out;
  }

  private enforceCreateLimits(
    book: TaskBidBook,
    taskId: string,
    bidderId: string,
    bondLamports: bigint,
    nowMs: number,
  ): void {
    if (book.bids.size >= this.antiSpam.maxBidsPerTask) {
      throw new MarketplaceStateError(
        `task "${taskId}" reached max bids per task (${this.antiSpam.maxBidsPerTask})`,
      );
    }

    if (this.antiSpam.minBondLamports !== undefined && bondLamports < this.antiSpam.minBondLamports) {
      throw new MarketplaceValidationError(
        `bid bond ${bondLamports.toString()} below minimum ${this.antiSpam.minBondLamports.toString()}`,
      );
    }

    const activeByBidder = this.countActiveBidsForBidder(book, bidderId, nowMs);
    if (activeByBidder >= this.antiSpam.maxActiveBidsPerBidderPerTask) {
      throw new MarketplaceStateError(
        `bidder "${bidderId}" reached max active bids per task (${this.antiSpam.maxActiveBidsPerBidderPerTask})`,
      );
    }

    this.pruneRateLimitBuckets(book, nowMs);

    const rateLimit = this.antiSpam.createRateLimit;
    if (!rateLimit) {
      return;
    }

    if (!Number.isInteger(rateLimit.maxCreates) || rateLimit.maxCreates < 1) {
      throw new MarketplaceValidationError('createRateLimit.maxCreates must be a positive integer');
    }

    if (!Number.isInteger(rateLimit.windowMs) || rateLimit.windowMs < 1) {
      throw new MarketplaceValidationError('createRateLimit.windowMs must be a positive integer');
    }

    const bucket = book.rateBuckets.get(bidderId) ?? [];
    const cutoff = nowMs - rateLimit.windowMs;
    const recent = bucket.filter((ts) => ts > cutoff);

    if (recent.length >= rateLimit.maxCreates) {
      throw new MarketplaceStateError(
        `bidder "${bidderId}" exceeded create rate limit (${rateLimit.maxCreates}/${rateLimit.windowMs}ms)`,
      );
    }
  }

  private recordCreateRate(book: TaskBidBook, bidderId: string, nowMs: number): void {
    const rateLimit = this.antiSpam.createRateLimit;
    if (!rateLimit) return;

    const cutoff = nowMs - rateLimit.windowMs;

    const current = book.rateBuckets.get(bidderId) ?? [];
    const recent = current.filter((ts) => ts > cutoff);
    recent.push(nowMs);

    if (!book.rateBuckets.has(bidderId) && book.rateBuckets.size >= this.antiSpam.maxTrackedBiddersPerTask) {
      const firstKey = book.rateBuckets.keys().next().value as string | undefined;
      if (firstKey) {
        book.rateBuckets.delete(firstKey);
      }
    }

    book.rateBuckets.delete(bidderId);
    book.rateBuckets.set(bidderId, recent);
  }

  private pruneRateLimitBuckets(book: TaskBidBook, nowMs: number): void {
    const rateLimit = this.antiSpam.createRateLimit;
    if (!rateLimit) return;

    const cutoff = nowMs - rateLimit.windowMs;

    for (const [bidderId, events] of book.rateBuckets.entries()) {
      const recent = events.filter((ts) => ts > cutoff);
      if (recent.length === 0) {
        book.rateBuckets.delete(bidderId);
        continue;
      }
      book.rateBuckets.set(bidderId, recent);
    }

    while (book.rateBuckets.size > this.antiSpam.maxTrackedBiddersPerTask) {
      const firstKey = book.rateBuckets.keys().next().value as string | undefined;
      if (!firstKey) break;
      book.rateBuckets.delete(firstKey);
    }
  }

  private countActiveBidsForBidder(book: TaskBidBook, bidderId: string, nowMs: number): number {
    let count = 0;
    for (const bid of book.bids.values()) {
      if (bid.bidderId !== bidderId) continue;
      if (bid.status !== 'active') continue;
      if (bid.expiresAtMs <= nowMs) continue;
      count += 1;
    }
    return count;
  }

  private toBookSnapshot(book: TaskBidBook): TaskBidBookSnapshot {
    const now = this.now();
    let activeBids = 0;

    for (const bid of book.bids.values()) {
      if (bid.status !== 'active') continue;
      if (bid.expiresAtMs <= now) continue;
      activeBids += 1;
    }

    return {
      taskId: book.taskId,
      taskVersion: book.taskVersion,
      acceptedBidId: book.acceptedBidId,
      totalBids: book.bids.size,
      activeBids,
      ownerId: book.ownerId,
    };
  }
}

function normalizeIdOrThrow(raw: string, label: string): string {
  const normalized = canonicalizeMarketplaceId(raw);
  const validationError = validateMarketplaceId(normalized);
  if (validationError) {
    throw new MarketplaceValidationError(`${label} ${validationError}`);
  }
  return normalized;
}

function normalizeTimestamp(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new MarketplaceValidationError(`${label} must be a non-negative integer timestamp (ms)`);
  }
  return value;
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function validateRewardLamports(value: bigint): void {
  if (value < 0n) {
    throw new MarketplaceValidationError('rewardLamports must be non-negative');
  }
}

function validateBondLamports(value: bigint): void {
  if (value < 0n) {
    throw new MarketplaceValidationError('bondLamports must be non-negative');
  }
}

function validateEtaSeconds(value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new MarketplaceValidationError('etaSeconds must be a non-negative integer');
  }
}

function projectBidForRead(bid: TaskBid, nowMs: number, includeExpiredProjection: boolean): TaskBid {
  const projected = cloneBid(bid);
  if (includeExpiredProjection && projected.status === 'active' && projected.expiresAtMs <= nowMs) {
    projected.status = 'expired';
  }
  return projected;
}

function compareByCreatedThenBidId(a: TaskBid, b: TaskBid): number {
  if (a.createdAtMs !== b.createdAtMs) {
    return a.createdAtMs - b.createdAtMs;
  }
  return a.bidId.localeCompare(b.bidId);
}

function cloneBid(bid: TaskBid): TaskBid {
  return {
    ...bid,
    metadata: cloneMetadata(bid.metadata),
  };
}

function cloneMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  return { ...metadata };
}

function defaultBidIdGenerator(taskId: string, bidderId: string, sequence: number): string {
  return `${taskId}:${bidderId}:${sequence.toString(36)}`;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
