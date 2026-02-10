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
} from './autonomous/types.js';
import { DisputeOperations } from './dispute/operations.js';
import type { AgencCoordination } from './types/agenc_coordination.js';
import type { Program } from '@coral-xyz/anchor';

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
  onEarnings?: (amount: bigint, task: Task) => void;
  onProofGenerated?: (task: Task, proofSizeBytes: number, durationMs: number) => void;
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

  // Callbacks
  private callbacks?: AgentCallbacks;

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

  withCallbacks(callbacks: AgentCallbacks): this {
    this.callbacks = callbacks;
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

    const { registry, initializedSkills } = await this.buildToolRegistry(logger, builderWallet);
    const memory = this.memoryType ? this.createMemoryBackend() : undefined;
    const taskExecutor = this.buildExecutor(registry, memory);
    const proofEngine = this.proofConfig
      ? new ProofEngine({ ...this.proofConfig, logger })
      : undefined;
    const autonomous = this.buildAutonomousAgent(taskExecutor, proofEngine, memory);

    return new BuiltAgent(autonomous, memory, proofEngine, registry, initializedSkills, logger);
  }

  private async buildToolRegistry(
    logger: Logger,
    wallet: Wallet,
  ): Promise<{ registry: ToolRegistry | undefined; initializedSkills: Skill[] }> {
    const hasTools = this.customTools.length > 0 || this.skillEntries.length > 0 || this.useAgencTools;
    if (!hasTools) return { registry: undefined, initializedSkills: [] };

    const registry = new ToolRegistry({ logger });
    const initializedSkills: Skill[] = [];

    for (const entry of this.skillEntries) {
      const ctx: SkillContext = { connection: this.connection, wallet, logger };
      await entry.skill.initialize(ctx);
      initializedSkills.push(entry.skill);
      registry.registerAll(skillToTools(entry.skill, { schemas: entry.schemas }));
    }

    for (const tool of this.customTools) {
      registry.register(tool);
    }

    if (this.useAgencTools) {
      registry.registerAll(createAgencTools({ connection: this.connection, logger }));
    }

    return { registry, initializedSkills };
  }

  private buildExecutor(registry: ToolRegistry | undefined, memory: MemoryBackend | undefined): TaskExecutor {
    if (this.executor) return this.executor;

    const provider = this.createLLMProvider(registry?.toLLMTools());
    return new LLMTaskExecutor({
      provider,
      systemPrompt: this.systemPrompt,
      toolHandler: registry?.createToolHandler(),
      memory,
    });
  }

  private buildAutonomousAgent(
    executor: TaskExecutor,
    proofEngine: ProofEngine | undefined,
    memory: MemoryBackend | undefined,
  ): AutonomousAgent {
    return new AutonomousAgent({
      connection: this.connection,
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
      taskFilter: this.taskFilter,
      claimStrategy: this.claimStrategy,
      discoveryMode: this.discoveryMode,
      scanIntervalMs: this.scanIntervalMs,
      maxConcurrentTasks: this.maxConcurrentTasks,
      onTaskDiscovered: this.callbacks?.onTaskDiscovered,
      onTaskClaimed: this.callbacks?.onTaskClaimed,
      onTaskExecuted: this.callbacks?.onTaskExecuted,
      onTaskCompleted: this.callbacks?.onTaskCompleted,
      onTaskFailed: this.callbacks?.onTaskFailed,
      onEarnings: this.callbacks?.onEarnings,
      onProofGenerated: this.callbacks?.onProofGenerated,
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

  private createMemoryBackend(): MemoryBackend {
    const config = this.memoryConfig ?? {};

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

  constructor(
    readonly autonomous: AutonomousAgent,
    readonly memory: MemoryBackend | undefined,
    readonly proofEngine: ProofEngine | undefined,
    readonly toolRegistry: ToolRegistry | undefined,
    private readonly skills: Skill[],
    logger?: Logger,
  ) {
    this.logger = logger ?? silentLogger;
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
    });

    return this._disputeOps;
  }

  getStats(): AutonomousAgentStats {
    return this.autonomous.getStats();
  }
}
