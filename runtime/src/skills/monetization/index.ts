/**
 * Skill monetization — subscriptions, revenue sharing, and usage analytics.
 *
 * @module
 */

// Types and constants
export type {
  SubscriptionPeriod,
  SubscriptionStatus,
  SubscriptionModel,
  SubscriptionRecord,
  SubscribeParams,
  SubscriptionResult,
  RevenueShareInput,
  RevenueShareResult,
  SkillUsageEvent,
  SkillAnalytics,
  AgentUsageSummary,
  SkillMonetizationConfig,
} from "./types.js";

export {
  DEVELOPER_REVENUE_BPS,
  PROTOCOL_REVENUE_BPS,
  REVENUE_BPS_DENOMINATOR,
  MIN_SUBSCRIPTION_DURATION_SECS,
  SECONDS_PER_MONTH,
  SECONDS_PER_YEAR,
  DEFAULT_TRIAL_SECS,
  MAX_ANALYTICS_ENTRIES_PER_SKILL,
} from "./types.js";

// Error classes
export { SkillSubscriptionError, SkillRevenueError } from "./errors.js";

// Revenue sharing
export { computeRevenueShare } from "./revenue.js";

// Usage analytics
export { SkillUsageTracker } from "./analytics.js";

// Manager (orchestrator)
export { SkillMonetizationManager } from "./manager.js";
