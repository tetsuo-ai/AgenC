import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  type AccountMeta,
} from "@solana/web3.js";
import anchor, { type Program } from "@coral-xyz/anchor";
import { PROGRAM_ID, SEEDS } from "./constants";
import { getAccount } from "./anchor-utils";
import { toBigInt, toNumber } from "./utils/numeric";

const BPF_LOADER_UPGRADEABLE_PROGRAM_ID = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);

export interface InitializeProtocolParams {
  disputeThreshold: number;
  protocolFeeBps: number;
  minStake: number | bigint;
  minStakeForDispute: number | bigint;
  multisigThreshold: number;
  multisigOwners: PublicKey[];
}

export interface UpdateRateLimitsParams {
  taskCreationCooldown: number;
  maxTasksPer24h: number;
  disputeInitiationCooldown: number;
  maxDisputesPer24h: number;
  minStakeForDispute: number | bigint;
}

export interface ProtocolConfigState {
  authority: PublicKey;
  treasury: PublicKey;
  disputeThreshold: number;
  protocolFeeBps: number;
  minAgentStake: bigint;
  minStakeForDispute: bigint;
  multisigThreshold: number;
}

function buildMultisigRemainingAccounts(signers: Keypair[]): AccountMeta[] {
  const unique = new Set<string>();
  const accounts: AccountMeta[] = [];

  for (const signer of signers) {
    const key = signer.publicKey.toBase58();
    if (unique.has(key)) continue;
    unique.add(key);
    accounts.push({
      pubkey: signer.publicKey,
      isSigner: true,
      isWritable: false,
    });
  }

  return accounts;
}

type MultisigInstructionBuilder = {
  accountsPartial(accounts: {
    protocolConfig: PublicKey;
  }): MultisigInstructionBuilder;
  signers(signers: Keypair[]): MultisigInstructionBuilder;
  remainingAccounts(accounts: AccountMeta[]): MultisigInstructionBuilder;
  rpc(): Promise<string>;
};

function validateMultisigSigners(
  signers: Keypair[],
  operationName: string,
): void {
  if (signers.length === 0) {
    throw new Error(`${operationName} requires at least one multisig signer`);
  }
}

async function executeMultisigProtocolInstruction(
  connection: Connection,
  program: Program,
  multisigSigners: Keypair[],
  operationName: string,
  createBuilder: () => MultisigInstructionBuilder,
): Promise<{ txSignature: string }> {
  validateMultisigSigners(multisigSigners, operationName);

  const builder = createBuilder()
    .accountsPartial({
      protocolConfig: deriveProtocolPda(program.programId),
    })
    .signers(multisigSigners);

  const remainingAccounts = buildMultisigRemainingAccounts(multisigSigners);
  if (remainingAccounts.length > 0) {
    builder.remainingAccounts(remainingAccounts);
  }

  const tx = await builder.rpc();
  await connection.confirmTransaction(tx, "confirmed");
  return { txSignature: tx };
}

function validateInitializeParams(params: InitializeProtocolParams): void {
  if (params.multisigThreshold < 1) {
    throw new Error("multisigThreshold must be >= 1");
  }

  if (params.multisigOwners.length === 0) {
    throw new Error("multisigOwners must contain at least one owner");
  }

  if (params.multisigThreshold > params.multisigOwners.length) {
    throw new Error("multisigThreshold cannot exceed multisigOwners length");
  }

  const owners = new Set(
    params.multisigOwners.map((owner) => owner.toBase58()),
  );
  if (owners.size !== params.multisigOwners.length) {
    throw new Error("multisigOwners cannot contain duplicates");
  }
}

export function deriveProtocolPda(
  programId: PublicKey = PROGRAM_ID,
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([SEEDS.PROTOCOL], programId);
  return pda;
}

