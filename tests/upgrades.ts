import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import { expect } from "chai";
import { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { AgencCoordination } from "../target/types/agenc_coordination";

describe("upgrades", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.AgencCoordination as Program<AgencCoordination>;

  const [protocolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol")],
    program.programId
  );

  const CURRENT_PROTOCOL_VERSION = 1;
  const FUTURE_PROTOCOL_VERSION = CURRENT_PROTOCOL_VERSION + 1;

  let treasury: Keypair;
  let creator: Keypair;
  let multisigSigner: Keypair;
  let initialProtocolVersion: number | null = null;
  let creatorAgentPda: PublicKey;

  const taskIdTooNew = Buffer.from("task-upg-too-new-001".padEnd(32, "\0"));
  const taskIdTooOld = Buffer.from("task-upg-too-old-001".padEnd(32, "\0"));
  const creatorAgentId = Buffer.from("creator-upg-000000000000000001".padEnd(32, "\0"));

  const deriveTaskPda = (creatorKey: PublicKey, taskId: Buffer): PublicKey => {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("task"), creatorKey.toBuffer(), taskId],
      program.programId
    )[0];
  };

  const deriveEscrowPda = (taskPda: PublicKey): PublicKey => {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), taskPda.toBuffer()],
      program.programId
    )[0];
  };

  before(async () => {
    treasury = Keypair.generate();
    creator = Keypair.generate();
    multisigSigner = Keypair.generate();

    const airdropAmount = 5 * LAMPORTS_PER_SOL;
    const wallets = [treasury, creator, multisigSigner];

    for (const wallet of wallets) {
      await provider.connection.confirmTransaction(
        await provider.connection.requestAirdrop(wallet.publicKey, airdropAmount),
        "confirmed"
      );
    }

    try {
      await program.methods
        .initializeProtocol(
          51, // dispute_threshold
          100, // protocol_fee_bps
          new BN(LAMPORTS_PER_SOL), // min_arbiter_stake
          2, // multisig_threshold
          [provider.wallet.publicKey, multisigSigner.publicKey]
        )
        .accounts({
          protocolConfig: protocolPda,
          treasury: treasury.publicKey,
          authority: provider.wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          { pubkey: provider.wallet.publicKey, isSigner: true, isWritable: false },
          { pubkey: multisigSigner.publicKey, isSigner: true, isWritable: false },
        ])
        .signers([multisigSigner])
        .rpc();
    } catch (e) {
      // Protocol may already be initialized
    }

    const config = await program.account.protocolConfig.fetch(protocolPda);
    initialProtocolVersion = config.protocolVersion;

    creatorAgentPda = PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), creatorAgentId],
      program.programId
    )[0];

    try {
      await program.methods
        .registerAgent(
          Array.from(creatorAgentId),
          new BN(1),
          "https://creator-upg.example.com",
          null,
          new BN(LAMPORTS_PER_SOL)  // stake_amount
        )
        .accountsPartial({
          agent: creatorAgentPda,
          protocolConfig: protocolPda,
          authority: creator.publicKey,
        })
        .signers([creator])
        .rpc();
    } catch (e) {
      // Agent may already be registered
    }
  });

  it("rejects migration without multisig approval", async () => {
    if (initialProtocolVersion !== null && initialProtocolVersion >= FUTURE_PROTOCOL_VERSION) {
      return;
    }

    try {
      await program.methods
        .migrateProtocol(FUTURE_PROTOCOL_VERSION)
        .accounts({
          protocolConfig: protocolPda,
        })
        .remainingAccounts([
          { pubkey: provider.wallet.publicKey, isSigner: true, isWritable: false },
        ])
        .rpc();
      expect.fail("Migration should require multisig approval");
    } catch (e: any) {
      expect(e.message).to.include("MultisigNotEnoughSigners");
    }
  });

  it("enforces AccountVersionTooOld when min_supported_version exceeds protocol_version", async () => {
    if (initialProtocolVersion !== null && initialProtocolVersion > CURRENT_PROTOCOL_VERSION) {
      return;
    }

    await program.methods
      .updateMinVersion(FUTURE_PROTOCOL_VERSION)
      .accounts({
        protocolConfig: protocolPda,
      })
      .remainingAccounts([
        { pubkey: provider.wallet.publicKey, isSigner: true, isWritable: false },
        { pubkey: multisigSigner.publicKey, isSigner: true, isWritable: false },
      ])
      .signers([multisigSigner])
      .rpc();

    const taskPda = deriveTaskPda(creator.publicKey, taskIdTooOld);
    const escrowPda = deriveEscrowPda(taskPda);

    try {
      await program.methods
        .createTask(
          Array.from(taskIdTooOld),
          new BN(1),
          Buffer.from("Too old version".padEnd(64, "\0")),
          new BN(0),
          1,
          new BN(0),
          0,
          null  // constraint_hash
        )
        .accountsPartial({
          task: taskPda,
          escrow: escrowPda,
          protocolConfig: protocolPda,
          creatorAgent: creatorAgentPda,
          authority: creator.publicKey,
          creator: creator.publicKey,
        })
        .signers([creator])
        .rpc();
      expect.fail("create_task should fail with AccountVersionTooOld");
    } catch (e: any) {
      expect(e.message).to.include("AccountVersionTooOld");
    }

    await program.methods
      .updateMinVersion(CURRENT_PROTOCOL_VERSION)
      .accounts({
        protocolConfig: protocolPda,
      })
      .remainingAccounts([
        { pubkey: provider.wallet.publicKey, isSigner: true, isWritable: false },
        { pubkey: multisigSigner.publicKey, isSigner: true, isWritable: false },
      ])
      .signers([multisigSigner])
      .rpc();
  });

  it("migrates with multisig and enforces AccountVersionTooNew", async () => {
    const configBefore = await program.account.protocolConfig.fetch(protocolPda);
    if (configBefore.protocolVersion <= CURRENT_PROTOCOL_VERSION) {
      await program.methods
        .migrateProtocol(FUTURE_PROTOCOL_VERSION)
        .accounts({
          protocolConfig: protocolPda,
        })
        .remainingAccounts([
          { pubkey: provider.wallet.publicKey, isSigner: true, isWritable: false },
          { pubkey: multisigSigner.publicKey, isSigner: true, isWritable: false },
        ])
        .signers([multisigSigner])
        .rpc();

      const configAfter = await program.account.protocolConfig.fetch(protocolPda);
      expect(configAfter.protocolVersion).to.equal(FUTURE_PROTOCOL_VERSION);
    } else {
      expect(configBefore.protocolVersion).to.be.greaterThan(CURRENT_PROTOCOL_VERSION);
    }

    const taskPda = deriveTaskPda(creator.publicKey, taskIdTooNew);
    const escrowPda = deriveEscrowPda(taskPda);

    try {
      await program.methods
        .createTask(
          Array.from(taskIdTooNew),
          new BN(1),
          Buffer.from("Too new version".padEnd(64, "\0")),
          new BN(0),
          1,
          0,
          0
        )
        .accounts({
          task: taskPda,
          escrow: escrowPda,
          protocolConfig: protocolPda,
          creatorAgent: creatorAgentPda,
          authority: creator.publicKey,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();
      expect.fail("create_task should fail with AccountVersionTooNew");
    } catch (e: any) {
      expect(e.message).to.include("AccountVersionTooNew");
    }
  });
});
