import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  type AccountMeta,
} from "@solana/web3.js";
import { type Program } from "@coral-xyz/anchor";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PROGRAM_ID, SEEDS } from "./constants";
import { getAccount } from "./anchor-utils";
import { deriveClaimPda, deriveEscrowPda } from "./tasks";
import { toBigInt, toNumber } from "./utils/numeric";

export enum DisputeStatus {
  Active = 0,
  Resolved = 1,
  Expired = 2,
  Cancelled = 3,
}

export enum ResolutionType {
  Refund = 0,
  Complete = 1,
  Split = 2,
}

export interface InitiateDisputeParams {
  disputeId: Uint8Array | number[];
  taskPda: PublicKey;
  taskId: Uint8Array | number[];
  evidenceHash: Uint8Array | number[];
  resolutionType: number;
  evidence: string;
  initiatorClaimPda?: PublicKey | null;
  workerAgentPda?: PublicKey | null;
  workerClaimPda?: PublicKey | null;
  defendantWorkers?: Array<{ claimPda: PublicKey; workerPda: PublicKey }>;
}

export interface VoteDisputeParams {
  disputePda: PublicKey;
  taskPda: PublicKey;
  approve: boolean;
  workerClaimPda?: PublicKey | null;
  defendantAgentPda?: PublicKey | null;
}

export interface ResolveDisputeParams {
  disputePda: PublicKey;
  taskPda: PublicKey;
  creatorPubkey: PublicKey;
  workerClaimPda?: PublicKey | null;
  workerAgentPda?: PublicKey | null;
  workerAuthority?: PublicKey | null;
  arbiterPairs?: Array<{ votePda: PublicKey; agentPda: PublicKey }>;
  workerPairs?: Array<{ claimPda: PublicKey; agentPda: PublicKey }>;
}

export interface ApplyDisputeSlashParams {
  disputePda: PublicKey;
  taskPda: PublicKey;
  workerClaimPda: PublicKey;
  workerAgentPda: PublicKey;
}

export interface ApplyInitiatorSlashParams {
  disputePda: PublicKey;
  taskPda: PublicKey;
  initiatorAgentPda: PublicKey;
}

export interface ExpireDisputeParams {
  disputePda: PublicKey;
  taskPda: PublicKey;
  creatorPubkey: PublicKey;
  workerClaimPda?: PublicKey | null;
  workerAgentPda?: PublicKey | null;
  workerAuthority?: PublicKey | null;
  arbiterPairs?: Array<{ votePda: PublicKey; agentPda: PublicKey }>;
  workerPairs?: Array<{ claimPda: PublicKey; agentPda: PublicKey }>;
}

export interface DisputeState {
  disputeId: Uint8Array;
  task: PublicKey;
  initiator: PublicKey;
  initiatorAuthority: PublicKey;
  evidenceHash: Uint8Array;
  resolutionType: ResolutionType;
  status: DisputeStatus;
  createdAt: number;
  resolvedAt: number;
  votesFor: bigint;
  votesAgainst: bigint;
  totalVoters: number;
  votingDeadline: number;
  expiresAt: number;
  slashApplied: boolean;
  initiatorSlashApplied: boolean;
  workerStakeAtDispute: bigint;
  initiatedByCreator: boolean;
  bump: number;
  defendant: PublicKey;
}

function toFixedBytes(
  value: Uint8Array | number[],
  length: number,
  fieldName: string,
): Uint8Array {
  const bytes = value instanceof Uint8Array ? value : Uint8Array.from(value);
  if (bytes.length !== length) {
    throw new Error(
      `Invalid ${fieldName} length: ${bytes.length}. Expected ${length} bytes.`,
    );
  }
  return bytes;
}

function parseResolutionType(raw: unknown): ResolutionType {
  if (typeof raw === "number") return raw as ResolutionType;
  if (raw && typeof raw === "object") {
    const enumObj = raw as Record<string, unknown>;
    if ("refund" in enumObj) return ResolutionType.Refund;
    if ("complete" in enumObj) return ResolutionType.Complete;
    if ("split" in enumObj) return ResolutionType.Split;
  }
  return ResolutionType.Refund;
}

