/**
 * AgentBuilder - Fluent API for composing AgenC agents.
 *
 * Reduces ~40 lines of manual wiring (LLM, tools, memory, proofs, skills)
 * to 5-10 lines of fluent builder calls.
 *
 * @module
 */

import type { Connection, PublicKey, Keypair } from '@solana/web3.js';
import type { Wallet } from './types/wallet.js';
import { ensureWallet } from './types/wallet.js';
import type { LogLevel, Logger } from './utils/logger.js';
import { createLogger, silentLogger } from './utils/logger.js';
import type { LLMProvider } from './llm/types.js';
import type { GrokProviderConfig } from './llm/grok/types.js';
import type { AnthropicProviderConfig } from './llm/anthropic/types.js';
import type { OllamaProviderConfig } from './llm/ollama/types.js';
import { GrokProvider } from './llm/grok/adapter.js';
import { AnthropicProvider } from './llm/anthropic/adapter.js';
import { OllamaProvider } from './llm/ollama/adapter.js';
import { LLMTaskExecutor } from './llm/executor.js';
import type { MemoryBackend } from './memory/types.js';
import type { InMemoryBackendConfig } from './memory/in-memory/index.js';
import { InMemoryBackend } from './memory/in-memory/backend.js';
import type { SqliteBackendConfig } from './memory/sqlite/types.js';
import { SqliteBackend } from './memory/sqlite/backend.js';
import type { RedisBackendConfig } from './memory/redis/types.js';
import { RedisBackend } from './memory/redis/backend.js';
import type { ProofEngineConfig } from './proof/types.js';
import { ProofEngine } from './proof/engine.js';
import type { Skill, SkillContext } from './skills/types.js';
import type { Tool } from './tools/types.js';
import { ToolRegistry } from './tools/registry.js';
import type { ActionSchemaMap } from './tools/skill-adapter.js';
import { skillToTools } from './tools/skill-adapter.js';
import { createAgencTools } from './tools/agenc/index.js';
import { AutonomousAgent } from './autonomous/agent.js';
import type {
  TaskExecutor,
  TaskFilter,
  ClaimStrategy,
  DiscoveryMode,
  Task,
  AutonomousAgentStats,
  SpeculationConfig,
  MultiCandidateConfig,
  VerifierLaneConfig,
  VerifierEscalationMetadata,
  VerifierVerdictPayload,
} from './autonomous/types.js';
import { DisputeOperations } from './dispute/operations.js';
import type { AgencCoordination } from './types/agenc_coordination.js';
import type { Program } from '@coral-xyz/anchor';
import { ConnectionManager } from './connection/manager.js';
import type { EndpointConfig, ConnectionManagerConfig } from './connection/types.js';
import type { TelemetryCollector, TelemetryConfig, TelemetrySnapshot } from './telemetry/types.js';
import { UnifiedTelemetryCollector } from './telemetry/collector.js';
import { PolicyEngine } from './policy/engine.js';
import type { RuntimePolicyConfig, PolicyViolation } from './policy/types.js';
import type { WorkflowOptimizerRuntimeConfig } from './workflow/optimizer.js';
import type { GatewayConfig } from './gateway/types.js';

// ============================================================================
// LLM provider type discriminator
// ============================================================================

type LLMProviderType = 'grok' | 'anthropic' | 'ollama';

type LLMConfigForType<T extends LLMProviderType> =
  T extends 'grok' ? Omit<GrokProviderConfig, 'tools'>
  : T extends 'anthropic' ? Omit<AnthropicProviderConfig, 'tools'>
  : T extends 'ollama' ? Omit<OllamaProviderConfig, 'tools'>
  : never;

// ============================================================================
// Memory backend type discriminator
// ============================================================================

type MemoryProviderType = 'memory' | 'sqlite' | 'redis';

type MemoryConfigForType<T extends MemoryProviderType> =
  T extends 'memory' ? InMemoryBackendConfig
  : T extends 'sqlite' ? SqliteBackendConfig
  : T extends 'redis' ? RedisBackendConfig
  : never;

// ============================================================================
// Skill registration entry
// ============================================================================

interface SkillEntry {
  skill: Skill;
  schemas: ActionSchemaMap;
}

// ============================================================================
// Callbacks
// ============================================================================

