/**
 * Reputation economy integration tests (Issue #1110)
 *
 * Tests for on-chain reputation staking, delegation, and revocation:
 * stake_reputation, withdraw_reputation_stake, delegate_reputation, revoke_delegation.
 *
 * Uses LiteSVM for fast test execution with clock manipulation.
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import { expect } from "chai";
import { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { AgencCoordination } from "../target/types/agenc_coordination";
import {
  CAPABILITY_COMPUTE,
  deriveProtocolPda,
  deriveAgentPda,
  deriveProgramDataPda,
  errorContainsAny,
} from "./test-utils";
import { createLiteSVMContext, fundAccount, getClockTimestamp, advanceClock } from "./litesvm-helpers";

// PDA derivation helpers for reputation accounts
function deriveReputationStakePda(agentPda: PublicKey, programId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("reputation_stake"), agentPda.toBuffer()],
    programId,
  );
  return pda;
}

function deriveReputationDelegationPda(
  delegatorPda: PublicKey,
  delegateePda: PublicKey,
  programId: PublicKey,
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("reputation_delegation"), delegatorPda.toBuffer(), delegateePda.toBuffer()],
    programId,
  );
  return pda;
}

describe("reputation economy (issue #1110)", () => {
  const { svm, provider, program, payer } = createLiteSVMContext();

  const protocolPda = deriveProtocolPda(program.programId);
  const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  let alice: Keypair;
  let bob: Keypair;

  let aliceAgentId: Buffer;
  let bobAgentId: Buffer;

  let aliceAgentPda: PublicKey;
  let bobAgentPda: PublicKey;

  const AGENT_STAKE = LAMPORTS_PER_SOL;

  // 7 days in seconds (matches on-chain constant)
  const STAKING_COOLDOWN = 7 * 24 * 60 * 60;

  function makeId(prefix: string): Buffer {
    return Buffer.from(`${prefix}-${runId}`.slice(0, 32).padEnd(32, "\0"));
  }

  const airdrop = (wallets: Keypair[], amount: number = 100 * LAMPORTS_PER_SOL) => {
    for (const wallet of wallets) {
      fundAccount(svm, wallet.publicKey, amount);
    }
  };

  const registerAgent = async (
    agentId: Buffer,
    authority: Keypair,
    capabilities: number = CAPABILITY_COMPUTE,
    stake: number = AGENT_STAKE,
  ): Promise<PublicKey> => {
    const agentPda = deriveAgentPda(agentId, program.programId);
    try {
      await program.account.agentRegistration.fetch(agentPda);
    } catch {
      await program.methods
        .registerAgent(Array.from(agentId), new BN(capabilities), "https://example.com", null, new BN(stake))
        .accountsPartial({
          agent: agentPda,
          protocolConfig: protocolPda,
          authority: authority.publicKey,
        })
        .signers([authority])
        .rpc();
    }
    return agentPda;
  };

  before(async () => {
    // Create wallets
    alice = Keypair.generate();
    bob = Keypair.generate();

    airdrop([alice, bob]);

    // Initialize protocol
    const treasury = Keypair.generate();
    fundAccount(svm, treasury.publicKey, LAMPORTS_PER_SOL);
    const secondSigner = Keypair.generate();
    fundAccount(svm, secondSigner.publicKey, LAMPORTS_PER_SOL);

    try {
      await program.account.protocolConfig.fetch(protocolPda);
    } catch {
      await program.methods
        .initializeProtocol(51, 100, new BN(LAMPORTS_PER_SOL / 100), new BN(LAMPORTS_PER_SOL / 100), 1, [payer.publicKey, secondSigner.publicKey])
        .accountsPartial({
          protocolConfig: protocolPda,
          authority: payer.publicKey,
          treasury: secondSigner.publicKey,
          secondSigner: secondSigner.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([{ pubkey: deriveProgramDataPda(program.programId), isSigner: false, isWritable: false }])
        .signers([secondSigner])
        .rpc();
    }

    // Register agents
    aliceAgentId = makeId("alice-rep");
    bobAgentId = makeId("bob-rep");
    aliceAgentPda = await registerAgent(aliceAgentId, alice);
    bobAgentPda = await registerAgent(bobAgentId, bob);
  });

  // ==========================================================================
  // Staking tests
  // ==========================================================================

  describe("stake_reputation", () => {
    it("successfully stakes SOL", async () => {
      const stakePda = deriveReputationStakePda(aliceAgentPda, program.programId);
      const stakeAmount = new BN(LAMPORTS_PER_SOL);

      await program.methods
        .stakeReputation(stakeAmount)
        .accountsPartial({
          authority: alice.publicKey,
          agent: aliceAgentPda,
          reputationStake: stakePda,
          systemProgram: SystemProgram.programId,
        })
        .signers([alice])
        .rpc();

      const stakeAccount = await (program.account as any).reputationStake.fetch(stakePda);
      expect(stakeAccount.stakedAmount.toNumber()).to.equal(LAMPORTS_PER_SOL);
      expect(stakeAccount.agent.toBase58()).to.equal(aliceAgentPda.toBase58());
      expect(stakeAccount.slashCount).to.equal(0);
    });

    it("incremental stake increases total", async () => {
      const stakePda = deriveReputationStakePda(aliceAgentPda, program.programId);
      const additionalAmount = new BN(500_000_000); // 0.5 SOL

      await program.methods
        .stakeReputation(additionalAmount)
        .accountsPartial({
          authority: alice.publicKey,
          agent: aliceAgentPda,
          reputationStake: stakePda,
          systemProgram: SystemProgram.programId,
        })
        .signers([alice])
        .rpc();

      const stakeAccount = await (program.account as any).reputationStake.fetch(stakePda);
      expect(stakeAccount.stakedAmount.toNumber()).to.equal(LAMPORTS_PER_SOL + 500_000_000);
    });

    it("fails with zero amount", async () => {
      const stakePda = deriveReputationStakePda(aliceAgentPda, program.programId);

      try {
        await program.methods
          .stakeReputation(new BN(0))
          .accountsPartial({
            authority: alice.publicKey,
            agent: aliceAgentPda,
            reputationStake: stakePda,
            systemProgram: SystemProgram.programId,
          })
          .signers([alice])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err) {
        expect(errorContainsAny(err, ["ReputationStakeAmountTooLow"])).to.be.true;
      }
    });
  });

  // ==========================================================================
  // Withdrawal tests
  // ==========================================================================

  describe("withdraw_reputation_stake", () => {
    it("fails before cooldown period", async () => {
      const stakePda = deriveReputationStakePda(aliceAgentPda, program.programId);

      try {
        await program.methods
          .withdrawReputationStake(new BN(100_000_000))
          .accountsPartial({
            authority: alice.publicKey,
            agent: aliceAgentPda,
            reputationStake: stakePda,
          })
          .signers([alice])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err) {
        expect(errorContainsAny(err, ["ReputationStakeLocked"])).to.be.true;
      }
    });

    it("succeeds after cooldown period", async () => {
      const stakePda = deriveReputationStakePda(aliceAgentPda, program.programId);

      // Advance clock past cooldown
      advanceClock(svm, STAKING_COOLDOWN + 1);

      const withdrawAmount = new BN(500_000_000);
      await program.methods
        .withdrawReputationStake(withdrawAmount)
        .accountsPartial({
          authority: alice.publicKey,
          agent: aliceAgentPda,
          reputationStake: stakePda,
        })
        .signers([alice])
        .rpc();

      const stakeAccount = await (program.account as any).reputationStake.fetch(stakePda);
      // Was 1.5 SOL, withdrew 0.5 SOL = 1.0 SOL remaining
      expect(stakeAccount.stakedAmount.toNumber()).to.equal(LAMPORTS_PER_SOL);
    });

    it("fails with insufficient balance", async () => {
      const stakePda = deriveReputationStakePda(aliceAgentPda, program.programId);

      // Advance past cooldown again (new stake resets lock)
      advanceClock(svm, STAKING_COOLDOWN + 1);

      try {
        await program.methods
          .withdrawReputationStake(new BN(100 * LAMPORTS_PER_SOL)) // Way more than staked
          .accountsPartial({
            authority: alice.publicKey,
            agent: aliceAgentPda,
            reputationStake: stakePda,
          })
          .signers([alice])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err) {
        expect(errorContainsAny(err, ["ReputationStakeInsufficientBalance"])).to.be.true;
      }
    });
  });

  // ==========================================================================
  // Delegation tests
  // ==========================================================================

  describe("delegate_reputation", () => {
    it("successfully delegates reputation", async () => {
      const delegationPda = deriveReputationDelegationPda(
        aliceAgentPda,
        bobAgentPda,
        program.programId,
      );

      await program.methods
        .delegateReputation(1000, new BN(0)) // 1000 points, no expiry
        .accountsPartial({
          authority: alice.publicKey,
          delegatorAgent: aliceAgentPda,
          delegateeAgent: bobAgentPda,
          delegation: delegationPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([alice])
        .rpc();

      const delegation = await (program.account as any).reputationDelegation.fetch(delegationPda);
      expect(delegation.delegator.toBase58()).to.equal(aliceAgentPda.toBase58());
      expect(delegation.delegatee.toBase58()).to.equal(bobAgentPda.toBase58());
      expect(delegation.amount).to.equal(1000);
      expect(delegation.expiresAt.toNumber()).to.equal(0);
    });

    it("fails on self-delegation", async () => {
      const delegationPda = deriveReputationDelegationPda(
        aliceAgentPda,
        aliceAgentPda,
        program.programId,
      );

      try {
        await program.methods
          .delegateReputation(500, new BN(0))
          .accountsPartial({
            authority: alice.publicKey,
            delegatorAgent: aliceAgentPda,
            delegateeAgent: aliceAgentPda,
            delegation: delegationPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([alice])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err) {
        expect(errorContainsAny(err, ["ReputationCannotDelegateSelf"])).to.be.true;
      }
    });

    it("fails with amount below minimum", async () => {
      // Create a fresh pair for this test
      const charlie = Keypair.generate();
      fundAccount(svm, charlie.publicKey, 100 * LAMPORTS_PER_SOL);
      const charlieAgentId = makeId("charlie-rep");
      const charlieAgentPda = await registerAgent(charlieAgentId, charlie);

      const delegationPda = deriveReputationDelegationPda(
        aliceAgentPda,
        charlieAgentPda,
        program.programId,
      );

      try {
        await program.methods
          .delegateReputation(50, new BN(0)) // Below MIN_DELEGATION_AMOUNT (100)
          .accountsPartial({
            authority: alice.publicKey,
            delegatorAgent: aliceAgentPda,
            delegateeAgent: charlieAgentPda,
            delegation: delegationPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([alice])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err) {
        expect(errorContainsAny(err, ["ReputationDelegationAmountInvalid"])).to.be.true;
      }
    });

    it("fails with amount exceeding 10000", async () => {
      const dave = Keypair.generate();
      fundAccount(svm, dave.publicKey, 100 * LAMPORTS_PER_SOL);
      const daveAgentId = makeId("dave-rep");
      const daveAgentPda = await registerAgent(daveAgentId, dave);

      const delegationPda = deriveReputationDelegationPda(
        aliceAgentPda,
        daveAgentPda,
        program.programId,
      );

      try {
        await program.methods
          .delegateReputation(10001, new BN(0))
          .accountsPartial({
            authority: alice.publicKey,
            delegatorAgent: aliceAgentPda,
            delegateeAgent: daveAgentPda,
            delegation: delegationPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([alice])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err) {
        expect(errorContainsAny(err, ["ReputationDelegationAmountInvalid"])).to.be.true;
      }
    });
  });

  // ==========================================================================
  // Revoke delegation tests
  // ==========================================================================

  describe("revoke_delegation", () => {
    it("successfully revokes a delegation", async () => {
      const delegationPda = deriveReputationDelegationPda(
        aliceAgentPda,
        bobAgentPda,
        program.programId,
      );

      // Verify delegation exists
      const before = await (program.account as any).reputationDelegation.fetch(delegationPda);
      expect(before).to.not.be.null;

      await program.methods
        .revokeDelegation()
        .accountsPartial({
          authority: alice.publicKey,
          delegatorAgent: aliceAgentPda,
          delegation: delegationPda,
        })
        .signers([alice])
        .rpc();

      // Verify delegation account is closed
      const after = await (program.account as any).reputationDelegation.fetchNullable(delegationPda);
      expect(after).to.be.null;
    });
  });

  // ==========================================================================
  // Edge case tests
  // ==========================================================================

  describe("edge cases", () => {
    it("fails to delegate with expires_at in the past", async () => {
      const eve = Keypair.generate();
      fundAccount(svm, eve.publicKey, 100 * LAMPORTS_PER_SOL);
      const eveAgentId = makeId("eve-rep");
      const eveAgentPda = await registerAgent(eveAgentId, eve);

      const delegationPda = deriveReputationDelegationPda(
        aliceAgentPda,
        eveAgentPda,
        program.programId,
      );

      // Use a timestamp in the past
      const pastTimestamp = getClockTimestamp(svm) - 1000;

      try {
        await program.methods
          .delegateReputation(500, new BN(pastTimestamp))
          .accountsPartial({
            authority: alice.publicKey,
            delegatorAgent: aliceAgentPda,
            delegateeAgent: eveAgentPda,
            delegation: delegationPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([alice])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err) {
        expect(errorContainsAny(err, ["ReputationDelegationExpired"])).to.be.true;
      }
    });

    it("suspended agent cannot stake", async () => {
      // Create a new agent and suspend it
      const frank = Keypair.generate();
      fundAccount(svm, frank.publicKey, 100 * LAMPORTS_PER_SOL);
      const frankAgentId = makeId("frank-rep");
      const frankAgentPda = await registerAgent(frankAgentId, frank);

      // Suspend the agent via protocol authority
      await program.methods
        .suspendAgent()
        .accountsPartial({
          agent: frankAgentPda,
          protocolConfig: protocolPda,
          authority: payer.publicKey,
        })
        .rpc();

      const stakePda = deriveReputationStakePda(frankAgentPda, program.programId);

      try {
        await program.methods
          .stakeReputation(new BN(LAMPORTS_PER_SOL))
          .accountsPartial({
            authority: frank.publicKey,
            agent: frankAgentPda,
            reputationStake: stakePda,
            systemProgram: SystemProgram.programId,
          })
          .signers([frank])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err) {
        expect(errorContainsAny(err, ["ReputationAgentNotActive"])).to.be.true;
      }
    });

    it("bob cannot withdraw from alice's stake", async () => {
      const stakePda = deriveReputationStakePda(aliceAgentPda, program.programId);

      // Advance clock past cooldown to rule out that error
      advanceClock(svm, STAKING_COOLDOWN + 1);

      try {
        await program.methods
          .withdrawReputationStake(new BN(100_000))
          .accountsPartial({
            authority: bob.publicKey,
            agent: aliceAgentPda,
            reputationStake: stakePda,
          })
          .signers([bob])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err) {
        expect(errorContainsAny(err, ["UnauthorizedAgent"])).to.be.true;
      }
    });
  });
});
