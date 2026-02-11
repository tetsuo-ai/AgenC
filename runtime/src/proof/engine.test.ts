import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';

// Mock @agenc/sdk before imports
vi.mock('@agenc/sdk', () => {
  const mockProof = Buffer.alloc(256, 0xab);
  const mockHash = Buffer.alloc(32, 0xcd);

  return {
    generateProof: vi.fn().mockResolvedValue({
      proof: mockProof,
      constraintHash: mockHash,
      outputCommitment: Buffer.alloc(32, 0xef),
      expectedBinding: Buffer.alloc(32, 0x12),
      proofSize: 256,
      generationTime: 42,
    }),
    verifyProofLocally: vi.fn().mockResolvedValue(true),
    computeHashes: vi.fn().mockReturnValue({
      constraintHash: 123n,
      outputCommitment: 456n,
      expectedBinding: 789n,
    }),
    generateSalt: vi.fn().mockReturnValue(999n),
    checkToolsAvailable: vi.fn().mockReturnValue({
      snarkjs: true,
      snarkjsVersion: '0.7.0',
    }),
    // Re-export types that the module expects
    PROGRAM_ID: new PublicKey('EopUaCV2svxj9j4hd7KjbrWfdjkspmm2BCBe7jGpKzKZ'),
    DEVNET_RPC: 'https://api.devnet.solana.com',
    MAINNET_RPC: 'https://api.mainnet-beta.solana.com',
    SEEDS: {},
    HASH_SIZE: 32,
    RESULT_DATA_SIZE: 64,
    U64_SIZE: 8,
    DISCRIMINATOR_SIZE: 8,
    OUTPUT_FIELD_COUNT: 4,
    PROOF_SIZE_BYTES: 256,
    VERIFICATION_COMPUTE_UNITS: 200000,
    PUBLIC_INPUTS_COUNT: 67,
    PERCENT_BASE: 10000,
    DEFAULT_FEE_PERCENT: 250,
    PRIVACY_CASH_PROGRAM_ID: new PublicKey('11111111111111111111111111111111'),
    TaskState: { Open: 0, InProgress: 1 },
    TaskStatus: {},
    // Logger re-exports needed by utils/logger.ts
    silentLogger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      setLevel: () => {},
    },
    createLogger: () => ({
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      setLevel: () => {},
    }),
  };
});

import {
  generateProof as mockGenerateProof,
  verifyProofLocally as mockVerifyProofLocally,
  computeHashes as mockComputeHashes,
  generateSalt as mockGenerateSalt,
  checkToolsAvailable as mockCheckToolsAvailable,
} from '@agenc/sdk';
import { ProofEngine } from './engine.js';
import { ProofCache, deriveCacheKey } from './cache.js';
import { ProofGenerationError, ProofVerificationError, ProofCacheError } from './errors.js';
import { RuntimeErrorCodes, RuntimeError } from '../types/errors.js';
import type { ProofInputs, EngineProofResult } from './types.js';

function makeInputs(): ProofInputs {
  return {
    taskPda: Keypair.generate().publicKey,
    agentPubkey: Keypair.generate().publicKey,
    output: [1n, 2n, 3n, 4n],
    salt: 12345n,
  };
}

