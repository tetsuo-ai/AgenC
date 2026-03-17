import assert from "node:assert/strict";
import test from "node:test";
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair } from "@solana/web3.js";
import { PROGRAM_ID } from "@tetsuo-ai/sdk";
import {
  createCoordinationProgram,
  keypairToWallet,
} from "./protocol-program.js";

test("createCoordinationProgram uses the expected program id", () => {
  const provider = new anchor.AnchorProvider(
    new Connection("http://127.0.0.1:65535", "confirmed"),
    keypairToWallet(Keypair.generate()),
    { commitment: "confirmed" },
  );

  const program = createCoordinationProgram(provider);
  assert.equal(program.programId.toBase58(), PROGRAM_ID.toBase58());
});

test("keypairToWallet preserves the signer public key", () => {
  const keypair = Keypair.generate();
  const wallet = keypairToWallet(keypair);
  assert.equal(wallet.publicKey.toBase58(), keypair.publicKey.toBase58());
});