export async function initializeProtocol(
  connection: Connection,
  program: Program,
  authority: Keypair,
  secondSigner: Keypair,
  treasury: PublicKey,
  params: InitializeProtocolParams,
): Promise<{ protocolPda: PublicKey; txSignature: string }> {
  validateInitializeParams(params);

  const protocolPda = deriveProtocolPda(program.programId);
  const [programDataPda] = PublicKey.findProgramAddressSync(
    [program.programId.toBuffer()],
    BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
  );

  const tx = await program.methods
    .initializeProtocol(
      params.disputeThreshold,
      params.protocolFeeBps,
      new anchor.BN(params.minStake.toString()),
      new anchor.BN(params.minStakeForDispute.toString()),
      params.multisigThreshold,
      params.multisigOwners,
    )
    .accountsPartial({
      protocolConfig: protocolPda,
      treasury,
      authority: authority.publicKey,
      secondSigner: secondSigner.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts([
      { pubkey: programDataPda, isSigner: false, isWritable: false },
    ])
    .signers([authority, secondSigner])
    .rpc();

  await connection.confirmTransaction(tx, "confirmed");
  return { protocolPda, txSignature: tx };
}

export async function updateProtocolFee(
  connection: Connection,
  program: Program,
  multisigSigners: Keypair[],
  newFeeBps: number,
): Promise<{ txSignature: string }> {
  return executeMultisigProtocolInstruction(
    connection,
    program,
    multisigSigners,
    "updateProtocolFee",
    () =>
      program.methods.updateProtocolFee(
        newFeeBps,
      ) as unknown as MultisigInstructionBuilder,
  );
}

export async function updateRateLimits(
  connection: Connection,
  program: Program,
  multisigSigners: Keypair[],
  params: UpdateRateLimitsParams,
): Promise<{ txSignature: string }> {
  return executeMultisigProtocolInstruction(
    connection,
    program,
    multisigSigners,
    "updateRateLimits",
    () =>
      program.methods.updateRateLimits(
        new anchor.BN(params.taskCreationCooldown.toString()),
        params.maxTasksPer24h,
        new anchor.BN(params.disputeInitiationCooldown.toString()),
        params.maxDisputesPer24h,
        new anchor.BN(params.minStakeForDispute.toString()),
      ) as unknown as MultisigInstructionBuilder,
  );
}

export async function migrateProtocol(
  connection: Connection,
  program: Program,
  multisigSigners: Keypair[],
  targetVersion: number,
): Promise<{ txSignature: string }> {
  return executeMultisigProtocolInstruction(
    connection,
    program,
    multisigSigners,
    "migrateProtocol",
    () =>
      program.methods.migrateProtocol(
        targetVersion,
      ) as unknown as MultisigInstructionBuilder,
  );
}

export async function updateMinVersion(
  connection: Connection,
  program: Program,
  multisigSigners: Keypair[],
  newMinVersion: number,
): Promise<{ txSignature: string }> {
  return executeMultisigProtocolInstruction(
    connection,
    program,
    multisigSigners,
    "updateMinVersion",
    () =>
      program.methods.updateMinVersion(
        newMinVersion,
      ) as unknown as MultisigInstructionBuilder,
  );
}

export async function getProtocolConfig(
  program: Program,
): Promise<ProtocolConfigState | null> {
  try {
    const protocolPda = deriveProtocolPda(program.programId);
    const raw = (await getAccount(program, "protocolConfig").fetch(
      protocolPda,
    )) as Record<string, unknown>;

    return {
      authority: raw.authority as PublicKey,
      treasury: raw.treasury as PublicKey,
      disputeThreshold: toNumber(raw.disputeThreshold ?? raw.dispute_threshold),
      protocolFeeBps: toNumber(raw.protocolFeeBps ?? raw.protocol_fee_bps),
      minAgentStake: toBigInt(raw.minAgentStake ?? raw.min_agent_stake),
      minStakeForDispute: toBigInt(
        raw.minStakeForDispute ?? raw.min_stake_for_dispute,
      ),
      multisigThreshold: toNumber(
        raw.multisigThreshold ?? raw.multisig_threshold,
      ),
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
