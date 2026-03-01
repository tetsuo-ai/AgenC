/**
 * LLM Adapters for @agenc/runtime
 *
 * Provides LLM provider adapters that bridge language models
 * to the AgenC task execution system (Phase 4).
 *
 * @module
 */

// Core types
export type {
  LLMProvider,
  LLMProviderConfig,
  LLMContentPart,
  LLMMessage,
  LLMChatOptions,
  LLMChatStatefulOptions,
  LLMStatefulDiagnostics,
  LLMStatefulEvent,
  LLMStatefulEventType,
  LLMStatefulFallbackReason,
  LLMResponse,
  LLMStreamChunk,
  LLMTool,
  LLMToolCall,
  LLMUsage,
  MessageRole,
  StreamProgressCallback,
  ToolHandler,
} from "./types.js";
export { validateToolCall } from "./types.js";

// Error classes
export {
  LLMAuthenticationError,
  LLMMessageValidationError,
  LLMProviderError,
  LLMRateLimitError,
  LLMResponseConversionError,
  LLMServerError,
  LLMToolCallError,
  LLMTimeoutError,
  classifyLLMFailure,
  mapLLMError,
} from "./errors.js";

// Policy taxonomy (Phase 1)
export {
  DEFAULT_LLM_RETRY_POLICY_MATRIX,
  toPipelineStopReason,
} from "./policy.js";
export type {
  LLMFailureClass,
  LLMPipelineStopReason,
  LLMRetryPolicyRule,
  LLMRetryPolicyMatrix,
} from "./policy.js";

// Tool-turn protocol validation (Phase 1)
export {
  findToolTurnValidationIssue,
  validateToolTurnSequence,
} from "./tool-turn-validator.js";
export type {
  ToolTurnValidationCode,
  ToolTurnValidationIssue,
  ToolTurnValidationOptions,
} from "./tool-turn-validator.js";

// Prompt budgeting (Phase 2)
export {
  applyPromptBudget,
  derivePromptBudgetPlan,
} from "./prompt-budget.js";
export type {
  PromptBudgetConfig,
  PromptBudgetPlan,
  PromptBudgetCaps,
  PromptBudgetSection,
  PromptBudgetMessage,
  PromptBudgetDiagnostics,
  PromptBudgetSectionStats,
  PromptBudgetMemoryRole,
  PromptBudgetMemoryRoleContract,
  PromptBudgetMemoryRoleContracts,
} from "./prompt-budget.js";

// Response converter
export { responseToOutput } from "./response-converter.js";

// LLM Task Executor
export { LLMTaskExecutor, type LLMTaskExecutorConfig } from "./executor.js";
export { FallbackLLMProvider, type FallbackChainConfig } from "./fallback.js";

// Chat Executor (Phase 1.11)
export { ChatExecutor, ChatBudgetExceededError } from "./chat-executor.js";
export type {
  ChatExecutorConfig,
  ChatExecuteParams,
  ChatExecutorResult,
  ChatStatefulSummary,
  ChatPromptShape,
  ChatCallUsageRecord,
  ToolCallRecord,
  SkillInjector,
  MemoryRetriever,
} from "./chat-executor.js";

// Provider adapters
export { GrokProvider, type GrokProviderConfig } from "./grok/index.js";
export { OllamaProvider, type OllamaProviderConfig } from "./ollama/index.js";
