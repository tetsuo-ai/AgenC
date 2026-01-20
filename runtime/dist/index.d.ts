import { PublicKey, Connection, Keypair } from '@solana/web3.js';
import { Program } from '@coral-xyz/anchor';

/**
 * Tool type definitions for @agenc/runtime
 *
 * MCP-compatible tool system for agent actions.
 */
/**
 * JSON Schema property type
 */
interface JSONSchemaProperty {
    type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
    description?: string;
    enum?: (string | number)[];
    items?: JSONSchemaProperty;
    properties?: Record<string, JSONSchemaProperty>;
    required?: string[];
    default?: unknown;
    minimum?: number;
    maximum?: number;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
}
/**
 * JSON Schema for tool input
 */
interface JSONSchema {
    type: 'object';
    properties: Record<string, JSONSchemaProperty>;
    required?: string[];
    additionalProperties?: boolean;
}
/**
 * Validation result
 */
interface ValidationResult {
    valid: boolean;
    error?: string;
}
/**
 * Tool execution result with call ID (returned by ToolRegistry)
 */
interface ToolResult {
    /** Tool call ID (matches the ToolCall.id) */
    toolCallId: string;
    /** Whether execution succeeded */
    success: boolean;
    /** Output data */
    output?: unknown;
    /** Error message if failed */
    error?: string;
    /** Additional metadata */
    metadata?: Record<string, unknown>;
}
/**
 * Tool call from LLM
 */
interface ToolCall {
    /** Unique ID for this call */
    id: string;
    /** Tool name */
    name: string;
    /** Input arguments */
    input: unknown;
}
/**
 * Tool definition (MCP-compatible)
 */
interface Tool {
    /** Tool name (unique identifier) */
    name: string;
    /** Human-readable description */
    description: string;
    /** Input schema */
    inputSchema: JSONSchema;
    /** Execute the tool - returns the output directly, or throws on error */
    execute(input: unknown): Promise<unknown>;
    /** Optional validation before execution */
    validate?(input: unknown): ValidationResult;
    /** Execution timeout in ms */
    timeout?: number;
    /** Requires human approval before execution */
    requiresApproval?: boolean;
    /** Tool category for organization */
    category?: string;
}
/**
 * MCP tool definition format (for LLM)
 */
interface MCPToolDefinition {
    name: string;
    description: string;
    input_schema: {
        type: 'object';
        properties: Record<string, JSONSchemaProperty>;
        required?: string[];
    };
}
/**
 * Tool sandbox configuration
 */
interface SandboxConfig {
    /** Enable sandboxing */
    enabled: boolean;
    /** Allowed file paths (for file operations) */
    allowedPaths?: string[];
    /** Allowed URLs (for network operations) */
    allowedUrls?: string[];
    /** Allowed shell commands */
    allowedCommands?: string[];
    /** Maximum execution time in ms */
    maxExecutionTime?: number;
    /** Maximum memory usage in bytes */
    maxMemory?: number;
    /** Disable network access */
    disableNetwork?: boolean;
    /** Disable file system access */
    disableFileSystem?: boolean;
}

/**
 * LLM adapter type definitions for @agenc/runtime
 */

/**
 * LLM configuration for different providers
 */
type LLMConfig = {
    provider: 'grok';
    apiKey: string;
    model?: string;
    baseUrl?: string;
} | {
    provider: 'anthropic';
    apiKey: string;
    model?: string;
    baseUrl?: string;
} | {
    provider: 'ollama';
    baseUrl?: string;
    model: string;
} | {
    provider: 'openai';
    apiKey: string;
    model?: string;
    baseUrl?: string;
};
/**
 * Message role
 */
type MessageRole = 'system' | 'user' | 'assistant' | 'tool';
/**
 * Chat message
 */
interface Message {
    role: MessageRole;
    content: string;
    /** Tool call ID (for tool responses) */
    toolCallId?: string;
    /** Tool calls made by assistant */
    toolCalls?: ToolCall[];
    /** Name for tool messages */
    name?: string;
}
/**
 * Completion options
 */
interface CompletionOptions {
    /** Temperature (0-2, default 0.7) */
    temperature?: number;
    /** Maximum tokens to generate */
    maxTokens?: number;
    /** Stop sequences */
    stopSequences?: string[];
    /** Available tools */
    tools?: Tool[];
    /** Tool choice strategy */
    toolChoice?: 'auto' | 'required' | 'none' | {
        name: string;
    };
    /** Response format */
    responseFormat?: 'text' | 'json';
    /** Top-p sampling */
    topP?: number;
    /** Frequency penalty */
    frequencyPenalty?: number;
    /** Presence penalty */
    presencePenalty?: number;
}
/**
 * Token usage information
 */
interface TokenUsage {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
}
/**
 * LLM completion response
 */
interface LLMResponse {
    /** Response content */
    content: string;
    /** Tool calls requested by the model */
    toolCalls?: ToolCall[];
    /** Finish reason */
    finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter';
    /** Token usage */
    usage: TokenUsage;
    /** Model used */
    model: string;
}
/**
 * LLM adapter interface
 */
interface LLMAdapter {
    /**
     * Generate a completion
     */
    complete(prompt: string, options?: CompletionOptions): Promise<string>;
    /**
     * Generate a streaming completion
     */
    stream(prompt: string, options?: CompletionOptions): AsyncIterable<string>;
    /**
     * Generate a completion with tool support
     */
    completeWithTools(prompt: string, tools: Tool[], options?: CompletionOptions): Promise<LLMResponse>;
    /**
     * Set the system prompt
     */
    setSystemPrompt(prompt: string): void;
    /**
     * Add a message to the conversation
     */
    addMessage(message: Message): void;
    /**
     * Get all messages in the conversation
     */
    getMessages(): Message[];
    /**
     * Clear the conversation history
     */
    clearContext(): void;
    /**
     * Count tokens in text
     */
    countTokens(text: string): number;
    /**
     * Get the context window size
     */
    getContextWindow(): number;
    /**
     * Get the model name
     */
    getModel(): string;
}
/**
 * Base adapter configuration
 */
interface BaseAdapterConfig {
    /** API key */
    apiKey?: string;
    /** Model name */
    model?: string;
    /** Base URL */
    baseUrl?: string;
    /** Default temperature */
    defaultTemperature?: number;
    /** Default max tokens */
    defaultMaxTokens?: number;
    /** Request timeout in ms */
    timeout?: number;
    /** Maximum retries */
    maxRetries?: number;
}
/**
 * Grok-specific configuration
 */
interface GrokConfig extends BaseAdapterConfig {
    apiKey: string;
    model?: 'grok-2' | 'grok-2-mini' | 'grok-beta';
    baseUrl?: string;
}
/**
 * Anthropic-specific configuration
 */
interface AnthropicConfig extends BaseAdapterConfig {
    apiKey: string;
    model?: 'claude-opus-4-5-20251101' | 'claude-sonnet-4-20250514' | 'claude-3-5-sonnet-20241022' | 'claude-3-5-haiku-20241022';
    baseUrl?: string;
    anthropicVersion?: string;
}
/**
 * Ollama-specific configuration
 */
interface OllamaConfig extends BaseAdapterConfig {
    model: string;
    baseUrl?: string;
}

/**
 * Task type definitions for @agenc/runtime
 */

/**
 * On-chain task representation
 */
interface OnChainTask$1 {
    /** Task PDA address */
    address: PublicKey;
    /** Task unique identifier */
    taskId: Buffer;
    /** Task creator */
    creator: PublicKey;
    /** Required capabilities bitmask */
    requiredCapabilities: bigint;
    /** Task description (64 bytes) */
    description: Buffer;
    /** Constraint hash for private tasks */
    constraintHash: Buffer | null;
    /** Reward amount in lamports */
    rewardAmount: bigint;
    /** Maximum workers allowed */
    maxWorkers: number;
    /** Current worker count */
    currentWorkers: number;
    /** Task status */
    status: TaskStatus$1;
    /** Task type */
    taskType: TaskType$1;
    /** Creation timestamp */
    createdAt: number;
    /** Deadline timestamp (0 = no deadline) */
    deadline: number;
    /** Completion timestamp */
    completedAt: number;
    /** Escrow PDA */
    escrow: PublicKey;
    /** Result data (64 bytes) */
    result: Buffer;
    /** Number of completions */
    completions: number;
    /** Required completions */
    requiredCompletions: number;
}
/**
 * Task claim on-chain representation
 */
interface TaskClaim {
    /** Claim PDA address */
    address: PublicKey;
    /** Task being claimed */
    task: PublicKey;
    /** Worker agent PDA */
    worker: PublicKey;
    /** Claim timestamp */
    claimedAt: number;
    /** Expiration timestamp */
    expiresAt: number;
    /** Completion timestamp */
    completedAt: number;
    /** Proof hash */
    proofHash: Buffer;
    /** Result data */
    resultData: Buffer;
    /** Is completed */
    isCompleted: boolean;
    /** Is validated */
    isValidated: boolean;
    /** Reward paid */
    rewardPaid: bigint;
}
/**
 * Task execution result
 */
