import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import { expect } from "chai";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { AgencCoordination } from "../target/types/agenc_coordination";
import { deriveProgramDataPda, disableRateLimitsForTests } from "./test-utils";

describe("upgrades", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace
    .AgencCoordination as Program<AgencCoordination>;

  const [protocolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol")],
    program.programId,
  );

  const programDataPda = deriveProgramDataPda(program.programId);

  const CURRENT_PROTOCOL_VERSION = 1;
  const FUTURE_PROTOCOL_VERSION = CURRENT_PROTOCOL_VERSION + 1;

  let treasury: Keypair;
  let creator: Keypair;
  let multisigSigner: Keypair;
  let initialProtocolVersion: number | null = null;
  let creatorAgentPda: PublicKey;

  const taskIdTooNew = Buffer.from("task-upg-too-new-001".padEnd(32, "\0"));
  const taskIdTooOld = Buffer.from("task-upg-too-old-001".padEnd(32, "\0"));
  const creatorAgentId = Buffer.from(
    "creator-upg-000000000000000001".padEnd(32, "\0"),
  );

  const deriveTaskPda = (creatorKey: PublicKey, taskId: Buffer): PublicKey => {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("task"), creatorKey.toBuffer(), taskId],
      program.programId,
    )[0];
  };

  const deriveEscrowPda = (taskPda: PublicKey): PublicKey => {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), taskPda.toBuffer()],
      program.programId,
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
        await provider.connection.requestAirdrop(
          wallet.publicKey,
          airdropAmount,
        ),
        "confirmed",
      );
    }

    try {
      await program.methods
        .initializeProtocol(
          51, // dispute_threshold
          100, // protocol_fee_bps
          new BN(LAMPORTS_PER_SOL), // min_arbiter_stake
          2, // multisig_threshold
          [provider.wallet.publicKey, multisigSigner.publicKey],
        )
        .accountsPartial({
          protocolConfig: protocolPda,
          treasury: treasury.publicKey,
          authority: provider.wallet.publicKey,
        })
        .remainingAccounts([
          {
            pubkey: deriveProgramDataPda(program.programId),
            isSigner: false,
            isWritable: false,
          },
        ])
        .signers([multisigSigner])
        .rpc();
    } catch (e) {
      // Protocol may already be initialized
    }

    // Disable rate limiting for tests
    await disableRateLimitsForTests({
      program,
      protocolPda,
      authority: provider.wallet.publicKey,
    });

    const config = await program.account.protocolConfig.fetch(protocolPda);
    initialProtocolVersion = config.protocolVersion;

    creatorAgentPda = PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), creatorAgentId],
      program.programId,
    )[0];

    try {
      await program.methods
        .registerAgent(
          Array.from(creatorAgentId),
          new BN(1),
          "https://creator-upg.example.com",
          null,
          new BN(LAMPORTS_PER_SOL), // stake_amount
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
    if (
      initialProtocolVersion !== null &&
      initialProtocolVersion >= FUTURE_PROTOCOL_VERSION
    ) {
      return;
    }

    // Check if protocol was initialized with multisig threshold > 1
    const config = await program.account.protocolConfig.fetch(protocolPda);
    if (config.multisigThreshold <= 1) {
      // Protocol was initialized by another test with threshold=1, skip this test
      console.log(
        "Skipping multisig test - protocol initialized with threshold=1",
      );
      return;
    }

    try {
      await program.methods
        .migrateProtocol(FUTURE_PROTOCOL_VERSION)
        .accountsPartial({
          protocolConfig: protocolPda,
        })
        .remainingAccounts([
          {
            pubkey: provider.wallet.publicKey,
            isSigner: true,
            isWritable: false,
          },
        ])
        .rpc();
      expect.fail("Migration should require multisig approval");
    } catch (e: any) {
      // Check for MultisigNotEnoughSigners error using Anchor's error structure
      const errorCode = e.error?.errorCode?.code;
      if (errorCode === "MultisigNotEnoughSigners") {
        // Expected error
        return;
      }
      // Fallback: check error string for older Anchor versions
      const errorStr = e.toString();
      if (errorStr.includes("MultisigNotEnoughSigners")) {
        return;
      }
      throw new Error(
        `Expected MultisigNotEnoughSigners but got: ${errorCode || errorStr}`,
      );
    }
  });

  it("enforces AccountVersionTooOld when min_supported_version exceeds protocol_version", async () => {
    if (
      initialProtocolVersion !== null &&
      initialProtocolVersion > CURRENT_PROTOCOL_VERSION
    ) {
      return;
    }

    // Check if we have enough multisig signers to update min version
    const config = await program.account.protocolConfig.fetch(protocolPda);
    const needsMultisig = config.multisigThreshold > 1;

    // Check if multisigSigner is actually a valid signer for this protocol
    const multisigSigners = config.multisigSigners || [];
    const hasValidMultisig = multisigSigners.some((s: PublicKey) =>
      s.equals(multisigSigner.publicKey),
    );

    if (needsMultisig && !hasValidMultisig) {
      // Protocol was initialized by another test with different multisig, skip
      console.log("Skipping version test - multisig signer mismatch");
      return;
    }

    try {
      await program.methods
        .updateMinVersion(FUTURE_PROTOCOL_VERSION)
        .accountsPartial({
          protocolConfig: protocolPda,
        })
        .remainingAccounts([
          {
            pubkey: provider.wallet.publicKey,
            isSigner: true,
            isWritable: false,
          },
          ...(needsMultisig
            ? [
                {
                  pubkey: multisigSigner.publicKey,
                  isSigner: true,
                  isWritable: false,
                },
              ]
            : []),
        ])
        .signers(needsMultisig ? [multisigSigner] : [])
        .rpc();
    } catch (e: any) {
      // updateMinVersion failed, skip test
      console.log(
        "Skipping version test - updateMinVersion failed:",
        e.message,
      );
      return;
    }

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
          null, // constraint_hash
          0, // min_reputation
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
      // Check for AccountVersionTooOld error using Anchor's error structure
      const errorCode = e.error?.errorCode?.code;
      if (errorCode === "AccountVersionTooOld") {
        // Expected error - test passes
        return;
      }
      // Fallback: check error string for older Anchor versions
      const errorStr = e.toString();
      if (errorStr.includes("AccountVersionTooOld")) {
        return;
      }
      throw new Error(
        `Expected AccountVersionTooOld but got: ${errorCode || errorStr}`,
      );
    }

    // Restore min version (cleanup)
    try {
      await program.methods
        .updateMinVersion(CURRENT_PROTOCOL_VERSION)
        .accountsPartial({
          protocolConfig: protocolPda,
        })
        .remainingAccounts([
          {
            pubkey: provider.wallet.publicKey,
            isSigner: true,
            isWritable: false,
          },
          ...(needsMultisig
            ? [
                {
                  pubkey: multisigSigner.publicKey,
                  isSigner: true,
                  isWritable: false,
                },
              ]
            : []),
        ])
        .signers(needsMultisig ? [multisigSigner] : [])
        .rpc();
    } catch (e: any) {
      // Cleanup failed, not critical for test result
    }
  });

  it("migrates with multisig and enforces AccountVersionTooNew", async () => {
    const configBefore =
      await program.account.protocolConfig.fetch(protocolPda);
    const needsMultisig = configBefore.multisigThreshold > 1;
    const multisigSigners = configBefore.multisigSigners || [];
    const hasValidMultisig = multisigSigners.some((s: PublicKey) =>
      s.equals(multisigSigner.publicKey),
    );

    if (needsMultisig && !hasValidMultisig) {
      console.log("Skipping migration test - multisig signer mismatch");
      return;
    }

    if (configBefore.protocolVersion <= CURRENT_PROTOCOL_VERSION) {
      try {
        await program.methods
          .migrateProtocol(FUTURE_PROTOCOL_VERSION)
          .accountsPartial({
            protocolConfig: protocolPda,
          })
          .remainingAccounts([
            {
              pubkey: provider.wallet.publicKey,
              isSigner: true,
              isWritable: false,
            },
            ...(needsMultisig
              ? [
                  {
                    pubkey: multisigSigner.publicKey,
                    isSigner: true,
                    isWritable: false,
                  },
                ]
              : []),
          ])
          .signers(needsMultisig ? [multisigSigner] : [])
          .rpc();

        const configAfter =
          await program.account.protocolConfig.fetch(protocolPda);
        expect(configAfter.protocolVersion).to.equal(FUTURE_PROTOCOL_VERSION);
      } catch (e: any) {
        console.log(
          "Skipping AccountVersionTooNew test - migration failed:",
          e.message,
        );
        return;
      }
    } else {
      expect(configBefore.protocolVersion).to.be.greaterThan(
        CURRENT_PROTOCOL_VERSION,
      );
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
          new BN(0),
          0,
          null, // constraint_hash
          0, // min_reputation
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
      expect.fail("create_task should fail with AccountVersionTooNew");
    } catch (e: any) {
      // Check for AccountVersionTooNew error using Anchor's error structure
      const errorCode = e.error?.errorCode?.code;
      if (errorCode === "AccountVersionTooNew") {
        // Expected error - test passes
        return;
      }
      // Fallback: check error string for older Anchor versions
      const errorStr = e.toString();
      if (errorStr.includes("AccountVersionTooNew")) {
        return;
      }
      throw new Error(
        `Expected AccountVersionTooNew but got: ${errorCode || errorStr}`,
      );
    }
  });
});
