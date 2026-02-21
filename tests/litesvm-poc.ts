/**
 * LiteSVM Proof of Concept — validates all API assumptions before migrating tests.
 *
 * Tests:
 * 1. fromWorkspace() loads the program
 * 2. LiteSVMProvider creates an Anchor-compatible provider
 * 3. Program instance works with IDL
 * 4. ProgramData PDA injection works
 * 5. initialize_protocol succeeds
 * 6. register_agent + create_task + claim_task + complete_task lifecycle
 * 7. provider.connection.getBalance() works
 * 8. provider.connection.getAccountInfo() works (and returns null for missing)
 * 9. SPL Token operations work (createMint, mintTo, getAccount)
 * 10. Clock manipulation works
 */

import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import { expect } from "chai";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  createLiteSVMContext,
  fundAccount,
  getClockTimestamp,
  advanceClock,
} from "./litesvm-helpers";
import {
  CAPABILITY_COMPUTE,
  CAPABILITY_INFERENCE,
  CAPABILITY_ARBITER,
  TASK_TYPE_EXCLUSIVE,
  getDefaultDeadline,
  deriveProgramDataPda,
  MIN_DISPUTE_STAKE_LAMPORTS,
} from "./test-utils";

describe("litesvm-poc", () => {
  const { svm, provider, program, payer } = createLiteSVMContext({
    splTokens: true,
  });

  const [protocolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol")],
    program.programId,
  );

  let treasury: Keypair;
  let secondSigner: Keypair;
  let thirdSigner: Keypair;
  let creator: Keypair;
  let worker: Keypair;

  before(() => {
    treasury = Keypair.generate();
    secondSigner = Keypair.generate();
    thirdSigner = Keypair.generate();
    creator = Keypair.generate();
    worker = Keypair.generate();

    // Fund accounts instantly (no airdrop latency)
    fundAccount(svm, treasury.publicKey, 10 * LAMPORTS_PER_SOL);
    fundAccount(svm, secondSigner.publicKey, 10 * LAMPORTS_PER_SOL);
    fundAccount(svm, thirdSigner.publicKey, 10 * LAMPORTS_PER_SOL);
    fundAccount(svm, creator.publicKey, 100 * LAMPORTS_PER_SOL);
    fundAccount(svm, worker.publicKey, 100 * LAMPORTS_PER_SOL);
  });

  describe("Phase 0: API Validation", () => {
    it("should have a valid program instance", () => {
      expect(program.programId).to.be.instanceOf(PublicKey);
      expect(program.programId.equals(PublicKey.default)).to.equal(false);
    });

    it("should initialize protocol successfully", async () => {
      const minStake = new BN(LAMPORTS_PER_SOL / 100);
      const minStakeForDispute = new BN(LAMPORTS_PER_SOL / 100);
      const programDataPda = deriveProgramDataPda(program.programId);

      await program.methods
        .initializeProtocol(51, 100, minStake, minStakeForDispute, 2, [
          provider.wallet.publicKey,
          secondSigner.publicKey,
          thirdSigner.publicKey,
        ])
        .accountsPartial({
          protocolConfig: protocolPda,
          treasury: secondSigner.publicKey,
          authority: provider.wallet.publicKey,
          secondSigner: secondSigner.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          { pubkey: programDataPda, isSigner: false, isWritable: false },
          {
            pubkey: thirdSigner.publicKey,
            isSigner: true,
            isWritable: false,
          },
        ])
        .signers([secondSigner, thirdSigner])
        .rpc();

      // Verify protocol was initialized
      const config = await program.account.protocolConfig.fetch(protocolPda);
      expect(config.treasury.toBase58()).to.equal(
        secondSigner.publicKey.toBase58(),
      );
      expect(config.protocolFeeBps).to.equal(100);
    });

    it("should set rate limits to minimums", async () => {
      await program.methods
        .updateRateLimits(
          new BN(1), // task_creation_cooldown = 1s (minimum allowed)
          255, // max_tasks_per_24h = 255 (effectively unlimited)
          new BN(1), // dispute_initiation_cooldown = 1s (minimum allowed)
          255, // max_disputes_per_24h = 255 (effectively unlimited)
          new BN(MIN_DISPUTE_STAKE_LAMPORTS),
        )
        .accountsPartial({ protocolConfig: protocolPda })
        .remainingAccounts([
          {
            pubkey: provider.wallet.publicKey,
            isSigner: true,
            isWritable: false,
          },
          {
            pubkey: secondSigner.publicKey,
            isSigner: true,
            isWritable: false,
          },
        ])
        .signers([secondSigner])
        .rpc();
    });

    it("should register an agent", async () => {
      const agentId = Buffer.from("poc-agent-creator".padEnd(32, "\0"));
      const [agentPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("agent"), agentId],
        program.programId,
      );

      await program.methods
        .registerAgent(
          Array.from(agentId),
          new BN(CAPABILITY_COMPUTE),
          "https://creator.example.com",
          null,
          new BN(LAMPORTS_PER_SOL / 100),
        )
        .accountsPartial({
          agent: agentPda,
          protocolConfig: protocolPda,
          authority: creator.publicKey,
        })
        .signers([creator])
        .rpc();

      const agent = await program.account.agentRegistration.fetch(agentPda);
      expect(agent.authority.toBase58()).to.equal(creator.publicKey.toBase58());
    });

    it("should create, claim, and complete a task", async () => {
      // Register worker agent
      const workerAgentId = Buffer.from("poc-agent-worker".padEnd(32, "\0"));
      const [workerAgentPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("agent"), workerAgentId],
        program.programId,
      );

      await program.methods
        .registerAgent(
          Array.from(workerAgentId),
          new BN(CAPABILITY_COMPUTE | CAPABILITY_INFERENCE),
          "https://worker.example.com",
          null,
          new BN(LAMPORTS_PER_SOL / 100),
        )
        .accountsPartial({
          agent: workerAgentPda,
          protocolConfig: protocolPda,
          authority: worker.publicKey,
        })
        .signers([worker])
        .rpc();

      // Create task
      const creatorAgentId = Buffer.from("poc-agent-creator".padEnd(32, "\0"));
      const [creatorAgentPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("agent"), creatorAgentId],
        program.programId,
      );
      const taskId = Buffer.from("poc-task-001".padEnd(32, "\0"));
      const [taskPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("task"), creator.publicKey.toBuffer(), taskId],
        program.programId,
      );
      const [escrowPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), taskPda.toBuffer()],
        program.programId,
      );

      const reward = LAMPORTS_PER_SOL;

      await program.methods
        .createTask(
          Array.from(taskId),
          new BN(CAPABILITY_COMPUTE),
          Buffer.from("PoC task description".padEnd(64, "\0")),
          new BN(reward),
          1,
          getDefaultDeadline(),
          TASK_TYPE_EXCLUSIVE,
          null,
          0,
          null,
        )
        .accountsPartial({
          task: taskPda,
          escrow: escrowPda,
          creatorAgent: creatorAgentPda,
          authority: creator.publicKey,
          creator: creator.publicKey,
          protocolConfig: protocolPda,
          systemProgram: SystemProgram.programId,
          rewardMint: null,
          creatorTokenAccount: null,
          tokenEscrowAta: null,
          tokenProgram: null,
          associatedTokenProgram: null,
        })
        .signers([creator])
        .rpc();

      // Verify task created
      const task = await program.account.task.fetch(taskPda);
      expect(task.rewardAmount.toNumber()).to.equal(reward);

      // Claim task
      const [claimPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("claim"), taskPda.toBuffer(), workerAgentPda.toBuffer()],
        program.programId,
      );

      await program.methods
        .claimTask()
        .accountsPartial({
          task: taskPda,
          claim: claimPda,
          worker: workerAgentPda,
          authority: worker.publicKey,
          protocolConfig: protocolPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([worker])
        .rpc();

      // Complete task
      const proofHash = Array.from(Buffer.from("proof".padEnd(32, "\0")));

      const balanceBefore = await provider.connection.getBalance(
        worker.publicKey,
      );

      await program.methods
        .completeTask(proofHash, null)
        .accountsPartial({
          task: taskPda,
          claim: claimPda,
          escrow: escrowPda,
          creator: creator.publicKey,
          worker: workerAgentPda,
          protocolConfig: protocolPda,
          treasury: secondSigner.publicKey,
          authority: worker.publicKey,
          tokenEscrowAta: null,
          workerTokenAccount: null,
          treasuryTokenAccount: null,
          rewardMint: null,
          tokenProgram: null,
        })
        .signers([worker])
        .rpc();

      // Verify task completed
      const completedTask = await program.account.task.fetch(taskPda);
      expect(completedTask.completions).to.equal(1);

      // Verify worker received reward
      const balanceAfter = await provider.connection.getBalance(
        worker.publicKey,
      );
      expect(balanceAfter).to.be.greaterThan(balanceBefore);
    });

    it("provider.connection.getBalance() works", async () => {
      const balance = await provider.connection.getBalance(payer.publicKey);
      expect(balance).to.be.a("number");
      expect(balance).to.be.greaterThan(0);
    });

    it("provider.connection.getAccountInfo() returns null for missing accounts", async () => {
      const missing = Keypair.generate().publicKey;
      const info = await provider.connection.getAccountInfo(missing);
      expect(info).to.be.null;
    });

    it("provider.connection.getAccountInfo() returns data for existing accounts", async () => {
      const info = await provider.connection.getAccountInfo(protocolPda);
      expect(info).to.not.be.null;
      expect(info!.data).to.be.instanceOf(Buffer);
      expect(info!.data.length).to.be.greaterThan(0);
    });

    it("provider.connection.getSlot() and getBlockTime() work", async () => {
      const slot = await provider.connection.getSlot();
      expect(slot).to.be.a("number");

      const blockTime = await provider.connection.getBlockTime(slot);
      expect(blockTime).to.be.a("number");
    });

    it("clock manipulation works", () => {
      const before = getClockTimestamp(svm);
      advanceClock(svm, 3600); // advance 1 hour
      const after = getClockTimestamp(svm);
      expect(after - before).to.equal(3600);
    });
  });

  describe("SPL Token Operations", () => {
    let mint: PublicKey;
    let payerAta: PublicKey;

    it("should create an SPL token mint", async () => {
      const payerKp = (provider.wallet as any).payer as Keypair;
      mint = await createMint(
        provider.connection,
        payerKp,
        payerKp.publicKey,
        null,
        6,
      );
      expect(mint).to.be.instanceOf(PublicKey);
    });

    it("should create an associated token account", async () => {
      const payerKp = (provider.wallet as any).payer as Keypair;
      payerAta = await createAssociatedTokenAccount(
        provider.connection,
        payerKp,
        mint,
        payerKp.publicKey,
      );
      expect(payerAta).to.be.instanceOf(PublicKey);
    });

    it("should mint tokens", async () => {
      const payerKp = (provider.wallet as any).payer as Keypair;
      await mintTo(
        provider.connection,
        payerKp,
        mint,
        payerAta,
        payerKp,
        1_000_000_000, // 1000 tokens with 6 decimals
      );

      const account = await getAccount(provider.connection, payerAta);
      expect(Number(account.amount)).to.equal(1_000_000_000);
    });
  });
});
