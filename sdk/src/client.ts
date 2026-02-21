/**
 * High-level Privacy Client for AgenC
 *
 * Provides a simplified interface for privacy-preserving task operations.
 * Wraps the lower-level proof generation and task completion APIs.
 */

import {
  Connection,
  PublicKey,
  Keypair,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { type Idl, Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { DEVNET_RPC, MAINNET_RPC } from "./constants";
import { validateProverEndpoint } from "./validation";
import {
  createLogger,
  silentLogger,
  type Logger,
  type LogLevel,
} from "./logger";
import {
  generateProof,
  generateSalt,
  type ProofGenerationParams,
} from "./proofs";
import { completeTaskPrivate as submitCompleteTaskPrivate } from "./tasks";

export interface PrivacyClientConfig {
  /** Solana RPC endpoint URL */
  rpcUrl?: string;
  /** Use devnet (default: false for mainnet) */
  devnet?: boolean;
  /** Optional external RISC0 prover endpoint */
  proverEndpoint?: string;
  /** Owner wallet keypair */
  wallet?: Keypair;
  /** Agent ID (32 bytes) — required for completeTaskPrivate */
  agentId?: Uint8Array | number[];
  /** Enable debug logging */
  debug?: boolean;
  /** Log level (overrides debug flag if set) */
  logLevel?: LogLevel;
  /** Program IDL (required for full functionality) */
  idl?: Idl;
}

export class PrivacyClient {
  private connection: Connection;
  private program: Program | null = null;
  private config: PrivacyClientConfig;
  private wallet: Keypair | null = null;
  private agentId: Uint8Array | number[] | null = null;
  private logger: Logger;

  constructor(config: PrivacyClientConfig = {}) {
    if (config.proverEndpoint !== undefined) {
      try {
        validateProverEndpoint(config.proverEndpoint);
      } catch (e) {
        throw new Error(`Invalid prover endpoint: ${(e as Error).message}`);
      }
    }

    // Validate RPC URL format if provided
    if (config.rpcUrl !== undefined) {
      try {
        const url = new URL(config.rpcUrl);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          throw new Error("RPC URL must use http or https protocol");
        }
      } catch (e) {
        if ((e as Error).message.includes("http or https")) {
          throw new Error(`Invalid RPC URL: ${(e as Error).message}`);
        }
        throw new Error(`Invalid RPC URL: ${config.rpcUrl}`);
      }
    }

    this.config = {
      devnet: false,
      debug: false,
      ...config,
    };

    // Set up logger: explicit logLevel takes priority, then debug flag, then silent
    if (config.logLevel) {
      this.logger = createLogger(config.logLevel);
    } else if (this.config.debug) {
      this.logger = createLogger("debug");
    } else {
      this.logger = silentLogger;
    }

    const rpcUrl =
      config.rpcUrl || (this.config.devnet ? DEVNET_RPC : MAINNET_RPC);
    this.connection = new Connection(rpcUrl, "confirmed");

    if (config.wallet) {
      this.wallet = config.wallet;
    }
    if (config.agentId) {
      this.agentId = config.agentId;
    }

    // Security: Only log non-sensitive info in debug mode
    this.logger.debug("PrivacyClient initialized");
    this.logger.debug(
      `  Network: ${this.config.devnet ? "devnet" : "mainnet"}`,
    );
    if (this.config.proverEndpoint) {
      this.logger.debug(`  Prover endpoint: ${this.config.proverEndpoint}`);
    }
  }

  /**
   * Initialize the client with a wallet and optional IDL
   * @param wallet - The wallet keypair to use for signing
   * @param idl - Optional IDL for the AgenC program (required for full functionality)
   */
  async init(wallet: Keypair, idl?: Idl): Promise<void> {
    this.wallet = wallet;

    // Create Anchor provider and program
    const anchorWallet = new Wallet(wallet);
    const provider = new AnchorProvider(this.connection, anchorWallet, {
      commitment: "confirmed",
    });

    // Initialize program if IDL is provided
    const programIdl = idl || this.config.idl;
    if (programIdl) {
      this.program = new Program(programIdl, provider);
      this.logger.debug("Program initialized with IDL");
    } else {
      this.logger.warn("No IDL provided - some features may not be available");
    }

    // Security: Truncate public key to avoid full exposure in logs
    const pubkey = wallet.publicKey.toBase58();
    this.logger.debug(
      `Wallet initialized: ${pubkey.substring(0, 8)}...${pubkey.substring(pubkey.length - 4)}`,
    );
  }

  /**
   * Get connection instance
   */
  getConnection(): Connection {
    return this.connection;
  }

  /**
   * Get wallet public key
   */
  getPublicKey(): PublicKey | null {
    return this.wallet?.publicKey || null;
  }

  /**
   * Complete a task privately with ZK proof.
   *
   * Generates a RISC Zero proof from the provided outputs and submits
   * the proof on-chain via `complete_task_private`.
   *
   * Requires `init()` with an IDL and `agentId` in config.
   */
  async completeTaskPrivate(params: {
    taskPda: PublicKey;
    output: bigint[];
    salt?: bigint;
    agentSecret?: bigint;
  }): Promise<{ txSignature: string }> {
    if (!this.wallet) {
      throw new Error("Client not initialized. Call init() first.");
    }
    if (!this.program) {
      throw new Error(
        "Program not initialized. Provide an IDL via init() or config.",
      );
    }
    if (!this.agentId) {
      throw new Error(
        "Agent ID not provided. Set agentId in PrivacyClientConfig.",
      );
    }

    // Validate output array (must be exactly 4 field elements)
    if (!Array.isArray(params.output) || params.output.length !== 4) {
      throw new Error(
        "Invalid output: must be an array of exactly 4 bigint field elements",
      );
    }
    for (let i = 0; i < params.output.length; i++) {
      if (typeof params.output[i] !== "bigint" || params.output[i] < 0n) {
        throw new Error(`Invalid output[${i}]: must be a non-negative bigint`);
      }
    }

    // Generate or use provided salt
    const salt = params.salt ?? generateSalt();

    // Validate salt is non-zero (zero salt = deterministic commitment, defeats privacy)
    if (salt === 0n) {
      throw new Error(
        "Invalid salt: must be non-zero for privacy preservation",
      );
    }

    // Generate the ZK proof
    const proofParams: ProofGenerationParams = {
      taskPda: params.taskPda,
      agentPubkey: this.wallet.publicKey,
      output: params.output,
      salt,
      agentSecret: params.agentSecret,
    };
    const proofResult = await generateProof(proofParams);

    this.logger.debug(`Proof generated in ${proofResult.generationTime}ms`);

    // Submit private completion on-chain
    const result = await submitCompleteTaskPrivate(
      this.connection,
      this.program,
      this.wallet,
      this.agentId,
      params.taskPda,
      {
        sealBytes: proofResult.sealBytes,
        journal: proofResult.journal,
        imageId: proofResult.imageId,
        bindingSeed: proofResult.bindingSeed,
        nullifierSeed: proofResult.nullifierSeed,
      },
    );

    return result;
  }

  /**
   * Format lamports as SOL string
   */
  static formatSol(lamports: number): string {
    return (lamports / LAMPORTS_PER_SOL).toFixed(9) + " SOL";
  }

  /**
   * Parse SOL string to lamports
   *
   * Note: For large SOL amounts (> ~9 million SOL), consider using BigInt
   * to avoid floating point precision issues. This method validates inputs
   * and throws on invalid values.
   *
   * @param sol - SOL amount as string or number
   * @returns lamports as number (safe for amounts < MAX_SAFE_INTEGER / LAMPORTS_PER_SOL)
   * @throws Error if input is invalid or would cause precision loss
   */
  static parseSol(sol: string | number): number {
    const value = typeof sol === "string" ? parseFloat(sol) : sol;

    // Security: Validate input is a valid number
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(
        "Invalid SOL amount: must be a non-negative finite number",
      );
    }

    // Security: Check for potential precision loss
    // Numbers larger than this can lose precision when converted to lamports
    const maxSafeSol = Number.MAX_SAFE_INTEGER / LAMPORTS_PER_SOL;
    if (value > maxSafeSol) {
      throw new Error(
        `SOL amount ${value} exceeds safe precision limit (${maxSafeSol.toFixed(9)} SOL). ` +
          "Use BigInt for larger amounts.",
      );
    }

    return Math.floor(value * LAMPORTS_PER_SOL);
  }
}

export default PrivacyClient;
