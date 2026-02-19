/**
 * High-level Privacy Client for AgenC
 *
 * Provides a simplified interface for privacy-preserving task operations
 */

import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { type Idl, Program, AnchorProvider, Wallet } from '@coral-xyz/anchor';
import { DEVNET_RPC, MAINNET_RPC } from './constants';
import { validateProverEndpoint } from './validation';
import { createLogger, silentLogger, type Logger, type LogLevel } from './logger';

interface PrivacyOperationsClient {
  initPrivacyCash(wallet: Keypair): Promise<void>;
  shieldEscrow(wallet: Keypair, lamports: number): Promise<{ txSignature: string; shieldedAmount: number }>;
  getShieldedBalance(): Promise<{ lamports: number }>;
  completeTaskPrivate(
    params: {
      taskId: number;
      output: bigint[];
      salt: bigint;
      recipientWallet: PublicKey;
      escrowLamports: number;
    },
    wallet: Keypair,
  ): Promise<{ proofTxSignature: string; withdrawResult: any }>;
}

export interface PrivacyClientConfig {
  /** Solana RPC endpoint URL */
  rpcUrl?: string;
  /** Use devnet (default: false for mainnet) */
  devnet?: boolean;
  /** Optional external RISC0 prover endpoint */
  proverEndpoint?: string;
  /** Owner wallet keypair */
  wallet?: Keypair;
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
  private privacyClient: PrivacyOperationsClient | null = null;
  private config: PrivacyClientConfig;
  private wallet: Keypair | null = null;
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
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          throw new Error('RPC URL must use http or https protocol');
        }
      } catch (e) {
        if ((e as Error).message.includes('http or https')) {
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
      this.logger = createLogger('debug');
    } else {
      this.logger = silentLogger;
    }

    const rpcUrl = config.rpcUrl || (this.config.devnet ? DEVNET_RPC : MAINNET_RPC);
    this.connection = new Connection(rpcUrl, 'confirmed');

    if (config.wallet) {
      this.wallet = config.wallet;
    }

    // Security: Only log non-sensitive info in debug mode
    this.logger.debug('PrivacyClient initialized');
    this.logger.debug(`  Network: ${this.config.devnet ? 'devnet' : 'mainnet'}`);
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
    const provider = new AnchorProvider(
      this.connection,
      anchorWallet,
      { commitment: 'confirmed' }
    );

    // Initialize program if IDL is provided
    const programIdl = idl || this.config.idl;
    if (programIdl) {
      this.program = new Program(programIdl, provider);
      this.logger.debug('Program initialized with IDL');
    } else {
      this.logger.warn('No IDL provided - some features may not be available');
    }

    // Security: Truncate public key to avoid full exposure in logs
    const pubkey = wallet.publicKey.toBase58();
    this.logger.debug(`Wallet initialized: ${pubkey.substring(0, 8)}...${pubkey.substring(pubkey.length - 4)}`);

    // The legacy embedded privacy client was removed from the SDK package.
    // Use explicit task/proof APIs for private completion flows.
    if (this.program) {
      this.logger.warn('Embedded privacy client is unavailable in this build');
      this.privacyClient = null;
    }
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
   * Shield SOL into the privacy pool
   * @param lamports - Amount in lamports to shield (must be positive integer)
   * @throws Error if lamports is invalid or client not initialized
   */
  async shield(lamports: number): Promise<{ txSignature: string; amount: number }> {
    if (!this.wallet || !this.privacyClient) {
      throw new Error('Client not initialized. Call init() first.');
    }

    // Security: Validate lamports input to prevent unexpected behavior
    if (!Number.isInteger(lamports) || lamports <= 0) {
      throw new Error('Invalid lamports amount: must be a positive integer');
    }
    if (lamports > Number.MAX_SAFE_INTEGER) {
      throw new Error('Lamports amount exceeds safe integer limit');
    }

    const result = await this.privacyClient.shieldEscrow(this.wallet, lamports);
    return {
      txSignature: result.txSignature,
      amount: result.shieldedAmount,
    };
  }

  /**
   * Get shielded balance
   */
  async getShieldedBalance(): Promise<number> {
    if (!this.privacyClient) {
      throw new Error('Client not initialized. Call init() first.');
    }

    const { lamports } = await this.privacyClient.getShieldedBalance();
    return lamports;
  }

  /**
   * Complete a task privately with ZK proof
   */
  async completeTaskPrivate(params: {
    taskId: number;
    output: bigint[];
    salt: bigint;
    recipientWallet: PublicKey;
    escrowLamports: number;
  }): Promise<{ proofTxSignature: string; withdrawResult: any }> {
    if (!this.wallet || !this.privacyClient) {
      throw new Error('Client not initialized. Call init() first.');
    }

    // Validate output array length (must be exactly 4 field elements for BN254)
    if (!Array.isArray(params.output) || params.output.length !== 4) {
      throw new Error('Invalid output: must be an array of exactly 4 bigint field elements');
    }

    // Validate output elements are non-negative and within BN254 field
    const BN254_FIELD_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
    for (let i = 0; i < params.output.length; i++) {
      if (typeof params.output[i] !== 'bigint' || params.output[i] < 0n || params.output[i] >= BN254_FIELD_MODULUS) {
        throw new Error(`Invalid output[${i}]: must be a non-negative bigint less than BN254 field modulus`);
      }
    }

    // Validate salt is non-zero (zero salt = deterministic commitment, defeats privacy)
    if (params.salt === 0n) {
      throw new Error('Invalid salt: must be non-zero for privacy preservation');
    }

    // Validate escrowLamports
    if (!Number.isInteger(params.escrowLamports) || params.escrowLamports <= 0) {
      throw new Error('Invalid escrowLamports: must be a positive integer');
    }

    return await this.privacyClient.completeTaskPrivate(params, this.wallet);
  }

  /**
   * Get the underlying privacy operations client for advanced operations
   */
  getPrivacyClient(): PrivacyOperationsClient | null {
    return this.privacyClient;
  }

  /**
   * Format lamports as SOL string
   */
  static formatSol(lamports: number): string {
    return (lamports / LAMPORTS_PER_SOL).toFixed(9) + ' SOL';
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
    const value = typeof sol === 'string' ? parseFloat(sol) : sol;

    // Security: Validate input is a valid number
    if (!Number.isFinite(value) || value < 0) {
      throw new Error('Invalid SOL amount: must be a non-negative finite number');
    }

    // Security: Check for potential precision loss
    // Numbers larger than this can lose precision when converted to lamports
    const maxSafeSol = Number.MAX_SAFE_INTEGER / LAMPORTS_PER_SOL;
    if (value > maxSafeSol) {
      throw new Error(
        `SOL amount ${value} exceeds safe precision limit (${maxSafeSol.toFixed(9)} SOL). ` +
        'Use BigInt for larger amounts.'
      );
    }

    return Math.floor(value * LAMPORTS_PER_SOL);
  }
}

export default PrivacyClient;
