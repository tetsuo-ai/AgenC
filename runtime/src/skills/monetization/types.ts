/**
 * Types and constants for skill monetization — subscriptions, revenue sharing,
 * and usage analytics.
 *
 * @module
 */

import type { PublicKey } from '@solana/web3.js';
import type { Logger } from '../../utils/logger.js';
import type { SkillPurchaseManager } from '../registry/payment.js';

// ============================================================================
// Constants
// ============================================================================

/** Developer share of revenue in basis points (80%) */
export const DEVELOPER_REVENUE_BPS = 8000;

/** Protocol share of revenue in basis points (20%) */
export const PROTOCOL_REVENUE_BPS = 2000;

/** Denominator for BPS calculations (named to avoid collision with SDK's BPS_BASE) */
export const REVENUE_BPS_DENOMINATOR = 10_000;

/** Minimum subscription duration in seconds (1 day) */
export const MIN_SUBSCRIPTION_DURATION_SECS = 86_400;

/** Seconds in a 30-day month */
export const SECONDS_PER_MONTH = 30 * 86_400;

/** Seconds in a 365-day year */
export const SECONDS_PER_YEAR = 365 * 86_400;

/** Default free trial duration in seconds (7 days) */
export const DEFAULT_TRIAL_SECS = 7 * 86_400;

/** Maximum analytics events stored per skill before FIFO eviction */
export const MAX_ANALYTICS_ENTRIES_PER_SKILL = 10_000;

// ============================================================================
// Subscription Types
// ============================================================================

export type SubscriptionPeriod = 'monthly' | 'yearly';

export type SubscriptionStatus = 'trial' | 'active' | 'expired' | 'cancelled';

/**
 * Pricing configuration for a skill's subscription model.
 *
 * Note: `pricePerMonth` and `pricePerYear` are advisory/display values.
 * The actual payment amount for the initial subscription is determined
 * by the on-chain `SkillRegistration.price` via `purchase_skill`.
 * Renewals are runtime-only time extensions (no additional payment).
 */
export interface SubscriptionModel {
  readonly pricePerMonth: bigint;
  readonly pricePerYear?: bigint;
  readonly paymentMint?: PublicKey;
  readonly freeTier: boolean;
  readonly trialDays?: number;
}

/** Runtime-managed subscription state for a buyer–skill pair. */
export interface SubscriptionRecord {
  /** Deterministic key: `${skillId}` */
  readonly id: string;
  readonly skillId: string;
  /** Stored for `isPurchased()` fallback lookups */
  readonly skillPda: PublicKey;
  /** Base58 of buyer agent PDA */
  readonly subscriberAgent: string;
  readonly period: SubscriptionPeriod;
  status: SubscriptionStatus;
  readonly startedAt: number;
  expiresAt: number;
  renewalCount: number;
  lastPaymentTx?: string;
  pricePaid: bigint;
  cancelledAt?: number;
}

/** Input parameters for creating/renewing a subscription. */
export interface SubscribeParams {
  readonly skillId: string;
  readonly skillPda: PublicKey;
  readonly period: SubscriptionPeriod;
  readonly targetPath?: string;
}

/** Result of a subscribe operation. */
export interface SubscriptionResult {
  readonly subscriptionId: string;
  readonly status: SubscriptionStatus;
  readonly expiresAt: number;
  readonly pricePaid: bigint;
  readonly protocolFee: bigint;
  readonly transactionSignature?: string;
  readonly isRenewal: boolean;
}

// ============================================================================
// Revenue Sharing Types
// ============================================================================

export interface RevenueShareInput {
  readonly taskRewardLamports: bigint;
  readonly skillAuthor: string;
  readonly protocolTreasury: string;
  readonly developerBps?: number;
  readonly protocolBps?: number;
}

export interface RevenueShareResult {
  readonly taskRewardLamports: bigint;
  readonly developerShare: bigint;
  readonly protocolShare: bigint;
  readonly developerBps: number;
  readonly protocolBps: number;
  readonly skillAuthor: string;
  readonly protocolTreasury: string;
}

// ============================================================================
// Usage Analytics Types
// ============================================================================

export interface SkillUsageEvent {
  readonly skillId: string;
  readonly agentId: string;
  readonly action: string;
  readonly timestamp: number;
  readonly durationMs: number;
  readonly success: boolean;
  readonly errorCode?: string;
}

export interface SkillAnalytics {
  readonly totalInvocations: number;
  readonly successCount: number;
  readonly failureCount: number;
  readonly successRate: number;
  readonly uniqueAgents: number;
  readonly avgDurationMs: number;
  readonly firstUsedAt: number;
  readonly lastUsedAt: number;
  readonly revenueGenerated: bigint;
}

export interface AgentUsageSummary {
  readonly agentId: string;
  readonly invocations: number;
  readonly successCount: number;
  readonly failureCount: number;
  readonly lastUsedAt: number;
}

// ============================================================================
// Configuration
// ============================================================================

export interface SkillMonetizationConfig {
  readonly purchaseManager: SkillPurchaseManager;
  /** 32-byte buyer agent ID (same as SkillPurchaseConfig.agentId) */
  readonly agentId: Uint8Array;
  readonly logger?: Logger;
  /** Injectable clock for testability, defaults to Unix seconds */
  readonly clockFn?: () => number;
}
