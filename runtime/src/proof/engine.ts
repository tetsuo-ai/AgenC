/**
 * ProofEngine - ZK proof generation engine with caching and stats tracking.
 *
 * Wraps the SDK's ZK proof functions with caching, verification,
 * statistics tracking, and error wrapping. Implements ProofGenerator
 * from the proof pipeline for plug-and-play integration.
 *
 * @module
 */

import {
  generateProof as sdkGenerateProof,
  generateProofWithProver as sdkGenerateProofWithProver,
  verifyProofLocally as sdkVerifyProofLocally,
  computeHashes as sdkComputeHashes,
  generateSalt as sdkGenerateSalt,
} from "@agenc/sdk";
import type { HashResult, ProverConfig as SdkProverConfig } from "@agenc/sdk";
import type { ProofGenerator } from "../task/proof-pipeline.js";
import type {
  OnChainTask,
  TaskExecutionResult,
  PrivateTaskExecutionResult,
} from "../task/types.js";
import type { Logger } from "../utils/logger.js";
import { silentLogger } from "../utils/logger.js";
import type { MetricsProvider } from "../task/types.js";
import { TELEMETRY_METRIC_NAMES } from "../telemetry/metric-names.js";
import type {
  ProofEngineConfig,
  ProofInputs,
  EngineProofResult,
  ProofEngineStats,
  ProverBackend,
  ProverBackendConfig,
  RouterConfig,
  ToolsStatus,
} from "./types.js";
import { ProofCache } from "./cache.js";
import { ProofGenerationError, ProofVerificationError } from "./errors.js";
const METHOD_ID_LEN = 32;

/**
 * Map runtime ProverBackendConfig to SDK's ProverConfig for real prover backends.
 * Throws ProofGenerationError if required fields are missing.
 */
export function buildSdkProverConfig(
  config: ProverBackendConfig,
): SdkProverConfig {
  const kind = config.kind ?? "deterministic-local";
  switch (kind) {
    case "local-binary": {
      if (!config.binaryPath) {
        throw new ProofGenerationError(
          "binaryPath is required for local-binary prover backend",
        );
      }
      return {
        kind: "local-binary",
        binaryPath: config.binaryPath,
        timeoutMs: config.timeoutMs,
      };
    }
    case "remote": {
      if (!config.endpoint) {
        throw new ProofGenerationError(
          "endpoint is required for remote prover backend",
        );
      }
      return {
        kind: "remote",
        endpoint: config.endpoint,
        timeoutMs: config.timeoutMs,
        headers: config.headers,
      };
    }
    default:
      throw new ProofGenerationError(
        `buildSdkProverConfig called with unsupported kind: ${kind}`,
      );
  }
}

/**
 * ProofEngine wraps the SDK's ZK proof functions with caching,
 * stats tracking, and error wrapping.
 *
 * Implements ProofGenerator for integration with ProofPipeline.
 *
 * @example
 * ```typescript
 * const engine = new ProofEngine({
 *   cache: { ttlMs: 300_000, maxEntries: 100 },
 *   verifyAfterGeneration: false,
 * });
 *
 * const result = await engine.generate({
 *   taskPda,
 *   agentPubkey,
 *   output: [1n, 2n, 3n, 4n],
 *   salt: engine.generateSalt(),
 * });
 * ```
 */
export class ProofEngine implements ProofGenerator {
  private readonly methodId: Uint8Array | null;
  private readonly routerConfig: RouterConfig | null;
  private readonly proverBackend: ProverBackend;
  private readonly proverBackendConfig: ProverBackendConfig | undefined;
  private readonly verifyAfterGeneration: boolean;
  private readonly cache: ProofCache | null;
  private readonly logger: Logger;
  private readonly metrics?: MetricsProvider;

  // Stats
  private _proofsGenerated = 0;
  private _totalRequests = 0;
  private _cacheHits = 0;
  private _cacheMisses = 0;
  private _totalGenerationTimeMs = 0;
  private _verificationsPerformed = 0;
  private _verificationsFailed = 0;