interface TaskResult$1 {
    /** Output values (for ZK proof) */
    output: bigint[];
    /** Salt for commitment (auto-generated if not provided) */
    salt?: bigint;
    /** Result data (max 64 bytes, for public tasks) */
    resultData?: Buffer;
    /** Execution metadata */
    metadata?: {
        /** Number of LLM iterations */
        iterations?: number;
        /** Total tokens used */
        tokensUsed?: number;
        /** Execution time in ms */
        executionTime?: number;
        /** Tools used */
        toolsUsed?: string[];
        /** Confidence score (0-1) */
        confidence?: number;
    };
}
/**
 * Task handler function signature
 */
type TaskHandler$1 = (task: OnChainTask$1, context: TaskExecutionContext) => Promise<TaskResult$1>;
/**
 * Context provided to task handlers
 */
interface TaskExecutionContext {
    /** Agent state */
    agent: AgentState$1;
    /** Claim information */
    claim: TaskClaim;
    /** Runtime logger */
    log: {
        debug(message: string, ...args: unknown[]): void;
        info(message: string, ...args: unknown[]): void;
        warn(message: string, ...args: unknown[]): void;
        error(message: string, ...args: unknown[]): void;
    };
    /** Abort signal for cancellation */
    signal: AbortSignal;
}
/**
 * Task evaluator interface for custom task selection logic
 */
interface TaskEvaluator {
    /**
     * Evaluate a task and return a score.
     * Higher scores = more desirable tasks.
     * Return null to skip the task entirely.
     */
    evaluate(task: OnChainTask$1, context: EvaluationContext): Promise<number | null>;
}
/**
 * Context for task evaluation
 */
interface EvaluationContext {
    /** Current agent state */
    agent: AgentState$1;
    /** Recently completed tasks */
    recentTasks: TaskHistoryEntry[];
    /** Current timestamp */
    timestamp: number;
    /** Agent's active task count */
    activeTaskCount: number;
    /** Rate limit budget */
    rateLimitBudget: {
        tasksRemaining: number;
        cooldownEnds: number;
    };
}
/**
 * Task history entry for memory
 */
interface TaskHistoryEntry {
    /** Task ID */
    taskId: Buffer;
    /** Task address */
    taskAddress: PublicKey;
    /** Result */
    result: TaskResult$1;
    /** Reward received */
    rewardReceived: bigint;
    /** Completion timestamp */
    completedAt: number;
    /** Transaction signature */
    txSignature: string;
}
/**
 * Task filter for discovery
 */
interface TaskFilter {
    /** Minimum reward amount */
    minReward?: bigint;
    /** Maximum reward amount */
    maxReward?: bigint;
    /** Required task types */
    taskTypes?: TaskType$1[];
    /** Required capabilities (agent must have these) */
    requiredCapabilities?: bigint;
    /** Maximum deadline (unix timestamp) */
    maxDeadline?: number;
    /** Minimum deadline (unix timestamp) */
    minDeadline?: number;
    /** Only private tasks */
    privateOnly?: boolean;
    /** Only public tasks */
    publicOnly?: boolean;
    /** Custom filter function */
    custom?: (task: OnChainTask$1) => boolean;
}
/**
 * Task executor state machine states
 */
declare enum ExecutorState {
    Idle = "idle",
    Discovering = "discovering",
    Evaluating = "evaluating",
    Claiming = "claiming",
    Executing = "executing",
    Proving = "proving",
    Submitting = "submitting",
    Error = "error"
}
/**
 * Built-in task evaluators
 */
declare const Evaluators: {
    /**
     * Maximize reward amount
     */
    rewardMaximizer: TaskEvaluator;
    /**
     * Prefer urgent tasks (close to deadline)
     */
    urgencyEvaluator: TaskEvaluator;
    /**
     * Balanced evaluator considering reward and urgency
     */
    balanced: TaskEvaluator;
    /**
     * Accept all tasks (no filtering)
     */
    acceptAll: TaskEvaluator;
};

/**
 * Memory store type definitions for @agenc/runtime
 */

/**
 * Memory store interface
 */
interface MemoryStore {
    /**
     * Add a message to conversation history
     */
    addMessage(message: Message): Promise<void>;
    /**
     * Get recent messages
     */
    getMessages(limit?: number): Promise<Message[]>;
    /**
     * Summarize the conversation history
     */
    summarize(): Promise<string>;
    /**
     * Clear conversation history
     */
    clearConversation(): Promise<void>;
    /**
     * Set the current task being worked on
     */
    setCurrentTask(task: OnChainTask$1 | null): Promise<void>;
    /**
     * Get the current task
     */
    getCurrentTask(): Promise<OnChainTask$1 | null>;
    /**
     * Add a completed task to history
     */
    addTaskResult(taskId: Buffer, taskAddress: PublicKey, result: TaskResult$1, txSignature: string, rewardReceived: bigint): Promise<void>;
    /**
     * Get task history
     */
    getTaskHistory(limit?: number): Promise<TaskHistoryEntry[]>;
    /**
     * Get a specific task result
     */
    getTaskResult(taskId: Buffer): Promise<TaskHistoryEntry | null>;
    /**
     * Set a value in namespaced storage
     */
    set(namespace: string, key: string, value: unknown): Promise<void>;
    /**
     * Get a value from namespaced storage
     */
    get<T>(namespace: string, key: string): Promise<T | null>;
    /**
     * Delete a value from namespaced storage
     */
    delete(namespace: string, key: string): Promise<void>;
    /**
     * List all keys in a namespace
     */
    keys(namespace: string): Promise<string[]>;
    /**
     * Save state to persistent storage
     */
    save(): Promise<void>;
    /**
     * Load state from persistent storage
     */
    load(): Promise<void>;
    /**
     * Clear all data
     */
    clear(): Promise<void>;
}
/**
 * Memory backend interface (for pluggable storage)
 */
interface MemoryBackend {
    addMessage(message: Message): Promise<void>;
    getMessages(limit?: number): Promise<Message[]>;
    clearConversation(): Promise<void>;
    setCurrentTask(task: OnChainTask$1 | null): Promise<void>;
    getCurrentTask(): Promise<OnChainTask$1 | null>;
    addTaskResult(entry: TaskHistoryEntry): Promise<void>;
    getTaskHistory(limit?: number): Promise<TaskHistoryEntry[]>;
    getTaskResult(taskId: Buffer): Promise<TaskHistoryEntry | null>;
    set(namespace: string, key: string, value: unknown): Promise<void>;
    get<T>(namespace: string, key: string): Promise<T | null>;
    delete(namespace: string, key: string): Promise<void>;
    keys(namespace: string): Promise<string[]>;
    save(): Promise<void>;
    load(): Promise<void>;
    clear(): Promise<void>;
}
/**
 * In-memory backend configuration
 */
interface InMemoryBackendConfig {
    /** Maximum messages to keep */
    maxMessages?: number;
    /** Maximum task history entries */
    maxTaskHistory?: number;
}
/**
 * SQLite backend configuration
 */
interface SqliteBackendConfig {
    /** Database file path */
    path: string;
    /** Maximum messages to keep */
    maxMessages?: number;
    /** Maximum task history entries */
    maxTaskHistory?: number;
}
/**
 * Redis backend configuration
 */
interface RedisBackendConfig {
    /** Redis URL */
    url: string;
    /** Key prefix */
    prefix?: string;
    /** Maximum messages to keep */
    maxMessages?: number;
    /** Maximum task history entries */
    maxTaskHistory?: number;
    /** TTL for conversation messages in seconds */
    conversationTtl?: number;
}
/**
 * Memory statistics
 */
interface MemoryStats {
    /** Number of messages in conversation */
    messageCount: number;
    /** Estimated token count */
    tokenCount: number;
    /** Number of task history entries */
    taskHistoryCount: number;
    /** Total size in bytes (approximate) */
    sizeBytes: number;
}

/**
 * Event type definitions for @agenc/runtime
 *
 * Matches the 17 events defined in programs/agenc-coordination/src/events.rs
 */

/**
 * All supported event types
 */