function parseDisputeStatus(raw: unknown): DisputeStatus {
  if (typeof raw === "number") return raw as DisputeStatus;
  if (raw && typeof raw === "object") {
    const enumObj = raw as Record<string, unknown>;
    if ("active" in enumObj) return DisputeStatus.Active;
    if ("resolved" in enumObj) return DisputeStatus.Resolved;
    if ("expired" in enumObj) return DisputeStatus.Expired;
    if ("cancelled" in enumObj) return DisputeStatus.Cancelled;
  }
  return DisputeStatus.Active;
}

function deriveProtocolPda(programId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([SEEDS.PROTOCOL], programId);
  return pda;
}

function deriveAgentPda(
  agentId: Uint8Array | number[],
  programId: PublicKey,
): PublicKey {
  const idBytes = toFixedBytes(agentId, 32, "agentId");
  const [pda] = PublicKey.findProgramAddressSync(
    [SEEDS.AGENT, idBytes],
    programId,
  );
  return pda;
}

function deriveAuthorityVotePda(
  disputePda: PublicKey,
  authority: PublicKey,
  programId: PublicKey,
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [SEEDS.AUTHORITY_VOTE, disputePda.toBuffer(), authority.toBuffer()],
    programId,
  );
  return pda;
}

function buildRemainingAccounts(
  arbiterPairs?: Array<{ votePda: PublicKey; agentPda: PublicKey }>,
  workerPairs?: Array<{ claimPda: PublicKey; agentPda: PublicKey }>,
): AccountMeta[] {
  const metas: AccountMeta[] = [];
  for (const pair of arbiterPairs ?? []) {
    metas.push({ pubkey: pair.votePda, isSigner: false, isWritable: true });
    metas.push({ pubkey: pair.agentPda, isSigner: false, isWritable: true });
  }
  for (const pair of workerPairs ?? []) {
    metas.push({ pubkey: pair.claimPda, isSigner: false, isWritable: true });
    metas.push({ pubkey: pair.agentPda, isSigner: false, isWritable: true });
  }
  return metas;
}

function buildResolveTokenAccounts(
  rewardMint: PublicKey | null,
  escrowPda: PublicKey,
  creator: PublicKey,
  workerAuthority: PublicKey | null,
  treasury: PublicKey,
): Record<string, PublicKey | undefined> {
  if (!rewardMint) {
    return {
      tokenEscrowAta: undefined,
      creatorTokenAccount: undefined,
      workerTokenAccountAta: undefined,
      treasuryTokenAccount: undefined,
      rewardMint: undefined,
      tokenProgram: undefined,
    };
  }

  return {
    tokenEscrowAta: getAssociatedTokenAddressSync(rewardMint, escrowPda, true),
    creatorTokenAccount: getAssociatedTokenAddressSync(rewardMint, creator),
    workerTokenAccountAta: workerAuthority
      ? getAssociatedTokenAddressSync(rewardMint, workerAuthority)
      : undefined,
    treasuryTokenAccount: getAssociatedTokenAddressSync(rewardMint, treasury),
    rewardMint,
    tokenProgram: TOKEN_PROGRAM_ID,
  };
}

function buildExpireTokenAccounts(
  rewardMint: PublicKey | null,
  escrowPda: PublicKey,
  creator: PublicKey,
  workerAuthority: PublicKey | null,
): Record<string, PublicKey | undefined> {
  if (!rewardMint) {
    return {
      tokenEscrowAta: undefined,
      creatorTokenAccount: undefined,
      workerTokenAccountAta: undefined,
      rewardMint: undefined,
      tokenProgram: undefined,
    };
  }

  return {
    tokenEscrowAta: getAssociatedTokenAddressSync(rewardMint, escrowPda, true),
    creatorTokenAccount: getAssociatedTokenAddressSync(rewardMint, creator),
    workerTokenAccountAta: workerAuthority
      ? getAssociatedTokenAddressSync(rewardMint, workerAuthority)
      : undefined,
    rewardMint,
    tokenProgram: TOKEN_PROGRAM_ID,
  };
}

