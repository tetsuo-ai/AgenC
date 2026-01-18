import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { AgencCoordination } from "../target/types/agenc_coordination";

describe("minimal-test", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.AgencCoordination as Program<AgencCoordination>;

  it("debugs registerAgent", async () => {
    // Print program info
    console.log("Program ID:", program.programId.toString());

    // Print IDL instruction info
    const registerAgentIx = (program.idl as any).instructions.find(
      (ix: any) => ix.name === "registerAgent" || ix.name === "register_agent"
    );
    console.log("registerAgent instruction:", JSON.stringify(registerAgentIx, null, 2));

    // Generate test data
    const worker = Keypair.generate();
    const agentId = Buffer.from("minimal-test-agent-001".padEnd(32, "\0"));

    // Derive PDA
    const [agentPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), agentId],
      program.programId
    );

    const [protocolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("protocol")],
      program.programId
    );

    console.log("Agent PDA:", agentPda.toString());
    console.log("Protocol PDA:", protocolPda.toString());
    console.log("Worker:", worker.publicKey.toString());

    // Airdrop
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(worker.publicKey, 2 * LAMPORTS_PER_SOL),
      "confirmed"
    );

    // Try to register
    console.log("Calling registerAgent...");

    try {
      const tx = await program.methods
        .registerAgent(
          Array.from(agentId),
          new BN(1),
          "https://test.example.com",
          null,
          new BN(1 * LAMPORTS_PER_SOL)  // stakeAmount (1 SOL minimum)
        )
        .accounts({
          agent: agentPda,
          protocolConfig: protocolPda,
          authority: worker.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([worker])
        .rpc();

      console.log("TX:", tx);
    } catch (e) {
      console.error("Error:", e);
    }
  });
});