type EventType = 'agentRegistered' | 'agentUpdated' | 'agentDeregistered' | 'taskCreated' | 'taskClaimed' | 'taskCompleted' | 'taskCancelled' | 'stateUpdated' | 'disputeInitiated' | 'disputeVoteCast' | 'disputeResolved' | 'disputeExpired' | 'protocolInitialized' | 'rewardDistributed' | 'rateLimitHit' | 'migrationCompleted' | 'protocolVersionUpdated';
interface AgentRegisteredEvent {
    agentId: Buffer;
    authority: PublicKey;
    capabilities: bigint;
    endpoint: string;
    stake: bigint;
    timestamp: number;
}
interface AgentUpdatedEvent {
    agentId: Buffer;
    capabilities: bigint;
    status: number;
    endpoint: string;
    timestamp: number;
}
interface AgentDeregisteredEvent {
    agentId: Buffer;
    authority: PublicKey;
    stakeReturned: bigint;
    timestamp: number;
}
interface TaskCreatedEvent {
    taskId: Buffer;
    creator: PublicKey;
    requiredCapabilities: bigint;
    rewardAmount: bigint;
    taskType: number;
    deadline: number;
    timestamp: number;
}
interface TaskClaimedEvent {
    taskId: Buffer;
    worker: PublicKey;
    currentWorkers: number;
    maxWorkers: number;
    timestamp: number;
}
interface TaskCompletedEvent {
    taskId: Buffer;
    worker: PublicKey;
    proofHash: Buffer;
    rewardPaid: bigint;
    timestamp: number;
}
interface TaskCancelledEvent {
    taskId: Buffer;
    creator: PublicKey;
    refundAmount: bigint;
    timestamp: number;
}
interface StateUpdatedEvent {
    stateKey: Buffer;
    updater: PublicKey;
    version: bigint;
    timestamp: number;
}
interface DisputeInitiatedEvent {
    disputeId: Buffer;
    taskId: Buffer;
    initiator: PublicKey;
    resolutionType: number;
    votingDeadline: number;
    timestamp: number;
}
interface DisputeVoteCastEvent {
    disputeId: Buffer;
    voter: PublicKey;
    approved: boolean;
    votesFor: bigint;
    votesAgainst: bigint;
    timestamp: number;
}
interface DisputeResolvedEvent {
    disputeId: Buffer;
    taskId: Buffer;
    resolutionType: number;
    votesFor: bigint;
    votesAgainst: bigint;
    timestamp: number;
}
interface DisputeExpiredEvent {
    disputeId: Buffer;
    taskId: Buffer;
    refundAmount: bigint;
    timestamp: number;
}
interface ProtocolInitializedEvent {
    authority: PublicKey;
    treasury: PublicKey;
    disputeThreshold: number;
    protocolFeeBps: number;
    timestamp: number;
}
interface RewardDistributedEvent {
    taskId: Buffer;
    recipient: PublicKey;
    amount: bigint;
    protocolFee: bigint;
    timestamp: number;
}
interface RateLimitHitEvent {
    agentId: Buffer;
    actionType: number;
    limitType: number;
    currentCount: number;
    maxCount: number;
    cooldownRemaining: number;
    timestamp: number;
}
interface MigrationCompletedEvent {
    fromVersion: number;
    toVersion: number;
    accountsMigrated: number;
    timestamp: number;
}
interface ProtocolVersionUpdatedEvent {
    oldVersion: number;
    newVersion: number;
    timestamp: number;
}
interface EventMap {
    agentRegistered: AgentRegisteredEvent;
    agentUpdated: AgentUpdatedEvent;
    agentDeregistered: AgentDeregisteredEvent;
    taskCreated: TaskCreatedEvent;
    taskClaimed: TaskClaimedEvent;
    taskCompleted: TaskCompletedEvent;
    taskCancelled: TaskCancelledEvent;
    stateUpdated: StateUpdatedEvent;
    disputeInitiated: DisputeInitiatedEvent;
    disputeVoteCast: DisputeVoteCastEvent;
    disputeResolved: DisputeResolvedEvent;
    disputeExpired: DisputeExpiredEvent;
    protocolInitialized: ProtocolInitializedEvent;
    rewardDistributed: RewardDistributedEvent;
    rateLimitHit: RateLimitHitEvent;
    migrationCompleted: MigrationCompletedEvent;
    protocolVersionUpdated: ProtocolVersionUpdatedEvent;
}
/**
 * Event handler function type
 */
type EventHandler<T extends EventType> = (event: EventMap[T]) => void | Promise<void>;
/**
 * All event handlers
 */
type EventHandlers = {
    [K in EventType]?: EventHandler<K>;
};
/**
 * Runtime-specific events (not on-chain)
 */
type RuntimeEventType = 'started' | 'stopped' | 'taskFound' | 'taskClaimed' | 'taskExecuting' | 'taskCompleted' | 'taskFailed' | 'error' | 'reconnecting' | 'reconnected';
interface RuntimeStartedEvent {
    type: 'started';
    agentId: Buffer;
    mode: string;
    timestamp: number;
}
interface RuntimeStoppedEvent {
    type: 'stopped';
    agentId: Buffer;
    completedCount: number;
    failedCount: number;
    timestamp: number;
}
interface RuntimeTaskFoundEvent {
    type: 'taskFound';
    taskId: Buffer;
    rewardAmount: bigint;
    deadline: number;
}
interface RuntimeTaskClaimedEvent {
    type: 'taskClaimed';
    taskId: Buffer;
    claimPda: PublicKey;
}
interface RuntimeTaskExecutingEvent {
    type: 'taskExecuting';
    taskId: Buffer;
    startedAt: number;
}
interface RuntimeTaskCompletedEvent {
    type: 'taskCompleted';
    taskId: Buffer;
    txSignature: string;
    rewardPaid: bigint;
}
interface RuntimeTaskFailedEvent {
    type: 'taskFailed';
    taskId: Buffer;
    error: Error;
}
interface RuntimeErrorEvent {
    type: 'error';
    error: Error;
    context?: string;
}
interface RuntimeReconnectingEvent {
    type: 'reconnecting';
    attempt: number;
    maxAttempts: number;
}
interface RuntimeReconnectedEvent {
    type: 'reconnected';
    attempt: number;
}
type RuntimeEvent$1 = RuntimeStartedEvent | RuntimeStoppedEvent | RuntimeTaskFoundEvent | RuntimeTaskClaimedEvent | RuntimeTaskExecutingEvent | RuntimeTaskCompletedEvent | RuntimeTaskFailedEvent | RuntimeErrorEvent | RuntimeReconnectingEvent | RuntimeReconnectedEvent;
type RuntimeEventListener = (event: RuntimeEvent$1) => void;

/**
 * Configuration types for @agenc/runtime
 */

/**
 * Agent capability flags (matches on-chain constants)
 */
declare const Capability: {
    readonly COMPUTE: bigint;
    readonly INFERENCE: bigint;
    readonly STORAGE: bigint;
    readonly NETWORK: bigint;
    readonly SENSOR: bigint;
    readonly ACTUATOR: bigint;
    readonly COORDINATOR: bigint;
    readonly ARBITER: bigint;
    readonly VALIDATOR: bigint;
    readonly AGGREGATOR: bigint;
};
/**
 * Agent status (matches on-chain enum)
 */
declare enum AgentStatus {
    Inactive = 0,
    Active = 1,
    Busy = 2,
    Suspended = 3
}
/**
 * Task type (matches on-chain enum)
 */
declare enum TaskType$1 {
    Exclusive = 0,
    Collaborative = 1,
    Competitive = 2
}
/**
 * Task status (matches on-chain enum)
 */
declare enum TaskStatus$1 {
    Open = 0,
    InProgress = 1,
    PendingValidation = 2,
    Completed = 3,
    Cancelled = 4,
    Disputed = 5
}
/**
 * Operating mode for the runtime
 */
type OperatingMode = 'autonomous' | 'assisted' | 'human-in-the-loop' | 'supervised' | 'batch';
/**
 * Approval callback for human-in-the-loop mode
 */
interface Proposal {
    type: 'claim_task' | 'submit_completion' | 'tool_execution' | 'dispute_initiation';
    reasoning: string;
    details: unknown;
}
type ApprovalCallback = (proposal: Proposal) => Promise<boolean>;
/**
 * Logger interface
 */
interface Logger {
    debug(message: string, ...args: unknown[]): void;
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
}
/**
 * Complete runtime configuration
 */
