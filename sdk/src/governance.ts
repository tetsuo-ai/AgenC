/**
 * Governance module — enums, PDA helpers, instruction wrappers, and CU budget constants.
 */

import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import anchor, { type Program } from "@coral-xyz/anchor";
import { PROGRAM_ID, SEEDS } from "./constants.js";
import { getAccount } from "./anchor-utils.js";
import { deriveProtocolPda } from "./protocol.js";
import { toBigInt, toNumber } from "./utils/numeric.js";

// ============================================================================
// Enums
// ============================================================================

export enum ProposalType {
  ProtocolUpgrade = 0,
  FeeChange = 1,
  TreasurySpend = 2,
  RateLimitChange = 3,
}

export enum ProposalStatus {
  Active = 0,
  Executed = 1,
  Defeated = 2,
  Cancelled = 3,
}

// ============================================================================
// State types
// ============================================================================

export interface ProposalState {
  proposer: PublicKey;
  proposerAuthority: PublicKey;
  nonce: bigint;
  proposalType: ProposalType;
  titleHash: Uint8Array;
  descriptionHash: Uint8Array;
  payload: Uint8Array;
  status: ProposalStatus;
  createdAt: number;
  votingDeadline: number;
  executionAfter: number;
  executedAt: number;
  votesFor: bigint;
  votesAgainst: bigint;
  totalVoters: number;
  quorum: bigint;
  bump: number;
}

function parseProposalType(raw: unknown): ProposalType {
  if (typeof raw === "number") return raw as ProposalType;
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if ("protocolUpgrade" in obj || "protocol_upgrade" in obj)
      return ProposalType.ProtocolUpgrade;
    if ("feeChange" in obj || "fee_change" in obj)
      return ProposalType.FeeChange;
    if ("treasurySpend" in obj || "treasury_spend" in obj)
      return ProposalType.TreasurySpend;
    if ("rateLimitChange" in obj || "rate_limit_change" in obj)
      return ProposalType.RateLimitChange;
  }
  return ProposalType.ProtocolUpgrade;
}

function parseProposalStatus(raw: unknown): ProposalStatus {
  if (typeof raw === "number") return raw as ProposalStatus;
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if ("active" in obj) return ProposalStatus.Active;
    if ("executed" in obj) return ProposalStatus.Executed;
    if ("defeated" in obj) return ProposalStatus.Defeated;
    if ("cancelled" in obj) return ProposalStatus.Cancelled;
  }
  return ProposalStatus.Active;
}

// ============================================================================
// PDA helpers
// ============================================================================

export function deriveGovernanceConfigPda(
  programId: PublicKey = PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([SEEDS.GOVERNANCE], programId);
}

export function deriveProposalPda(
  proposerAgentPda: PublicKey,
  nonce: bigint | number,
  programId: PublicKey = PROGRAM_ID,
): [PublicKey, number] {
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64LE(BigInt(nonce));
  return PublicKey.findProgramAddressSync(
    [SEEDS.PROPOSAL, proposerAgentPda.toBuffer(), nonceBuf],
    programId,
  );
}

export function deriveGovernanceVotePda(
  proposalPda: PublicKey,
  voterAuthorityPubkey: PublicKey,
  programId: PublicKey = PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      SEEDS.GOVERNANCE_VOTE,
      proposalPda.toBuffer(),
      voterAuthorityPubkey.toBuffer(),
    ],
    programId,
  );
}

// ============================================================================
// Instruction wrappers
// ============================================================================

export interface InitializeGovernanceParams {
  votingPeriod: number | bigint;
  executionDelay: number | bigint;
  quorumBps: number;
  approvalThresholdBps: number;
  minProposalStake: number | bigint;
}

export interface CreateProposalParams {
  proposerAgentPda: PublicKey;
  nonce: number | bigint;
  proposalType: number;
  titleHash: Uint8Array | number[];
  descriptionHash: Uint8Array | number[];
  payload: Uint8Array | number[];
  votingPeriod?: number | bigint;
}