export interface AgentCallbacks {
  onTaskDiscovered?: (task: Task) => void;
  onTaskClaimed?: (task: Task, txSignature: string) => void;
  onTaskExecuted?: (task: Task, output: bigint[]) => void;
  onTaskCompleted?: (task: Task, txSignature: string) => void;
  onTaskFailed?: (task: Task, error: Error) => void;
  onEarnings?: (amount: bigint, task: Task, mint?: PublicKey | null) => void;
  onProofGenerated?: (task: Task, proofSizeBytes: number, durationMs: number) => void;
  onVerifierVerdict?: (task: Task, verdict: VerifierVerdictPayload) => void;
  onTaskEscalated?: (task: Task, metadata: VerifierEscalationMetadata) => void;
  onPolicyViolation?: (violation: PolicyViolation) => void;
}

// ============================================================================
// AgentBuilder
// ============================================================================

/**
 * Fluent builder for composing AgenC agents.
 *
 * Wires together AutonomousAgent, LLM providers, tool registry,
 * memory backends, proof engine, and skills with minimal boilerplate.
 *
 * @example
 * ```typescript
 * const agent = await new AgentBuilder(connection, wallet)
 *   .withCapabilities(AgentCapabilities.COMPUTE | AgentCapabilities.INFERENCE)
 *   .withStake(1_000_000_000n)
 *   .withLLM('grok', { apiKey: 'xai-...', model: 'grok-3' })
 *   .withMemory('sqlite', { dbPath: './agent.db' })
 *   .withProofs({ cache: { ttlMs: 300_000, maxEntries: 100 } })
 *   .withAgencTools()
 *   .build();
 *
 * await agent.start();
 * ```
 */
export class AgentBuilder {
  private readonly connection: Connection;
  private readonly wallet: Keypair | Wallet;

  // Agent configuration
  private capabilities?: bigint;
  private initialStake?: bigint;
  private endpoint?: string;
  private agentId?: Uint8Array;
  private programId?: PublicKey;
  private logLevel?: LogLevel;

  // Execution
  private llmType?: LLMProviderType;
  private llmConfig?: Record<string, unknown>;
  private executor?: TaskExecutor;
  private systemPrompt?: string;

  // Memory
  private memoryType?: MemoryProviderType;
  private memoryConfig?: Record<string, unknown>;

  // Proofs
  private proofConfig?: ProofEngineConfig;

  // Tools
  private customTools: Tool[] = [];
  private skillEntries: SkillEntry[] = [];
  private useAgencTools = false;

  // Task execution
  private taskFilter?: TaskFilter;
  private claimStrategy?: ClaimStrategy;
  private discoveryMode?: DiscoveryMode;
  private scanIntervalMs?: number;
  private maxConcurrentTasks?: number;

  // Speculation
  private speculationConfig?: SpeculationConfig;
  private multiCandidateConfig?: MultiCandidateConfig;
  private verifierConfig?: VerifierLaneConfig;
  private workflowOptimizerConfig?: WorkflowOptimizerRuntimeConfig;

  // Callbacks
  private callbacks?: AgentCallbacks;

  // Connection manager
  private connectionManager?: ConnectionManager;

  // Telemetry
  private telemetryConfig?: TelemetryConfig;
  // Policy
  private policyConfig?: RuntimePolicyConfig;
  // Gateway (stored for future Gateway integration in build())
  gatewayConfig?: GatewayConfig;

  constructor(connection: Connection, wallet: Keypair | Wallet) {
    this.connection = connection;
    this.wallet = wallet;
  }

  withCapabilities(capabilities: bigint): this {
    this.capabilities = capabilities;
    return this;
  }

  withStake(amount: bigint): this {
    this.initialStake = amount;
    return this;
  }

  withEndpoint(endpoint: string): this {
    this.endpoint = endpoint;
    return this;
  }

  withAgentId(agentId: Uint8Array): this {
    this.agentId = agentId;
    return this;
  }

  withProgramId(programId: PublicKey): this {
    this.programId = programId;
    return this;
  }

  withLogLevel(level: LogLevel): this {
    this.logLevel = level;
    return this;
  }

  withLLM<T extends LLMProviderType>(type: T, config: LLMConfigForType<T>): this {
    this.llmType = type;
    this.llmConfig = config as Record<string, unknown>;
    return this;
  }

  withExecutor(executor: TaskExecutor): this {
    this.executor = executor;
    return this;
  }

  withMemory<T extends MemoryProviderType>(type: T, config?: MemoryConfigForType<T>): this {
    this.memoryType = type;
    this.memoryConfig = (config ?? {}) as Record<string, unknown>;
    return this;
  }