interface AgentRuntimeConfig {
    /** Solana RPC connection */
    connection: Connection;
    /** Agent wallet keypair */
    wallet: Keypair;
    /** Anchor program instance */
    program: Program;
    /** Agent capabilities bitmask */
    capabilities: bigint;
    /** Unique 32-byte agent identifier */
    agentId?: Buffer;
    /** Network endpoint for agent communication */
    endpoint?: string;
    /** IPFS/Arweave URI for extended metadata */
    metadataUri?: string;
    /** Initial stake amount in lamports */
    initialStake?: bigint;
    /** LLM provider configuration or custom adapter */
    llm?: LLMConfig | LLMAdapter;
    /** Custom task evaluator */
    taskEvaluator?: TaskEvaluator;
    /** Task types to accept */
    acceptedTaskTypes?: TaskType$1[];
    /** Maximum reward to accept (lamports) */
    maxTaskReward?: bigint;
    /** Minimum reward to accept (lamports) */
    minTaskReward?: bigint;
    /** Task execution timeout in ms */
    taskTimeout?: number;
    /** Maximum concurrent tasks */
    maxConcurrentTasks?: number;
    /** Task polling interval in ms */
    pollIntervalMs?: number;
    /** Operating mode */
    mode?: OperatingMode;
    /** Approval callback for human-in-the-loop mode */
    approvalCallback?: ApprovalCallback;
    /** Memory store backend */
    memoryBackend?: MemoryBackend;
    /** Maximum conversation history tokens */
    maxContextTokens?: number;
    /** Additional custom tools */
    customTools?: Tool[];
    /** Disable built-in tools */
    disableBuiltinTools?: boolean;
    /** Tool sandbox mode */
    sandboxTools?: boolean;
    /** Circuit path for ZK proofs */
    circuitPath?: string;
    /** Hash helper circuit path */
    hashHelperPath?: string;
    /** Enable Privacy Cash integration */
    enablePrivacyCash?: boolean;
    /** Custom event handlers */
    eventHandlers?: Partial<EventHandlers>;
    /** WebSocket RPC URL (if different from HTTP) */
    wsRpcUrl?: string;
    /** Retry attempts for failed operations */
    retryAttempts?: number;
    /** Base delay for exponential backoff in ms */
    retryBaseDelayMs?: number;
    /** Log level */
    logLevel?: 'debug' | 'info' | 'warn' | 'error';
    /** Custom logger */
    logger?: Logger;
}
/**
 * Agent on-chain state
 */
interface AgentState$1 {
    /** Agent PDA address */
    pda: PublicKey;
    /** Agent ID */
    agentId: Buffer;
    /** Authority pubkey */
    authority: PublicKey;
    /** Capability bitmask */
    capabilities: bigint;
    /** Current status */
    status: AgentStatus;
    /** Endpoint URL */
    endpoint: string;
    /** Metadata URI */
    metadataUri: string;
    /** Registration timestamp */
    registeredAt: number;
    /** Last activity timestamp */
    lastActive: number;
    /** Total tasks completed */
    tasksCompleted: number;
    /** Total rewards earned */
    totalEarned: bigint;
    /** Reputation score (0-10000) */
    reputation: number;
    /** Active task count */
    activeTasks: number;
    /** Staked amount */
    stake: bigint;
    /** Is registered on-chain */
    registered: boolean;
    /** Last task creation timestamp */
    lastTaskCreated: number;
    /** Last dispute initiation timestamp */
    lastDisputeInitiated: number;
    /** Tasks created in current 24h window */
    taskCount24h: number;
    /** Disputes initiated in current 24h window */
    disputeCount24h: number;
    /** Rate limit window start */
    rateLimitWindowStart: number;
}

/**
 * AgentManager - Manages agent on-chain identity and lifecycle
 */

/**
 * Agent registration configuration
 */
interface AgentRegistrationConfig {
    /** Unique agent ID (auto-generated if not provided) */
    agentId?: Buffer;
    /** Capability bitmask */
    capabilities: bigint;
    /** Endpoint URL */
    endpoint?: string;
    /** Metadata URI */
    metadataUri?: string;
    /** Initial stake in lamports */
    initialStake?: bigint;
}
/**
 * AgentManager constructor configuration
 */
interface AgentManagerConfig {
    /** Solana connection */
    connection: Connection;
    /** Agent's keypair */
    wallet: Keypair;
    /** Program instance */
    program: Program;
    /** Agent ID (32 bytes) */
    agentId: Buffer;
    /** Optional logger */
    logger?: Logger;
}
/**
 * AgentManager handles agent registration, status, and stake management
 */
declare class AgentManager {
    private connection;
    private wallet;
    private program;
    private agentId;
    private logger;
    private state;
    private protocolPda;
    private agentPda;
    private protocolConfig;
    constructor(config: AgentManagerConfig);
    /**
     * Get the agent ID
     */
    getAgentId(): Buffer;
    /**
     * Get the agent PDA
     */
    getAgentPda(): PublicKey;
    /**
     * Get current agent state
     */
    getState(): AgentState$1 | null;
    /**
     * Check if agent is registered
     */
    isRegistered(): boolean;
    /**
     * Register agent on-chain
     */
    register(config: AgentRegistrationConfig): Promise<AgentState$1>;
    /**
     * Deregister agent from protocol
     */
    deregister(): Promise<bigint>;
    /**
     * Update agent status
     */
    updateStatus(status: AgentStatus): Promise<void>;
    /**
     * Update agent capabilities
     */
    updateCapabilities(capabilities: bigint): Promise<void>;
    /**
     * Update agent endpoint
     */
    updateEndpoint(endpoint: string): Promise<void>;
    /**
     * Refresh agent state from on-chain
     */
    refresh(): Promise<AgentState$1>;
    /**
     * Check if agent is rate limited for task creation
     */
    isRateLimited(): boolean;
    /**
     * Get rate limit budget
     */
    getRateLimitBudget(): {
        tasksRemaining: number;
        cooldownEnds: number;
    };
    /**
     * Load protocol configuration
     */
    loadProtocolConfig(): Promise<void>;
    /**
     * Get agent's reputation score
     */
    getReputation(): number;
    /**
     * Get agent PDA
     */
    getPda(): PublicKey | null;
    /**
     * Fetch and parse agent account
     */
    private fetchAgentAccount;
}

/**
 * EventMonitor - Real-time subscription to AgenC protocol events
 *
 * Subscribes to all 17 protocol events via WebSocket and dispatches
 * to registered handlers.
 */

/**
 * Event filter configuration
 */
interface EventFilter {
    /** Only events for specific task IDs */
    taskIds?: Buffer[];
    /** Only events for specific agent IDs */
    agentIds?: Buffer[];
    /** Only specific event types */
    eventTypes?: EventType[];
}
/**
 * EventMonitor configuration
 */
interface EventMonitorConfig {
    /** Solana connection */
    connection: Connection;
    /** Program ID to monitor */
    programId: PublicKey;
    /** Program IDL for event parsing (optional) */
    idl?: object;
    /** Optional logger */
    logger?: Logger;
    /** Maximum reconnection attempts */
    maxReconnectAttempts?: number;
    /** Reconnection delay in ms */
    reconnectDelayMs?: number;
}
/**
 * EventMonitor handles WebSocket subscriptions to protocol events
 */
declare class EventMonitor {
    private connection;
    private programId;
    private logger;
    private handlers;
    private subscriptionId;
    private eventParser;
    private filter;
    private reconnectAttempts;
    private maxReconnectAttempts;
    private reconnectDelayMs;
    private isConnected;
    constructor(config: EventMonitorConfig);
    /**
     * Start listening for events
     */
    connect(): Promise<void>;
    /**
     * Stop listening for events
     */
    disconnect(): Promise<void>;
    /**
     * Register an event handler
     */
    on<T extends EventType>(event: T, handler: EventHandler<T>): () => void;
    /**
     * Unregister an event handler
     */
    off<T extends EventType>(event: T, handler: EventHandler<T>): void;
    /**
     * Register a one-time event handler
     */
    once<T extends EventType>(event: T, handler: EventHandler<T>): void;
    /**
     * Register multiple handlers at once
     */
    registerHandlers(handlers: Partial<EventHandlers>): () => void;
    /**
     * Set event filter
     */
    setFilter(filter: EventFilter | null): void;
    /**
     * Subscribe to events for specific tasks
     */
    subscribeToTasks(taskIds: Buffer[]): void;
    /**
     * Subscribe to events for specific agents
     */
    subscribeToAgents(agentIds: Buffer[]): void;
    /**
     * Check if connected
     */
    isActive(): boolean;
    /**
     * Handle incoming logs
     */
    private handleLogs;
    /**
     * Dispatch event to handlers
     */
    private dispatchEvent;
    /**
     * Convert Anchor event name to EventType
     */
    private toEventType;
    /**
     * Parse event data into typed structure
     */
    private parseEventData;
    /**
     * Check if event passes filter
     */
    private passesFilter;
    /**
     * Handle reconnection
     */
    private handleReconnect;
}

/**
 * TaskExecutor - Orchestrates complete task lifecycle
 *
 * State machine: IDLE → DISCOVERING → EVALUATING → CLAIMING → EXECUTING → PROVING → SUBMITTING → IDLE
 */

/**
 * TaskExecutor constructor configuration
 */