function buildApplySlashTokenAccounts(
  rewardMint: PublicKey | null,
  escrowPda: PublicKey,
  treasury: PublicKey,
): Record<string, PublicKey | undefined> {
  if (!rewardMint) {
    return {
      escrow: undefined,
      tokenEscrowAta: undefined,
      treasuryTokenAccount: undefined,
      rewardMint: undefined,
      tokenProgram: undefined,
    };
  }

  return {
    escrow: escrowPda,
    tokenEscrowAta: getAssociatedTokenAddressSync(rewardMint, escrowPda, true),
    treasuryTokenAccount: getAssociatedTokenAddressSync(rewardMint, treasury),
    rewardMint,
    tokenProgram: TOKEN_PROGRAM_ID,
  };
}

export function deriveDisputePda(
  disputeId: Uint8Array | number[],
  programId: PublicKey = PROGRAM_ID,
): PublicKey {
  const idBytes = toFixedBytes(disputeId, 32, "disputeId");
  const [pda] = PublicKey.findProgramAddressSync(
    [SEEDS.DISPUTE, idBytes],
    programId,
  );
  return pda;
}

export function deriveVotePda(
  disputePda: PublicKey,
  voterAgentPda: PublicKey,
  programId: PublicKey = PROGRAM_ID,
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [SEEDS.VOTE, disputePda.toBuffer(), voterAgentPda.toBuffer()],
    programId,
  );
  return pda;
}

