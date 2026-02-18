import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
} from '@solana/web3.js';
import anchor, { type Program } from '@coral-xyz/anchor';
import { PROGRAM_ID, SEEDS } from './constants';
import { getAccount } from './anchor-utils';
import { toBigInt, toNumber } from './utils/numeric';

export interface RegisterAgentParams {
  agentId: Uint8Array | number[];
  capabilities: number | bigint;
  endpoint: string;
  metadataUri?: string | null;
  stakeAmount: number | bigint;
}

export interface UpdateAgentParams {
  capabilities?: number | bigint | null;
  endpoint?: string | null;
  metadataUri?: string | null;
  status?: number | null;
}

export enum AgentStatus {
  Inactive = 0,
  Active = 1,
  Busy = 2,
  Suspended = 3,
}

export interface AgentState {
  agentId: Uint8Array;
  authority: PublicKey;
  capabilities: bigint;
  status: AgentStatus;
  endpoint: string;
  metadataUri: string | null;
  stakeAmount: bigint;
  activeTasks: number;
  reputation: number;
  registeredAt: number;
}

function toAgentIdBytes(agentId: Uint8Array | number[]): Uint8Array {
  const bytes = agentId instanceof Uint8Array ? agentId : Uint8Array.from(agentId);
  if (bytes.length !== 32) {
    throw new Error(`Invalid agentId length: ${bytes.length}. Expected 32 bytes.`);
  }
  return bytes;
}

function parseAgentStatus(raw: unknown): AgentStatus {
  if (typeof raw === 'number') {
    return raw as AgentStatus;
  }

  if (raw && typeof raw === 'object') {
    const enumObj = raw as Record<string, unknown>;
    if ('inactive' in enumObj) return AgentStatus.Inactive;
    if ('active' in enumObj) return AgentStatus.Active;
    if ('busy' in enumObj) return AgentStatus.Busy;
    if ('suspended' in enumObj) return AgentStatus.Suspended;
  }

  return AgentStatus.Inactive;
}

function deriveProtocolPda(programId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([SEEDS.PROTOCOL], programId);
  return pda;
}

export function deriveAgentPda(
  agentId: Uint8Array | number[],
  programId: PublicKey = PROGRAM_ID,
): PublicKey {
  const idBytes = toAgentIdBytes(agentId);
  const [pda] = PublicKey.findProgramAddressSync([SEEDS.AGENT, idBytes], programId);
  return pda;
}

export async function registerAgent(
  connection: Connection,
  program: Program,
  authority: Keypair,
  params: RegisterAgentParams,
): Promise<{ agentPda: PublicKey; txSignature: string }> {
  const programId = program.programId;
  const agentId = toAgentIdBytes(params.agentId);
  const agentPda = deriveAgentPda(agentId, programId);
  const protocolPda = deriveProtocolPda(programId);

  const tx = await program.methods
    .registerAgent(
      Array.from(agentId),
      new anchor.BN(params.capabilities.toString()),
      params.endpoint,
      params.metadataUri ?? null,
      new anchor.BN(params.stakeAmount.toString()),
    )
    .accountsPartial({
      agent: agentPda,
      protocolConfig: protocolPda,
      authority: authority.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([authority])
    .rpc();

  await connection.confirmTransaction(tx, 'confirmed');
  return { agentPda, txSignature: tx };
}

export async function updateAgent(
  connection: Connection,
  program: Program,
  authority: Keypair,
  agentId: Uint8Array | number[],
  params: UpdateAgentParams,
): Promise<{ txSignature: string }> {
  const programId = program.programId;
  const agentPda = deriveAgentPda(agentId, programId);

  const capabilities =
    params.capabilities === undefined || params.capabilities === null
      ? null
      : new anchor.BN(params.capabilities.toString());

  const builder = program.methods
    .updateAgent(
      capabilities,
      params.endpoint ?? null,
      params.metadataUri ?? null,
      params.status ?? null,
    )
    .accountsPartial({
      agent: agentPda,
      authority: authority.publicKey,
    })
    .signers([authority]);

  if (params.status === AgentStatus.Suspended) {
    builder.remainingAccounts([
      {
        pubkey: deriveProtocolPda(programId),
        isSigner: false,
        isWritable: false,
      },
    ]);
  }

  const tx = await builder.rpc();
  await connection.confirmTransaction(tx, 'confirmed');

  return { txSignature: tx };
}

export async function suspendAgent(
  connection: Connection,
  program: Program,
  protocolAuthority: Keypair,
  agentId: Uint8Array | number[],
): Promise<{ txSignature: string }> {
  const programId = program.programId;
  const agentPda = deriveAgentPda(agentId, programId);
  const protocolPda = deriveProtocolPda(programId);

  const tx = await program.methods
    .suspendAgent()
    .accountsPartial({
      agent: agentPda,
      protocolConfig: protocolPda,
      authority: protocolAuthority.publicKey,
    })
    .signers([protocolAuthority])
    .rpc();

  await connection.confirmTransaction(tx, 'confirmed');
  return { txSignature: tx };
}

export async function unsuspendAgent(
  connection: Connection,
  program: Program,
  protocolAuthority: Keypair,
  agentId: Uint8Array | number[],
): Promise<{ txSignature: string }> {
  const programId = program.programId;
  const agentPda = deriveAgentPda(agentId, programId);
  const protocolPda = deriveProtocolPda(programId);

  const tx = await program.methods
    .unsuspendAgent()
    .accountsPartial({
      agent: agentPda,
      protocolConfig: protocolPda,
      authority: protocolAuthority.publicKey,
    })
    .signers([protocolAuthority])
    .rpc();

  await connection.confirmTransaction(tx, 'confirmed');
  return { txSignature: tx };
}

export async function deregisterAgent(
  connection: Connection,
  program: Program,
  authority: Keypair,
  agentId: Uint8Array | number[],
): Promise<{ txSignature: string }> {
  const programId = program.programId;
  const agentPda = deriveAgentPda(agentId, programId);
  const protocolPda = deriveProtocolPda(programId);

  const tx = await program.methods
    .deregisterAgent()
    .accountsPartial({
      agent: agentPda,
      protocolConfig: protocolPda,
      authority: authority.publicKey,
    })
    .signers([authority])
    .rpc();

  await connection.confirmTransaction(tx, 'confirmed');
  return { txSignature: tx };
}

export async function getAgent(
  program: Program,
  agentPda: PublicKey,
): Promise<AgentState | null> {
  try {
    const account = (await getAccount(program, 'agentRegistration').fetch(agentPda)) as Record<string, unknown>;

    const metadataUriRaw = account.metadataUri ?? account.metadata_uri;
    const metadataUri = typeof metadataUriRaw === 'string' && metadataUriRaw.length > 0
      ? metadataUriRaw
      : null;

    return {
      agentId: new Uint8Array((account.agentId ?? account.agent_id ?? []) as number[]),
      authority: account.authority as PublicKey,
      capabilities: toBigInt(account.capabilities),
      status: parseAgentStatus(account.status),
      endpoint: (account.endpoint ?? '') as string,
      metadataUri,
      stakeAmount: toBigInt(account.stake),
      activeTasks: toNumber(account.activeTasks ?? account.active_tasks),
      reputation: toNumber(account.reputation),
      registeredAt: toNumber(account.registeredAt ?? account.registered_at),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('Account does not exist') || message.includes('could not find account')) {
      return null;
    }
    throw error;
  }
}