interface TaskExecutorConfig {
    /** Solana connection */
    connection: Connection;
    /** Program instance */
    program: Program;
    /** Agent's keypair */
    wallet: Keypair;
    /** Agent PDA */
    agentPda: PublicKey;
    /** Agent manager (optional, for rate limiting) */
    agentManager?: AgentManager;
    /** Task evaluator for selection */
    evaluator?: TaskEvaluator;
    /** Task filter */
    filter?: TaskFilter;
    /** Maximum concurrent tasks */
    maxConcurrentTasks?: number;
    /** Polling interval in ms */
    pollInterval?: number;
    /** Task execution timeout in ms */
    taskTimeout?: number;
    /** Retry attempts for failed operations */
    retryAttempts?: number;
    /** Base delay for exponential backoff */
    retryBaseDelayMs?: number;
    /** Auto-claim matching tasks */
    autoClaim?: boolean;
    /** Optional logger */
    logger?: Logger;
}
/**
 * TaskExecutor handles task discovery, claiming, execution, and submission
 */
declare class TaskExecutor {
    private connection;
    private wallet;
    private program;
    private agentPda;
    private agentManager;
    private logger;
    private options;
    private state;
    private activeTasks;
    private taskHandler;
    private _pollInterval;
    private isRunning;
    private listeners;
    private protocolPda;
    private completedCount;
    private failedCount;
    private pendingCount;
    constructor(config: TaskExecutorConfig);
    /**
     * Set the task evaluator
     */
    setEvaluator(evaluator: TaskEvaluator): void;
    /**
     * Get executor statistics
     */
    getStats(): {
        pending: number;
        executing: number;
        completed: number;
        failed: number;
    };
    /**
     * Create a default agent state when agentManager is not available
     */
    private createDefaultAgentState;
    /**
     * Register task handler
     */
    onTask(handler: TaskHandler$1): void;
    /**
     * Register event listener
     */
    on(listener: RuntimeEventListener): () => void;
    /**
     * Start the executor
     */
    start(): Promise<void>;
    /**
     * Stop the executor
     */
    stop(): Promise<void>;
    /**
     * Get current executor state
     */
    getState(): ExecutorState;
    /**
     * Get active task count
     */
    getActiveTaskCount(): number;
    /**
     * Poll for available tasks
     */
    private poll;
    /**
     * Discover available tasks
     */
    discoverTasks(): Promise<OnChainTask$1[]>;
    /**
     * Select the best task based on evaluator
     */
    private selectBestTask;
    /**
     * Claim and execute a task
     */
    claimAndExecute(task: OnChainTask$1): Promise<void>;
    /**
     * Claim a task on-chain
     */
    private claimTask;
    /**
     * Execute task handler with retry logic
     */
    private executeWithRetry;
    /**
     * Submit task completion on-chain
     */
    private submitCompletion;
    /**
     * Check if task matches filter
     */
    private matchesFilter;
    /**
     * Parse task account to OnChainTask
     */
    private parseTask;
    /**
     * Parse claim account to TaskClaim
     */
    private parseClaim;
    /**
     * Emit runtime event
     */
    private emit;
    /**
     * Handle error
     */
    private handleError;
}

/**
 * Tool Registry with MCP compatibility
 *
 * Manages tool registration, discovery, and execution with sandboxing support.
 */

interface ToolRegistryConfig {
    /** Enable sandboxed execution */
    sandbox?: SandboxConfig;
    /** Timeout for tool execution in ms */
    defaultTimeout?: number;
    /** Maximum concurrent tool executions */
    maxConcurrent?: number;
}
/**
 * Tool Registry for managing and executing tools
 */
declare class ToolRegistry {
    private tools;
    private config;
    private activeExecutions;
    constructor(config?: ToolRegistryConfig);
    /**
     * Register a tool
     */
    register(tool: Tool): void;
    /**
     * Register multiple tools at once
     */
    registerAll(tools: Tool[]): void;
    /**
     * Unregister a tool
     */
    unregister(name: string): boolean;
    /**
     * Get a tool by name
     */
    get(name: string): Tool | undefined;
    /**
     * Check if a tool exists
     */
    has(name: string): boolean;
    /**
     * List all registered tools
     */
    list(): Tool[];
    /**
     * Get tools in MCP format
     */
    toMCPFormat(): MCPToolDefinition[];
    /**
     * Execute a tool call
     */
    execute(call: ToolCall): Promise<ToolResult>;
    /**
     * Execute multiple tool calls
     */
    executeAll(calls: ToolCall[]): Promise<ToolResult[]>;
    /**
     * Get tool statistics
     */
    getStats(name: string): {
        executionCount: number;
        avgExecutionTime: number;
        lastError?: string;
    } | undefined;
    /**
     * Clear all registered tools
     */
    clear(): void;
    /**
     * Validate a tool definition
     */
    private validateTool;
    /**
     * Validate input against tool schema
     */
    private validateInput;
    /**
     * Execute a tool with timeout
     */
    private executeWithTimeout;
}

/**
 * Built-in tools for common agent operations
 */

/**
 * HTTP fetch tool for making web requests
 */
declare const httpFetch: Tool;
/**
 * JSON parse tool
 */
declare const jsonParse: Tool;
/**
 * JSON stringify tool
 */
declare const jsonStringify: Tool;
/**
 * Base64 encode tool
 */
declare const base64Encode: Tool;
/**
 * Base64 decode tool
 */
declare const base64Decode: Tool;
/**
 * Hash computation tool
 */
declare const computeHash: Tool;
/**
 * Random number generator tool
 */
declare const randomNumber: Tool;
/**
 * Current timestamp tool
 */
declare const currentTime: Tool;
/**
 * Sleep/delay tool
 */
declare const sleep: Tool;
/**
 * All built-in tools
 */
declare const builtinTools: Tool[];

/**
 * Memory Store implementation with pluggable backends
 */

interface MemoryStoreConfig {
    /** Backend to use for storage */
    backend: MemoryBackend;
    /** LLM adapter for summarization (optional) */
    summarizer?: {
        summarize(messages: Message[]): Promise<string>;
    };
}
/**
 * Memory store with conversation history, task context, and key-value storage
 */
declare class DefaultMemoryStore implements MemoryStore {
    private backend;
    private summarizer?;
    constructor(config: MemoryStoreConfig);
    addMessage(message: Message): Promise<void>;
    getMessages(limit?: number): Promise<Message[]>;
    summarize(): Promise<string>;
    clearConversation(): Promise<void>;
    setCurrentTask(task: OnChainTask$1 | null): Promise<void>;
    getCurrentTask(): Promise<OnChainTask$1 | null>;
    addTaskResult(taskId: Buffer, taskAddress: PublicKey, result: TaskResult$1, txSignature: string, rewardReceived: bigint): Promise<void>;
    getTaskHistory(limit?: number): Promise<TaskHistoryEntry[]>;
    getTaskResult(taskId: Buffer): Promise<TaskHistoryEntry | null>;
    set(namespace: string, key: string, value: unknown): Promise<void>;
    get<T>(namespace: string, key: string): Promise<T | null>;
    delete(namespace: string, key: string): Promise<void>;
    keys(namespace: string): Promise<string[]>;
    save(): Promise<void>;
    load(): Promise<void>;
    clear(): Promise<void>;
    getStats(): Promise<MemoryStats>;
}

/**
 * In-memory storage backend
 */

/**
 * In-memory backend for MemoryStore
 * Useful for development and testing
 */
declare class InMemoryBackend implements MemoryBackend {
    private messages;
    private currentTask;
    private taskHistory;
    private kvStore;
    private maxMessages;
    private maxTaskHistory;
    constructor(config?: InMemoryBackendConfig);
    addMessage(message: Message): Promise<void>;
    getMessages(limit?: number): Promise<Message[]>;
    clearConversation(): Promise<void>;
    setCurrentTask(task: OnChainTask$1 | null): Promise<void>;
    getCurrentTask(): Promise<OnChainTask$1 | null>;
    addTaskResult(entry: TaskHistoryEntry): Promise<void>;
    getTaskHistory(limit?: number): Promise<TaskHistoryEntry[]>;
    getTaskResult(taskId: Buffer): Promise<TaskHistoryEntry | null>;
    set(namespace: string, key: string, value: unknown): Promise<void>;
    get<T>(namespace: string, key: string): Promise<T | null>;
    delete(namespace: string, key: string): Promise<void>;
    keys(namespace: string): Promise<string[]>;
    save(): Promise<void>;
    load(): Promise<void>;
    clear(): Promise<void>;
    /**
     * Export all data (for debugging or migration)
     */
    export(): {
        messages: Message[];
        currentTask: OnChainTask$1 | null;
        taskHistory: TaskHistoryEntry[];
        kvStore: Record<string, Record<string, unknown>>;
    };
    /**
     * Import data (for debugging or migration)
     */
    import(data: {
        messages?: Message[];
        currentTask?: OnChainTask$1 | null;
        taskHistory?: TaskHistoryEntry[];
        kvStore?: Record<string, Record<string, unknown>>;
    }): void;
}

/**
 * File-based storage backend
 */

