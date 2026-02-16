/**
 * Skill monetization manager — orchestrates subscriptions, revenue sharing,
 * and usage analytics.
 *
 * Subscriptions reuse `purchase_skill` as the initial payment primitive with
 * runtime-managed time-locked access. Revenue sharing is a pure computation.
 * Usage analytics is in-memory tracking.
 *
 * @module
 */

import type { Logger } from '../../utils/logger.js';
import { silentLogger } from '../../utils/logger.js';
import { findAgentPda } from '../../agent/pda.js';
import type { SkillPurchaseManager } from '../registry/payment.js';
import { SkillSubscriptionError } from './errors.js';
import { computeRevenueShare } from './revenue.js';
import { SkillUsageTracker } from './analytics.js';
import {
  SECONDS_PER_MONTH,
  SECONDS_PER_YEAR,
  type SkillMonetizationConfig,
  type SubscriptionModel,
  type SubscriptionRecord,
  type SubscribeParams,
  type SubscriptionResult,
  type RevenueShareInput,
  type RevenueShareResult,
  type SkillUsageEvent,
  type SkillAnalytics,
} from './types.js';

export class SkillMonetizationManager {
  private readonly purchaseManager: SkillPurchaseManager;
  private readonly subscriberAgent: string;
  private readonly logger: Logger;
  private readonly clockFn: () => number;
  private readonly tracker: SkillUsageTracker;

  private readonly models = new Map<string, SubscriptionModel>();
  private readonly subscriptions = new Map<string, SubscriptionRecord>();
  /** Track skills that have had a prior trial to prevent re-trialing */
  private readonly trialHistory = new Set<string>();

  constructor(config: SkillMonetizationConfig) {
    this.purchaseManager = config.purchaseManager;
    this.logger = config.logger ?? silentLogger;
    this.clockFn = config.clockFn ?? (() => Math.floor(Date.now() / 1000));
    this.tracker = new SkillUsageTracker();

    // Derive subscriberAgent base58 from agentId
    const agentPda = findAgentPda(config.agentId);
    this.subscriberAgent = agentPda.toBase58();
  }

  // ==========================================================================
  // Subscription Model Management
  // ==========================================================================

  registerModel(skillId: string, model: SubscriptionModel): void {
    this.models.set(skillId, model);
    this.logger.debug(`Registered subscription model for skill "${skillId}"`);
  }

  getModel(skillId: string): SubscriptionModel | undefined {
    return this.models.get(skillId);
  }

  // ==========================================================================
  // Subscription Lifecycle
  // ==========================================================================

  async subscribe(params: SubscribeParams): Promise<SubscriptionResult> {
    const model = this.models.get(params.skillId);
    if (!model) {
      throw new SkillSubscriptionError(
        params.skillId,
        'No subscription model registered for this skill',
      );
    }

    const now = this.clockFn();
    const existing = this.subscriptions.get(params.skillId);

    // Free tier — instant access, no payment
    if (model.freeTier) {
      const record = this.createRecord(params, 'active', now, now + SECONDS_PER_YEAR * 100, 0n);
      this.subscriptions.set(params.skillId, record);
      return {
        subscriptionId: record.id,
        status: 'active',
        expiresAt: record.expiresAt,
        pricePaid: 0n,
        protocolFee: 0n,
        isRenewal: false,
      };
    }

    // Existing active subscription — renewal (runtime-only time extension)
    if (existing && (existing.status === 'active' || existing.status === 'trial')) {
      const effectiveStart = existing.expiresAt > now ? existing.expiresAt : now;
      const duration = this.getPeriodDuration(params.period);
      existing.expiresAt = effectiveStart + duration;
      existing.renewalCount++;
      existing.status = 'active';

      this.logger.info(
        `Renewed subscription for skill "${params.skillId}" (renewal #${existing.renewalCount})`,
      );

      return {
        subscriptionId: existing.id,
        status: 'active',
        expiresAt: existing.expiresAt,
        pricePaid: 0n,
        protocolFee: 0n,
        isRenewal: true,
      };
    }

    // Trial available — no prior subscription and trialDays configured
    const trialDays = model.trialDays ?? 0;
    if (trialDays > 0 && !this.trialHistory.has(params.skillId)) {
      const trialSecs = trialDays * 86_400;
      const record = this.createRecord(params, 'trial', now, now + trialSecs, 0n);
      this.subscriptions.set(params.skillId, record);
      this.trialHistory.add(params.skillId);

      this.logger.info(`Started ${trialDays}-day trial for skill "${params.skillId}"`);

      return {
        subscriptionId: record.id,
        status: 'trial',
        expiresAt: record.expiresAt,
        pricePaid: 0n,
        protocolFee: 0n,
        isRenewal: false,
      };
    }

    // Paid subscription — call purchase_skill for initial payment
    const purchaseResult = await this.purchaseManager.purchase(
      params.skillPda,
      params.skillId,
      params.targetPath ?? '',
    );

    const duration = this.getPeriodDuration(params.period);
    const record = this.createRecord(
      params,
      'active',
      now,
      now + duration,
      purchaseResult.pricePaid,
    );
    record.lastPaymentTx = purchaseResult.transactionSignature;
    this.subscriptions.set(params.skillId, record);
    this.trialHistory.add(params.skillId);

    this.logger.info(
      `Subscribed to skill "${params.skillId}" (${params.period}, paid ${purchaseResult.pricePaid} lamports)`,
    );

    return {
      subscriptionId: record.id,
      status: 'active',
      expiresAt: record.expiresAt,
      pricePaid: purchaseResult.pricePaid,
      protocolFee: purchaseResult.protocolFee,
      transactionSignature: purchaseResult.transactionSignature,
      isRenewal: false,
    };
  }

