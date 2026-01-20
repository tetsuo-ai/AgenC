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

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { Program, AnchorProvider, Wallet } from '@coral-xyz/anchor';

import { AgentManager, type AgentManagerConfig, type AgentRegistrationConfig } from './agent/manager';
import { EventMonitor, type EventMonitorConfig } from './events';
import { TaskExecutor, type TaskExecutorConfig } from './task';
import { ToolRegistry, type ToolRegistryConfig, builtinTools } from './tools';
import { DefaultMemoryStore, InMemoryBackend, FileBackend, type MemoryStoreConfig } from './memory';
import { ProofEngine, type ProofEngineConfig } from './proof';
import { DisputeHandler, type DisputeHandlerConfig } from './dispute';
import { BaseLLMAdapter, AnthropicAdapter, OllamaAdapter, GrokAdapter } from './llm';

import type {
  AgentRuntimeConfig,
  AgentState,
  OperatingMode,
} from './types/config';
import type { OnChainTask, TaskHandler, TaskEvaluator, TaskResult } from './types/task';
import type { LLMAdapter, AnthropicConfig, GrokConfig, OllamaConfig } from './types/llm';
import type { Tool } from './types/tools';
import type { MemoryStore, MemoryBackend } from './types/memory';
import type { RuntimeEvent, RuntimeEventListener, EventType, EventHandler } from './types/events';

export interface RuntimeConfig {
  /** Solana connection */
  connection: Connection;
  /** Agent's keypair */
  wallet: Keypair;
  /** Program ID */
  programId: PublicKey;
  /** Program IDL */
  idl: object;

  // === Operating Mode ===
  /** Operating mode */
  mode?: OperatingMode;

  // === Agent Configuration ===
  /** Agent ID (32 bytes) */
  agentId: Buffer;
  /** Agent capabilities bitmask */
  capabilities?: bigint;
  /** Agent endpoint URL */
  endpoint?: string;
  /** Initial stake amount in lamports */
  stake?: bigint;

  // === Component Configuration ===
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

  // === Task Configuration ===
  /** Task evaluator for selecting tasks */
  taskEvaluator?: TaskEvaluator;
  /** Task handler for processing tasks */
  taskHandler?: TaskHandler;
  /** Polling interval for task discovery (ms) */
  pollInterval?: number;
  /** Maximum concurrent tasks */
  maxConcurrentTasks?: number;

  // === Event Configuration ===
  /** Event filter */
  eventFilter?: {
    taskIds?: Buffer[];
    agentIds?: Buffer[];
    eventTypes?: EventType[];
  };
}

export interface RuntimeStatus {
  running: boolean;
  mode: OperatingMode;
  agentState: AgentState | null;
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
export class AgentRuntime {
  private connection: Connection;
  private wallet: Keypair;
  private program: Program;
  private mode: OperatingMode;

  // Components
  private agentManager: AgentManager;
  private eventMonitor: EventMonitor;
  private taskExecutor: TaskExecutor;
  private toolRegistry: ToolRegistry;
  private memoryStore: MemoryStore;
  private proofEngine: ProofEngine;
  private disputeHandler: DisputeHandler;
  private llm: LLMAdapter | null;

  // State
  private running: boolean = false;
  private agentState: AgentState | null = null;
  private listeners: RuntimeEventListener[] = [];

  constructor(config: RuntimeConfig) {
    this.connection = config.connection;
    this.wallet = config.wallet;
    this.mode = config.mode ?? 'autonomous';

    // Create provider and program
    const provider = new AnchorProvider(
      config.connection,
      new Wallet(config.wallet),
      { commitment: 'confirmed' }
    );
    this.program = new Program(config.idl as any, provider);

    // Find agent PDA
    const [agentPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('agent'), config.agentId],
      config.programId
    );

    // Initialize components
    this.agentManager = new AgentManager({
      connection: config.connection,
      program: this.program,
      wallet: config.wallet,
      agentId: config.agentId,
    });

