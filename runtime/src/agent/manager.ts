/**
 * AgentManager - Manages agent on-chain identity and lifecycle
 */

import { PublicKey, SystemProgram } from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';
import type { Program } from '@coral-xyz/anchor';
import type { Connection, Keypair } from '@solana/web3.js';
import {
  AgentState,
  AgentStatus,
  Logger,
  generateAgentId,
} from '../types/config';

/**
 * Agent registration configuration
 */
export interface AgentRegistrationConfig {
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
 * Protocol configuration from on-chain
 */
interface ProtocolConfig {
  taskCreationCooldown: number;
  maxTasksPer24h: number;
  disputeInitiationCooldown: number;
  maxDisputesPer24h: number;
}

/**
 * AgentManager constructor configuration
 */
export interface AgentManagerConfig {
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
export class AgentManager {
  private connection: Connection;
  private wallet: Keypair;
  private program: Program;
  private agentId: Buffer;
  private logger: Logger;
  private state: AgentState | null = null;
  private protocolPda: PublicKey;
  private agentPda: PublicKey;
  private protocolConfig: ProtocolConfig | null = null;

  constructor(config: AgentManagerConfig) {
    this.connection = config.connection;
    this.wallet = config.wallet;
    this.program = config.program;
    this.agentId = config.agentId;
    this.logger = config.logger ?? console;

    // Derive protocol PDA
    const [protocolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('protocol')],
      config.program.programId
    );
    this.protocolPda = protocolPda;

    // Derive agent PDA
    const [agentPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('agent'), config.agentId],
      config.program.programId
    );
    this.agentPda = agentPda;
  }

  /**
   * Get the agent ID
   */
  getAgentId(): Buffer {
    return this.agentId;
  }

  /**
   * Get the agent PDA
   */
  getAgentPda(): PublicKey {
    return this.agentPda;
  }

  /**
   * Get current agent state
   */
  getState(): AgentState | null {
    return this.state;
  }

  /**
   * Check if agent is registered
   */
  isRegistered(): boolean {
    return this.state?.registered ?? false;
  }

