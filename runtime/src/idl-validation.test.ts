/**
 * Tests for validateIdl error paths using module mocking.
 *
 * These tests are separated from idl.test.ts because they require
 * vi.mock() to replace the IDL import with malformed data.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Connection, Keypair } from '@solana/web3.js';
import { AnchorProvider, Wallet } from '@coral-xyz/anchor';

describe('validateIdl error paths', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws error when IDL is missing address field', async () => {
    // Mock the IDL JSON import with missing address
    vi.doMock('../idl/agenc_coordination.json', () => ({
      default: {
        metadata: { name: 'test' },
        instructions: [{ name: 'test_instruction' }],
        // address is missing
      },
    }));

    // Import the module after mocking
    const { createReadOnlyProgram } = await import('./idl');
    const connection = new Connection('http://127.0.0.1:8899', 'confirmed');

    expect(() => createReadOnlyProgram(connection)).toThrow(
      'IDL is missing program address. The IDL file may be corrupted or from an older Anchor version. Run "anchor build" to regenerate the IDL.'
    );
  });

  it('throws error when IDL has empty instructions array', async () => {
    // Mock the IDL JSON import with empty instructions
    vi.doMock('../idl/agenc_coordination.json', () => ({
      default: {
        address: 'EopUaCV2svxj9j4hd7KjbrWfdjkspmm2BCBe7jGpKzKZ',
        metadata: { name: 'test' },
        instructions: [],
        // instructions array is empty
      },
    }));

    // Import the module after mocking
    const { createReadOnlyProgram } = await import('./idl');
    const connection = new Connection('http://127.0.0.1:8899', 'confirmed');

    expect(() => createReadOnlyProgram(connection)).toThrow(
      'IDL has no instructions. The IDL file may be corrupted. Run "anchor build" to regenerate the IDL.'
    );
  });

  it('throws error when IDL has null instructions', async () => {
    // Mock the IDL JSON import with null instructions
    vi.doMock('../idl/agenc_coordination.json', () => ({
      default: {
        address: 'EopUaCV2svxj9j4hd7KjbrWfdjkspmm2BCBe7jGpKzKZ',
        metadata: { name: 'test' },
        instructions: null,
      },
    }));

    // Import the module after mocking
    const { createReadOnlyProgram } = await import('./idl');
    const connection = new Connection('http://127.0.0.1:8899', 'confirmed');

    expect(() => createReadOnlyProgram(connection)).toThrow(
      'IDL has no instructions. The IDL file may be corrupted. Run "anchor build" to regenerate the IDL.'
    );
  });

  it('createProgram also validates IDL before creating program', async () => {
    // Mock the IDL JSON import with missing address
    vi.doMock('../idl/agenc_coordination.json', () => ({
      default: {
        metadata: { name: 'test' },
        instructions: [{ name: 'test_instruction' }],
        // address is missing
      },
    }));

    // Import the module after mocking
    const { createProgram } = await import('./idl');
    const connection = new Connection('http://127.0.0.1:8899', 'confirmed');
    const wallet = new Wallet(Keypair.generate());
    const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' });

    expect(() => createProgram(provider)).toThrow(
      'IDL is missing program address. The IDL file may be corrupted or from an older Anchor version. Run "anchor build" to regenerate the IDL.'
    );
  });
});
