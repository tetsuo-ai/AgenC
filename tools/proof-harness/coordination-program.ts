import * as anchor from "@coral-xyz/anchor";
import { Program, type Idl } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  AGENC_COORDINATION_IDL,
  type AgencCoordination,
} from "@tetsuo-ai/protocol";
import { PROGRAM_ID } from "@tetsuo-ai/sdk";

export type CoordinationProgram = Program<AgencCoordination>;

export function createCoordinationProgram(
  provider: anchor.AnchorProvider,
  programId: PublicKey = PROGRAM_ID,
): CoordinationProgram {
  return new Program(
    {
      ...(AGENC_COORDINATION_IDL as Idl),
      address: programId.toBase58(),
    },
    provider,
  ) as CoordinationProgram;
}

export function keypairToWallet(authority: Keypair): anchor.Wallet {
  return new anchor.Wallet(authority);
}

export function asSdkProgram(program: CoordinationProgram): Program<Idl> {
  return program as unknown as Program<Idl>;
}