  withProofs(config?: ProofEngineConfig): this {
    this.proofConfig = config ?? {};
    return this;
  }

  withTool(tool: Tool): this {
    this.customTools.push(tool);
    return this;
  }

  withSkill(skill: Skill, schemas: ActionSchemaMap): this {
    this.skillEntries.push({ skill, schemas });
    return this;
  }

  withAgencTools(): this {
    this.useAgencTools = true;
    return this;
  }

  withTaskFilter(filter: TaskFilter): this {
    this.taskFilter = filter;
    return this;
  }

  withAcceptedMints(mints: (PublicKey | null)[]): this {
    if (!this.taskFilter) {
      this.taskFilter = {};
    }
    this.taskFilter.acceptedMints = mints;
    return this;
  }

  withRewardMintFilter(rewardMint: PublicKey | PublicKey[] | null): this {
    if (!this.taskFilter) {
      this.taskFilter = {};
    }
    this.taskFilter.rewardMint = rewardMint;
    return this;
  }

  withClaimStrategy(strategy: ClaimStrategy): this {
    this.claimStrategy = strategy;
    return this;
  }

  withDiscoveryMode(mode: DiscoveryMode): this {
    this.discoveryMode = mode;
    return this;
  }

  withScanInterval(ms: number): this {
    this.scanIntervalMs = ms;
    return this;
  }

  withMaxConcurrentTasks(max: number): this {
    this.maxConcurrentTasks = max;
    return this;
  }

  withSystemPrompt(prompt: string): this {
    this.systemPrompt = prompt;
    return this;
  }

  withSpeculation(config?: SpeculationConfig): this {
    this.speculationConfig = config ?? { enabled: true };
    return this;
  }

  withVerifier(config: VerifierLaneConfig): this {
    this.verifierConfig = config;
    return this;
  }

  withMultiCandidate(config?: MultiCandidateConfig): this {
    this.multiCandidateConfig = config ?? { enabled: true };
    return this;
  }

  withWorkflowOptimizer(config?: WorkflowOptimizerRuntimeConfig): this {
    this.workflowOptimizerConfig = config ?? { enabled: true };
    return this;
  }

  withCallbacks(callbacks: AgentCallbacks): this {
    this.callbacks = callbacks;
    return this;
  }

  /**
   * Configure resilient RPC with multiple endpoints, retry, and failover.
   *
   * Creates a ConnectionManager internally. The resulting connection is used
   * for all agent operations.
   */
  withRpcEndpoints(
    endpoints: (string | EndpointConfig)[],
    config?: Omit<ConnectionManagerConfig, 'endpoints' | 'logger'>,
  ): this {
    this.connectionManager = new ConnectionManager({
      ...config,
      endpoints,
      logger: this.logLevel ? createLogger(this.logLevel, '[ConnectionManager]') : undefined,
    });
    return this;
  }

  /**
   * Use a pre-configured ConnectionManager.
   */
  withConnectionManager(manager: ConnectionManager): this {
    this.connectionManager = manager;
    return this;
  }

  /**
   * Enable unified telemetry collection.
   *
   * Creates a `UnifiedTelemetryCollector` in `build()` and passes it as
   * `metrics` to all instrumented components (LLM, memory, proofs, disputes,
   * connection manager).
   */
  withTelemetry(config?: TelemetryConfig): this {
    this.telemetryConfig = config ?? {};
    return this;
  }

  withPolicy(config: RuntimePolicyConfig): this {
    this.policyConfig = config;
    return this;
  }

  /**
   * Store gateway config for future Gateway integration.
   *
   * The config is stored and will be used when `build()` is extended
   * to optionally create a Gateway wrapper.
   */
  withGateway(config: GatewayConfig): this {
    this.gatewayConfig = config;
    return this;
  }

