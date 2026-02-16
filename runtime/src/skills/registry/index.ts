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
} from './errors.js';

// Client implementation and constants
export {
  OnChainSkillRegistryClient,
  SKILL_REGISTRY_PROGRAM_ID,
} from './client.js';