  /**
   * Register agent on-chain
   */
  async register(config: AgentRegistrationConfig): Promise<AgentState> {
    // Check if already registered
    try {
      const existing = await this.fetchAgentAccount(this.agentPda);
      if (existing) {
        this.logger.info?.('Agent already registered', { agentId: this.agentId.toString('hex') });
        this.state = existing;
        return existing;
      }
    } catch {
      // Not registered, continue
    }

    this.logger.info?.('Registering agent', {
      agentId: this.agentId.toString('hex'),
      capabilities: config.capabilities.toString(),
    });

    const stake = config.initialStake ?? 0n;

    // Call register_agent instruction
    await (this.program.methods as any)
      .registerAgent(
        Array.from(this.agentId),
        new BN(config.capabilities.toString()),
        config.endpoint ?? '',
        null, // delegatedSigner
        new BN(stake.toString())
      )
      .accountsPartial({
        agent: this.agentPda,
        protocolConfig: this.protocolPda,
        authority: this.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([this.wallet])
      .rpc();

    // Fetch the created state
    this.state = await this.fetchAgentAccount(this.agentPda);
    if (!this.state) {
      throw new Error('Failed to fetch agent state after registration');
    }

    this.logger.info?.('Agent registered successfully', { pda: this.agentPda.toBase58() });
    return this.state;
  }

  /**
   * Deregister agent from protocol
   */
  async deregister(): Promise<bigint> {
    if (!this.state) {
      throw new Error('Agent not registered');
    }

    if (this.state.activeTasks > 0) {
      throw new Error('Cannot deregister with active tasks');
    }

    this.logger.info?.('Deregistering agent', { agentId: this.state.agentId.toString('hex') });

    const stakeToReturn = this.state.stake;

    await this.program.methods
      .deregisterAgent()
      .accountsPartial({
        agent: this.state.pda,
        protocolConfig: this.protocolPda,
        authority: this.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([this.wallet])
      .rpc();

    this.logger.info?.('Agent deregistered', { stakeReturned: stakeToReturn.toString() });
    this.state = null;

    return stakeToReturn;
  }

  /**
   * Update agent status
   */
  async updateStatus(status: AgentStatus): Promise<void> {
    if (!this.state) {
      throw new Error('Agent not registered');
    }

    this.logger.debug?.('Updating agent status', {
      from: AgentStatus[this.state.status],
      to: AgentStatus[status],
    });

    await this.program.methods
      .updateAgent(
        new BN(this.state.capabilities.toString()),
        status,
        this.state.endpoint,
        this.state.metadataUri
      )
      .accountsPartial({
        agent: this.state.pda,
        authority: this.wallet.publicKey,
      })
      .signers([this.wallet])
      .rpc();

    this.state.status = status;
  }

  /**
   * Update agent capabilities
   */
  async updateCapabilities(capabilities: bigint): Promise<void> {
    if (!this.state) {
      throw new Error('Agent not registered');
    }

    this.logger.debug?.('Updating agent capabilities', {
      old: this.state.capabilities.toString(),
      new: capabilities.toString(),
    });

    await this.program.methods
      .updateAgent(
        new BN(capabilities.toString()),
        this.state.status,
        this.state.endpoint,
        this.state.metadataUri
      )
      .accountsPartial({
        agent: this.state.pda,
        authority: this.wallet.publicKey,
      })
      .signers([this.wallet])
      .rpc();

    this.state.capabilities = capabilities;
  }

  /**
   * Update agent endpoint
   */
  async updateEndpoint(endpoint: string): Promise<void> {
    if (!this.state) {
      throw new Error('Agent not registered');
    }

    if (endpoint.length > 128) {
      throw new Error('Endpoint must be <= 128 characters');
    }

    await this.program.methods
      .updateAgent(
        new BN(this.state.capabilities.toString()),
        this.state.status,
        endpoint,
        this.state.metadataUri
      )
      .accountsPartial({
        agent: this.state.pda,
        authority: this.wallet.publicKey,
      })
      .signers([this.wallet])
      .rpc();

    this.state.endpoint = endpoint;
  }

  /**
   * Refresh agent state from on-chain
   */
  async refresh(): Promise<AgentState> {
    if (!this.state) {
      throw new Error('Agent not registered');
    }

    const updated = await this.fetchAgentAccount(this.state.pda);
    if (!updated) {
      throw new Error('Agent account not found');
    }

    this.state = updated;
    return this.state;
  }

  /**
   * Check if agent is rate limited for task creation
   */
  isRateLimited(): boolean {
    if (!this.state || !this.protocolConfig) {
      return false;
    }

    const now = Math.floor(Date.now() / 1000);

    // Check cooldown
    if (this.protocolConfig.taskCreationCooldown > 0) {
      const cooldownEnds = this.state.lastTaskCreated + this.protocolConfig.taskCreationCooldown;
      if (now < cooldownEnds) {
        return true;
      }
    }

    // Check 24h limit
    if (this.protocolConfig.maxTasksPer24h > 0) {
      // Reset if window expired
      const windowExpired = now - this.state.rateLimitWindowStart >= 86400;
      if (!windowExpired && this.state.taskCount24h >= this.protocolConfig.maxTasksPer24h) {
        return true;
      }
    }

    return false;
  }

  /**
   * Get rate limit budget
   */
  getRateLimitBudget(): { tasksRemaining: number; cooldownEnds: number } {
    if (!this.state || !this.protocolConfig) {
      return { tasksRemaining: 0, cooldownEnds: 0 };
    }

    const now = Math.floor(Date.now() / 1000);

    // Calculate cooldown end
    let cooldownEnds = 0;
    if (this.protocolConfig.taskCreationCooldown > 0 && this.state.lastTaskCreated > 0) {
      cooldownEnds = this.state.lastTaskCreated + this.protocolConfig.taskCreationCooldown;
      if (cooldownEnds < now) cooldownEnds = 0;
    }

    // Calculate tasks remaining
    let tasksRemaining = this.protocolConfig.maxTasksPer24h;
    if (this.protocolConfig.maxTasksPer24h > 0) {
      const windowExpired = now - this.state.rateLimitWindowStart >= 86400;
      if (!windowExpired) {
        tasksRemaining = Math.max(0, this.protocolConfig.maxTasksPer24h - this.state.taskCount24h);
      }
    }

    return { tasksRemaining, cooldownEnds };
  }

  /**
   * Load protocol configuration
   */
  async loadProtocolConfig(): Promise<void> {
    try {
      const accounts = this.program.account as Record<string, { fetch: (key: PublicKey) => Promise<unknown> }>;
      const config = await accounts['protocolConfig'].fetch(this.protocolPda) as {
        taskCreationCooldown: { toNumber: () => number };
        maxTasksPer24h: number;
        disputeInitiationCooldown: { toNumber: () => number };
        maxDisputesPer24h: number;
      };

      this.protocolConfig = {
        taskCreationCooldown: config.taskCreationCooldown.toNumber(),
        maxTasksPer24h: config.maxTasksPer24h,
        disputeInitiationCooldown: config.disputeInitiationCooldown.toNumber(),
        maxDisputesPer24h: config.maxDisputesPer24h,
      };

      this.logger.debug?.('Loaded protocol config', this.protocolConfig);
    } catch (error) {
      this.logger.warn?.('Failed to load protocol config', { error });
    }
  }

  /**
   * Get agent's reputation score
   */
  getReputation(): number {
    return this.state?.reputation ?? 0;
  }

  /**
   * Get agent PDA
   */
  getPda(): PublicKey | null {
    return this.state?.pda ?? null;
  }

  /**
   * Fetch and parse agent account
   */
  private async fetchAgentAccount(pda: PublicKey): Promise<AgentState | null> {
    try {
      const accounts = this.program.account as Record<string, { fetch: (key: PublicKey) => Promise<unknown> }>;
      const account = await accounts['agentRegistration'].fetch(pda) as {
        agentId: number[];
        authority: PublicKey;
        capabilities: { toString: () => string };
        status: { inactive?: unknown; active?: unknown; busy?: unknown; suspended?: unknown };
        endpoint: string;
        metadataUri: string;
        registeredAt: { toNumber: () => number };
        lastActive: { toNumber: () => number };
        tasksCompleted: { toNumber: () => number };
        totalEarned: { toString: () => string };
        reputation: number;
        activeTasks: number;
        stake: { toString: () => string };
        lastTaskCreated: { toNumber: () => number };
        lastDisputeInitiated: { toNumber: () => number };
        taskCount24h: number;
        disputeCount24h: number;
        rateLimitWindowStart: { toNumber: () => number };
      };

      const status = account.status.inactive !== undefined ? AgentStatus.Inactive
        : account.status.active !== undefined ? AgentStatus.Active
        : account.status.busy !== undefined ? AgentStatus.Busy
        : AgentStatus.Suspended;

      return {
        pda,
        agentId: Buffer.from(account.agentId),
        authority: account.authority,
        capabilities: BigInt(account.capabilities.toString()),
        status,
        endpoint: account.endpoint,
        metadataUri: account.metadataUri,
        registeredAt: account.registeredAt.toNumber(),
        lastActive: account.lastActive.toNumber(),
        tasksCompleted: account.tasksCompleted.toNumber(),
        totalEarned: BigInt(account.totalEarned.toString()),
        reputation: account.reputation,
        activeTasks: account.activeTasks,
        stake: BigInt(account.stake.toString()),
        registered: true,
        lastTaskCreated: account.lastTaskCreated.toNumber(),
        lastDisputeInitiated: account.lastDisputeInitiated.toNumber(),
        taskCount24h: account.taskCount24h,
        disputeCount24h: account.disputeCount24h,
        rateLimitWindowStart: account.rateLimitWindowStart.toNumber(),
      };
    } catch {
      return null;
    }
  }
}