  /**
   * Build and return a fully wired BuiltAgent.
   *
   * Validates configuration, creates all components, and wires them together.
   * Skills are initialized during build (async).
   */
  async build(): Promise<BuiltAgent> {
    if (!this.capabilities) {
      throw new Error('capabilities required — call withCapabilities()');
    }
    if (!this.executor && !this.llmType) {
      throw new Error('executor or LLM required — call withExecutor() or withLLM()');
    }

    const logger = this.logLevel
      ? createLogger(this.logLevel, '[AgentBuilder]')
      : silentLogger;

    const builderWallet: Wallet = ensureWallet(this.wallet);

    const resolvedConnection = this.connectionManager?.getConnection() ?? this.connection;

    // Create telemetry collector if configured
    const telemetry = this.telemetryConfig
      ? new UnifiedTelemetryCollector(this.telemetryConfig, logger)
      : undefined;
    const policyEngine = this.policyConfig
      ? new PolicyEngine({ policy: this.policyConfig, logger, metrics: telemetry })
      : undefined;

    // Inject metrics into connection manager (created before collector exists)
    if (telemetry && this.connectionManager) {
      this.connectionManager.setMetrics(telemetry);
    }

    const { registry, initializedSkills } = await this.buildToolRegistry(
      logger,
      builderWallet,
      resolvedConnection,
      policyEngine,
    );
    const memory = this.memoryType ? this.createMemoryBackend(telemetry) : undefined;
    const taskExecutor = this.buildExecutor(registry, memory, telemetry);
    const proofEngine = this.proofConfig
      ? new ProofEngine({ ...this.proofConfig, logger, metrics: telemetry })
      : undefined;
    const autonomous = this.buildAutonomousAgent(
      taskExecutor,
      proofEngine,
      memory,
      resolvedConnection,
      telemetry,
      policyEngine,
    );

    return new BuiltAgent(
      autonomous,
      memory,
      proofEngine,
      registry,
      initializedSkills,
      this.connectionManager,
      logger,
      telemetry,
      policyEngine,
    );
  }

  private async buildToolRegistry(
    logger: Logger,
    wallet: Wallet,
    resolvedConnection: Connection,
    policyEngine?: PolicyEngine,
  ): Promise<{ registry: ToolRegistry | undefined; initializedSkills: Skill[] }> {
    const hasTools = this.customTools.length > 0 || this.skillEntries.length > 0 || this.useAgencTools;
    if (!hasTools) return { registry: undefined, initializedSkills: [] };

    const registry = new ToolRegistry({ logger, policyEngine });
    const initializedSkills: Skill[] = [];

    for (const entry of this.skillEntries) {
      const ctx: SkillContext = { connection: resolvedConnection, wallet, logger };
      await entry.skill.initialize(ctx);
      initializedSkills.push(entry.skill);
      registry.registerAll(skillToTools(entry.skill, { schemas: entry.schemas }));
    }

    for (const tool of this.customTools) {
      registry.register(tool);
    }

    if (this.useAgencTools) {
      registry.registerAll(createAgencTools({
        connection: resolvedConnection,
        wallet,
        programId: this.programId,
        logger,
      }));
    }

    return { registry, initializedSkills };
  }

  private buildExecutor(
    registry: ToolRegistry | undefined,
    memory: MemoryBackend | undefined,
    metrics?: TelemetryCollector,
  ): TaskExecutor {
    if (this.executor) return this.executor;

    const provider = this.createLLMProvider(registry?.toLLMTools());
    return new LLMTaskExecutor({
      provider,
      systemPrompt: this.systemPrompt,
      toolHandler: registry?.createToolHandler(),
      memory,
      metrics,
    });
  }

  private buildAutonomousAgent(
    executor: TaskExecutor,
    proofEngine: ProofEngine | undefined,
    memory: MemoryBackend | undefined,
    resolvedConnection: Connection,
    metrics?: TelemetryCollector,
    policyEngine?: PolicyEngine,
  ): AutonomousAgent {
    return new AutonomousAgent({
      connection: resolvedConnection,
      wallet: this.wallet,
      programId: this.programId,
      agentId: this.agentId,
      capabilities: this.capabilities!,
      endpoint: this.endpoint,
      initialStake: this.initialStake,
      logLevel: this.logLevel,
      executor,
      proofEngine,
      memory,
      metrics,
      policyEngine,
      taskFilter: this.taskFilter,
      claimStrategy: this.claimStrategy,
      discoveryMode: this.discoveryMode,
      scanIntervalMs: this.scanIntervalMs,
      maxConcurrentTasks: this.maxConcurrentTasks,
      speculation: this.speculationConfig,
      verifier: this.verifierConfig,
      multiCandidate: this.multiCandidateConfig,
      workflowOptimizer: this.workflowOptimizerConfig,
      onTaskDiscovered: this.callbacks?.onTaskDiscovered,
      onTaskClaimed: this.callbacks?.onTaskClaimed,
      onTaskExecuted: this.callbacks?.onTaskExecuted,
      onTaskCompleted: this.callbacks?.onTaskCompleted,
      onTaskFailed: this.callbacks?.onTaskFailed,
      onEarnings: this.callbacks?.onEarnings,
      onProofGenerated: this.callbacks?.onProofGenerated,
      onVerifierVerdict: this.callbacks?.onVerifierVerdict,
      onTaskEscalated: this.callbacks?.onTaskEscalated,
      onPolicyViolation: this.callbacks?.onPolicyViolation,
    });
  }