interface FileBackendConfig {
    /** Directory path for storage files */
    directory: string;
    /** Maximum messages to keep */
    maxMessages?: number;
    /** Maximum task history entries */
    maxTaskHistory?: number;
    /** Auto-save on every write */
    autoSave?: boolean;
}
/**
 * File-based backend for MemoryStore
 * Persists data to JSON files
 */
declare class FileBackend implements MemoryBackend {
    private messages;
    private currentTask;
    private taskHistory;
    private kvStore;
    private directory;
    private maxMessages;
    private maxTaskHistory;
    private autoSave;
    private dirty;
    constructor(config: FileBackendConfig);
    private get filePath();
    private maybeSave;
    addMessage(message: Message): Promise<void>;
    getMessages(limit?: number): Promise<Message[]>;
    clearConversation(): Promise<void>;
    setCurrentTask(task: OnChainTask$1 | null): Promise<void>;
    getCurrentTask(): Promise<OnChainTask$1 | null>;
    addTaskResult(entry: TaskHistoryEntry): Promise<void>;
    getTaskHistory(limit?: number): Promise<TaskHistoryEntry[]>;
    getTaskResult(taskId: Buffer): Promise<TaskHistoryEntry | null>;
    set(namespace: string, key: string, value: unknown): Promise<void>;
    get<T>(namespace: string, key: string): Promise<T | null>;
    delete(namespace: string, key: string): Promise<void>;
    keys(namespace: string): Promise<string[]>;
    save(): Promise<void>;
    load(): Promise<void>;
    clear(): Promise<void>;
}

/**
 * ProofEngine for ZK proof generation and verification
 *
 * Wraps the SDK proof generation API and provides caching,
 * batching, and status tracking.
 */

interface ProofEngineConfig {
    /** Path to task_completion circuit (default: ./circuits/task_completion) */
    circuitPath?: string;
    /** Path to hash_helper circuit (default: ./circuits/hash_helper) */
    hashHelperPath?: string;
    /** Whether to cache generated proofs */
    cacheProofs?: boolean;
    /** Maximum cache size */
    maxCacheSize?: number;
    /** Proof generation timeout in ms */
    timeout?: number;
}
interface ProofRequest {
    taskPda: PublicKey;
    agentPubkey: PublicKey;
    output: bigint[];
    salt?: bigint;
}
interface ProofOutput {
    proof: Buffer;
    publicWitness: Buffer;
    constraintHash: Buffer;
    outputCommitment: Buffer;
    expectedBinding: Buffer;
    proofSize: number;
    generationTime: number;
    cached: boolean;
}
interface ProofStatus {
    pending: number;
    completed: number;
    failed: number;
    totalGenerationTime: number;
    averageGenerationTime: number;
}
interface ToolsStatus {
    nargo: boolean;
    sunspot: boolean;
    nargoVersion?: string;
    sunspotVersion?: string;
}
/**
 * Generate a cryptographically secure random salt
 */
declare function generateSalt(): bigint;
/**
 * ProofEngine manages ZK proof generation for task completion
 */
declare class ProofEngine {
    private config;
    private cache;
    private pendingCount;
    private completedCount;
    private failedCount;
    private totalGenerationTime;
    private toolsAvailable;
    constructor(config?: ProofEngineConfig);
    /**
     * Check if required tools (nargo, sunspot) are available
     */
    checkTools(): Promise<ToolsStatus>;
    /**
     * Require tools to be available, throws with installation instructions if not
     */
    requireTools(): Promise<void>;
    /**
     * Generate a ZK proof for task completion
     */
    generateProof(request: ProofRequest): Promise<ProofOutput>;
    /**
     * Verify a proof locally
     */
    verifyProof(proof: Buffer, publicWitness: Buffer): Promise<boolean>;
    /**
     * Compute hashes via the hash_helper circuit
     */
    computeHashes(taskPda: PublicKey, agentPubkey: PublicKey, output: bigint[], salt: bigint): Promise<{
        constraintHash: bigint;
        outputCommitment: bigint;
        expectedBinding: bigint;
    }>;
    /**
     * Get proof generation status
     */
    getStatus(): ProofStatus;
    /**
     * Clear the proof cache
     */
    clearCache(): void;
    /**
     * Get cache statistics
     */
    getCacheStats(): {
        size: number;
        maxSize: number;
    };
    private getCacheKey;
    private addToCache;
}
/**
 * Create a ProofEngine instance
 */
declare function createProofEngine(config?: ProofEngineConfig): ProofEngine;

/**
 * DisputeHandler for managing dispute lifecycle
 *
 * Handles dispute initiation, voting, and resolution for agents.
 */

interface DisputeHandlerConfig {
    /** Solana connection */
    connection: Connection;
    /** Program instance */
    program: Program;
    /** Agent's keypair */
    wallet: Keypair;
    /** Agent's registration PDA */
    agentPda: PublicKey;
}
declare enum DisputeStatus {
    Active = "active",
    Resolved = "resolved",
    Expired = "expired"
}
declare enum ResolutionType {
    RefundCreator = 0,
    PayWorker = 1,
    Split = 2,
    Arbitration = 3
}
interface Dispute {
    disputeId: Buffer;
    taskId: Buffer;
    initiator: PublicKey;
    resolutionType: ResolutionType;
    votingDeadline: number;
    votesFor: bigint;
    votesAgainst: bigint;
    status: DisputeStatus;
    resolved: boolean;
    resolution?: ResolutionType;
}
interface VoteRecord {
    disputeId: Buffer;
    voter: PublicKey;
    approved: boolean;
    votedAt: number;
}
interface DisputeStats {
    initiated: number;
    votedOn: number;
    resolved: number;
    expired: number;
    wonAsInitiator: number;
    lostAsInitiator: number;
}
type DisputeEventHandler = {
    onInitiated?: (event: DisputeInitiatedEvent) => void | Promise<void>;
    onVoteCast?: (event: DisputeVoteCastEvent) => void | Promise<void>;
    onResolved?: (event: DisputeResolvedEvent) => void | Promise<void>;
    onExpired?: (event: DisputeExpiredEvent) => void | Promise<void>;
};
/**
 * DisputeHandler manages dispute lifecycle for agents
 */
declare class DisputeHandler {
    private connection;
    private program;
    private wallet;
    private agentPda;
    private activeDisputes;
    private voteRecords;
    private stats;
    private eventHandlers;
    constructor(config: DisputeHandlerConfig);
    /**
     * Set event handlers
     */
    setEventHandlers(handlers: DisputeEventHandler): void;
    /**
     * Initiate a dispute for a task
     */
    initiateDispute(taskPda: PublicKey, resolutionType: ResolutionType, evidence?: string): Promise<{
        disputePda: PublicKey;
        txSignature: string;
    }>;
    /**
     * Vote on a dispute (requires ARBITER capability)
     */
    voteOnDispute(disputePda: PublicKey, approve: boolean): Promise<{
        txSignature: string;
    }>;
    /**
     * Resolve a dispute (after voting deadline)
     */
    resolveDispute(disputePda: PublicKey, taskPda: PublicKey, escrowPda: PublicKey, workerPda?: PublicKey, workerClaimPda?: PublicKey): Promise<{
        txSignature: string;
        resolution: ResolutionType;
    }>;
    /**
     * Expire a dispute that has passed its deadline without resolution
     */
    expireDispute(disputePda: PublicKey, taskPda: PublicKey, escrowPda: PublicKey): Promise<{
        txSignature: string;
        refundAmount: bigint;
    }>;
    /**
     * Fetch a dispute's current state
     */
    getDispute(disputePda: PublicKey): Promise<Dispute | null>;
    /**
     * Get all active disputes for a task
     */
    getDisputesForTask(taskPda: PublicKey): Promise<Dispute[]>;
    /**
     * Check if the agent has already voted on a dispute
     */
    hasVoted(disputePda: PublicKey): Promise<boolean>;
    /**
     * Get dispute statistics
     */
    getStats(): DisputeStats;
    /**
     * Handle a dispute initiated event
     */
    handleDisputeInitiated(event: DisputeInitiatedEvent): void;
    /**
     * Handle a dispute vote cast event
     */
    handleDisputeVoteCast(event: DisputeVoteCastEvent): void;
    /**
     * Handle a dispute resolved event
     */
    handleDisputeResolved(event: DisputeResolvedEvent): void;
    /**
     * Handle a dispute expired event
     */
    handleDisputeExpired(event: DisputeExpiredEvent): void;
    /**
     * Generate a unique dispute ID
     */
    private generateDisputeId;
}
/**
 * Create a DisputeHandler instance
 */
declare function createDisputeHandler(config: DisputeHandlerConfig): DisputeHandler;

