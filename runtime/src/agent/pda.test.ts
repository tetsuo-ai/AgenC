import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { PROGRAM_ID, SEEDS } from '@agenc/sdk';
import {
  deriveAgentPda,
  deriveProtocolPda,
  findAgentPda,
  findProtocolPda,
  type PdaWithBump,
} from './pda';
import { AGENT_ID_LENGTH } from './types';

/**
 * Creates a valid 32-byte agent ID from a seed value
 */
function createAgentId(seed = 0): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = (seed + i) % 256;
  }
  return bytes;
}

describe('PDA derivation helpers', () => {
  describe('deriveAgentPda', () => {
    it('returns address and bump for valid agentId', () => {
      const agentId = createAgentId(42);
      const result = deriveAgentPda(agentId);

      expect(result.address).toBeInstanceOf(PublicKey);
      expect(typeof result.bump).toBe('number');
      expect(result.bump).toBeGreaterThanOrEqual(0);
      expect(result.bump).toBeLessThanOrEqual(255);
    });

    it('uses PROGRAM_ID by default', () => {
      const agentId = createAgentId(1);
      const result = deriveAgentPda(agentId);

      // Verify by deriving with same seeds manually
      const [expected, expectedBump] = PublicKey.findProgramAddressSync(
        [SEEDS.AGENT, Buffer.from(agentId)],
        PROGRAM_ID
      );

      expect(result.address.equals(expected)).toBe(true);
      expect(result.bump).toBe(expectedBump);
    });

    it('uses custom programId when provided', () => {
      const agentId = createAgentId(2);
      const customProgramId = new PublicKey('11111111111111111111111111111111');
      const result = deriveAgentPda(agentId, customProgramId);

      // Verify by deriving with custom program ID
      const [expected, expectedBump] = PublicKey.findProgramAddressSync(
        [SEEDS.AGENT, Buffer.from(agentId)],
        customProgramId
      );

      expect(result.address.equals(expected)).toBe(true);
      expect(result.bump).toBe(expectedBump);
    });

    it('throws for agentId shorter than 32 bytes', () => {
      const shortId = new Uint8Array(16);

      expect(() => deriveAgentPda(shortId)).toThrow(
        `Invalid agentId length: 16 (must be ${AGENT_ID_LENGTH})`
      );
    });

    it('throws for agentId longer than 32 bytes', () => {
      const longId = new Uint8Array(64);

      expect(() => deriveAgentPda(longId)).toThrow(
        `Invalid agentId length: 64 (must be ${AGENT_ID_LENGTH})`
      );
    });

    it('throws for empty agentId', () => {
      const emptyId = new Uint8Array(0);

      expect(() => deriveAgentPda(emptyId)).toThrow(
        `Invalid agentId length: 0 (must be ${AGENT_ID_LENGTH})`
      );
    });

    it('produces different addresses for different agentIds', () => {
      const id1 = createAgentId(1);
      const id2 = createAgentId(2);

      const result1 = deriveAgentPda(id1);
      const result2 = deriveAgentPda(id2);

      expect(result1.address.equals(result2.address)).toBe(false);
    });

    it('produces consistent results for same agentId', () => {
      const agentId = createAgentId(99);

      const result1 = deriveAgentPda(agentId);
      const result2 = deriveAgentPda(agentId);

      expect(result1.address.equals(result2.address)).toBe(true);
      expect(result1.bump).toBe(result2.bump);
    });
  });

  describe('deriveProtocolPda', () => {
    it('returns address and bump', () => {
      const result = deriveProtocolPda();

      expect(result.address).toBeInstanceOf(PublicKey);
      expect(typeof result.bump).toBe('number');
      expect(result.bump).toBeGreaterThanOrEqual(0);
      expect(result.bump).toBeLessThanOrEqual(255);
    });

    it('uses PROGRAM_ID by default', () => {
      const result = deriveProtocolPda();

      // Verify by deriving with same seeds manually
      const [expected, expectedBump] = PublicKey.findProgramAddressSync(
        [SEEDS.PROTOCOL],
        PROGRAM_ID
      );

      expect(result.address.equals(expected)).toBe(true);
      expect(result.bump).toBe(expectedBump);
    });

    it('uses custom programId when provided', () => {
      const customProgramId = new PublicKey('11111111111111111111111111111111');
      const result = deriveProtocolPda(customProgramId);

      // Verify by deriving with custom program ID
      const [expected, expectedBump] = PublicKey.findProgramAddressSync(
        [SEEDS.PROTOCOL],
        customProgramId
      );

      expect(result.address.equals(expected)).toBe(true);
      expect(result.bump).toBe(expectedBump);
    });

    it('produces consistent results', () => {
      const result1 = deriveProtocolPda();
      const result2 = deriveProtocolPda();

      expect(result1.address.equals(result2.address)).toBe(true);
      expect(result1.bump).toBe(result2.bump);
    });

    it('produces different addresses for different program IDs', () => {
      const programId1 = PROGRAM_ID;
      const programId2 = new PublicKey('11111111111111111111111111111111');

      const result1 = deriveProtocolPda(programId1);
      const result2 = deriveProtocolPda(programId2);

      expect(result1.address.equals(result2.address)).toBe(false);
    });
  });

  describe('findAgentPda', () => {
    it('returns just the address (convenience wrapper)', () => {
      const agentId = createAgentId(10);
      const address = findAgentPda(agentId);

      expect(address).toBeInstanceOf(PublicKey);
    });

    it('matches deriveAgentPda address', () => {
      const agentId = createAgentId(20);
      const address = findAgentPda(agentId);
      const { address: derivedAddress } = deriveAgentPda(agentId);

      expect(address.equals(derivedAddress)).toBe(true);
    });

    it('accepts custom programId', () => {
      const agentId = createAgentId(30);
      const customProgramId = new PublicKey('11111111111111111111111111111111');

      const address = findAgentPda(agentId, customProgramId);
      const { address: derivedAddress } = deriveAgentPda(agentId, customProgramId);

      expect(address.equals(derivedAddress)).toBe(true);
    });

    it('throws for invalid agentId length', () => {
      const shortId = new Uint8Array(10);

      expect(() => findAgentPda(shortId)).toThrow('Invalid agentId length');
    });
  });

  describe('findProtocolPda', () => {
    it('returns just the address (convenience wrapper)', () => {
      const address = findProtocolPda();

      expect(address).toBeInstanceOf(PublicKey);
    });

    it('matches deriveProtocolPda address', () => {
      const address = findProtocolPda();
      const { address: derivedAddress } = deriveProtocolPda();

      expect(address.equals(derivedAddress)).toBe(true);
    });

    it('accepts custom programId', () => {
      const customProgramId = new PublicKey('11111111111111111111111111111111');

      const address = findProtocolPda(customProgramId);
      const { address: derivedAddress } = deriveProtocolPda(customProgramId);

      expect(address.equals(derivedAddress)).toBe(true);
    });
  });

  describe('PdaWithBump type', () => {
    it('satisfies interface contract', () => {
      const agentId = createAgentId(42);
      const pda: PdaWithBump = deriveAgentPda(agentId);

      // Type check - these should compile
      const _address: PublicKey = pda.address;
      const _bump: number = pda.bump;

      expect(_address).toBeInstanceOf(PublicKey);
      expect(typeof _bump).toBe('number');
    });
  });
});
