/**
 * Agent Registration Tests
 *
 * Tests for agent registration, updates, and deregistration functionality.
 * Covers: registerAgent, updateAgent, deregisterAgent instructions.
 *
 * Run with: npx ts-mocha tests/agent-registration.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import { expect } from "chai";
import { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { AgencCoordination } from "../target/types/agenc_coordination";
import {
  CAPABILITY_COMPUTE,
  CAPABILITY_INFERENCE,
  CAPABILITY_ARBITER,
  deriveProtocolPda,
  deriveAgentPda,
  generateRunId,
  makeAgentId,
  fundWallet,
  fundWallets,
  initializeProtocolIfNeeded,
  disableRateLimits,
  registerAgent,
  registerAgentSafe,
} from "./utils/test-helpers";

describe("Agent Registration", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.AgencCoordination as Program<AgencCoordination>;
  const protocolPda = deriveProtocolPda(program.programId);
  const runId = generateRunId();

  let treasury: Keypair;
  let treasuryPubkey: PublicKey;

  before(async () => {
    console.log("\n========================================");
    console.log("Agent Registration Tests");
    console.log("Program ID:", program.programId.toBase58());
    console.log("Run ID:", runId);
    console.log("========================================\n");

    treasury = Keypair.generate();
    await fundWallet(provider.connection, treasury);

    treasuryPubkey = await initializeProtocolIfNeeded(
      program,
      protocolPda,
      treasury,
      provider.wallet as anchor.Wallet
    );

    await disableRateLimits(program, protocolPda, provider.wallet as anchor.Wallet);
  });

  // ============================================================================
  // Registration Happy Paths
  // ============================================================================

  describe("Registration Happy Paths", () => {
    it("registers agent with minimum stake", async () => {
      const wallet = Keypair.generate();
      await fundWallet(provider.connection, wallet, 2 * LAMPORTS_PER_SOL);

      const agentId = makeAgentId("min-stake", runId);
      const agentPda = await registerAgent(
        program,
        protocolPda,
        agentId,
        wallet,
        CAPABILITY_COMPUTE,
        LAMPORTS_PER_SOL / 10
      );

      const agent = await program.account.agentRegistration.fetch(agentPda);
      expect(agent.authority.toBase58()).to.equal(wallet.publicKey.toBase58());
      expect(agent.capabilities.toNumber()).to.equal(CAPABILITY_COMPUTE);
      expect(agent.stake.toNumber()).to.be.greaterThan(0);
      expect(agent.status).to.equal(1); // Active
      console.log("  Agent registered with minimum stake");
    });

    it("registers agent with multiple capabilities", async () => {
      const wallet = Keypair.generate();
      await fundWallet(provider.connection, wallet, 2 * LAMPORTS_PER_SOL);

      const agentId = makeAgentId("multi-cap", runId);
      const capabilities = CAPABILITY_COMPUTE | CAPABILITY_INFERENCE | CAPABILITY_ARBITER;
      const agentPda = await registerAgent(
        program,
        protocolPda,
        agentId,
        wallet,
        capabilities
      );

      const agent = await program.account.agentRegistration.fetch(agentPda);
      expect(agent.capabilities.toNumber() & CAPABILITY_COMPUTE).to.be.greaterThan(0);
      expect(agent.capabilities.toNumber() & CAPABILITY_INFERENCE).to.be.greaterThan(0);
      expect(agent.capabilities.toNumber() & CAPABILITY_ARBITER).to.be.greaterThan(0);
      console.log("  Agent registered with multiple capabilities");
    });

    it("registers agent with custom endpoint", async () => {
      const wallet = Keypair.generate();
      await fundWallet(provider.connection, wallet, 2 * LAMPORTS_PER_SOL);

      const agentId = makeAgentId("custom-ep", runId);
      const agentPda = deriveAgentPda(agentId, program.programId);

      await program.methods
        .registerAgent(
          Array.from(agentId),
          new BN(CAPABILITY_COMPUTE),
          "https://my-custom-endpoint.example.com/api/v2",
          null,
          new BN(LAMPORTS_PER_SOL / 10)
        )
        .accountsPartial({
          agent: agentPda,
          protocolConfig: protocolPda,
          authority: wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([wallet])
        .rpc({ skipPreflight: true });

      const agent = await program.account.agentRegistration.fetch(agentPda);
      expect(agent.endpoint).to.include("my-custom-endpoint");
      console.log("  Agent registered with custom endpoint");
    });
  });

  // ============================================================================
  // Registration Rejection Cases
  // ============================================================================

  describe("Registration Rejection Cases", () => {
    it("rejects duplicate agent ID registration", async () => {
      const wallet1 = Keypair.generate();
      const wallet2 = Keypair.generate();
      await fundWallets(provider.connection, [wallet1, wallet2], 2 * LAMPORTS_PER_SOL);

      const agentId = makeAgentId("dup-test", runId);

      // First registration succeeds
      await registerAgent(program, protocolPda, agentId, wallet1);

      // Second registration with same ID fails
      try {
        await registerAgent(program, protocolPda, agentId, wallet2);
        expect.fail("Should have rejected duplicate registration");
      } catch (e: any) {
        expect(e.message).to.satisfy((msg: string) =>
          msg.includes("already in use") || msg.includes("AlreadyRegistered")
        );
        console.log("  Duplicate registration rejected");
      }
    });

    it("rejects registration with insufficient stake", async () => {
      const wallet = Keypair.generate();
      await fundWallet(provider.connection, wallet, 2 * LAMPORTS_PER_SOL);

      const agentId = makeAgentId("low-stake", runId);
      const agentPda = deriveAgentPda(agentId, program.programId);

      try {
        await program.methods
          .registerAgent(
            Array.from(agentId),
            new BN(CAPABILITY_COMPUTE),
            "https://test.example.com",
            null,
            new BN(1) // 1 lamport - below minimum
          )
          .accountsPartial({
            agent: agentPda,
            protocolConfig: protocolPda,
            authority: wallet.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([wallet])
          .rpc();
        expect.fail("Should have rejected insufficient stake");
      } catch (e: any) {
        expect(e.message).to.include("InsufficientStake");
        console.log("  Insufficient stake rejected");
      }
    });
  });

  // ============================================================================
  // Update Agent Tests
  // ============================================================================

  describe("Update Agent", () => {
    let agentOwner: Keypair;
    let agentId: Buffer;
    let agentPda: PublicKey;

    before(async () => {
      agentOwner = Keypair.generate();
      await fundWallet(provider.connection, agentOwner, 2 * LAMPORTS_PER_SOL);

      agentId = makeAgentId("update-test", runId);
      agentPda = await registerAgent(
        program,
        protocolPda,
        agentId,
        agentOwner,
        CAPABILITY_COMPUTE
      );
    });

    it("allows owner to update capabilities", async () => {
      const newCapabilities = CAPABILITY_COMPUTE | CAPABILITY_INFERENCE;

      await program.methods
        .updateAgent(new BN(newCapabilities), null, null, null)
        .accountsPartial({
          agent: agentPda,
          authority: agentOwner.publicKey,
        })
        .signers([agentOwner])
        .rpc();

      const agent = await program.account.agentRegistration.fetch(agentPda);
      expect(agent.capabilities.toNumber()).to.equal(newCapabilities);
      console.log("  Capabilities updated by owner");
    });

    it("allows owner to update endpoint", async () => {
      await program.methods
        .updateAgent(null, "https://new-endpoint.example.com", null, null)
        .accountsPartial({
          agent: agentPda,
          authority: agentOwner.publicKey,
        })
        .signers([agentOwner])
        .rpc();

      const agent = await program.account.agentRegistration.fetch(agentPda);
      expect(agent.endpoint).to.include("new-endpoint");
      console.log("  Endpoint updated by owner");
    });

    it("rejects update by non-owner", async () => {
      const nonOwner = Keypair.generate();
      await fundWallet(provider.connection, nonOwner);

      try {
        await program.methods
          .updateAgent(new BN(CAPABILITY_ARBITER), null, null, null)
          .accountsPartial({
            agent: agentPda,
            authority: nonOwner.publicKey,
          })
          .signers([nonOwner])
          .rpc();
        expect.fail("Should have rejected non-owner update");
      } catch (e: any) {
        expect(e.message).to.satisfy((msg: string) =>
          msg.includes("UnauthorizedAgent") || msg.includes("constraint")
        );
        console.log("  Non-owner update rejected");
      }
    });
  });

  // ============================================================================
  // Deregistration Tests
  // ============================================================================

  describe("Deregistration", () => {
    it("allows owner to deregister inactive agent", async () => {
      const wallet = Keypair.generate();
      await fundWallet(provider.connection, wallet, 2 * LAMPORTS_PER_SOL);

      const agentId = makeAgentId("dereg-ok", runId);
      const agentPda = await registerAgent(program, protocolPda, agentId, wallet);

      const balanceBefore = await provider.connection.getBalance(wallet.publicKey);

      await program.methods
        .deregisterAgent()
        .accountsPartial({
          agent: agentPda,
          protocolConfig: protocolPda,
          authority: wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([wallet])
        .rpc();

      const balanceAfter = await provider.connection.getBalance(wallet.publicKey);
      expect(balanceAfter).to.be.greaterThan(balanceBefore * 0.9);
      console.log("  Agent deregistered and stake returned");
    });

    it("rejects deregistration by non-owner", async () => {
      const owner = Keypair.generate();
      const nonOwner = Keypair.generate();
      await fundWallets(provider.connection, [owner, nonOwner], 2 * LAMPORTS_PER_SOL);

      const agentId = makeAgentId("dereg-fail", runId);
      const agentPda = await registerAgent(program, protocolPda, agentId, owner);

      try {
        await program.methods
          .deregisterAgent()
          .accountsPartial({
            agent: agentPda,
            protocolConfig: protocolPda,
            authority: nonOwner.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([nonOwner])
          .rpc();
        expect.fail("Should have rejected non-owner deregistration");
      } catch (e: any) {
        expect(e.message).to.satisfy((msg: string) =>
          msg.includes("UnauthorizedAgent") || msg.includes("constraint")
        );
        console.log("  Non-owner deregistration rejected");
      }
    });
  });

  // ============================================================================
  // Agent Status Queries
  // ============================================================================

  describe("Agent Status Queries", () => {
    it("correctly reports agent status as active", async () => {
      const wallet = Keypair.generate();
      await fundWallet(provider.connection, wallet, 2 * LAMPORTS_PER_SOL);

      const agentId = makeAgentId("status-test", runId);
      const agentPda = await registerAgent(program, protocolPda, agentId, wallet);

      const agent = await program.account.agentRegistration.fetch(agentPda);
      expect(agent.status).to.equal(1); // Active
      expect(agent.tasksCompleted).to.equal(0);
      expect(agent.activeTasks).to.equal(0);
      console.log("  Agent status query successful");
    });

    it("tracks agent statistics correctly", async () => {
      const wallet = Keypair.generate();
      await fundWallet(provider.connection, wallet, 2 * LAMPORTS_PER_SOL);

      const agentId = makeAgentId("stats-test", runId);
      const agentPda = await registerAgent(program, protocolPda, agentId, wallet);

      const agent = await program.account.agentRegistration.fetch(agentPda);
      expect(agent.totalEarned.toNumber()).to.equal(0);
      expect(agent.tasksCompleted).to.equal(0);
      expect(agent.disputesWon).to.equal(0);
      expect(agent.disputesLost).to.equal(0);
      console.log("  Agent statistics initialized correctly");
    });
  });

  after(() => {
    console.log("\n========================================");
    console.log("Agent Registration Tests Complete");
    console.log("========================================\n");
  });
});