  constructor(config?: ProofEngineConfig) {
    this.methodId = config?.methodId ? new Uint8Array(config.methodId) : null;
    if (this.methodId && this.methodId.length !== METHOD_ID_LEN) {
      throw new Error(`methodId must be ${METHOD_ID_LEN} bytes`);
    }
    this.routerConfig = config?.routerConfig ?? null;
    this.proverBackendConfig = config?.proverBackend;
    this.proverBackend = config?.proverBackend?.kind ?? "deterministic-local";
    this.verifyAfterGeneration = config?.verifyAfterGeneration ?? false;
    this.cache = config?.cache ? new ProofCache(config.cache) : null;
    this.logger = config?.logger ?? silentLogger;
    this.metrics = config?.metrics;

    // Warn on config inconsistencies
    if (
      config?.proverBackend?.binaryPath &&
      this.proverBackend !== "local-binary"
    ) {
      this.logger.warn(
        'binaryPath is set but prover backend kind is not "local-binary" — binaryPath will be ignored',
      );
    }
    if (config?.proverBackend?.endpoint && this.proverBackend !== "remote") {
      this.logger.warn(
        'endpoint is set but prover backend kind is not "remote" — endpoint will be ignored',
      );
    }
  }

  /**
   * Generate a ZK proof for the given inputs.
   *
   * Checks cache first (if enabled). On cache miss, calls the SDK's
   * generateProof function, optionally verifies, caches, and returns.
   */
  async generate(inputs: ProofInputs): Promise<EngineProofResult> {
    this._totalRequests++;

    // Check cache
    if (this.cache) {
      const cached = this.cache.get(inputs);
      if (cached) {
        this._cacheHits++;
        this.metrics?.counter(TELEMETRY_METRIC_NAMES.PROOF_CACHE_HITS);
        this.logger.debug("Proof cache hit");
        return { ...cached, fromCache: true };
      }
      this._cacheMisses++;
      this.metrics?.counter(TELEMETRY_METRIC_NAMES.PROOF_CACHE_MISSES);
    }

    // Generate proof via SDK
    const startTime = Date.now();
    const useRealProver =
      this.proverBackend === "local-binary" || this.proverBackend === "remote";
    let sdkResult;
    try {
      if (useRealProver) {
        const sdkProverConfig = buildSdkProverConfig(this.proverBackendConfig!);
        sdkResult = await sdkGenerateProofWithProver(
          {
            taskPda: inputs.taskPda,
            agentPubkey: inputs.agentPubkey,
            output: inputs.output,
            salt: inputs.salt,
            agentSecret: inputs.agentSecret,
          },
          sdkProverConfig,
        );
      } else {
        sdkResult = await sdkGenerateProof({
          taskPda: inputs.taskPda,
          agentPubkey: inputs.agentPubkey,
          output: inputs.output,
          salt: inputs.salt,
          agentSecret: inputs.agentSecret,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ProofGenerationError(message);
    }
    const generationTimeMs = Date.now() - startTime;

    if (this.methodId) {
      const generatedMethodId = new Uint8Array(sdkResult.imageId);
      if (generatedMethodId.length !== METHOD_ID_LEN) {
        throw new ProofGenerationError(
          `imageId must be ${METHOD_ID_LEN} bytes`,
        );
      }
      if (!Buffer.from(generatedMethodId).equals(Buffer.from(this.methodId))) {
        throw new ProofGenerationError(
          "Generated imageId does not match configured methodId",
        );
      }
    }

    // Convert Buffer -> Uint8Array
    const result: EngineProofResult = {
      sealBytes: new Uint8Array(sdkResult.sealBytes),
      journal: new Uint8Array(sdkResult.journal),
      imageId: new Uint8Array(sdkResult.imageId),
      bindingSeed: new Uint8Array(sdkResult.bindingSeed),
      nullifierSeed: new Uint8Array(sdkResult.nullifierSeed),
      proofSize: sdkResult.sealBytes.length,
      generationTimeMs,
      fromCache: false,
      verified: false,
    };

    this._proofsGenerated++;
    this._totalGenerationTimeMs += generationTimeMs;
    this.metrics?.histogram(
      TELEMETRY_METRIC_NAMES.PROOF_GENERATION_DURATION,
      generationTimeMs,
    );

    // Verify if configured
    if (this.verifyAfterGeneration) {
      if (useRealProver) {
        // verifyProofLocally() only verifies the simulated XOR transform and would
        // always return false for real Groth16 proofs. On-chain Verifier Router CPI
        // is the authoritative verification for real prover backends.
        this.logger.warn(
          "verifyAfterGeneration is not supported with real prover backends — on-chain Verifier Router CPI is the authoritative verification",
        );
      } else {
        this._verificationsPerformed++;
        try {
          const valid = await sdkVerifyProofLocally(
            sdkResult.sealBytes,
            sdkResult.journal,
          );
          if (!valid) {
            this._verificationsFailed++;
            throw new ProofVerificationError(
              "Generated proof failed local verification",
            );
          }
          result.verified = true;
        } catch (err) {
          if (err instanceof ProofVerificationError) {
            throw err;
          }
          this._verificationsFailed++;
          const message = err instanceof Error ? err.message : String(err);
          throw new ProofVerificationError(message);
        }
      }
    }

    // Cache result
    if (this.cache) {
      this.cache.set(inputs, result);
    }

    this.logger.debug(`Proof generated in ${generationTimeMs}ms`);
    return result;
  }

  /**
   * Verify a proof locally against its journal.
   */
  async verify(proof: Uint8Array, journal: Uint8Array): Promise<boolean> {
    this._verificationsPerformed++;
    try {
      const proofBuffer = Buffer.from(proof);
      const valid = await sdkVerifyProofLocally(
        proofBuffer,
        Buffer.from(journal),
      );
      if (!valid) {
        this._verificationsFailed++;
      }
      return valid;
    } catch (err) {
      this._verificationsFailed++;
      const message = err instanceof Error ? err.message : String(err);
      throw new ProofVerificationError(message);
    }
  }

  /**
   * Compute hashes (constraintHash, outputCommitment, binding) without generating a proof.
   */
  computeHashes(inputs: ProofInputs): HashResult {
    return sdkComputeHashes(
      inputs.taskPda,
      inputs.agentPubkey,
      inputs.output,
      inputs.salt,
      inputs.agentSecret,
    );
  }

  /**
   * Generate a cryptographically secure random salt.
   */
  generateSalt(): bigint {
    return sdkGenerateSalt();
  }

  /**
   * Clear the proof cache.
   */
  clearCache(): void {
    this.cache?.clear();
  }

  /**
   * Get engine statistics.
   */
  getStats(): ProofEngineStats {
    return {
      proofsGenerated: this._proofsGenerated,
      totalRequests: this._totalRequests,
      cacheHits: this._cacheHits,
      cacheMisses: this._cacheMisses,
      avgGenerationTimeMs:
        this._proofsGenerated > 0
          ? this._totalGenerationTimeMs / this._proofsGenerated
          : 0,
      verificationsPerformed: this._verificationsPerformed,
      verificationsFailed: this._verificationsFailed,
      cacheSize: this.cache?.size ?? 0,
    };
  }

  private isRouterPinned(): boolean {
    if (!this.routerConfig) {
      return false;
    }
    return Boolean(
      this.routerConfig.routerProgramId &&
      this.routerConfig.routerPda &&
      this.routerConfig.verifierEntryPda &&
      this.routerConfig.verifierProgramId,
    );
  }

  /**
   * Report current runtime proof backend status.
   */
  checkTools(): ToolsStatus {
    return {
      risc0: true,
      proverBackend: this.proverBackend,
      methodIdPinned: this.methodId !== null,
      routerPinned: this.isRouterPinned(),
    };
  }

  // ==========================================================================
  // ProofGenerator interface (for ProofPipeline integration)
  // ==========================================================================

  /**
   * Generate proof for public task completion.
   * Returns the proofHash from the execution result.
   */
  async generatePublicProof(
    _task: OnChainTask,
    result: TaskExecutionResult,
  ): Promise<Uint8Array> {
    return result.proofHash;
  }

  /**
   * Generate proof for private (ZK) task completion.
   * Returns the router seal bytes from the execution result.
   */
  async generatePrivateProof(
    _task: OnChainTask,
    result: PrivateTaskExecutionResult,
  ): Promise<Uint8Array> {
    return result.sealBytes;
  }
}
