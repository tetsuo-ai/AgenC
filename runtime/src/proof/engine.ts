/**
 * ProofEngine - ZK proof generation engine with caching and stats tracking.
 *
 * Wraps the SDK's ZK proof functions with caching, statistics tracking,
 * and error wrapping. Implements ProofGenerator from the proof pipeline
 * for plug-and-play integration.
 *
 * @module
 */

import {
  generateProof as sdkGenerateProof,
  computeHashes as sdkComputeHashes,
  generateSalt as sdkGenerateSalt,
  type HashResult,
  type ProverConfig as SdkProverConfig,
} from "@agenc/sdk";
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
import { ProofGenerationError } from "./errors.js";
const METHOD_ID_LEN = 32;
const ROUTER_CONFIG_FIELDS = [
  "routerProgramId",
  "routerPda",
  "verifierEntryPda",
  "verifierProgramId",
] as const;

/**
 * Map runtime ProverBackendConfig to SDK's ProverConfig for real prover backends.
 * Throws ProofGenerationError if required fields are missing.
 */
export function buildSdkProverConfig(
  config: ProverBackendConfig,
): SdkProverConfig {
  const kind = config.kind;
  if (!kind) {
    throw new ProofGenerationError(
      'ProofEngine requires an explicit proverBackend kind ("remote")',
    );
  }
  switch (kind) {
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
 *   proverBackend: {
 *     kind: "remote",
 *     endpoint: "https://prover.example.com",
 *   },
 *   methodId: trustedImageIdBytes,
 *   routerConfig: {
 *     routerProgramId,
 *     routerPda,
 *     verifierEntryPda,
 *     verifierProgramId,
 *   },
 *   cache: { ttlMs: 300_000, maxEntries: 100 },
 * });
 *
 * const result = await engine.generate({
 *   taskPda,
 *   agentPubkey,
 *   output: [1n, 2n, 3n, 4n],
 *   salt: engine.generateSalt(),
 *   agentSecret: secretWitnessBigint,
 * });
 * ```
 */
export class ProofEngine implements ProofGenerator {
  private readonly methodId: Uint8Array | null;
  private readonly routerConfig: RouterConfig | null;
  private readonly proverBackend: ProverBackend;
  private readonly proverBackendConfig: ProverBackendConfig | undefined;
  private readonly unsafeAllowUnpinnedPrivateProofs: boolean;
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
    this.proverBackend = config?.proverBackend?.kind ?? "remote";
    this.unsafeAllowUnpinnedPrivateProofs =
      config?.unsafeAllowUnpinnedPrivateProofs ?? false;
    this.cache = config?.cache ? new ProofCache(config.cache) : null;
    this.logger = config?.logger ?? silentLogger;
    this.metrics = config?.metrics;

    // Warn on config inconsistencies
    if (config?.proverBackend?.endpoint && this.proverBackend !== "remote") {
      this.logger.warn(
        'endpoint is set but prover backend kind is not "remote" — endpoint will be ignored',
      );
    }
    if (this.unsafeAllowUnpinnedPrivateProofs) {
      this.logger.warn(
        "unsafeAllowUnpinnedPrivateProofs=true disables methodId/router pinning and should only be used for local development",
      );
    }
  }

  /**
   * Generate a ZK proof for the given inputs.
   *
   * Checks cache first (if enabled). On cache miss, calls the SDK's
   * generateProof function, caches, and returns.
   */
  async generate(inputs: ProofInputs): Promise<EngineProofResult> {
    this._totalRequests++;
    const proverBackendConfig = this.requireProverBackendConfig();
    this.requirePinnedPrivateProofConfig();

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
    let sdkResult;
    try {
      const sdkProverConfig = buildSdkProverConfig(proverBackendConfig);
      sdkResult = await sdkGenerateProof(
        {
          taskPda: inputs.taskPda,
          agentPubkey: inputs.agentPubkey,
          output: inputs.output,
          salt: inputs.salt,
          agentSecret: inputs.agentSecret,
        },
        sdkProverConfig,
      );
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

    // Cache result
    if (this.cache) {
      this.cache.set(inputs, result);
    }

    this.logger.debug(`Proof generated in ${generationTimeMs}ms`);
    return result;
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

  private requireProverBackendConfig(): ProverBackendConfig {
    if (!this.proverBackendConfig) {
      throw new ProofGenerationError(
        "ProofEngine requires an explicit proverBackend configuration",
      );
    }
    return this.proverBackendConfig;
  }

  private requirePinnedPrivateProofConfig(): void {
    if (this.unsafeAllowUnpinnedPrivateProofs) {
      return;
    }

    const missingFields = [
      ...(this.methodId ? [] : ["methodId"]),
      ...this.getMissingRouterConfigFields(),
    ];
    if (missingFields.length === 0) {
      return;
    }

    throw new ProofGenerationError(
      `Private proof generation requires pinned methodId and complete routerConfig; missing ${missingFields.join(", ")}. Set unsafeAllowUnpinnedPrivateProofs=true only for local development.`,
    );
  }

  private getMissingRouterConfigFields(): string[] {
    if (!this.routerConfig) {
      return ROUTER_CONFIG_FIELDS.map((field) => `routerConfig.${field}`);
    }

    const missingFields: string[] = [];
    for (const field of ROUTER_CONFIG_FIELDS) {
      if (!this.routerConfig[field]) {
        missingFields.push(`routerConfig.${field}`);
      }
    }
    return missingFields;
  }

  private isRouterPinned(): boolean {
    return this.getMissingRouterConfigFields().length === 0;
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