export async function initializeGovernance(
  connection: Connection,
  program: Program,
  authority: Keypair,
  params: InitializeGovernanceParams,
): Promise<{ txSignature: string; governanceConfigPda: PublicKey }> {
  const [governanceConfigPda] = deriveGovernanceConfigPda(program.programId);
  const protocolPda = deriveProtocolPda(program.programId);

  const tx = await program.methods
    .initializeGovernance(
      new anchor.BN(params.votingPeriod.toString()),
      new anchor.BN(params.executionDelay.toString()),
      params.quorumBps,
      params.approvalThresholdBps,
      new anchor.BN(params.minProposalStake.toString()),
    )
    .accountsPartial({
      governanceConfig: governanceConfigPda,
      protocolConfig: protocolPda,
      authority: authority.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([authority])
    .rpc();

  await connection.confirmTransaction(tx, "confirmed");
  return { txSignature: tx, governanceConfigPda };
}

export async function createProposal(
  connection: Connection,
  program: Program,
  authority: Keypair,
  params: CreateProposalParams,
): Promise<{ txSignature: string; proposalPda: PublicKey }> {
  const [proposalPda] = deriveProposalPda(
    params.proposerAgentPda,
    params.nonce,
    program.programId,
  );
  const protocolPda = deriveProtocolPda(program.programId);
  const [governanceConfigPda] = deriveGovernanceConfigPda(program.programId);

  const tx = await program.methods
    .createProposal(
      new anchor.BN(params.nonce.toString()),
      params.proposalType,
      Array.from(params.titleHash),
      Array.from(params.descriptionHash),
      Array.from(params.payload),
      new anchor.BN((params.votingPeriod ?? 0).toString()),
    )
    .accountsPartial({
      proposal: proposalPda,
      proposer: params.proposerAgentPda,
      protocolConfig: protocolPda,
      governanceConfig: governanceConfigPda,
      authority: authority.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([authority])
    .rpc();

  await connection.confirmTransaction(tx, "confirmed");
  return { txSignature: tx, proposalPda };
}

export async function voteProposal(
  connection: Connection,
  program: Program,
  authority: Keypair,
  proposalPda: PublicKey,
  voterAgentPda: PublicKey,
  approve: boolean,
): Promise<{ txSignature: string; votePda: PublicKey }> {
  const [votePda] = deriveGovernanceVotePda(
    proposalPda,
    authority.publicKey,
    program.programId,
  );
  const protocolPda = deriveProtocolPda(program.programId);

  const tx = await program.methods
    .voteProposal(approve)
    .accountsPartial({
      proposal: proposalPda,
      vote: votePda,
      voter: voterAgentPda,
      protocolConfig: protocolPda,
      authority: authority.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([authority])
    .rpc();

  await connection.confirmTransaction(tx, "confirmed");
  return { txSignature: tx, votePda };
}

export async function executeProposal(
  connection: Connection,
  program: Program,
  executor: Keypair,
  proposalPda: PublicKey,
  treasury?: PublicKey,
  recipient?: PublicKey,
): Promise<{ txSignature: string }> {
  const protocolPda = deriveProtocolPda(program.programId);
  const [governanceConfigPda] = deriveGovernanceConfigPda(program.programId);

  const accounts: Record<string, PublicKey> = {
    proposal: proposalPda,
    protocolConfig: protocolPda,
    governanceConfig: governanceConfigPda,
    executor: executor.publicKey,
    systemProgram: SystemProgram.programId,
  };
  if (treasury) accounts.treasury = treasury;
  if (recipient) accounts.recipient = recipient;

  const tx = await program.methods
    .executeProposal()
    .accountsPartial(accounts)
    .signers([executor])
    .rpc();

  await connection.confirmTransaction(tx, "confirmed");
  return { txSignature: tx };
}

export async function cancelProposal(
  connection: Connection,
  program: Program,
  authority: Keypair,
  proposalPda: PublicKey,
): Promise<{ txSignature: string }> {
  const tx = await program.methods
    .cancelProposal()
    .accountsPartial({
      proposal: proposalPda,
      authority: authority.publicKey,
    })
    .signers([authority])
    .rpc();

  await connection.confirmTransaction(tx, "confirmed");
  return { txSignature: tx };
}

// ============================================================================
// Query functions
// ============================================================================

export async function getProposal(
  program: Program,
  proposalPda: PublicKey,
): Promise<ProposalState | null> {
  try {
    const raw = (await getAccount(program, "proposal").fetch(
      proposalPda,
    )) as Record<string, unknown>;

    return {
      proposer: raw.proposer as PublicKey,
      proposerAuthority: (raw.proposerAuthority ??
        raw.proposer_authority) as PublicKey,
      nonce: toBigInt(raw.nonce),
      proposalType: parseProposalType(raw.proposalType ?? raw.proposal_type),
      titleHash: new Uint8Array(
        (raw.titleHash ?? raw.title_hash ?? []) as number[],
      ),
      descriptionHash: new Uint8Array(
        (raw.descriptionHash ?? raw.description_hash ?? []) as number[],
      ),
      payload: new Uint8Array((raw.payload ?? []) as number[]),
      status: parseProposalStatus(raw.status),
      createdAt: toNumber(raw.createdAt ?? raw.created_at),
      votingDeadline: toNumber(raw.votingDeadline ?? raw.voting_deadline),
      executionAfter: toNumber(raw.executionAfter ?? raw.execution_after),
      executedAt: toNumber(raw.executedAt ?? raw.executed_at),
      votesFor: toBigInt(raw.votesFor ?? raw.votes_for),
      votesAgainst: toBigInt(raw.votesAgainst ?? raw.votes_against),
      totalVoters: toNumber(raw.totalVoters ?? raw.total_voters),
      quorum: toBigInt(raw.quorum),
      bump: toNumber(raw.bump),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.includes("Account does not exist") ||
      message.includes("could not find account")
    ) {
      return null;
    }
    throw error;
  }
}

// ============================================================================
// Compute unit budgets
// ============================================================================

export const RECOMMENDED_CU_INITIALIZE_GOVERNANCE = 50_000;
export const RECOMMENDED_CU_CREATE_PROPOSAL = 60_000;
export const RECOMMENDED_CU_VOTE_PROPOSAL = 50_000;
export const RECOMMENDED_CU_EXECUTE_PROPOSAL = 80_000;
export const RECOMMENDED_CU_CANCEL_PROPOSAL = 30_000;