/**
 * AgentRuntime - Main orchestrator for AI agent runtime
 *
 * Coordinates all runtime components:
 * - AgentManager: Registration, status, capabilities
 * - EventMonitor: Real-time event subscriptions
 * - TaskExecutor: Task discovery, execution, completion
 * - ToolRegistry: Tool management and execution
 * - MemoryStore: Conversation and context management
 * - ProofEngine: ZK proof generation
 * - DisputeHandler: Dispute lifecycle management
 * - LLM Adapters: Multi-provider LLM support
 */

interface RuntimeConfig {
    /** Solana connection */
    connection: Connection;
    /** Agent's keypair */
    wallet: Keypair;
    /** Program ID */
    programId: PublicKey;
    /** Program IDL */
    idl: object;
    /** Operating mode */
    mode?: OperatingMode;
    /** Agent ID (32 bytes) */
    agentId: Buffer;
    /** Agent capabilities bitmask */
    capabilities?: bigint;
    /** Agent endpoint URL */
    endpoint?: string;
    /** Initial stake amount in lamports */
    stake?: bigint;
    /** LLM adapter to use */
    llm?: LLMAdapter;
    /** Memory backend */
    memoryBackend?: MemoryBackend;
    /** Memory store configuration */
    memory?: Partial<MemoryStoreConfig>;
    /** Tool registry configuration */
    tools?: ToolRegistryConfig;
    /** Proof engine configuration */
    proof?: ProofEngineConfig;
    /** Task evaluator for selecting tasks */
    taskEvaluator?: TaskEvaluator;
    /** Task handler for processing tasks */
    taskHandler?: TaskHandler$1;
    /** Polling interval for task discovery (ms) */
    pollInterval?: number;
    /** Maximum concurrent tasks */
    maxConcurrentTasks?: number;
    /** Event filter */
    eventFilter?: {
        taskIds?: Buffer[];
        agentIds?: Buffer[];
        eventTypes?: EventType[];
    };
}
interface RuntimeStatus {
    running: boolean;
    mode: OperatingMode;
    agentState: AgentState$1 | null;
    taskCount: {
        pending: number;
        executing: number;
        completed: number;
        failed: number;
    };
    proofStats: {
        pending: number;
        completed: number;
        failed: number;
    };
    memoryStats: {
        messageCount: number;
        taskHistoryCount: number;
    };
}
/**
 * AgentRuntime - Main runtime orchestrator
 */
declare class AgentRuntime {
    private connection;
    private wallet;
    private program;
    private mode;
    private agentManager;
    private eventMonitor;
    private taskExecutor;
    private toolRegistry;
    private memoryStore;
    private proofEngine;
    private disputeHandler;
    private llm;
    private running;
    private agentState;
    private listeners;
    constructor(config: RuntimeConfig);
    /**
     * Start the runtime
     */
    start(): Promise<void>;
    /**
     * Stop the runtime
     */
    stop(): Promise<void>;
    /**
     * Register the agent on-chain
     */
    register(config: AgentRegistrationConfig): Promise<AgentState$1>;
    /**
     * Deregister the agent
     */
    deregister(): Promise<bigint>;
    /**
     * Set the task handler
     */
    onTask(handler: TaskHandler$1): void;
    /**
     * Set the task evaluator
     */
    setEvaluator(evaluator: TaskEvaluator): void;
    /**
     * Register a tool
     */
    registerTool(tool: Tool): void;
    /**
     * Register multiple tools
     */
    registerTools(tools: Tool[]): void;
    /**
     * Set the LLM adapter
     */
    setLLM(llm: LLMAdapter): void;
    /**
     * Add a runtime event listener
     */
    on(listener: RuntimeEventListener): () => void;
    /**
     * Subscribe to on-chain events
     */
    onEvent<T extends EventType>(eventType: T, handler: EventHandler<T>): () => void;
    /**
     * Get runtime status
     */
    getStatus(): Promise<RuntimeStatus>;
    getAgentManager(): AgentManager;
    getEventMonitor(): EventMonitor;
    getTaskExecutor(): TaskExecutor;
    getToolRegistry(): ToolRegistry;
    getMemoryStore(): MemoryStore;
    getProofEngine(): ProofEngine;
    getDisputeHandler(): DisputeHandler;
    getLLM(): LLMAdapter | null;
    private setupEventForwarding;
    private emit;
}
/**
 * Create an AgentRuntime instance
 */
declare function createRuntime(config: RuntimeConfig): AgentRuntime;
declare function createAnthropicLLM(config: {
    apiKey: string;
    model?: string;
}): LLMAdapter;
declare function createOllamaLLM(config: {
    model: string;
    baseUrl?: string;
}): LLMAdapter;
declare function createGrokLLM(config: {
    apiKey: string;
    model?: string;
}): LLMAdapter;

/**
 * Type definitions for @agenc/runtime
 */

/**
 * Agent configuration options
 */
interface AgentConfig {
    /** Solana RPC connection */
    connection: Connection;
    /** Agent wallet keypair */
    wallet: Keypair;
    /** Anchor program instance */
    program: Program;
    /** Agent's capability bitmask */
    capabilities: number;
    /** Agent's unique ID (32 bytes) */
    agentId: Buffer;
    /** Endpoint URL for agent (for discovery) */
    endpoint?: string;
    /** Initial stake amount in lamports */
    stake?: number;
    /** Path to ZK circuits directory */
    circuitPath?: string;
    /** Path to hash helper circuit */
    hashHelperPath?: string;
}
/**
 * Agent runtime options
 */
interface RuntimeOptions {
    /** Polling interval in milliseconds (default: 5000) */
    pollIntervalMs?: number;
    /** Maximum concurrent tasks (default: 1) */
    maxConcurrentTasks?: number;
    /** Auto-claim matching tasks (default: false) */
    autoClaim?: boolean;
    /** Filter function for task selection */
    taskFilter?: (task: OnChainTask) => boolean;
    /** Retry attempts for failed operations (default: 3) */
    retryAttempts?: number;
    /** Base delay for exponential backoff in ms (default: 1000) */
    retryBaseDelayMs?: number;
}
/**
 * On-chain task representation
 */
interface OnChainTask {
    /** Task PDA address */
    address: PublicKey;
    /** Task unique identifier */
    taskId: Buffer;
    /** Task creator */
    creator: PublicKey;
    /** Required capabilities bitmask */
    requiredCapabilities: number;
    /** Task description */
    description: string;
    /** Reward amount in lamports */
    rewardLamports: number;
    /** Maximum workers allowed */
    maxWorkers: number;
    /** Current worker count */
    currentWorkers: number;
    /** Deadline timestamp (0 = no deadline) */
    deadline: number;
    /** Task type (exclusive, collaborative, competitive) */
    taskType: TaskType;
    /** Constraint hash for private tasks (null for public) */
    constraintHash: Buffer | null;
    /** Task status */
    status: TaskStatus;
}
/**
 * Task types
 */
declare enum TaskType {
    Exclusive = 0,
    Collaborative = 1,
    Competitive = 2
}
/**
 * Task status
 */
declare enum TaskStatus {
    Open = 0,
    InProgress = 1,
    Completed = 2,
    Cancelled = 3,
    Disputed = 4
}
/**
 * Task execution result from handler
 */
interface TaskResult {
    /** Output values (4 field elements for private tasks) */
    output: bigint[];
    /** Salt for proof generation (auto-generated if not provided) */
    salt?: bigint;
    /** Optional result data (max 128 bytes, for public tasks) */
    resultData?: Buffer;
}
/**
 * Task handler function signature
 */
type TaskHandler = (task: OnChainTask) => Promise<TaskResult>;
/**
 * Event types emitted by the runtime
 */
type RuntimeEvent = {
    type: 'started';
    agentId: Buffer;
} | {
    type: 'stopped';
    agentId: Buffer;
} | {
    type: 'taskFound';
    task: OnChainTask;
} | {
    type: 'taskClaimed';
    task: OnChainTask;
    claimPda: PublicKey;
} | {
    type: 'taskCompleted';
    task: OnChainTask;
    txSignature: string;
} | {
    type: 'taskFailed';
    task: OnChainTask;
    error: Error;
} | {
    type: 'error';
    error: Error;
};
/**
 * Event listener callback
 */
type EventListener = (event: RuntimeEvent) => void;
/**
 * Agent state
 */
interface AgentState {
    /** Agent PDA address */
    pda: PublicKey;
    /** Is agent registered on-chain */
    registered: boolean;
    /** Is runtime running */
    running: boolean;
    /** Current active tasks */
    activeTasks: Map<string, OnChainTask>;
    /** Tasks completed this session */
    completedCount: number;
    /** Tasks failed this session */
    failedCount: number;
}

/**
 * Agent - Core runtime class for AI agents on AgenC
 *
 * Manages agent lifecycle, task execution, and on-chain interactions.
 */

