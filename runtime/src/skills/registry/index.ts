/**
 * On-chain skill registry client — public API surface.
 *
 * @module
 */

// Data types and interface
export type {
  SkillListing,
  SkillListingEntry,
  SkillRegistryClient,
  SkillRegistryClientConfig,
  SearchOptions,
} from './types.js';

// Error classes
export {
  SkillRegistryNotFoundError,
  SkillDownloadError,
  SkillVerificationError,
  SkillPublishError,
  SkillPurchaseError,
} from './errors.js';

// Payment flow
export type { SkillPurchaseConfig, PurchaseResult, OnChainPurchaseRecord } from './payment.js';
export { SkillPurchaseManager } from './payment.js';

// Client implementation and constants
export {
  OnChainSkillRegistryClient,
  SKILL_REGISTRY_PROGRAM_ID,
} from './client.js';