  unsubscribe(skillId: string): void {
    const existing = this.subscriptions.get(skillId);
    if (!existing) {
      throw new SkillSubscriptionError(skillId, 'No subscription found');
    }
    existing.status = 'cancelled';
    existing.cancelledAt = this.clockFn();
    this.logger.info(`Cancelled subscription for skill "${skillId}"`);
  }

  async checkAccess(skillId: string): Promise<boolean> {
    // Free tier — always accessible
    const model = this.models.get(skillId);
    if (model && model.freeTier) return true;

    // Active, trial, or cancelled subscription — all honor expiresAt.
    // Cancelled means "don't auto-renew" but access continues until expiry.
    const sub = this.subscriptions.get(skillId);
    if (sub) {
      if (sub.status === 'active' || sub.status === 'trial' || sub.status === 'cancelled') {
        if (this.clockFn() < sub.expiresAt) return true;
        // Lazily expire
        sub.status = 'expired';
      }
      // Fallback to on-chain purchase record using stored skillPda
      return this.purchaseManager.isPurchased(sub.skillPda);
    }

    return false;
  }

  getSubscription(skillId: string): SubscriptionRecord | undefined {
    return this.subscriptions.get(skillId);
  }

  getActiveSubscriptions(): SubscriptionRecord[] {
    const now = this.clockFn();
    const result: SubscriptionRecord[] = [];
    for (const sub of this.subscriptions.values()) {
      if ((sub.status === 'active' || sub.status === 'trial') && now < sub.expiresAt) {
        result.push(sub);
      }
    }
    return result;
  }

  getAllSubscriptions(): SubscriptionRecord[] {
    return [...this.subscriptions.values()];
  }

  // ==========================================================================
  // Revenue Sharing
  // ==========================================================================

  computeRevenue(input: RevenueShareInput): RevenueShareResult {
    return computeRevenueShare(input);
  }

  // ==========================================================================
  // Usage Analytics
  // ==========================================================================

  recordUsage(event: SkillUsageEvent): void {
    this.tracker.record(event);
  }

  getAnalytics(skillId: string): SkillAnalytics | null {
    return this.tracker.getAnalytics(skillId);
  }

  getTopSkills(limit?: number): Array<{ skillId: string; invocations: number }> {
    return this.tracker.getTopSkills(limit);
  }

  get usageTracker(): SkillUsageTracker {
    return this.tracker;
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  private getPeriodDuration(period: 'monthly' | 'yearly'): number {
    return period === 'yearly' ? SECONDS_PER_YEAR : SECONDS_PER_MONTH;
  }

  private createRecord(
    params: SubscribeParams,
    status: SubscriptionRecord['status'],
    startedAt: number,
    expiresAt: number,
    pricePaid: bigint,
  ): SubscriptionRecord {
    return {
      id: params.skillId,
      skillId: params.skillId,
      skillPda: params.skillPda,
      subscriberAgent: this.subscriberAgent,
      period: params.period,
      status,
      startedAt,
      expiresAt,
      renewalCount: 0,
      pricePaid,
    };
  }
}