    this.eventMonitor = new EventMonitor({
      connection: config.connection,
      programId: config.programId,
      idl: config.idl,
    });

    // Set event filter if provided
    if (config.eventFilter) {
      this.eventMonitor.setFilter({
        taskIds: config.eventFilter.taskIds,
        agentIds: config.eventFilter.agentIds,
        eventTypes: config.eventFilter.eventTypes,
      });
    }

    this.taskExecutor = new TaskExecutor({
      connection: config.connection,
      program: this.program,
      wallet: config.wallet,
      agentPda,
      evaluator: config.taskEvaluator,
      pollInterval: config.pollInterval,
      maxConcurrentTasks: config.maxConcurrentTasks,
    });

    // Set task handler if provided
    if (config.taskHandler) {
      this.taskExecutor.onTask(config.taskHandler);
    }

    this.toolRegistry = new ToolRegistry(config.tools);
    // Register built-in tools
    this.toolRegistry.registerAll(builtinTools);

    // Initialize memory store
    const memoryBackend = config.memoryBackend ?? new InMemoryBackend();
    this.memoryStore = new DefaultMemoryStore({
      backend: memoryBackend,
      ...config.memory,
    });

    this.proofEngine = new ProofEngine(config.proof);

    this.disputeHandler = new DisputeHandler({
      connection: config.connection,
      program: this.program,
      wallet: config.wallet,
      agentPda,
    });

    this.llm = config.llm ?? null;

    // Wire up event forwarding
    this.setupEventForwarding();
  }

  /**
   * Start the runtime
   */
  async start(): Promise<void> {
    if (this.running) {
      throw new Error('Runtime is already running');
    }

    // Load memory state
    await this.memoryStore.load();

    // Check if agent is registered
    this.agentState = await this.agentManager.getState();

    // Connect event monitor
    await this.eventMonitor.connect();

    // Start task executor based on mode
    if (this.mode === 'autonomous' || this.mode === 'assisted') {
      await this.taskExecutor.start();
    }

    this.running = true;

    this.emit({
      type: 'started',
      agentId: this.agentManager.getAgentId(),
      mode: this.mode,
      timestamp: Date.now(),
    });
  }

  /**
   * Stop the runtime
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    // Stop task executor
    await this.taskExecutor.stop();

    // Disconnect event monitor
    await this.eventMonitor.disconnect();

    // Save memory state
    await this.memoryStore.save();

    const stats = this.taskExecutor.getStats();

    this.running = false;

    this.emit({
      type: 'stopped',
      agentId: this.agentManager.getAgentId(),
      completedCount: stats.completed,
      failedCount: stats.failed,
      timestamp: Date.now(),
    });
  }

  /**
   * Register the agent on-chain
   */
  async register(config: AgentRegistrationConfig): Promise<AgentState> {
    this.agentState = await this.agentManager.register(config);
    return this.agentState;
  }

  /**
   * Deregister the agent
   */
  async deregister(): Promise<bigint> {
    const stakeReturned = await this.agentManager.deregister();
    this.agentState = null;
    return stakeReturned;
  }

  /**
   * Set the task handler
   */
  onTask(handler: TaskHandler): void {
    this.taskExecutor.onTask(handler);
  }

  /**
   * Set the task evaluator
   */
  setEvaluator(evaluator: TaskEvaluator): void {
    this.taskExecutor.setEvaluator(evaluator);
  }

  /**
   * Register a tool
   */
  registerTool(tool: Tool): void {
    this.toolRegistry.register(tool);
  }

  /**
   * Register multiple tools
   */
  registerTools(tools: Tool[]): void {
    this.toolRegistry.registerAll(tools);
  }

  /**
   * Set the LLM adapter
   */
  setLLM(llm: LLMAdapter): void {
    this.llm = llm;
  }

