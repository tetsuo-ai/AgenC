import { describe, expect, it, vi } from 'vitest';
import { Connection, Keypair } from '@solana/web3.js';
import type { Program } from '@coral-xyz/anchor';
import { initializeProtocol } from '../protocol';
import { PROGRAM_ID } from '../constants';

describe('protocol wrappers', () => {
  it('initializeProtocol validates multisig threshold against owner count', async () => {
    const authority = Keypair.generate();
    const secondSigner = Keypair.generate();

    const program = {
      programId: PROGRAM_ID,
      methods: {
        initializeProtocol: vi.fn(),
      },
    } as unknown as Program;

    const connection = {
      confirmTransaction: vi.fn(),
    } as unknown as Connection;

    await expect(
      initializeProtocol(
        connection,
        program,
        authority,
        secondSigner,
        Keypair.generate().publicKey,
        {
          disputeThreshold: 51,
          protocolFeeBps: 100,
          minStake: 1_000_000,
          minStakeForDispute: 500_000,
          multisigThreshold: 3,
          multisigOwners: [authority.publicKey, secondSigner.publicKey],
        },
      ),
    ).rejects.toThrow('multisigThreshold cannot exceed multisigOwners length');
  });

  it('initializeProtocol submits expected args and confirms transaction', async () => {
    const authority = Keypair.generate();
    const secondSigner = Keypair.generate();
    const treasury = Keypair.generate().publicKey;

    const rpc = vi.fn().mockResolvedValue('protocol-init-sig');
    const signers = vi.fn().mockReturnValue({ rpc });
    const remainingAccounts = vi.fn().mockReturnValue({ signers });
    const accountsPartial = vi.fn().mockReturnValue({ remainingAccounts });
    const initializeProtocolMethod = vi.fn().mockReturnValue({ accountsPartial });

    const program = {
      programId: PROGRAM_ID,
      methods: {
        initializeProtocol: initializeProtocolMethod,
      },
    } as unknown as Program;

    const confirmTransaction = vi.fn().mockResolvedValue(undefined);
    const connection = {
      confirmTransaction,
    } as unknown as Connection;

    const params = {
      disputeThreshold: 51,
      protocolFeeBps: 100,
      minStake: 1_000_000,
      minStakeForDispute: 500_000,
      multisigThreshold: 2,
      multisigOwners: [authority.publicKey, secondSigner.publicKey, Keypair.generate().publicKey],
    };

    const result = await initializeProtocol(
      connection,
      program,
      authority,
      secondSigner,
      treasury,
      params,
    );

    expect(initializeProtocolMethod).toHaveBeenCalledOnce();
    const args = initializeProtocolMethod.mock.calls[0];
    expect(args[0]).toBe(51);
    expect(args[1]).toBe(100);
    expect(args[2].toString()).toBe('1000000');
    expect(args[3].toString()).toBe('500000');
    expect(args[4]).toBe(2);

    expect(confirmTransaction).toHaveBeenCalledWith('protocol-init-sig', 'confirmed');
    expect(result.txSignature).toBe('protocol-init-sig');
  });
});
