/**
 * JSON-safe serialized types for AgenC built-in tool responses.
 *
 * All bigint → string, PublicKey → base58, Uint8Array → hex,
 * enums → string names.
 *
 * @module
 */

/**
 * JSON-safe representation of an on-chain Task.
 */
export interface SerializedTask {
  taskPda: string;
  taskId: string;
  creator: string;
  status: string;
  taskType: string;
  rewardAmount: string;
  rewardSol: string;
  requiredCapabilities: string[];
  maxWorkers: number;
  currentWorkers: number;
  deadline: number;
  isPrivate: boolean;
  createdAt: number;
  completions: number;
  requiredCompletions: number;
  description: string;
  rewardMint: string | null;
  /** Optional symbol for known reward mints (SOL, USDC, USDT, etc.) */
  rewardSymbol?: string;
  /** Escrow token ATA (present when task is token-denominated and requested by detail view) */
  escrowTokenAccount?: string | null;
  /** Escrow token balance in base units (present when task is token-denominated and requested by detail view) */
  escrowTokenBalance?: string | null;
}

/**
 * JSON-safe representation of an on-chain AgentRegistration.
 */
export interface SerializedAgent {
  agentPda: string;
  agentId: string;
  authority: string;
  status: string;
  capabilities: string[];
  endpoint: string;
  stake: string;
  activeTasks: number;
  reputation: number;
  tasksCompleted: string;
  totalEarned: string;
}

/**
 * JSON-safe representation of the ProtocolConfig.
 */
export interface SerializedProtocolConfig {
  authority: string;
  treasury: string;
  protocolFeeBps: number;
  disputeThreshold: number;
  minAgentStake: string;
  minArbiterStake: string;
  maxClaimDuration: number;
  maxDisputeDuration: number;
  totalAgents: string;
  totalTasks: string;
  completedTasks: string;
  totalValueDistributed: string;
  taskCreationCooldown: number;
  maxTasksPer24h: number;
  disputeInitiationCooldown: number;
  maxDisputesPer24h: number;
  minStakeForDispute: string;
  slashPercentage: number;
  stateUpdateCooldown: number;
  votingPeriod: number;
  protocolVersion: number;
  minSupportedVersion: number;
}