describe('ProofEngine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ==========================================================================
  // Construction
  // ==========================================================================

  describe('construction', () => {
    it('creates with default config', () => {
      const engine = new ProofEngine();
      expect(engine).toBeInstanceOf(ProofEngine);
    });

    it('creates with custom config', () => {
      const engine = new ProofEngine({
        circuitPath: '/custom/path',
        verifyAfterGeneration: true,
        cache: { ttlMs: 60_000, maxEntries: 50 },
      });
      expect(engine).toBeInstanceOf(ProofEngine);
    });

    it('creates without cache when config.cache is omitted', () => {
      const engine = new ProofEngine({});
      const stats = engine.getStats();
      expect(stats.cacheSize).toBe(0);
    });
  });

  // ==========================================================================
  // generate() without cache
  // ==========================================================================

  describe('generate without cache', () => {
    it('calls SDK generateProof and returns EngineProofResult', async () => {
      const engine = new ProofEngine();
      const inputs = makeInputs();
      const result = await engine.generate(inputs);

      expect(mockGenerateProof).toHaveBeenCalledOnce();
      expect(result.proof).toBeInstanceOf(Uint8Array);
      expect(result.proof.length).toBe(256);
      expect(result.constraintHash).toBeInstanceOf(Uint8Array);
      expect(result.constraintHash.length).toBe(32);
      expect(result.outputCommitment).toBeInstanceOf(Uint8Array);
      expect(result.expectedBinding).toBeInstanceOf(Uint8Array);
      expect(result.proofSize).toBe(256);
      expect(result.fromCache).toBe(false);
      expect(result.verified).toBe(false);
      expect(result.generationTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('passes circuitPath to SDK', async () => {
      const engine = new ProofEngine({ circuitPath: '/my/circuit' });
      const inputs = makeInputs();
      await engine.generate(inputs);

      expect(mockGenerateProof).toHaveBeenCalledWith(
        expect.objectContaining({ circuitPath: '/my/circuit' }),
      );
    });

    it('wraps SDK errors in ProofGenerationError', async () => {
      vi.mocked(mockGenerateProof).mockRejectedValueOnce(new Error('snarkjs boom'));
      const engine = new ProofEngine();

      await expect(engine.generate(makeInputs())).rejects.toThrow(ProofGenerationError);
    });

    it('ProofGenerationError message includes SDK error details', async () => {
      vi.mocked(mockGenerateProof).mockRejectedValueOnce(new Error('snarkjs boom'));
      const engine = new ProofEngine();

      await expect(engine.generate(makeInputs())).rejects.toThrow('snarkjs boom');
    });

    it('wraps non-Error SDK throws in ProofGenerationError', async () => {
      vi.mocked(mockGenerateProof).mockRejectedValueOnce('string error');
      const engine = new ProofEngine();

      await expect(engine.generate(makeInputs())).rejects.toThrow(ProofGenerationError);
    });
  });

  // ==========================================================================
  // generate() with cache
  // ==========================================================================

  describe('generate with cache', () => {
    it('stores result in cache on miss', async () => {
      const engine = new ProofEngine({ cache: { ttlMs: 60_000 } });
      const inputs = makeInputs();

      const result1 = await engine.generate(inputs);
      expect(result1.fromCache).toBe(false);

      // Second call should hit cache
      const result2 = await engine.generate(inputs);
      expect(result2.fromCache).toBe(true);
      expect(mockGenerateProof).toHaveBeenCalledOnce(); // Only first call
    });

    it('returns cached result with fromCache: true', async () => {
      const engine = new ProofEngine({ cache: { ttlMs: 60_000 } });
      const inputs = makeInputs();

      await engine.generate(inputs);
      const cached = await engine.generate(inputs);

      expect(cached.fromCache).toBe(true);
      expect(cached.proof).toBeInstanceOf(Uint8Array);
      expect(cached.proof.length).toBe(256);
    });

    it('respects cache TTL expiry', async () => {
      vi.useFakeTimers();
      const engine = new ProofEngine({ cache: { ttlMs: 1000 } });
      const inputs = makeInputs();

      await engine.generate(inputs);

      // Advance past TTL
      vi.advanceTimersByTime(1500);

      await engine.generate(inputs);
      expect(mockGenerateProof).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    it('evicts oldest entry when cache is full', async () => {
      const engine = new ProofEngine({ cache: { ttlMs: 60_000, maxEntries: 2 } });

      const inputs1 = makeInputs();
      const inputs2 = makeInputs();
      const inputs3 = makeInputs();

      await engine.generate(inputs1);
      await engine.generate(inputs2);
      await engine.generate(inputs3); // Should evict inputs1

      // inputs1 should be evicted, so next call generates new proof
      vi.mocked(mockGenerateProof).mockClear();
      await engine.generate(inputs1);
      expect(mockGenerateProof).toHaveBeenCalledOnce();

      // inputs3 should still be cached
      vi.mocked(mockGenerateProof).mockClear();
      await engine.generate(inputs3);
      expect(mockGenerateProof).not.toHaveBeenCalled();
    });

    it('clearCache clears all entries', async () => {
      const engine = new ProofEngine({ cache: { ttlMs: 60_000 } });
      const inputs = makeInputs();

      await engine.generate(inputs);
      engine.clearCache();

      vi.mocked(mockGenerateProof).mockClear();
      await engine.generate(inputs);
      expect(mockGenerateProof).toHaveBeenCalledOnce();
    });
  });

  // ==========================================================================
  // generate() with verification
  // ==========================================================================

  describe('generate with verification', () => {
    it('verifies proof after generation when configured', async () => {
      vi.mocked(mockVerifyProofLocally).mockResolvedValueOnce(true);
      const engine = new ProofEngine({ verifyAfterGeneration: true });

      const result = await engine.generate(makeInputs());
      expect(mockVerifyProofLocally).toHaveBeenCalledOnce();
      expect(result.verified).toBe(true);
    });

    it('throws ProofVerificationError when verification returns false', async () => {
      vi.mocked(mockVerifyProofLocally).mockResolvedValueOnce(false);
      const engine = new ProofEngine({ verifyAfterGeneration: true });

      await expect(engine.generate(makeInputs())).rejects.toThrow(ProofVerificationError);
    });

    it('throws ProofVerificationError when verification throws', async () => {
      vi.mocked(mockVerifyProofLocally).mockRejectedValueOnce(new Error('vkey not found'));
      const engine = new ProofEngine({ verifyAfterGeneration: true });

      await expect(engine.generate(makeInputs())).rejects.toThrow(ProofVerificationError);
    });

    it('does not verify when verifyAfterGeneration is false', async () => {
      const engine = new ProofEngine({ verifyAfterGeneration: false });
      await engine.generate(makeInputs());
      expect(mockVerifyProofLocally).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // verify()
  // ==========================================================================

  describe('verify', () => {
    it('delegates to SDK verifyProofLocally', async () => {
      vi.mocked(mockVerifyProofLocally).mockResolvedValueOnce(true);
      const engine = new ProofEngine();

      const valid = await engine.verify(new Uint8Array(256), [1n, 2n]);
      expect(valid).toBe(true);
      expect(mockVerifyProofLocally).toHaveBeenCalledOnce();
    });

    it('tracks verification stats on success', async () => {
      vi.mocked(mockVerifyProofLocally).mockResolvedValueOnce(true);
      const engine = new ProofEngine();

      await engine.verify(new Uint8Array(256), []);
      const stats = engine.getStats();
      expect(stats.verificationsPerformed).toBe(1);
      expect(stats.verificationsFailed).toBe(0);
    });

    it('tracks verification stats on failure', async () => {
      vi.mocked(mockVerifyProofLocally).mockResolvedValueOnce(false);
      const engine = new ProofEngine();

      await engine.verify(new Uint8Array(256), []);
      const stats = engine.getStats();
      expect(stats.verificationsPerformed).toBe(1);
      expect(stats.verificationsFailed).toBe(1);
    });

    it('throws ProofVerificationError when SDK throws', async () => {
      vi.mocked(mockVerifyProofLocally).mockRejectedValueOnce(new Error('boom'));
      const engine = new ProofEngine();

      await expect(engine.verify(new Uint8Array(256), [])).rejects.toThrow(
        ProofVerificationError,
      );
    });
  });

  // ==========================================================================
  // computeHashes()
  // ==========================================================================

  describe('computeHashes', () => {
    it('delegates to SDK computeHashes', () => {
      const engine = new ProofEngine();
      const inputs = makeInputs();

      const result = engine.computeHashes(inputs);
      expect(mockComputeHashes).toHaveBeenCalledWith(
        inputs.taskPda,
        inputs.agentPubkey,
        inputs.output,
        inputs.salt,
      );
      expect(result.constraintHash).toBe(123n);
      expect(result.outputCommitment).toBe(456n);
      expect(result.expectedBinding).toBe(789n);
    });
  });

  // ==========================================================================
  // generateSalt()
  // ==========================================================================

  describe('generateSalt', () => {
    it('delegates to SDK generateSalt', () => {
      const engine = new ProofEngine();
      const salt = engine.generateSalt();
      expect(mockGenerateSalt).toHaveBeenCalledOnce();
      expect(salt).toBe(999n);
    });
  });

  // ==========================================================================
  // checkTools()
  // ==========================================================================

  describe('checkTools', () => {
    it('delegates to SDK checkToolsAvailable', () => {
      const engine = new ProofEngine();
      const status = engine.checkTools();
      expect(mockCheckToolsAvailable).toHaveBeenCalledOnce();
      expect(status.snarkjs).toBe(true);
      expect(status.snarkjsVersion).toBe('0.7.0');
    });
  });

  // ==========================================================================
  // getStats()
  // ==========================================================================

  describe('getStats', () => {
    it('returns initial zero stats', () => {
      const engine = new ProofEngine();
      const stats = engine.getStats();

      expect(stats.proofsGenerated).toBe(0);
      expect(stats.totalRequests).toBe(0);
      expect(stats.cacheHits).toBe(0);
      expect(stats.cacheMisses).toBe(0);
      expect(stats.avgGenerationTimeMs).toBe(0);
      expect(stats.verificationsPerformed).toBe(0);
      expect(stats.verificationsFailed).toBe(0);
      expect(stats.cacheSize).toBe(0);
    });

    it('tracks generation stats', async () => {
      const engine = new ProofEngine();

      await engine.generate(makeInputs());
      await engine.generate(makeInputs());

      const stats = engine.getStats();
      expect(stats.proofsGenerated).toBe(2);
      expect(stats.totalRequests).toBe(2);
      expect(stats.avgGenerationTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('tracks cache hit/miss stats', async () => {
      const engine = new ProofEngine({ cache: { ttlMs: 60_000 } });
      const inputs = makeInputs();

      await engine.generate(inputs); // miss
      await engine.generate(inputs); // hit

      const stats = engine.getStats();
      expect(stats.cacheHits).toBe(1);
      expect(stats.cacheMisses).toBe(1);
      expect(stats.totalRequests).toBe(2);
      expect(stats.proofsGenerated).toBe(1); // only 1 actual generation
      expect(stats.cacheSize).toBe(1);
    });
  });

  // ==========================================================================
  // ProofGenerator interface
  // ==========================================================================

  describe('ProofGenerator interface', () => {
    it('generatePublicProof returns proofHash', async () => {
      const engine = new ProofEngine();
      const proofHash = new Uint8Array(32).fill(0xaa);
      const result = await engine.generatePublicProof(
        {} as any,
        { proofHash, resultData: new Uint8Array(64) },
      );
      expect(result).toBe(proofHash);
    });

    it('generatePrivateProof returns proof bytes', async () => {
      const engine = new ProofEngine();
      const proof = new Uint8Array(256).fill(0xbb);
      const result = await engine.generatePrivateProof(
        {} as any,
        {
          proof,
          constraintHash: new Uint8Array(32),
          outputCommitment: new Uint8Array(32),
          expectedBinding: new Uint8Array(32),
        },
      );
      expect(result).toBe(proof);
    });
  });
});

// =============================================================================
// ProofCache unit tests
// =============================================================================

describe('ProofCache', () => {
  function makeCacheResult(): EngineProofResult {
    return {
      proof: new Uint8Array(256).fill(0x01),
      constraintHash: new Uint8Array(32).fill(0x02),
      outputCommitment: new Uint8Array(32).fill(0x03),
      expectedBinding: new Uint8Array(32).fill(0x04),
      proofSize: 256,
      generationTimeMs: 100,
      fromCache: false,
      verified: false,
    };
  }

  it('returns undefined for missing key', () => {
    const cache = new ProofCache();
    expect(cache.get(makeInputs())).toBeUndefined();
  });

  it('stores and retrieves entries', () => {
    const cache = new ProofCache();
    const inputs = makeInputs();
    const result = makeCacheResult();

    cache.set(inputs, result);
    const retrieved = cache.get(inputs);

    expect(retrieved).toBeDefined();
    expect(retrieved!.proof).toEqual(result.proof);
  });

  it('clears all entries', () => {
    const cache = new ProofCache();
    cache.set(makeInputs(), makeCacheResult());
    cache.set(makeInputs(), makeCacheResult());

    expect(cache.size).toBe(2);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});

// =============================================================================
// deriveCacheKey unit tests
// =============================================================================

describe('deriveCacheKey', () => {
  it('produces deterministic key from inputs', () => {
    const taskPda = Keypair.generate().publicKey;
    const agentPubkey = Keypair.generate().publicKey;
    const inputs: ProofInputs = {
      taskPda,
      agentPubkey,
      output: [1n, 2n, 3n, 4n],
      salt: 12345n,
    };

    const key1 = deriveCacheKey(inputs);
    const key2 = deriveCacheKey(inputs);
    expect(key1).toBe(key2);
    expect(key1).toContain(taskPda.toBase58());
    expect(key1).toContain(agentPubkey.toBase58());
    expect(key1).toContain('12345');
  });

  it('produces different keys for different inputs', () => {
    const inputs1 = makeInputs();
    const inputs2 = makeInputs();

    expect(deriveCacheKey(inputs1)).not.toBe(deriveCacheKey(inputs2));
  });
});

// =============================================================================
// Error class tests
// =============================================================================

describe('Proof error classes', () => {
  it('ProofGenerationError has correct properties', () => {
    const err = new ProofGenerationError('circuit not found');
    expect(err.name).toBe('ProofGenerationError');
    expect(err.code).toBe(RuntimeErrorCodes.PROOF_GENERATION_ERROR);
    expect(err.cause).toBe('circuit not found');
    expect(err.message).toContain('circuit not found');
    expect(err instanceof RuntimeError).toBe(true);
  });

  it('ProofVerificationError has correct properties', () => {
    const err = new ProofVerificationError('invalid proof');
    expect(err.name).toBe('ProofVerificationError');
    expect(err.code).toBe(RuntimeErrorCodes.PROOF_VERIFICATION_ERROR);
    expect(err.message).toContain('invalid proof');
    expect(err instanceof RuntimeError).toBe(true);
  });

  it('ProofCacheError has correct properties', () => {
    const err = new ProofCacheError('serialization failed');
    expect(err.name).toBe('ProofCacheError');
    expect(err.code).toBe(RuntimeErrorCodes.PROOF_CACHE_ERROR);
    expect(err.message).toContain('serialization failed');
    expect(err instanceof RuntimeError).toBe(true);
  });
});
