import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { deriveDisputePda, deriveVotePda } from "../disputes";
import { PROGRAM_ID, SEEDS } from "../constants";

describe("disputes PDA helpers", () => {
  it('deriveDisputePda uses ["dispute", disputeId] seeds', () => {
    const disputeId = new Uint8Array(32).fill(11);
    const pda = deriveDisputePda(disputeId, PROGRAM_ID);

    const [expected] = PublicKey.findProgramAddressSync(
      [SEEDS.DISPUTE, disputeId],
      PROGRAM_ID,
    );

    expect(pda.equals(expected)).toBe(true);
  });

  it('deriveVotePda uses ["vote", disputePda, voterAgentPda] seeds', () => {
    const disputePda = Keypair.generate().publicKey;
    const voterAgentPda = Keypair.generate().publicKey;
    const pda = deriveVotePda(disputePda, voterAgentPda, PROGRAM_ID);

    const [expected] = PublicKey.findProgramAddressSync(
      [SEEDS.VOTE, disputePda.toBuffer(), voterAgentPda.toBuffer()],
      PROGRAM_ID,
    );

    expect(pda.equals(expected)).toBe(true);
  });
});
