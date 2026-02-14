import { describe, expect, it, vi } from 'vitest';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import type { Program } from '@coral-xyz/anchor';
import { deriveAgentPda, registerAgent } from '../agents';
import { PROGRAM_ID, SEEDS } from '../constants';

describe('agents', () => {
  it('deriveAgentPda matches manual seed derivation', () => {
    const agentId = new Uint8Array(32).fill(7);
    const derived = deriveAgentPda(agentId, PROGRAM_ID);

    const [expected] = PublicKey.findProgramAddressSync(
      [SEEDS.AGENT, agentId],
      PROGRAM_ID,
    );

    expect(derived.equals(expected)).toBe(true);
  });

  it('registerAgent converts numeric params to BN and submits expected accounts', async () => {
    const rpc = vi.fn().mockResolvedValue('tx-signature');
    const signers = vi.fn().mockReturnValue({ rpc });
    const accountsPartial = vi.fn().mockReturnValue({ signers });
    const registerAgentMethod = vi.fn().mockReturnValue({ accountsPartial });

    const program = {
      programId: PROGRAM_ID,
      methods: {
        registerAgent: registerAgentMethod,
      },
    } as unknown as Program;

    const confirmTransaction = vi.fn().mockResolvedValue(undefined);
    const connection = {
      confirmTransaction,
    } as unknown as Connection;

    const authority = Keypair.generate();
    const params = {
      agentId: new Uint8Array(32).fill(3),
      capabilities: 42,
      endpoint: 'https://agent.example.com',
      stakeAmount: 1_000_000,
    };

    const result = await registerAgent(connection, program, authority, params);

    expect(registerAgentMethod).toHaveBeenCalledOnce();
    const args = registerAgentMethod.mock.calls[0];
    expect(args[1].toString()).toBe('42');
    expect(args[4].toString()).toBe('1000000');

    expect(accountsPartial).toHaveBeenCalledWith(
      expect.objectContaining({
        authority: authority.publicKey,
      }),
    );

    expect(confirmTransaction).toHaveBeenCalledWith('tx-signature', 'confirmed');
    expect(result.txSignature).toBe('tx-signature');
  });
});
