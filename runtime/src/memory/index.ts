/**
 * Memory Backends for @agenc/runtime
 *
 * Provides pluggable memory storage for conversation history,
 * task context, and persistent key-value state (Phase 6).
 *
 * @module
 */

// Core types
export type {
  MemoryBackend,
  MemoryBackendConfig,
  MemoryEntry,
  MemoryRole,
  MemoryQuery,
  AddEntryOptions,
  DurabilityLevel,
  DurabilityInfo,
} from './types.js';

// LLM interop helpers + operational limits
export { entryToMessage, messageToEntryOptions, MEMORY_OPERATIONAL_LIMITS } from './types.js';

// Error classes
export {
  MemoryBackendError,
  MemoryConnectionError,
  MemorySerializationError,
  MemoryEncryptionError,
} from './errors.js';

// Encryption
export type { EncryptionConfig, EncryptionProvider } from './encryption.js';
export { createAES256GCMProvider } from './encryption.js';

// In-memory backend (zero deps)
export { InMemoryBackend, type InMemoryBackendConfig } from './in-memory/index.js';

// SQLite backend (optional better-sqlite3)
export { SqliteBackend, type SqliteBackendConfig } from './sqlite/index.js';

// Redis backend (optional ioredis)
export { RedisBackend, type RedisBackendConfig } from './redis/index.js';

// Provenance-aware graph layer
export {
  MemoryGraph,
  type ProvenanceSourceType,
  type ProvenanceSource,
  type MemoryEdgeType,
  type MemoryGraphNode,
  type MemoryGraphEdge,
  type UpsertMemoryNodeInput,
  type AddMemoryEdgeInput,
  type MemoryGraphQuery,
  type MemoryGraphResult,
  type MemoryGraphConfig,
  type CompactOptions,
} from './graph.js';

// Structured memory (daily logs, curated facts, entity extraction)
export {
  formatLogDate,
  DailyLogManager,
  CuratedMemoryManager,
  NoopEntityExtractor,
  type StructuredMemoryEntry,
  type EntityExtractor,
} from './structured.js';
