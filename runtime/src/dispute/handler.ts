/**
 * DisputeHandler for managing dispute lifecycle
 *
 * Handles dispute initiation, voting, and resolution for agents.
 */

import { Connection, PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { Program, AnchorProvider, BN } from '@coral-xyz/anchor';
import type {
  DisputeInitiatedEvent,
  DisputeVoteCastEvent,
  DisputeResolvedEvent,
  DisputeExpiredEvent,
} from '../types/events';

export interface DisputeHandlerConfig {
  /** Solana connection */
  connection: Connection;
  /** Program instance */
  program: Program;
  /** Agent's keypair */
  wallet: Keypair;
  /** Agent's registration PDA */
  agentPda: PublicKey;
}

export enum DisputeStatus {
  Active = 'active',
  Resolved = 'resolved',
  Expired = 'expired',
}

export enum ResolutionType {
  RefundCreator = 0,
  PayWorker = 1,
  Split = 2,
  Arbitration = 3,
}

export interface Dispute {
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

export interface VoteRecord {
  disputeId: Buffer;
  voter: PublicKey;
  approved: boolean;
  votedAt: number;
}

export interface DisputeStats {
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
export class DisputeHandler {
  private connection: Connection;
  private program: Program;
  private wallet: Keypair;
  private agentPda: PublicKey;

  private activeDisputes: Map<string, Dispute> = new Map();
  private voteRecords: Map<string, VoteRecord[]> = new Map();
  private stats: DisputeStats = {
    initiated: 0,
    votedOn: 0,
    resolved: 0,
    expired: 0,
    wonAsInitiator: 0,
    lostAsInitiator: 0,
  };

  private eventHandlers: DisputeEventHandler = {};

  constructor(config: DisputeHandlerConfig) {
    this.connection = config.connection;
    this.program = config.program;
    this.wallet = config.wallet;
    this.agentPda = config.agentPda;
  }

  /**
   * Set event handlers
   */
  setEventHandlers(handlers: DisputeEventHandler): void {
    this.eventHandlers = { ...this.eventHandlers, ...handlers };
  }

  /**
   * Initiate a dispute for a task
   */
  async initiateDispute(
    taskPda: PublicKey,
    resolutionType: ResolutionType,
    evidence?: string
  ): Promise<{ disputePda: PublicKey; txSignature: string }> {
    // Generate dispute ID
    const disputeId = this.generateDisputeId();

    // Find dispute PDA
    const [disputePda] = PublicKey.findProgramAddressSync(
      [Buffer.from('dispute'), disputeId],
      this.program.programId
    );

    // Find protocol config PDA
    const [protocolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('protocol')],
      this.program.programId
    );

    try {
      const tx = await (this.program.methods as any)
        .initiateDispute(
          Array.from(disputeId),
          resolutionType,
          evidence ?? ''
        )
        .accounts({
          initiator: this.wallet.publicKey,
          agent: this.agentPda,
          task: taskPda,
          dispute: disputePda,
          protocol: protocolPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([this.wallet])
        .rpc();

      this.stats.initiated++;

      return {
        disputePda,
        txSignature: tx,
      };
    } catch (error) {
      throw new Error(`Failed to initiate dispute: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Vote on a dispute (requires ARBITER capability)
   */
  async voteOnDispute(
    disputePda: PublicKey,
    approve: boolean
  ): Promise<{ txSignature: string }> {
    // Find vote PDA
    const [votePda] = PublicKey.findProgramAddressSync(
      [Buffer.from('vote'), disputePda.toBytes(), this.wallet.publicKey.toBytes()],
      this.program.programId
    );

    try {
      const tx = await (this.program.methods as any)
        .voteDispute(approve)
        .accounts({
          voter: this.wallet.publicKey,
          agent: this.agentPda,
          dispute: disputePda,
          vote: votePda,
          systemProgram: SystemProgram.programId,
        })
        .signers([this.wallet])
        .rpc();

      this.stats.votedOn++;

      return {
        txSignature: tx,
      };
    } catch (error) {
      throw new Error(`Failed to vote on dispute: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Resolve a dispute (after voting deadline)
   */
  async resolveDispute(
    disputePda: PublicKey,
    taskPda: PublicKey,
    escrowPda: PublicKey,
    workerPda?: PublicKey,
    workerClaimPda?: PublicKey
  ): Promise<{ txSignature: string; resolution: ResolutionType }> {
    // Find protocol config PDA
    const [protocolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('protocol')],
      this.program.programId
    );

    try {
      // Fetch protocol to get treasury
      const protocol = await (this.program.account as any).protocolConfig.fetch(protocolPda);

      const tx = await (this.program.methods as any)
        .resolveDispute()
        .accountsPartial({
          resolver: this.wallet.publicKey,
          dispute: disputePda,
          task: taskPda,
          escrow: escrowPda,
          protocol: protocolPda,
          treasury: protocol.treasury,
          worker: workerPda ?? null,
          workerClaim: workerClaimPda ?? null,
          systemProgram: SystemProgram.programId,
        })
        .signers([this.wallet])
        .rpc();

      this.stats.resolved++;

      // Fetch dispute to get resolution
      const dispute = await (this.program.account as any).dispute.fetch(disputePda);

      return {
        txSignature: tx,
        resolution: dispute.resolution as ResolutionType,
      };
    } catch (error) {
      throw new Error(`Failed to resolve dispute: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Expire a dispute that has passed its deadline without resolution
   */
  async expireDispute(
    disputePda: PublicKey,
    taskPda: PublicKey,
    escrowPda: PublicKey
  ): Promise<{ txSignature: string; refundAmount: bigint }> {
    try {
      // Fetch task to get creator for refund
      const task = await (this.program.account as any).task.fetch(taskPda);

      const tx = await (this.program.methods as any)
        .expireDispute()
        .accounts({
          dispute: disputePda,
          task: taskPda,
          escrow: escrowPda,
          creator: task.creator,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      this.stats.expired++;

      // Fetch the refund amount from the task
      const refundAmount = BigInt(task.reward.toString());

      return {
        txSignature: tx,
        refundAmount,
      };
    } catch (error) {
      throw new Error(`Failed to expire dispute: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Fetch a dispute's current state
   */
  async getDispute(disputePda: PublicKey): Promise<Dispute | null> {
    try {
      const dispute = await (this.program.account as any).dispute.fetch(disputePda);

      return {
        disputeId: Buffer.from(dispute.disputeId),
        taskId: Buffer.from(dispute.taskId),
        initiator: dispute.initiator,
        resolutionType: dispute.resolutionType,
        votingDeadline: dispute.votingDeadline.toNumber(),
        votesFor: BigInt(dispute.votesFor.toString()),
        votesAgainst: BigInt(dispute.votesAgainst.toString()),
        status: dispute.resolved
          ? DisputeStatus.Resolved
          : Date.now() / 1000 > dispute.votingDeadline.toNumber()
            ? DisputeStatus.Expired
            : DisputeStatus.Active,
        resolved: dispute.resolved,
        resolution: dispute.resolved ? dispute.resolution : undefined,
      };
    } catch {
      return null;
    }
  }

  /**
   * Get all active disputes for a task
   */
  async getDisputesForTask(taskPda: PublicKey): Promise<Dispute[]> {
    try {
      const disputes = await (this.program.account as any).dispute.all([
        {
          memcmp: {
            offset: 8, // After discriminator
            bytes: taskPda.toBase58(),
          },
        },
      ]);

      return disputes.map((d: any) => ({
        disputeId: Buffer.from(d.account.disputeId),
        taskId: Buffer.from(d.account.taskId),
        initiator: d.account.initiator,
        resolutionType: d.account.resolutionType,
        votingDeadline: d.account.votingDeadline.toNumber(),
        votesFor: BigInt(d.account.votesFor.toString()),
        votesAgainst: BigInt(d.account.votesAgainst.toString()),
        status: d.account.resolved
          ? DisputeStatus.Resolved
          : Date.now() / 1000 > d.account.votingDeadline.toNumber()
            ? DisputeStatus.Expired
            : DisputeStatus.Active,
        resolved: d.account.resolved,
        resolution: d.account.resolved ? d.account.resolution : undefined,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Check if the agent has already voted on a dispute
   */
  async hasVoted(disputePda: PublicKey): Promise<boolean> {
    const [votePda] = PublicKey.findProgramAddressSync(
      [Buffer.from('vote'), disputePda.toBytes(), this.wallet.publicKey.toBytes()],
      this.program.programId
    );

    try {
      await (this.program.account as any).disputeVote.fetch(votePda);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get dispute statistics
   */
  getStats(): DisputeStats {
    return { ...this.stats };
  }

  /**
   * Handle a dispute initiated event
   */
  handleDisputeInitiated(event: DisputeInitiatedEvent): void {
    const dispute: Dispute = {
      disputeId: event.disputeId,
      taskId: event.taskId,
      initiator: event.initiator,
      resolutionType: event.resolutionType,
      votingDeadline: event.votingDeadline,
      votesFor: 0n,
      votesAgainst: 0n,
      status: DisputeStatus.Active,
      resolved: false,
    };

    this.activeDisputes.set(event.disputeId.toString('hex'), dispute);

    if (event.initiator.equals(this.wallet.publicKey)) {
      this.stats.initiated++;
    }

    this.eventHandlers.onInitiated?.(event);
  }

  /**
   * Handle a dispute vote cast event
   */
  handleDisputeVoteCast(event: DisputeVoteCastEvent): void {
    const disputeKey = event.disputeId.toString('hex');
    const dispute = this.activeDisputes.get(disputeKey);

    if (dispute) {
      dispute.votesFor = event.votesFor;
      dispute.votesAgainst = event.votesAgainst;
    }

    // Track vote record
    const records = this.voteRecords.get(disputeKey) ?? [];
    records.push({
      disputeId: event.disputeId,
      voter: event.voter,
      approved: event.approved,
      votedAt: event.timestamp,
    });
    this.voteRecords.set(disputeKey, records);

    if (event.voter.equals(this.wallet.publicKey)) {
      this.stats.votedOn++;
    }

    this.eventHandlers.onVoteCast?.(event);
  }

  /**
   * Handle a dispute resolved event
   */
  handleDisputeResolved(event: DisputeResolvedEvent): void {
    const disputeKey = event.disputeId.toString('hex');
    const dispute = this.activeDisputes.get(disputeKey);

    if (dispute) {
      dispute.status = DisputeStatus.Resolved;
      dispute.resolved = true;
      dispute.resolution = event.resolutionType;
      dispute.votesFor = event.votesFor;
      dispute.votesAgainst = event.votesAgainst;

      // Track win/loss for initiator
      if (dispute.initiator.equals(this.wallet.publicKey)) {
        const initiatorWon = event.resolutionType === dispute.resolutionType;
        if (initiatorWon) {
          this.stats.wonAsInitiator++;
        } else {
          this.stats.lostAsInitiator++;
        }
      }
    }

    this.stats.resolved++;
    this.eventHandlers.onResolved?.(event);
  }

  /**
   * Handle a dispute expired event
   */
  handleDisputeExpired(event: DisputeExpiredEvent): void {
    const disputeKey = event.disputeId.toString('hex');
    const dispute = this.activeDisputes.get(disputeKey);

    if (dispute) {
      dispute.status = DisputeStatus.Expired;
    }

    this.stats.expired++;
    this.eventHandlers.onExpired?.(event);
  }

  /**
   * Generate a unique dispute ID
   */
  private generateDisputeId(): Buffer {
    const id = Buffer.alloc(32);
    const timestamp = BigInt(Date.now());
    const random = crypto.getRandomValues(new Uint8Array(24));

    // First 8 bytes: timestamp
    for (let i = 0; i < 8; i++) {
      id[i] = Number((timestamp >> BigInt(8 * (7 - i))) & 0xffn);
    }

    // Remaining 24 bytes: random
    id.set(random, 8);

    return id;
  }
}

/**
 * Create a DisputeHandler instance
 */
export function createDisputeHandler(config: DisputeHandlerConfig): DisputeHandler {
  return new DisputeHandler(config);
}