export async function initiateDispute(
  connection: Connection,
  program: Program,
  initiator: Keypair,
  initiatorAgentId: Uint8Array | number[],
  params: InitiateDisputeParams,
): Promise<{ disputePda: PublicKey; txSignature: string }> {
  const programId = program.programId;
  const disputeId = toFixedBytes(params.disputeId, 32, "disputeId");
  const taskId = toFixedBytes(params.taskId, 32, "taskId");
  const evidenceHash = toFixedBytes(params.evidenceHash, 32, "evidenceHash");

  const disputePda = deriveDisputePda(disputeId, programId);
  const protocolPda = deriveProtocolPda(programId);
  const initiatorAgentPda = deriveAgentPda(initiatorAgentId, programId);
  const derivedClaimPda = deriveClaimPda(
    params.taskPda,
    initiatorAgentPda,
    programId,
  );

  const builder = program.methods
    .initiateDispute(
      Array.from(disputeId),
      Array.from(taskId),
      Array.from(evidenceHash),
      params.resolutionType,
      params.evidence,
    )
    .accountsPartial({
      dispute: disputePda,
      task: params.taskPda,
      agent: initiatorAgentPda,
      protocolConfig: protocolPda,
      initiatorClaim:
        params.initiatorClaimPda === undefined
          ? derivedClaimPda
          : (params.initiatorClaimPda ?? undefined),
      workerAgent: params.workerAgentPda ?? undefined,
      workerClaim: params.workerClaimPda ?? undefined,
      authority: initiator.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([initiator]);

  const remainingAccounts = buildRemainingAccounts(
    undefined,
    params.defendantWorkers?.map((pair) => ({
      claimPda: pair.claimPda,
      agentPda: pair.workerPda,
    })),
  );

  if (remainingAccounts.length > 0) {
    builder.remainingAccounts(remainingAccounts);
  }

  const tx = await builder.rpc();
  await connection.confirmTransaction(tx, "confirmed");

  return { disputePda, txSignature: tx };
}

export async function voteDispute(
  connection: Connection,
  program: Program,
  voter: Keypair,
  voterAgentId: Uint8Array | number[],
  params: VoteDisputeParams,
): Promise<{ votePda: PublicKey; txSignature: string }> {
  const programId = program.programId;
  const protocolPda = deriveProtocolPda(programId);
  const voterAgentPda = deriveAgentPda(voterAgentId, programId);
  const votePda = deriveVotePda(params.disputePda, voterAgentPda, programId);
  const authorityVotePda = deriveAuthorityVotePda(
    params.disputePda,
    voter.publicKey,
    programId,
  );

  const tx = await program.methods
    .voteDispute(params.approve)
    .accountsPartial({
      dispute: params.disputePda,
      task: params.taskPda,
      workerClaim: params.workerClaimPda ?? undefined,
      defendantAgent: params.defendantAgentPda ?? undefined,
      vote: votePda,
      authorityVote: authorityVotePda,
      arbiter: voterAgentPda,
      protocolConfig: protocolPda,
      authority: voter.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([voter])
    .rpc();

  await connection.confirmTransaction(tx, "confirmed");

  return { votePda, txSignature: tx };
}

export async function resolveDispute(
  connection: Connection,
  program: Program,
  resolver: Keypair,
  params: ResolveDisputeParams,
): Promise<{ txSignature: string }> {
  const programId = program.programId;
  const protocolPda = deriveProtocolPda(programId);
  const escrowPda = deriveEscrowPda(params.taskPda, programId);

  const task = (await getAccount(program, "task").fetch(params.taskPda)) as {
    rewardMint: PublicKey | null;
  };
  const protocolConfig = (await getAccount(program, "protocolConfig").fetch(
    protocolPda,
  )) as {
    treasury: PublicKey;
  };

  const tokenAccounts = buildResolveTokenAccounts(
    task.rewardMint ?? null,
    escrowPda,
    params.creatorPubkey,
    params.workerAuthority ?? null,
    protocolConfig.treasury,
  );

  const builder = program.methods
    .resolveDispute()
    .accountsPartial({
      dispute: params.disputePda,
      task: params.taskPda,
      escrow: escrowPda,
      protocolConfig: protocolPda,
      resolver: resolver.publicKey,
      creator: params.creatorPubkey,
      workerClaim: params.workerClaimPda ?? undefined,
      worker: params.workerAgentPda ?? undefined,
      workerAuthority: params.workerAuthority ?? undefined,
      systemProgram: SystemProgram.programId,
      ...tokenAccounts,
    })
    .signers([resolver]);

  const remainingAccounts = buildRemainingAccounts(
    params.arbiterPairs,
    params.workerPairs,
  );
  if (remainingAccounts.length > 0) {
    builder.remainingAccounts(remainingAccounts);
  }

  const tx = await builder.rpc();
  await connection.confirmTransaction(tx, "confirmed");

  return { txSignature: tx };
}

export async function applyDisputeSlash(
  connection: Connection,
  program: Program,
  payer: Keypair,
  params: ApplyDisputeSlashParams,
): Promise<{ txSignature: string }> {
  const programId = program.programId;
  const protocolPda = deriveProtocolPda(programId);
  const escrowPda = deriveEscrowPda(params.taskPda, programId);

  const task = (await getAccount(program, "task").fetch(params.taskPda)) as {
    rewardMint: PublicKey | null;
  };
  const protocolConfig = (await getAccount(program, "protocolConfig").fetch(
    protocolPda,
  )) as {
    treasury: PublicKey;
  };

  const tokenAccounts = buildApplySlashTokenAccounts(
    task.rewardMint ?? null,
    escrowPda,
    protocolConfig.treasury,
  );

  const tx = await program.methods
    .applyDisputeSlash()
    .accountsPartial({
      dispute: params.disputePda,
      task: params.taskPda,
      workerClaim: params.workerClaimPda,
      workerAgent: params.workerAgentPda,
      protocolConfig: protocolPda,
      treasury: protocolConfig.treasury,
      ...tokenAccounts,
    })
    .signers([payer])
    .rpc();

  await connection.confirmTransaction(tx, "confirmed");
  return { txSignature: tx };
}

export async function applyInitiatorSlash(
  connection: Connection,
  program: Program,
  payer: Keypair,
  params: ApplyInitiatorSlashParams,
): Promise<{ txSignature: string }> {
  const protocolPda = deriveProtocolPda(program.programId);
  const protocolConfig = (await getAccount(program, "protocolConfig").fetch(
    protocolPda,
  )) as {
    treasury: PublicKey;
  };

  const tx = await program.methods
    .applyInitiatorSlash()
    .accountsPartial({
      dispute: params.disputePda,
      task: params.taskPda,
      initiatorAgent: params.initiatorAgentPda,
      protocolConfig: protocolPda,
      treasury: protocolConfig.treasury,
    })
    .signers([payer])
    .rpc();

  await connection.confirmTransaction(tx, "confirmed");
  return { txSignature: tx };
}

export async function cancelDispute(
  connection: Connection,
  program: Program,
  authority: Keypair,
  disputePda: PublicKey,
  taskPda: PublicKey,
  defendantAgentPda?: PublicKey,
): Promise<{ txSignature: string }> {
  const builder = program.methods
    .cancelDispute()
    .accountsPartial({
      dispute: disputePda,
      task: taskPda,
      authority: authority.publicKey,
    })
    .signers([authority]);

  if (defendantAgentPda) {
    builder.remainingAccounts([
      {
        pubkey: defendantAgentPda,
        isSigner: false,
        isWritable: true,
      },
    ]);
  }

  const tx = await builder.rpc();
  await connection.confirmTransaction(tx, "confirmed");
  return { txSignature: tx };
}

export async function expireDispute(
  connection: Connection,
  program: Program,
  caller: Keypair,
  params: ExpireDisputeParams,
): Promise<{ txSignature: string }> {
  const protocolPda = deriveProtocolPda(program.programId);
  const escrowPda = deriveEscrowPda(params.taskPda, program.programId);

  const task = (await getAccount(program, "task").fetch(params.taskPda)) as {
    rewardMint: PublicKey | null;
  };
  const tokenAccounts = buildExpireTokenAccounts(
    task.rewardMint ?? null,
    escrowPda,
    params.creatorPubkey,
    params.workerAuthority ?? null,
  );

  const builder = program.methods
    .expireDispute()
    .accountsPartial({
      dispute: params.disputePda,
      task: params.taskPda,
      escrow: escrowPda,
      protocolConfig: protocolPda,
      creator: params.creatorPubkey,
      workerClaim: params.workerClaimPda ?? undefined,
      worker: params.workerAgentPda ?? undefined,
      workerAuthority: params.workerAuthority ?? undefined,
      ...tokenAccounts,
    })
    .signers([caller]);

  const remainingAccounts = buildRemainingAccounts(
    params.arbiterPairs,
    params.workerPairs,
  );
  if (remainingAccounts.length > 0) {
    builder.remainingAccounts(remainingAccounts);
  }

  const tx = await builder.rpc();
  await connection.confirmTransaction(tx, "confirmed");
  return { txSignature: tx };
}

export async function getDispute(
  program: Program,
  disputePda: PublicKey,
): Promise<DisputeState | null> {
  try {
    const raw = (await getAccount(program, "dispute").fetch(
      disputePda,
    )) as Record<string, unknown>;

    return {
      disputeId: new Uint8Array(
        (raw.disputeId ?? raw.dispute_id ?? []) as number[],
      ),
      task: raw.task as PublicKey,
      initiator: raw.initiator as PublicKey,
      initiatorAuthority: (raw.initiatorAuthority ??
        raw.initiator_authority) as PublicKey,
      evidenceHash: new Uint8Array(
        (raw.evidenceHash ?? raw.evidence_hash ?? []) as number[],
      ),
      resolutionType: parseResolutionType(
        raw.resolutionType ?? raw.resolution_type,
      ),
      status: parseDisputeStatus(raw.status),
      createdAt: toNumber(raw.createdAt ?? raw.created_at),
      resolvedAt: toNumber(raw.resolvedAt ?? raw.resolved_at),
      votesFor: toBigInt(raw.votesFor ?? raw.votes_for),
      votesAgainst: toBigInt(raw.votesAgainst ?? raw.votes_against),
      totalVoters: toNumber(raw.totalVoters ?? raw.total_voters),
      votingDeadline: toNumber(raw.votingDeadline ?? raw.voting_deadline),
      expiresAt: toNumber(raw.expiresAt ?? raw.expires_at),
      slashApplied: Boolean(raw.slashApplied ?? raw.slash_applied),
      initiatorSlashApplied: Boolean(
        raw.initiatorSlashApplied ?? raw.initiator_slash_applied,
      ),
      workerStakeAtDispute: toBigInt(
        raw.workerStakeAtDispute ?? raw.worker_stake_at_dispute,
      ),
      initiatedByCreator: Boolean(
        raw.initiatedByCreator ?? raw.initiated_by_creator,
      ),
      bump: toNumber(raw.bump),
      defendant: raw.defendant as PublicKey,
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
