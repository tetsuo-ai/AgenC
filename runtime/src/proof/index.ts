/**
 * ZK Proof Engine for @agenc/runtime
 *
 * Provides proof generation with caching, verification,
 * and statistics tracking (Phase 7).
 *
 * @module
 */

// Core types
export type {
  ProofEngineConfig,
  ProofCacheConfig,
  RouterConfig,
  ProverBackend,
  ProverBackendConfig,
  ProofInputs,
  EngineProofResult,
  ProofEngineStats,
  HashResult,
  ToolsStatus,
} from "./types.js";

// Error classes
export {
  ProofGenerationError,
  ProofVerificationError,
  ProofCacheError,
} from "./errors.js";

// Cache
export { ProofCache, deriveCacheKey } from "./cache.js";

// Engine
export { ProofEngine, buildSdkProverConfig } from "./engine.js";
