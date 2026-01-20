/**
 * ProofEngine for ZK proof generation and verification
 *
 * Wraps the SDK proof generation API and provides caching,
 * batching, and status tracking.
 */

import { PublicKey } from '@solana/web3.js';

export interface ProofEngineConfig {
  /** Path to task_completion circuit (default: ./circuits/task_completion) */
  circuitPath?: string;
  /** Path to hash_helper circuit (default: ./circuits/hash_helper) */
  hashHelperPath?: string;
  /** Whether to cache generated proofs */
  cacheProofs?: boolean;
  /** Maximum cache size */
  maxCacheSize?: number;
  /** Proof generation timeout in ms */
  timeout?: number;
}

export interface ProofRequest {
  taskPda: PublicKey;
  agentPubkey: PublicKey;
  output: bigint[];
  salt?: bigint;
}

export interface ProofOutput {
  proof: Buffer;
  publicWitness: Buffer;
  constraintHash: Buffer;
  outputCommitment: Buffer;
  expectedBinding: Buffer;
  proofSize: number;
  generationTime: number;
  cached: boolean;
}

export interface ProofStatus {
  pending: number;
  completed: number;
  failed: number;
  totalGenerationTime: number;
  averageGenerationTime: number;
}

export interface ToolsStatus {
  nargo: boolean;
  sunspot: boolean;
  nargoVersion?: string;
  sunspotVersion?: string;
}

/** BN254 scalar field modulus */
const FIELD_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/**
 * Generate a cryptographically secure random salt
 */
export function generateSalt(): bigint {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let salt = 0n;
  for (const byte of bytes) {
    salt = (salt << 8n) | BigInt(byte);
  }
  return salt % FIELD_MODULUS;
}

interface CacheEntry {
  proof: ProofOutput;
  createdAt: number;
}

/**
 * ProofEngine manages ZK proof generation for task completion
 */
export class ProofEngine {
  private config: Required<ProofEngineConfig>;
  private cache: Map<string, CacheEntry> = new Map();
  private pendingCount: number = 0;
  private completedCount: number = 0;
  private failedCount: number = 0;
  private totalGenerationTime: number = 0;
  private toolsAvailable: ToolsStatus | null = null;

  constructor(config: ProofEngineConfig = {}) {
    this.config = {
      circuitPath: config.circuitPath ?? './circuits/task_completion',
      hashHelperPath: config.hashHelperPath ?? './circuits/hash_helper',
      cacheProofs: config.cacheProofs ?? true,
      maxCacheSize: config.maxCacheSize ?? 100,
      timeout: config.timeout ?? 300000,
    };
  }

  /**
   * Check if required tools (nargo, sunspot) are available
   */
  async checkTools(): Promise<ToolsStatus> {
    if (this.toolsAvailable) {
      return this.toolsAvailable;
    }

    // Dynamic import to avoid bundling SDK in runtime
    const sdk = await import('@agenc/sdk');
    const status = sdk.checkToolsAvailable();
    this.toolsAvailable = status;
    return status;
  }

  /**
   * Require tools to be available, throws with installation instructions if not
   */
  async requireTools(): Promise<void> {
    const { requireTools } = await import('@agenc/sdk');
    requireTools(true);
  }

  /**
   * Generate a ZK proof for task completion
   */
  async generateProof(request: ProofRequest): Promise<ProofOutput> {
    const salt = request.salt ?? generateSalt();
    const cacheKey = this.getCacheKey(request, salt);

    // Check cache
    if (this.config.cacheProofs) {
      const cached = this.cache.get(cacheKey);
      if (cached) {
        return { ...cached.proof, cached: true };
      }
    }

    this.pendingCount++;

    try {
      const { generateProof } = await import('@agenc/sdk');

      const result = await generateProof({
        taskPda: request.taskPda,
        agentPubkey: request.agentPubkey,
        output: request.output,
        salt,
        circuitPath: this.config.circuitPath,
        hashHelperPath: this.config.hashHelperPath,
      });

      const output: ProofOutput = {
        proof: result.proof,
        publicWitness: result.publicWitness,
        constraintHash: result.constraintHash,
        outputCommitment: result.outputCommitment,
        expectedBinding: result.expectedBinding,
        proofSize: result.proofSize,
        generationTime: result.generationTime,
        cached: false,
      };

      // Update stats
      this.completedCount++;
      this.totalGenerationTime += result.generationTime;

      // Cache result
      if (this.config.cacheProofs) {
        this.addToCache(cacheKey, output);
      }

      return output;
    } catch (error) {
      this.failedCount++;
      throw error;
    } finally {
      this.pendingCount--;
    }
  }

  /**
   * Verify a proof locally
   */
  async verifyProof(proof: Buffer, publicWitness: Buffer): Promise<boolean> {
    const { verifyProofLocally } = await import('@agenc/sdk');
    return verifyProofLocally(proof, publicWitness, this.config.circuitPath);
  }

  /**
   * Compute hashes via the hash_helper circuit
   */
  async computeHashes(
    taskPda: PublicKey,
    agentPubkey: PublicKey,
    output: bigint[],
    salt: bigint
  ): Promise<{ constraintHash: bigint; outputCommitment: bigint; expectedBinding: bigint }> {
    const { computeHashesViaNargo } = await import('@agenc/sdk');
    return computeHashesViaNargo(
      taskPda,
      agentPubkey,
      output,
      salt,
      this.config.hashHelperPath
    );
  }

  /**
   * Get proof generation status
   */
  getStatus(): ProofStatus {
    return {
      pending: this.pendingCount,
      completed: this.completedCount,
      failed: this.failedCount,
      totalGenerationTime: this.totalGenerationTime,
      averageGenerationTime: this.completedCount > 0
        ? this.totalGenerationTime / this.completedCount
        : 0,
    };
  }

  /**
   * Clear the proof cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number; maxSize: number } {
    return {
      size: this.cache.size,
      maxSize: this.config.maxCacheSize,
    };
  }

  private getCacheKey(request: ProofRequest, salt: bigint): string {
    return [
      request.taskPda.toBase58(),
      request.agentPubkey.toBase58(),
      request.output.map((o) => o.toString()).join(','),
      salt.toString(),
    ].join(':');
  }

  private addToCache(key: string, proof: ProofOutput): void {
    // Evict oldest entries if cache is full
    while (this.cache.size >= this.config.maxCacheSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(key, {
      proof,
      createdAt: Date.now(),
    });
  }
}

/**
 * Create a ProofEngine instance
 */
export function createProofEngine(config?: ProofEngineConfig): ProofEngine {
  return new ProofEngine(config);
}