  private createLLMProvider(tools?: ReturnType<ToolRegistry['toLLMTools']>): LLMProvider {
    const config = { ...this.llmConfig, tools };

    switch (this.llmType) {
      case 'grok':
        return new GrokProvider(config as unknown as GrokProviderConfig);
      case 'anthropic':
        return new AnthropicProvider(config as unknown as AnthropicProviderConfig);
      case 'ollama':
        return new OllamaProvider(config as unknown as OllamaProviderConfig);
      default:
        throw new Error(`Unknown LLM provider type: ${this.llmType}`);
    }
  }

  private createMemoryBackend(metrics?: TelemetryCollector): MemoryBackend {
    const config = { ...(this.memoryConfig ?? {}), metrics };

    switch (this.memoryType) {
      case 'memory':
        return new InMemoryBackend(config as InMemoryBackendConfig);
      case 'sqlite':
        return new SqliteBackend(config as SqliteBackendConfig);
      case 'redis':
        return new RedisBackend(config as RedisBackendConfig);
      default:
        throw new Error(`Unknown memory backend type: ${this.memoryType}`);
    }
  }
}

// ============================================================================
// BuiltAgent
// ============================================================================

/**
 * Lifecycle wrapper returned by AgentBuilder.build().
 *
 * Owns all composed resources and provides start/stop lifecycle
 * that properly initializes and cleans up everything.
 */
export class BuiltAgent {
  private _disputeOps?: DisputeOperations;
  private readonly logger: Logger;
  readonly telemetry: TelemetryCollector | undefined;
  readonly policyEngine: PolicyEngine | undefined;

  constructor(
    readonly autonomous: AutonomousAgent,
    readonly memory: MemoryBackend | undefined,
    readonly proofEngine: ProofEngine | undefined,
    readonly toolRegistry: ToolRegistry | undefined,
    private readonly skills: Skill[],
    private readonly connectionManager?: ConnectionManager,
    logger?: Logger,
    telemetry?: TelemetryCollector,
    policyEngine?: PolicyEngine,
  ) {
    this.logger = logger ?? silentLogger;
    this.telemetry = telemetry;
    this.policyEngine = policyEngine;
  }

  async start(): Promise<void> {
    await this.autonomous.start();
  }

  async stop(): Promise<void> {
    try {
      await this.autonomous.stop();
    } catch (e) {
      this.logger.error('Error stopping autonomous agent:', e);
    }

    for (const skill of this.skills) {
      try {
        await skill.shutdown();
      } catch (e) {
        this.logger.error(`Error shutting down skill ${skill.metadata.name}:`, e);
      }
    }

    if (this.memory) {
      try {
        await this.memory.close();
      } catch (e) {
        this.logger.error('Error closing memory backend:', e);
      }
    }

    if (this.proofEngine) {
      this.proofEngine.clearCache();
    }

    if (this.connectionManager) {
      this.connectionManager.destroy();
    }

    if (this.telemetry) {
      this.telemetry.destroy();
    }
  }

  /**
   * Lazy DisputeOperations — created after start() when program + agentId are available.
   */
  getDisputeOps(): DisputeOperations {
    if (this._disputeOps) return this._disputeOps;

    const program: Program<AgencCoordination> | null = this.autonomous.getProgram();
    if (!program) {
      throw new Error('Agent not started — call start() first');
    }

    const agentId = this.autonomous.getAgentId();
    if (!agentId) {
      throw new Error('Agent not registered — call start() first');
    }

    this._disputeOps = new DisputeOperations({
      program,
      agentId,
      metrics: this.telemetry,
    });

    return this._disputeOps;
  }

  getStats(): AutonomousAgentStats {
    return this.autonomous.getStats();
  }

  /**
   * Get a full telemetry snapshot (counters, gauges, bigintGauges, histograms).
   * Returns null if telemetry is not configured.
   */
  getTelemetrySnapshot(): TelemetrySnapshot | null {
    return this.telemetry?.getFullSnapshot() ?? null;
  }

  /**
   * Flush telemetry to all registered sinks.
   */
  flushTelemetry(): void {
    this.telemetry?.flush();
  }
}
