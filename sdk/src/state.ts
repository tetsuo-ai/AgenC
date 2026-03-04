import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import anchor, { type Program } from "@coral-xyz/anchor";
import { PROGRAM_ID, SEEDS } from "./constants";
import { getAccount } from "./anchor-utils";
import { deriveProtocolPda } from "./protocol";
import { toBigInt, toNumber } from "./utils/numeric";
import { deriveAgentPdaFromId, toFixedBytes } from "./utils/pda";

export interface CoordinationState {
  owner: PublicKey;
  stateKey: Uint8Array;
  stateValue: Uint8Array;
  lastUpdater: PublicKey;
  version: bigint;
  updatedAt: number;
  bump: number;
}

export interface UpdateStateParams {
  agentId: Uint8Array | number[];
  stateKey: Uint8Array | number[];
  stateValue: Uint8Array | number[];
  version: number | bigint;
}

export function deriveStatePda(
  authority: PublicKey,
  stateKey: Uint8Array | number[],
  programId: PublicKey = PROGRAM_ID,
): PublicKey {
  const keyBytes = toFixedBytes(stateKey, 32, "stateKey");
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("state"), authority.toBuffer(), keyBytes],
    programId,
  );
  return pda;
}

export async function updateState(
  connection: Connection,
  program: Program,
  authority: Keypair,
  params: UpdateStateParams,
): Promise<{ statePda: PublicKey; txSignature: string }> {
  const programId = program.programId;
  const stateKey = toFixedBytes(params.stateKey, 32, "stateKey");
  const stateValue = toFixedBytes(params.stateValue, 64, "stateValue");

  const statePda = deriveStatePda(authority.publicKey, stateKey, programId);
  const agentPda = deriveAgentPdaFromId(params.agentId, programId);
  const protocolPda = deriveProtocolPda(programId);

  const tx = await program.methods
    .updateState(
      Array.from(stateKey),
      Array.from(stateValue),
      new anchor.BN(params.version.toString()),
    )
    .accountsPartial({
      state: statePda,
      agent: agentPda,
      authority: authority.publicKey,
      protocolConfig: protocolPda,
      systemProgram: SystemProgram.programId,
    })
    .signers([authority])
    .rpc();

  await connection.confirmTransaction(tx, "confirmed");
  return { statePda, txSignature: tx };
}

export async function getState(
  program: Program,
  statePda: PublicKey,
): Promise<CoordinationState | null> {
  try {
    const raw = (await getAccount(program, "coordinationState").fetch(
      statePda,
    )) as Record<string, unknown>;

    return {
      owner: raw.owner as PublicKey,
      stateKey: new Uint8Array(
        (raw.stateKey ?? raw.state_key ?? []) as number[],
      ),
      stateValue: new Uint8Array(
        (raw.stateValue ?? raw.state_value ?? []) as number[],
      ),
      lastUpdater: (raw.lastUpdater ?? raw.last_updater) as PublicKey,
      version: toBigInt(raw.version),
      updatedAt: toNumber(raw.updatedAt ?? raw.updated_at),
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
