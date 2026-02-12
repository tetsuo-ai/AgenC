/**
 * Integration tests for @agenc/runtime
 *
 * Validates AgentManager and AgentRuntime lifecycle against a LiteSVM instance.
 * No external validator required — runs in-process via LiteSVM.
 *
 * @see https://github.com/tetsuo-ai/AgenC/issues/124
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { AgentRuntime } from '../src/runtime.js';
import { AgentManager } from '../src/agent/manager.js';
import { Capability, combineCapabilities } from '../src/agent/capabilities.js';
import { generateAgentId } from '../src/utils/encoding.js';
import { AgentStatus } from '../src/agent/types.js';
import { keypairToWallet } from '../src/types/wallet.js';
import {
  createRuntimeTestContext,
  initializeProtocol,
  advanceClock,
  type RuntimeTestContext,
} from './litesvm-setup.js';

/** Minimum stake required by on-chain protocol (0.01 SOL) */
const MIN_STAKE = BigInt(LAMPORTS_PER_SOL / 100);

describe('Integration Tests', () => {
  let ctx: RuntimeTestContext;

  beforeAll(async () => {
    ctx = createRuntimeTestContext();
    await initializeProtocol(ctx);
  });

  // ==========================================================================
  // AgentManager Lifecycle
  // ==========================================================================

  describe('AgentManager Lifecycle', () => {
    it('registers, updates, and deregisters an agent', async () => {
      const agentId = generateAgentId();
      const manager = new AgentManager({
        connection: ctx.connection,
        wallet: keypairToWallet(ctx.payer),
        program: ctx.program,
      });

      // Register
      const state = await manager.register({
        agentId,
        capabilities: combineCapabilities(Capability.COMPUTE, Capability.INFERENCE),
        endpoint: 'https://my-agent.example.com',
        stakeAmount: MIN_STAKE,
      });

      expect(state.status).toBe(AgentStatus.Active);
      expect(state.capabilities).toBe(3n);
      expect(state.endpoint).toBe('https://my-agent.example.com');
      expect(state.reputation).toBe(5000); // 50%

      // Update capabilities (add STORAGE → COMPUTE | INFERENCE | STORAGE = 7n)
      // register sets last_state_update = 0, so first update won't need clock advance
      const updated = await manager.updateCapabilities(
        combineCapabilities(Capability.COMPUTE, Capability.INFERENCE, Capability.STORAGE),
      );
      expect(updated.capabilities).toBe(7n);

      // Advance clock for the next updateAgent call (60s cooldown)
      advanceClock(ctx.svm, 61);

      // Update status to Inactive
      await manager.updateStatus(AgentStatus.Inactive);
      const inactive = await manager.getState();
      expect(inactive.status).toBe(AgentStatus.Inactive);

      // Deregister
      const tx = await manager.deregister();
      expect(tx).toBeTruthy();

      // Verify agent no longer exists
      const exists = await AgentManager.agentExists(
        ctx.connection,
        agentId,
        ctx.program.programId,
      );
      expect(exists).toBe(false);
    });
  });

  // ==========================================================================
  // AgentRuntime Lifecycle
  // ==========================================================================

  describe('AgentRuntime Lifecycle', () => {
    it('starts and stops runtime', async () => {
      const runtime = new AgentRuntime({
        connection: ctx.connection,
        wallet: ctx.payer,
        capabilities: combineCapabilities(Capability.COMPUTE),
        program: ctx.program,
        programId: ctx.program.programId,
        initialStake: MIN_STAKE,
        endpoint: 'https://test.agent.example.com',
      });

      // Start (registers + sets Active)
      const state = await runtime.start();
      expect(state.status).toBe(AgentStatus.Active);
      expect(runtime.isStarted()).toBe(true);

      // Advance clock before stop (updateStatus needs 60s cooldown since register set last_state_update=0,
      // but the first update is free. stop() calls updateStatus(Inactive) — register doesn't call updateAgent,
      // it sets last_state_update=0, so clock >= 0+60 is satisfied. But to be safe, advance.)
      advanceClock(ctx.svm, 61);

      // Stop
      await runtime.stop();
      expect(runtime.isStarted()).toBe(false);

      // Agent should be inactive now
      const finalState = await runtime.getAgentState();
      expect(finalState.status).toBe(AgentStatus.Inactive);

      // Cleanup: advance clock for deregister's preceding update
      advanceClock(ctx.svm, 61);
      await runtime.getAgentManager().deregister();
    });

    it('loads existing agent on restart', async () => {
      const agentId = generateAgentId();

      // First runtime — register
      const runtime1 = new AgentRuntime({
        connection: ctx.connection,
        wallet: ctx.payer,
        agentId,
        capabilities: combineCapabilities(Capability.COMPUTE),
        program: ctx.program,
        programId: ctx.program.programId,
        initialStake: MIN_STAKE,
        endpoint: 'https://test.agent.example.com',
      });
      await runtime1.start();

      // Advance clock before stop (so updateStatus(Inactive) can proceed)
      advanceClock(ctx.svm, 61);
      await runtime1.stop();

      // Advance clock before second start (so updateStatus(Active) can proceed)
      advanceClock(ctx.svm, 61);

      // Second runtime — should load existing agent
      const runtime2 = new AgentRuntime({
        connection: ctx.connection,
        wallet: ctx.payer,
        agentId,
        capabilities: combineCapabilities(Capability.COMPUTE),
        program: ctx.program,
        programId: ctx.program.programId,
        initialStake: MIN_STAKE,
        endpoint: 'https://test.agent.example.com',
      });
      const state = await runtime2.start();
      expect(state.status).toBe(AgentStatus.Active);

      // Cleanup
      advanceClock(ctx.svm, 61);
      await runtime2.stop();
      advanceClock(ctx.svm, 61);
      await runtime2.getAgentManager().deregister();
    });
  });

  // ==========================================================================
  // Rate Limiting
  // ==========================================================================

  describe('Rate Limiting', () => {
    it('returns correct rate limit state for new agent', async () => {
      const agentId = generateAgentId();
      const manager = new AgentManager({
        connection: ctx.connection,
        wallet: keypairToWallet(ctx.payer),
        program: ctx.program,
      });

      await manager.register({
        agentId,
        capabilities: combineCapabilities(Capability.COMPUTE),
        endpoint: 'https://test.example.com',
        stakeAmount: MIN_STAKE,
      });

      // New agent should not be rate limited
      const rateLimitState = await manager.getRateLimitState();
      expect(rateLimitState.canCreateTask).toBe(true);
      expect(rateLimitState.canInitiateDispute).toBe(true);
      expect(rateLimitState.tasksRemainingIn24h).toBeGreaterThan(0);
      expect(rateLimitState.disputesRemainingIn24h).toBeGreaterThan(0);

      // Cleanup
      await manager.deregister();
    });

    it('getRateLimitState does not throw for new agent', async () => {
      const agentId = generateAgentId();
      const manager = new AgentManager({
        connection: ctx.connection,
        wallet: keypairToWallet(ctx.payer),
        program: ctx.program,
      });

      await manager.register({
        agentId,
        capabilities: combineCapabilities(Capability.COMPUTE),
        endpoint: 'https://test.example.com',
        stakeAmount: MIN_STAKE,
      });

      // getRateLimitState should succeed and indicate no limits hit
      const rateLimitState = await manager.getRateLimitState();
      expect(rateLimitState.canCreateTask).toBe(true);
      expect(rateLimitState.canInitiateDispute).toBe(true);

      // Cleanup
      await manager.deregister();
    });

    it('correctly reads rate limit window fields', async () => {
      const agentId = generateAgentId();
      const manager = new AgentManager({
        connection: ctx.connection,
        wallet: keypairToWallet(ctx.payer),
        program: ctx.program,
      });

      await manager.register({
        agentId,
        capabilities: combineCapabilities(Capability.COMPUTE),
        endpoint: 'https://test.example.com',
        stakeAmount: MIN_STAKE,
      });

      const state = await manager.getState();

      // Rate limit window should be initialized
      expect(state.rateLimitWindowStart).toBeGreaterThan(0);
      expect(state.taskCount24h).toBe(0);
      expect(state.disputeCount24h).toBe(0);
      expect(state.lastTaskCreated).toBe(0);
      expect(state.lastDisputeInitiated).toBe(0);

      // Cleanup
      await manager.deregister();
    });
  });

  // ==========================================================================
  // Static Methods
  // ==========================================================================

  describe('Static Methods', () => {
    it('fetches agent by ID', async () => {
      const agentId = generateAgentId();
      const manager = new AgentManager({
        connection: ctx.connection,
        wallet: keypairToWallet(ctx.payer),
        program: ctx.program,
      });

      await manager.register({
        agentId,
        capabilities: combineCapabilities(Capability.COMPUTE),
        endpoint: 'https://test.example.com',
        stakeAmount: MIN_STAKE,
      });

      // Fetch using static method
      const fetchedState = await AgentManager.fetchAgent(
        ctx.connection,
        agentId,
        ctx.program.programId,
      );
      expect(fetchedState).not.toBeNull();
      expect(fetchedState!.endpoint).toBe('https://test.example.com');

      // Fetch by PDA
      const pda = manager.getAgentPda()!;
      const fetchedByPda = await AgentManager.fetchAgentByPda(
        ctx.connection,
        pda,
        ctx.program.programId,
      );
      expect(fetchedByPda).not.toBeNull();
      expect(fetchedByPda!.endpoint).toBe('https://test.example.com');

      // Cleanup
      await manager.deregister();
    });

    it('returns null for non-existent agent', async () => {
      const nonExistentId = generateAgentId();
      const state = await AgentManager.fetchAgent(
        ctx.connection,
        nonExistentId,
        ctx.program.programId,
      );
      expect(state).toBeNull();
    });
  });
});
