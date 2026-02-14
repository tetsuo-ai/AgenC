/**
 * Skill library system for @agenc/runtime
 *
 * Provides a pluggable skill abstraction for packaging reusable
 * blockchain operations (swaps, transfers, staking) as composable units.
 *
 * @module
 */

// Core types
export {
  // Plugin catalog
  type Skill,
  type SkillMetadata,
  type SkillAction,
  type SkillContext,
  type SemanticVersion,
  type SkillRegistryConfig,
  SkillState,
} from './types.js';

export {
  PluginCatalog,
  PluginCatalogError,
  type CatalogEntry,
  type CatalogOperationResult,
  type CatalogState,
  type PluginPrecedence,
  type PluginSlot,
  type SlotCollision,
} from './catalog.js';

// Error types
export {
  SkillNotFoundError,
  SkillNotReadyError,
  SkillActionNotFoundError,
  SkillInitializationError,
  SkillAlreadyRegisteredError,
} from './errors.js';

// Plugin manifests and governance
export {
  type PluginManifest,
  type PluginPermission,
  type PluginAllowDeny,
  type PluginsConfig,
  type ManifestValidationError,
  PluginManifestError,
  validatePluginManifest,
  validatePluginsConfig,
  getPluginConfigHints,
} from './manifest.js';

// Registry
export { SkillRegistry } from './registry.js';

// Jupiter skill
export {
  JupiterSkill,
  JupiterClient,
  JupiterApiError,
  type JupiterClientConfig,
  type JupiterSkillConfig,
  type SwapQuoteParams,
  type SwapQuote,
  type SwapResult,
  type TokenBalance,
  type TransferSolParams,
  type TransferTokenParams,
  type TransferResult,
  type TokenPrice,
  type TokenMint,
  JUPITER_API_BASE_URL,
  JUPITER_PRICE_API_URL,
  WSOL_MINT,
  USDC_MINT,
  USDT_MINT,
  WELL_KNOWN_TOKENS,
} from './jupiter/index.js';
