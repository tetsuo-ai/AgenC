"use strict";
/**
 * Reputation economy integration tests (Issue #1110)
 *
 * Tests for on-chain reputation staking, delegation, and revocation:
 * stake_reputation, withdraw_reputation_stake, delegate_reputation, revoke_delegation.
 *
 * Uses LiteSVM for fast test execution with clock manipulation.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const bn_js_1 = __importDefault(require("bn.js"));
const chai_1 = require("chai");
const web3_js_1 = require("@solana/web3.js");
const test_utils_1 = require("./test-utils");
const litesvm_helpers_1 = require("./litesvm-helpers");
// PDA derivation helpers for reputation accounts
function deriveReputationStakePda(agentPda, programId) {
    const [pda] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("reputation_stake"), agentPda.toBuffer()], programId);
    return pda;
}
function deriveReputationDelegationPda(delegatorPda, delegateePda, programId) {
    const [pda] = web3_js_1.PublicKey.findProgramAddressSync([
        Buffer.from("reputation_delegation"),
        delegatorPda.toBuffer(),
        delegateePda.toBuffer(),
    ], programId);
    return pda;
}
describe("reputation economy (issue #1110)", () => {
    const { svm, provider, program, payer } = (0, litesvm_helpers_1.createLiteSVMContext)();
    const protocolPda = (0, test_utils_1.deriveProtocolPda)(program.programId);
    const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    let alice;
    let bob;
    let aliceAgentId;
    let bobAgentId;
    let aliceAgentPda;
    let bobAgentPda;
    const AGENT_STAKE = web3_js_1.LAMPORTS_PER_SOL;
    // 7 days in seconds (matches on-chain constant)
    const STAKING_COOLDOWN = 7 * 24 * 60 * 60;
    function makeId(prefix) {
        return Buffer.from(`${prefix}-${runId}`.slice(0, 32).padEnd(32, "\0"));
    }
    const airdrop = (wallets, amount = 100 * web3_js_1.LAMPORTS_PER_SOL) => {
        for (const wallet of wallets) {
            (0, litesvm_helpers_1.fundAccount)(svm, wallet.publicKey, amount);
        }
    };
    const registerAgent = async (agentId, authority, capabilities = test_utils_1.CAPABILITY_COMPUTE, stake = AGENT_STAKE) => {
        const agentPda = (0, test_utils_1.deriveAgentPda)(agentId, program.programId);
        try {
            await program.account.agentRegistration.fetch(agentPda);
        }
        catch {
            await program.methods
                .registerAgent(Array.from(agentId), new bn_js_1.default(capabilities), "https://example.com", null, new bn_js_1.default(stake))
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
        alice = web3_js_1.Keypair.generate();
        bob = web3_js_1.Keypair.generate();
        airdrop([alice, bob]);
        // Initialize protocol
        const treasury = web3_js_1.Keypair.generate();
        (0, litesvm_helpers_1.fundAccount)(svm, treasury.publicKey, web3_js_1.LAMPORTS_PER_SOL);
        const secondSigner = web3_js_1.Keypair.generate();
        const thirdSigner = web3_js_1.Keypair.generate();
        (0, litesvm_helpers_1.fundAccount)(svm, secondSigner.publicKey, web3_js_1.LAMPORTS_PER_SOL);
        (0, litesvm_helpers_1.fundAccount)(svm, thirdSigner.publicKey, web3_js_1.LAMPORTS_PER_SOL);
        try {
            await program.account.protocolConfig.fetch(protocolPda);
        }
        catch {
            await program.methods
                .initializeProtocol(51, 100, new bn_js_1.default(web3_js_1.LAMPORTS_PER_SOL / 100), new bn_js_1.default(web3_js_1.LAMPORTS_PER_SOL / 100), 2, [payer.publicKey, secondSigner.publicKey, thirdSigner.publicKey])
                .accountsPartial({
                protocolConfig: protocolPda,
                authority: payer.publicKey,
                treasury: secondSigner.publicKey,
                secondSigner: secondSigner.publicKey,
                systemProgram: web3_js_1.SystemProgram.programId,
            })
                .remainingAccounts([
                {
                    pubkey: (0, test_utils_1.deriveProgramDataPda)(program.programId),
                    isSigner: false,
                    isWritable: false,
                },
                {
                    pubkey: thirdSigner.publicKey,
                    isSigner: true,
                    isWritable: false,
                },
            ])
                .signers([secondSigner, thirdSigner])
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
            const stakeAmount = new bn_js_1.default(web3_js_1.LAMPORTS_PER_SOL);
            await program.methods
                .stakeReputation(stakeAmount)
                .accountsPartial({
                authority: alice.publicKey,
                agent: aliceAgentPda,
                reputationStake: stakePda,
                systemProgram: web3_js_1.SystemProgram.programId,
            })
                .signers([alice])
                .rpc();
            const stakeAccount = await program.account.reputationStake.fetch(stakePda);
            (0, chai_1.expect)(stakeAccount.stakedAmount.toNumber()).to.equal(web3_js_1.LAMPORTS_PER_SOL);
            (0, chai_1.expect)(stakeAccount.agent.toBase58()).to.equal(aliceAgentPda.toBase58());
            (0, chai_1.expect)(stakeAccount.slashCount).to.equal(0);
        });
        it("incremental stake increases total", async () => {
            const stakePda = deriveReputationStakePda(aliceAgentPda, program.programId);
            const additionalAmount = new bn_js_1.default(500000000); // 0.5 SOL
            await program.methods
                .stakeReputation(additionalAmount)
                .accountsPartial({
                authority: alice.publicKey,
                agent: aliceAgentPda,
                reputationStake: stakePda,
                systemProgram: web3_js_1.SystemProgram.programId,
            })
                .signers([alice])
                .rpc();
            const stakeAccount = await program.account.reputationStake.fetch(stakePda);
            (0, chai_1.expect)(stakeAccount.stakedAmount.toNumber()).to.equal(web3_js_1.LAMPORTS_PER_SOL + 500000000);
        });
        it("fails with zero amount", async () => {
            const stakePda = deriveReputationStakePda(aliceAgentPda, program.programId);
            try {
                await program.methods
                    .stakeReputation(new bn_js_1.default(0))
                    .accountsPartial({
                    authority: alice.publicKey,
                    agent: aliceAgentPda,
                    reputationStake: stakePda,
                    systemProgram: web3_js_1.SystemProgram.programId,
                })
                    .signers([alice])
                    .rpc();
                chai_1.expect.fail("Should have thrown");
            }
            catch (err) {
                (0, chai_1.expect)((0, test_utils_1.errorContainsAny)(err, ["ReputationStakeAmountTooLow"])).to.be
                    .true;
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
                    .withdrawReputationStake(new bn_js_1.default(100000000))
                    .accountsPartial({
                    authority: alice.publicKey,
                    agent: aliceAgentPda,
                    reputationStake: stakePda,
                })
                    .signers([alice])
                    .rpc();
                chai_1.expect.fail("Should have thrown");
            }
            catch (err) {
                (0, chai_1.expect)((0, test_utils_1.errorContainsAny)(err, ["ReputationStakeLocked"])).to.be.true;
            }
        });
        it("succeeds after cooldown period", async () => {
            const stakePda = deriveReputationStakePda(aliceAgentPda, program.programId);
            // Advance clock past cooldown
            (0, litesvm_helpers_1.advanceClock)(svm, STAKING_COOLDOWN + 1);
            const withdrawAmount = new bn_js_1.default(500000000);
            await program.methods
                .withdrawReputationStake(withdrawAmount)
                .accountsPartial({
                authority: alice.publicKey,
                agent: aliceAgentPda,
                reputationStake: stakePda,
            })
                .signers([alice])
                .rpc();
            const stakeAccount = await program.account.reputationStake.fetch(stakePda);
            // Was 1.5 SOL, withdrew 0.5 SOL = 1.0 SOL remaining
            (0, chai_1.expect)(stakeAccount.stakedAmount.toNumber()).to.equal(web3_js_1.LAMPORTS_PER_SOL);
        });
        it("fails with insufficient balance", async () => {
            const stakePda = deriveReputationStakePda(aliceAgentPda, program.programId);
            // Advance past cooldown again (new stake resets lock)
            (0, litesvm_helpers_1.advanceClock)(svm, STAKING_COOLDOWN + 1);
            try {
                await program.methods
                    .withdrawReputationStake(new bn_js_1.default(100 * web3_js_1.LAMPORTS_PER_SOL)) // Way more than staked
                    .accountsPartial({
                    authority: alice.publicKey,
                    agent: aliceAgentPda,
                    reputationStake: stakePda,
                })
                    .signers([alice])
                    .rpc();
                chai_1.expect.fail("Should have thrown");
            }
            catch (err) {
                (0, chai_1.expect)((0, test_utils_1.errorContainsAny)(err, ["ReputationStakeInsufficientBalance"])).to
                    .be.true;
            }
        });
    });
    // ==========================================================================
    // Delegation tests
    // ==========================================================================
    describe("delegate_reputation", () => {
        it("successfully delegates reputation", async () => {
            const delegationPda = deriveReputationDelegationPda(aliceAgentPda, bobAgentPda, program.programId);
            await program.methods
                .delegateReputation(1000, new bn_js_1.default(0)) // 1000 points, no expiry
                .accountsPartial({
                authority: alice.publicKey,
                delegatorAgent: aliceAgentPda,
                delegateeAgent: bobAgentPda,
                delegation: delegationPda,
                systemProgram: web3_js_1.SystemProgram.programId,
            })
                .signers([alice])
                .rpc();
            const delegation = await program.account.reputationDelegation.fetch(delegationPda);
            (0, chai_1.expect)(delegation.delegator.toBase58()).to.equal(aliceAgentPda.toBase58());
            (0, chai_1.expect)(delegation.delegatee.toBase58()).to.equal(bobAgentPda.toBase58());
            (0, chai_1.expect)(delegation.amount).to.equal(1000);
            (0, chai_1.expect)(delegation.expiresAt.toNumber()).to.equal(0);
        });
        it("fails on self-delegation", async () => {
            const delegationPda = deriveReputationDelegationPda(aliceAgentPda, aliceAgentPda, program.programId);
            try {
                await program.methods
                    .delegateReputation(500, new bn_js_1.default(0))
                    .accountsPartial({
                    authority: alice.publicKey,
                    delegatorAgent: aliceAgentPda,
                    delegateeAgent: aliceAgentPda,
                    delegation: delegationPda,
                    systemProgram: web3_js_1.SystemProgram.programId,
                })
                    .signers([alice])
                    .rpc();
                chai_1.expect.fail("Should have thrown");
            }
            catch (err) {
                (0, chai_1.expect)((0, test_utils_1.errorContainsAny)(err, ["ReputationCannotDelegateSelf"])).to.be
                    .true;
            }
        });
        it("fails with amount below minimum", async () => {
            // Create a fresh pair for this test
            const charlie = web3_js_1.Keypair.generate();
            (0, litesvm_helpers_1.fundAccount)(svm, charlie.publicKey, 100 * web3_js_1.LAMPORTS_PER_SOL);
            const charlieAgentId = makeId("charlie-rep");
            const charlieAgentPda = await registerAgent(charlieAgentId, charlie);
            const delegationPda = deriveReputationDelegationPda(aliceAgentPda, charlieAgentPda, program.programId);
            try {
                await program.methods
                    .delegateReputation(50, new bn_js_1.default(0)) // Below MIN_DELEGATION_AMOUNT (100)
                    .accountsPartial({
                    authority: alice.publicKey,
                    delegatorAgent: aliceAgentPda,
                    delegateeAgent: charlieAgentPda,
                    delegation: delegationPda,
                    systemProgram: web3_js_1.SystemProgram.programId,
                })
                    .signers([alice])
                    .rpc();
                chai_1.expect.fail("Should have thrown");
            }
            catch (err) {
                (0, chai_1.expect)((0, test_utils_1.errorContainsAny)(err, ["ReputationDelegationAmountInvalid"])).to
                    .be.true;
            }
        });
        it("fails with amount exceeding 10000", async () => {
            const dave = web3_js_1.Keypair.generate();
            (0, litesvm_helpers_1.fundAccount)(svm, dave.publicKey, 100 * web3_js_1.LAMPORTS_PER_SOL);
            const daveAgentId = makeId("dave-rep");
            const daveAgentPda = await registerAgent(daveAgentId, dave);
            const delegationPda = deriveReputationDelegationPda(aliceAgentPda, daveAgentPda, program.programId);
            try {
                await program.methods
                    .delegateReputation(10001, new bn_js_1.default(0))
                    .accountsPartial({
                    authority: alice.publicKey,
                    delegatorAgent: aliceAgentPda,
                    delegateeAgent: daveAgentPda,
                    delegation: delegationPda,
                    systemProgram: web3_js_1.SystemProgram.programId,
                })
                    .signers([alice])
                    .rpc();
                chai_1.expect.fail("Should have thrown");
            }
            catch (err) {
                (0, chai_1.expect)((0, test_utils_1.errorContainsAny)(err, ["ReputationDelegationAmountInvalid"])).to
                    .be.true;
            }
        });
    });
    // ==========================================================================
    // Revoke delegation tests
    // ==========================================================================
    describe("revoke_delegation", () => {
        it("fails before delegation cooldown (7 days)", async () => {
            const delegationPda = deriveReputationDelegationPda(aliceAgentPda, bobAgentPda, program.programId);
            // Verify delegation exists
            const before = await program.account.reputationDelegation.fetch(delegationPda);
            (0, chai_1.expect)(before).to.not.be.null;
            // Attempt immediate revocation — should fail due to 7-day cooldown
            try {
                await program.methods
                    .revokeDelegation()
                    .accountsPartial({
                    authority: alice.publicKey,
                    delegatorAgent: aliceAgentPda,
                    delegation: delegationPda,
                })
                    .signers([alice])
                    .rpc();
                chai_1.expect.fail("Should have thrown");
            }
            catch (err) {
                // Error code 6196 = DelegationCooldownNotElapsed
                (0, chai_1.expect)((0, test_utils_1.errorContainsAny)(err, [
                    "DelegationCooldownNotElapsed",
                    "6196",
                    "0x1834",
                ])).to.be.true;
            }
        });
        it("successfully revokes a delegation after cooldown", async () => {
            const delegationPda = deriveReputationDelegationPda(aliceAgentPda, bobAgentPda, program.programId);
            // Advance clock past 7-day delegation cooldown
            const DELEGATION_COOLDOWN = 7 * 24 * 60 * 60;
            (0, litesvm_helpers_1.advanceClock)(svm, DELEGATION_COOLDOWN + 1);
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
            const after = await program.account.reputationDelegation.fetchNullable(delegationPda);
            (0, chai_1.expect)(after).to.be.null;
        });
    });
    // ==========================================================================
    // Edge case tests
    // ==========================================================================
    describe("edge cases", () => {
        it("fails to delegate with expires_at in the past", async () => {
            const eve = web3_js_1.Keypair.generate();
            (0, litesvm_helpers_1.fundAccount)(svm, eve.publicKey, 100 * web3_js_1.LAMPORTS_PER_SOL);
            const eveAgentId = makeId("eve-rep");
            const eveAgentPda = await registerAgent(eveAgentId, eve);
            const delegationPda = deriveReputationDelegationPda(aliceAgentPda, eveAgentPda, program.programId);
            // Use a timestamp in the past
            const pastTimestamp = (0, litesvm_helpers_1.getClockTimestamp)(svm) - 1000;
            try {
                await program.methods
                    .delegateReputation(500, new bn_js_1.default(pastTimestamp))
                    .accountsPartial({
                    authority: alice.publicKey,
                    delegatorAgent: aliceAgentPda,
                    delegateeAgent: eveAgentPda,
                    delegation: delegationPda,
                    systemProgram: web3_js_1.SystemProgram.programId,
                })
                    .signers([alice])
                    .rpc();
                chai_1.expect.fail("Should have thrown");
            }
            catch (err) {
                (0, chai_1.expect)((0, test_utils_1.errorContainsAny)(err, ["ReputationDelegationExpired"])).to.be
                    .true;
            }
        });
        it("suspended agent cannot stake", async () => {
            // Create a new agent and suspend it
            const frank = web3_js_1.Keypair.generate();
            (0, litesvm_helpers_1.fundAccount)(svm, frank.publicKey, 100 * web3_js_1.LAMPORTS_PER_SOL);
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
                    .stakeReputation(new bn_js_1.default(web3_js_1.LAMPORTS_PER_SOL))
                    .accountsPartial({
                    authority: frank.publicKey,
                    agent: frankAgentPda,
                    reputationStake: stakePda,
                    systemProgram: web3_js_1.SystemProgram.programId,
                })
                    .signers([frank])
                    .rpc();
                chai_1.expect.fail("Should have thrown");
            }
            catch (err) {
                (0, chai_1.expect)((0, test_utils_1.errorContainsAny)(err, ["ReputationAgentNotActive"])).to.be.true;
            }
        });
        it("bob cannot withdraw from alice's stake", async () => {
            const stakePda = deriveReputationStakePda(aliceAgentPda, program.programId);
            // Advance clock past cooldown to rule out that error
            (0, litesvm_helpers_1.advanceClock)(svm, STAKING_COOLDOWN + 1);
            try {
                await program.methods
                    .withdrawReputationStake(new bn_js_1.default(100000))
                    .accountsPartial({
                    authority: bob.publicKey,
                    agent: aliceAgentPda,
                    reputationStake: stakePda,
                })
                    .signers([bob])
                    .rpc();
                chai_1.expect.fail("Should have thrown");
            }
            catch (err) {
                (0, chai_1.expect)((0, test_utils_1.errorContainsAny)(err, ["UnauthorizedAgent"])).to.be.true;
            }
        });
    });
});
