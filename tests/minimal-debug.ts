/**
 * Minimal debug test to diagnose websocket/connection issues
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { AgencCoordination } from "../target/types/agenc_coordination";
import { deriveProgramDataPda } from "./test-utils";

describe("minimal-debug", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.AgencCoordination as Program<AgencCoordination>;

  const [protocolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol")],
    program.programId
  );

  it("should connect to provider", async () => {
    console.log("Provider endpoint:", provider.connection.rpcEndpoint);
    console.log("Program ID:", program.programId.toBase58());

    const slot = await provider.connection.getSlot();
    console.log("Current slot:", slot);

    const balance = await provider.connection.getBalance(provider.wallet.publicKey);
    console.log("Wallet balance:", balance / LAMPORTS_PER_SOL, "SOL");

    console.log("Protocol PDA:", protocolPda.toBase58());

    const info = await provider.connection.getAccountInfo(protocolPda);
    console.log("Protocol exists:", info !== null);

    console.log("Connection test passed!");
  });

  it("should initialize protocol", async () => {
    const treasury = Keypair.generate();
    const secondSigner = Keypair.generate();
    console.log("Treasury:", treasury.publicKey.toBase58());
    console.log("SecondSigner:", secondSigner.publicKey.toBase58());

    // Airdrop to treasury and secondSigner
    const airdropSig1 = await provider.connection.requestAirdrop(treasury.publicKey, LAMPORTS_PER_SOL);
    const airdropSig2 = await provider.connection.requestAirdrop(secondSigner.publicKey, LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(airdropSig1, "confirmed");
    await provider.connection.confirmTransaction(airdropSig2, "confirmed");
    console.log("Treasury and secondSigner funded");

    try {
      console.log("Calling initializeProtocol...");
      // Protocol initialization requires (fix #556):
      // - min_stake >= 0.001 SOL (1_000_000 lamports)
      // - min_stake_for_dispute > 0
      // - second_signer different from authority
      // - both authority and second_signer in multisig_owners
      // - threshold < multisig_owners.length
      const minStake = new BN(LAMPORTS_PER_SOL / 100);  // 0.01 SOL
      const minStakeForDispute = new BN(LAMPORTS_PER_SOL / 100);  // 0.01 SOL
      const programDataPda = deriveProgramDataPda(program.programId);
      const tx = await program.methods
        .initializeProtocol(
          51,                // dispute_threshold
          100,               // protocol_fee_bps
          minStake,          // min_stake
          minStakeForDispute, // min_stake_for_dispute (new arg)
          1,                 // multisig_threshold (must be < owners.length)
          [provider.wallet.publicKey, secondSigner.publicKey]  // multisig_owners (need at least 2)
        )
        .accountsPartial({
          protocolConfig: protocolPda,
          treasury: secondSigner.publicKey,
          authority: provider.wallet.publicKey,
          secondSigner: secondSigner.publicKey,  // new account (fix #556)
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([{ pubkey: deriveProgramDataPda(program.programId), isSigner: false, isWritable: false }])
        .signers([secondSigner])
        .rpc();
      console.log("Transaction signature:", tx);
      console.log("Protocol initialized successfully!");
    } catch (e: any) {
      console.error("Error during initializeProtocol:");
      console.error("  Message:", e.message);
      if (e.logs) {
        console.error("  Logs:");
        e.logs.forEach((log: string) => console.error("    ", log));
      }
      if (
        e?.message?.includes("already in use") ||
        e?.message?.includes("ProtocolAlreadyInitialized")
      ) {
        console.log("Protocol already initialized, continuing with existing config");
      } else {
        throw e;
      }
    }

    // Verify it was created
    const config = await program.account.protocolConfig.fetch(protocolPda);
    console.log("Protocol config fetched:");
    console.log("  Authority:", config.authority.toBase58());
    console.log("  Treasury:", config.treasury.toBase58());
    console.log("  Protocol fee:", config.protocolFeeBps);
  });
});
