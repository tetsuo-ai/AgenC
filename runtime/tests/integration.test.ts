/**
 * Integration tests for @agenc/runtime
 *
 * Validates AgentManager and AgentRuntime lifecycle against a localnet validator.
 * Requires a running Solana test validator with the AgenC program deployed.
 *
 * Run: cd runtime && npx vitest run tests/integration.test.ts
 * Skip: SKIP_INTEGRATION=true npx vitest run tests/integration.test.ts
 *
 * @see https://github.com/tetsuo-ai/AgenC/issues/124
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { AgentRuntime } from '../src/runtime.js';
import { AgentManager } from '../src/agent/manager.js';
import { Capability, combineCapabilities } from '../src/agent/capabilities.js';
import { generateAgentId } from '../src/utils/encoding.js';
import { AgentStatus } from '../src/agent/types.js';
import { keypairToWallet } from '../src/types/wallet.js';

// Skip integration tests if not running against localnet
const SKIP_INTEGRATION = process.env.SKIP_INTEGRATION === 'true';

describe.skipIf(SKIP_INTEGRATION)('Integration Tests', () => {
  let connection: Connection;
  let payer: Keypair;

  beforeAll(async () => {
    connection = new Connection('http://localhost:8899', 'confirmed');
    payer = Keypair.generate();
    const signature = await connection.requestAirdrop(payer.publicKey, 10 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(signature);
  });

  // ==========================================================================
  // AgentManager Lifecycle
  // ==========================================================================

  describe('AgentManager Lifecycle', () => {
    it('registers, updates, and deregisters an agent', async () => {
      const agentId = generateAgentId();
      const manager = new AgentManager({
        connection,
        wallet: keypairToWallet(payer),
      });

      // Register
      const state = await manager.register({
        agentId,
        capabilities: combineCapabilities(Capability.COMPUTE, Capability.INFERENCE),
        endpoint: 'https://my-agent.example.com',
        stakeAmount: 0n,
      });

      expect(state.status).toBe(AgentStatus.Active);
      expect(state.capabilities).toBe(3n);
      expect(state.endpoint).toBe('https://my-agent.example.com');
      expect(state.reputation).toBe(5000); // 50%

      // Update capabilities (add STORAGE → COMPUTE | INFERENCE | STORAGE = 7n)
      const updated = await manager.updateCapabilities(
        combineCapabilities(Capability.COMPUTE, Capability.INFERENCE, Capability.STORAGE),
      );
      expect(updated.capabilities).toBe(7n);

      // Update status to Inactive
      await manager.updateStatus(AgentStatus.Inactive);
      const inactive = await manager.getState();
      expect(inactive.status).toBe(AgentStatus.Inactive);

      // Deregister
      const tx = await manager.deregister();
      expect(tx).toBeTruthy();

      // Verify agent no longer exists
      const exists = await AgentManager.agentExists(connection, agentId);
      expect(exists).toBe(false);
    });
  });

  // ==========================================================================
  // AgentRuntime Lifecycle
  // ==========================================================================

  describe('AgentRuntime Lifecycle', () => {
    it('starts and stops runtime', async () => {
      const runtime = new AgentRuntime({
        connection,
        wallet: payer,
        capabilities: combineCapabilities(Capability.COMPUTE),
        logLevel: 'debug',
      });

      // Start
      const state = await runtime.start();
      expect(state.status).toBe(AgentStatus.Active);
      expect(runtime.isStarted()).toBe(true);

      // Stop
      await runtime.stop();
      expect(runtime.isStarted()).toBe(false);

      // Agent should be inactive now
      const finalState = await runtime.getAgentState();
      expect(finalState.status).toBe(AgentStatus.Inactive);

      // Cleanup: deregister
      await runtime.getAgentManager().deregister();
    });

    it('loads existing agent on restart', async () => {
      const agentId = generateAgentId();

      // First runtime — register
      const runtime1 = new AgentRuntime({
        connection,
        wallet: payer,
        agentId,
        capabilities: combineCapabilities(Capability.COMPUTE),
      });
      await runtime1.start();
      await runtime1.stop();

      // Second runtime — should load existing agent
      const runtime2 = new AgentRuntime({
        connection,
        wallet: payer,
        agentId,
        capabilities: combineCapabilities(Capability.COMPUTE),
      });
      const state = await runtime2.start();
      expect(state.status).toBe(AgentStatus.Active);
      await runtime2.stop();

      // Cleanup
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
        connection,
        wallet: keypairToWallet(payer),
      });

      await manager.register({
        agentId,
        capabilities: combineCapabilities(Capability.COMPUTE),
        endpoint: 'https://test.example.com',
        stakeAmount: 0n,
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

    it('checkRateLimit does not throw for new agent', async () => {
      const agentId = generateAgentId();
      const manager = new AgentManager({
        connection,
        wallet: keypairToWallet(payer),
      });

      await manager.register({
        agentId,
        capabilities: combineCapabilities(Capability.COMPUTE),
        endpoint: 'https://test.example.com',
        stakeAmount: 0n,
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
        connection,
        wallet: keypairToWallet(payer),
      });

      await manager.register({
        agentId,
        capabilities: combineCapabilities(Capability.COMPUTE),
        endpoint: 'https://test.example.com',
        stakeAmount: 0n,
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
        connection,
        wallet: keypairToWallet(payer),
      });

      await manager.register({
        agentId,
        capabilities: combineCapabilities(Capability.COMPUTE),
        endpoint: 'https://test.example.com',
        stakeAmount: 0n,
      });

      // Fetch using static method
      const fetchedState = await AgentManager.fetchAgent(connection, agentId);
      expect(fetchedState).not.toBeNull();
      expect(fetchedState!.endpoint).toBe('https://test.example.com');

      // Fetch by PDA
      const pda = manager.getAgentPda()!;
      const fetchedByPda = await AgentManager.fetchAgentByPda(connection, pda);
      expect(fetchedByPda).not.toBeNull();
      expect(fetchedByPda!.endpoint).toBe('https://test.example.com');

      // Cleanup
      await manager.deregister();
    });

    it('returns null for non-existent agent', async () => {
      const nonExistentId = generateAgentId();
      const state = await AgentManager.fetchAgent(connection, nonExistentId);
      expect(state).toBeNull();
    });
  });
});