/**
 * Agent runtime for automated task execution on AgenC protocol.
 *
 * @example
 * ```typescript
 * import { Agent, Capabilities } from '@agenc/runtime';
 *
 * const agent = new Agent({
 *   connection,
 *   wallet,
 *   program,
 *   capabilities: Capabilities.COMPUTE | Capabilities.INFERENCE,
 *   agentId: Buffer.from('my-agent-id'.padEnd(32, '\0')),
 * });
 *
 * // Define task handler
 * agent.onTask(async (task) => {
 *   const output = await processTask(task);
 *   return { output: [1n, 2n, 3n, 4n] };
 * });
 *
 * // Start the agent
 * await agent.start();
 * ```
 */
declare class Agent {
    private config;
    private options;
    private state;
    private taskHandler;
    private listeners;
    private pollInterval;
    private protocolPda;
    constructor(config: AgentConfig, options?: RuntimeOptions);
    /**
     * Get agent's PDA address
     */
    get pda(): PublicKey;
    /**
     * Check if agent is running
     */
    get isRunning(): boolean;
    /**
     * Get current agent state
     */
    getState(): Readonly<AgentState>;
    /**
     * Register task handler
     */
    onTask(handler: TaskHandler): void;
    /**
     * Register event listener
     */
    on(listener: EventListener): () => void;
    private emit;
    /**
     * Register agent on-chain (if not already registered)
     */
    register(): Promise<void>;
    /**
     * Start the agent runtime
     */
    start(): Promise<void>;
    /**
     * Stop the agent runtime
     */
    stop(): Promise<void>;
    /**
     * Poll for available tasks
     */
    private pollTasks;
    /**
     * Fetch open tasks from on-chain
     */
    private fetchOpenTasks;
    /**
     * Parse on-chain task account to OnChainTask
     */
    private parseTask;
    private parseTaskType;
    private parseTaskStatus;
    /**
     * Claim a task and execute
     */
    claimAndExecute(task: OnChainTask): Promise<void>;
    /**
     * Execute task handler with retry logic
     */
    private executeWithRetry;
    /**
     * Complete a task with result
     */
    private completeTask;
    private handleError;
}

/**
 * Base LLM adapter with common functionality
 */

/**
 * Abstract base adapter with common message handling
 */
declare abstract class BaseLLMAdapter implements LLMAdapter {
    protected config: BaseAdapterConfig;
    protected messages: Message[];
    protected systemPrompt: string | null;
    constructor(config: BaseAdapterConfig);
    /**
     * Set the system prompt
     */
    setSystemPrompt(prompt: string): void;
    /**
     * Add a message to the conversation
     */
    addMessage(message: Message): void;
    /**
     * Get all messages
     */
    getMessages(): Message[];
    /**
     * Clear conversation history
     */
    clearContext(): void;
    /**
     * Get the model name
     */
    getModel(): string;
    /**
     * Estimate token count (rough approximation)
     */
    countTokens(text: string): number;
    /**
     * Get context window size (override in subclasses)
     */
    abstract getContextWindow(): number;
    /**
     * Generate a completion
     */
    abstract complete(prompt: string, options?: CompletionOptions): Promise<string>;
    /**
     * Generate a streaming completion
     */
    abstract stream(prompt: string, options?: CompletionOptions): AsyncIterable<string>;
    /**
     * Generate a completion with tool support
     */
    abstract completeWithTools(prompt: string, tools: Tool[], options?: CompletionOptions): Promise<LLMResponse>;
    /**
     * Build messages array for API call
     */
    protected buildMessages(prompt: string): Message[];
    /**
     * Convert tools to API format
     */
    protected toolsToAPIFormat(tools: Tool[]): MCPToolDefinition[];
    /**
     * Make HTTP request with retry
     */
    protected fetchWithRetry(url: string, options: RequestInit, retries?: number): Promise<Response>;
}

/**
 * Anthropic Claude LLM adapter
 */

/**
 * Anthropic Claude adapter
 */
declare class AnthropicAdapter extends BaseLLMAdapter {
    private apiKey;
    private baseUrl;
    private anthropicVersion;
    constructor(config: AnthropicConfig);
    getContextWindow(): number;
    complete(prompt: string, options?: CompletionOptions): Promise<string>;
    stream(prompt: string, options?: CompletionOptions): AsyncIterable<string>;
    completeWithTools(prompt: string, tools: Tool[], options?: CompletionOptions): Promise<LLMResponse>;
    private callAPI;
    private buildAnthropicMessages;
    private convertTools;
    private extractTextContent;
    private convertResponse;
}

/**
 * Ollama local LLM adapter
 */

/**
 * Ollama adapter for local LLM inference
 */
declare class OllamaAdapter extends BaseLLMAdapter {
    private baseUrl;
    constructor(config: OllamaConfig);
    getContextWindow(): number;
    complete(prompt: string, options?: CompletionOptions): Promise<string>;
    stream(prompt: string, options?: CompletionOptions): AsyncIterable<string>;
    completeWithTools(prompt: string, tools: Tool[], options?: CompletionOptions): Promise<LLMResponse>;
    private buildOllamaMessages;
    private convertTools;
    private convertResponse;
    /**
     * Check if Ollama is running
     */
    isAvailable(): Promise<boolean>;
    /**
     * List available models
     */
    listModels(): Promise<string[]>;
    /**
     * Pull a model
     */
    pullModel(model: string): Promise<void>;
}

/**
 * Grok (xAI) LLM adapter
 *
 * Grok uses an OpenAI-compatible API format.
 */

/**
 * Grok (xAI) adapter using OpenAI-compatible API
 */
declare class GrokAdapter extends BaseLLMAdapter {
    private apiKey;
    private baseUrl;
    constructor(config: GrokConfig);
    getContextWindow(): number;
    complete(prompt: string, options?: CompletionOptions): Promise<string>;
    stream(prompt: string, options?: CompletionOptions): AsyncIterable<string>;
    completeWithTools(prompt: string, tools: Tool[], options?: CompletionOptions): Promise<LLMResponse>;
    private callAPI;
    private buildOpenAIMessages;
    private convertTools;
    private convertResponse;
}

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

declare const VERSION = "1.0.0";

export { Agent, type AgentRuntimeConfig as AgentConfig, type AgentDeregisteredEvent, AgentManager, type AgentManagerConfig, type AgentRegisteredEvent, type AgentRegistrationConfig, AgentRuntime, type AgentRuntimeConfig, type AgentState$1 as AgentState, AgentStatus, type AgentUpdatedEvent, AnthropicAdapter, type AnthropicConfig, type BaseAdapterConfig, BaseLLMAdapter, Capability as Capabilities, Capability, type CompletionOptions, DefaultMemoryStore, type Dispute, type DisputeExpiredEvent, DisputeHandler, type DisputeHandlerConfig, type DisputeInitiatedEvent, type DisputeResolvedEvent, type DisputeStats, DisputeStatus, type DisputeVoteCastEvent, Evaluators, type EventFilter, type EventHandler, type EventHandlers, type RuntimeEvent$1 as EventListener, type EventMap, EventMonitor, type EventMonitorConfig, type EventType, ExecutorState, FileBackend, type FileBackendConfig, GrokAdapter, type GrokConfig, InMemoryBackend, type InMemoryBackendConfig, type LLMAdapter, type LLMResponse, type MCPToolDefinition, type MemoryBackend, type MemoryStats, type MemoryStore, type MemoryStoreConfig, type Message, type MigrationCompletedEvent, OllamaAdapter, type OllamaConfig, type OnChainTask$1 as OnChainTask, type OperatingMode, ProofEngine, type ProofEngineConfig, type ProofOutput, type ProofRequest, type ProofStatus, type ProtocolInitializedEvent, type ProtocolVersionUpdatedEvent, type RateLimitHitEvent, type RedisBackendConfig, ResolutionType, type RewardDistributedEvent, type RuntimeConfig, type RuntimeEvent$1 as RuntimeEvent, type RuntimeEventListener, type RuntimeEventType, type AgentState$1 as RuntimeOptions, type RuntimeStatus, type SandboxConfig, type SqliteBackendConfig, type StateUpdatedEvent, type TaskCancelledEvent, type TaskClaim, type TaskClaimedEvent, type TaskCompletedEvent, type TaskCreatedEvent, type TaskEvaluator, TaskExecutor, type TaskExecutorConfig, type TaskHandler$1 as TaskHandler, type TaskHistoryEntry, type TaskResult$1 as TaskResult, TaskStatus$1 as TaskStatus, TaskType$1 as TaskType, type TokenUsage, type Tool, type ToolCall, ToolRegistry, type ToolRegistryConfig, type ToolResult, type ToolsStatus, VERSION, type VoteRecord, base64Decode, base64Encode, Evaluators as builtinEvaluators, builtinTools, computeHash, createAnthropicLLM, createDisputeHandler, createGrokLLM, createOllamaLLM, createProofEngine, createRuntime, currentTime, generateSalt, httpFetch, jsonParse, jsonStringify, randomNumber, sleep };
