/**
 * @agenc/runtime - AI Agent Runtime for AgenC Protocol
 *
 * Automated task execution with privacy-preserving proofs on Solana.
 *
 * @example
 * ```typescript
 * import { AgentRuntime, createRuntime, createAnthropicLLM, Capability } from '@agenc/runtime';
 *
 * const runtime = createRuntime({
 *   connection,
 *   wallet,
 *   programId,
 *   idl,
 *   agentId: Buffer.from('my-agent'.padEnd(32, '\0')),
 *   capabilities: Capability.COMPUTE | Capability.INFERENCE,
 *   llm: createAnthropicLLM({ apiKey: process.env.ANTHROPIC_API_KEY }),
 * });
 *
 * runtime.onTask(async (task) => {
 *   const result = await myAIModel.process(task.description);
 *   return { output: [1n, 2n, 3n, 4n] };
 * });
 *
 * runtime.on((event) => {
 *   console.log('Event:', event.type);
 * });
 *
 * await runtime.start();
 * ```
 */

// Main Runtime
export {
  AgentRuntime,
  createRuntime,
  createAnthropicLLM,
  createOllamaLLM,
  createGrokLLM,
  type RuntimeConfig,
  type RuntimeStatus,
} from './runtime';

// Legacy Agent class (for backwards compatibility)
export { Agent } from './agent';

// Agent Management
export {
  AgentManager,
  type AgentManagerConfig,
  type AgentRegistrationConfig,
} from './agent/manager';

// Event Monitoring
export {
  EventMonitor,
  type EventMonitorConfig,
  type EventFilter,
} from './events';

// Task Execution
export {
  TaskExecutor,
  type TaskExecutorConfig,
} from './task';

// Tool Registry
export {
  ToolRegistry,
  builtinTools,
  httpFetch,
  jsonParse,
  jsonStringify,
  base64Encode,
  base64Decode,
  computeHash,
  randomNumber,
  currentTime,
  sleep,
  type ToolRegistryConfig,
} from './tools';

// Memory Store
export {
  DefaultMemoryStore,
  InMemoryBackend,
  FileBackend,
  type MemoryStoreConfig,
  type FileBackendConfig,
} from './memory';

// Proof Engine
export {
  ProofEngine,
  createProofEngine,
  generateSalt,
  type ProofEngineConfig,
  type ProofRequest,
  type ProofOutput,
  type ProofStatus,
  type ToolsStatus,
} from './proof';

// Dispute Handler
export {
  DisputeHandler,
  createDisputeHandler,
  DisputeStatus,
  ResolutionType,
  type DisputeHandlerConfig,
  type Dispute,
  type VoteRecord,
  type DisputeStats,
} from './dispute';

// LLM Adapters
export {
  BaseLLMAdapter,
  AnthropicAdapter,
  OllamaAdapter,
  GrokAdapter,
} from './llm';

// Types - Config
export {
  Capability,
  AgentStatus,
  TaskType,
  TaskStatus,
  OperatingMode,
  type AgentRuntimeConfig,
  type AgentState,
} from './types/config';

// Types - Events
export type {
  EventType,
  EventHandler,
  EventHandlers,
  EventMap,
  AgentRegisteredEvent,
  AgentUpdatedEvent,
  AgentDeregisteredEvent,
  TaskCreatedEvent,
  TaskClaimedEvent,
  TaskCompletedEvent,
  TaskCancelledEvent,
  StateUpdatedEvent,
  DisputeInitiatedEvent,
  DisputeVoteCastEvent,
  DisputeResolvedEvent,
  DisputeExpiredEvent,
  ProtocolInitializedEvent,
  RewardDistributedEvent,
  RateLimitHitEvent,
  MigrationCompletedEvent,
  ProtocolVersionUpdatedEvent,
  RuntimeEventType,
  RuntimeEvent,
  RuntimeEventListener,
} from './types/events';

// Types - Task
export {
  ExecutorState,
  Evaluators,
  Evaluators as builtinEvaluators,
} from './types/task';

export type {
  OnChainTask,
  TaskClaim,
  TaskResult,
  TaskHandler,
  TaskEvaluator,
  TaskHistoryEntry,
} from './types/task';

// Types - LLM
export type {
  LLMAdapter,
  LLMResponse,
  Message,
  CompletionOptions,
  TokenUsage,
  BaseAdapterConfig,
  GrokConfig,
  AnthropicConfig,
  OllamaConfig,
} from './types/llm';

// Types - Tools
export type {
  Tool,
  ToolCall,
  ToolResult,
  MCPToolDefinition,
  SandboxConfig,
} from './types/tools';

// Types - Memory
export type {
  MemoryStore,
  MemoryBackend,
  MemoryStats,
  InMemoryBackendConfig,
  SqliteBackendConfig,
  RedisBackendConfig,
} from './types/memory';

// Version
export const VERSION = '1.0.0';

// Re-export legacy types for backwards compatibility
export {
  Capability as Capabilities,
} from './types/config';

// Legacy type aliases
export type {
  AgentRuntimeConfig as AgentConfig,
  AgentState as RuntimeOptions,
} from './types/config';

export type {
  RuntimeEvent as EventListener,
} from './types/events';