  /**
   * Add a runtime event listener
   */
  on(listener: RuntimeEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index !== -1) {
        this.listeners.splice(index, 1);
      }
    };
  }

  /**
   * Subscribe to on-chain events
   */
  onEvent<T extends EventType>(eventType: T, handler: EventHandler<T>): () => void {
    return this.eventMonitor.on(eventType, handler);
  }

  /**
   * Get runtime status
   */
  async getStatus(): Promise<RuntimeStatus> {
    const taskStats = this.taskExecutor.getStats();
    const proofStats = this.proofEngine.getStatus();
    const memoryStats = await (this.memoryStore as DefaultMemoryStore).getStats();

    return {
      running: this.running,
      mode: this.mode,
      agentState: this.agentState,
      taskCount: {
        pending: taskStats.pending,
        executing: taskStats.executing,
        completed: taskStats.completed,
        failed: taskStats.failed,
      },
      proofStats: {
        pending: proofStats.pending,
        completed: proofStats.completed,
        failed: proofStats.failed,
      },
      memoryStats: {
        messageCount: memoryStats.messageCount,
        taskHistoryCount: memoryStats.taskHistoryCount,
      },
    };
  }

  // === Component Accessors ===

  getAgentManager(): AgentManager {
    return this.agentManager;
  }

  getEventMonitor(): EventMonitor {
    return this.eventMonitor;
  }

  getTaskExecutor(): TaskExecutor {
    return this.taskExecutor;
  }

  getToolRegistry(): ToolRegistry {
    return this.toolRegistry;
  }

  getMemoryStore(): MemoryStore {
    return this.memoryStore;
  }

  getProofEngine(): ProofEngine {
    return this.proofEngine;
  }

  getDisputeHandler(): DisputeHandler {
    return this.disputeHandler;
  }

  getLLM(): LLMAdapter | null {
    return this.llm;
  }

  // === Private Methods ===

  private setupEventForwarding(): void {
    // Forward task executor events
    this.taskExecutor.on((event) => {
      this.emit(event);
    });

    // Forward relevant on-chain events to dispute handler
    this.eventMonitor.on('disputeInitiated', (event) => {
      this.disputeHandler.handleDisputeInitiated(event);
    });

    this.eventMonitor.on('disputeVoteCast', (event) => {
      this.disputeHandler.handleDisputeVoteCast(event);
    });

    this.eventMonitor.on('disputeResolved', (event) => {
      this.disputeHandler.handleDisputeResolved(event);
    });

    this.eventMonitor.on('disputeExpired', (event) => {
      this.disputeHandler.handleDisputeExpired(event);
    });

    // Handle reconnection events
    this.eventMonitor.on('taskCreated', async () => {
      // Trigger task discovery when new tasks are created
      if (this.running && (this.mode === 'autonomous' || this.mode === 'assisted')) {
        try {
          await this.taskExecutor.discoverTasks();
        } catch {
          // Ignore discovery errors, will retry on next poll
        }
      }
    });
  }

  private emit(event: RuntimeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error('Error in runtime event listener:', error);
      }
    }
  }
}

/**
 * Create an AgentRuntime instance
 */
export function createRuntime(config: RuntimeConfig): AgentRuntime {
  return new AgentRuntime(config);
}

// Re-export LLM adapter factories for convenience
export function createAnthropicLLM(config: { apiKey: string; model?: string }): LLMAdapter {
  return new AnthropicAdapter({
    ...config,
    model: config.model as AnthropicConfig['model'],
  } as AnthropicConfig);
}

export function createOllamaLLM(config: { model: string; baseUrl?: string }): LLMAdapter {
  return new OllamaAdapter(config as OllamaConfig);
}

export function createGrokLLM(config: { apiKey: string; model?: string }): LLMAdapter {
  return new GrokAdapter({
    ...config,
    model: config.model as GrokConfig['model'],
  } as GrokConfig);
}
