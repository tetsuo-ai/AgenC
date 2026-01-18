/**
 * High-level Privacy Client for AgenC
 *
 * Provides a simplified interface for privacy-preserving task operations
 */

import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { Program, AnchorProvider, Wallet, Idl } from '@coral-xyz/anchor';
import * as path from 'path';
import { AgenCPrivacyClient } from './privacy';
import { PROGRAM_ID, VERIFIER_PROGRAM_ID, DEVNET_RPC, MAINNET_RPC } from './constants';

/**
 * Validates a circuit path to prevent path traversal attacks.
 * @param circuitPath - The circuit path to validate
 * @returns true if the path is safe, false otherwise
 */
function isValidCircuitPath(circuitPath: string): boolean {
  // Disallow absolute paths and path traversal
  if (path.isAbsolute(circuitPath)) {
    return false;
  }
  // Normalize and check for traversal attempts
  const normalized = path.normalize(circuitPath);
  if (normalized.startsWith('..') || normalized.includes('../')) {
    return false;
  }
  return true;
}

export interface PrivacyClientConfig {
  /** Solana RPC endpoint URL */
  rpcUrl?: string;
  /** Use devnet (default: false for mainnet) */
  devnet?: boolean;
  /** Path to Noir circuit directory */
  circuitPath?: string;
  /** Owner wallet keypair */
  wallet?: Keypair;
  /** Enable debug logging */
  debug?: boolean;
  /** Program IDL (required for full functionality) */
  idl?: Idl;
}

export class PrivacyClient {
  private connection: Connection;
  private program: Program | null = null;
  private privacyClient: AgenCPrivacyClient | null = null;
  private config: PrivacyClientConfig;
  private wallet: Keypair | null = null;

  constructor(config: PrivacyClientConfig = {}) {
    // Validate circuit path before accepting it
    const circuitPath = config.circuitPath || './circuits/task_completion';
    if (!isValidCircuitPath(circuitPath)) {
      throw new Error('Invalid circuit path: path traversal or absolute paths not allowed');
    }

    this.config = {
      devnet: false,
      circuitPath,
      debug: false,
      ...config,
    };

    const rpcUrl = config.rpcUrl || (this.config.devnet ? DEVNET_RPC : MAINNET_RPC);
    this.connection = new Connection(rpcUrl, 'confirmed');

    if (config.wallet) {
      this.wallet = config.wallet;
    }

    if (this.config.debug) {
      // Security: Only log non-sensitive info in debug mode
      console.log('PrivacyClient initialized');
      console.log('  Network:', this.config.devnet ? 'devnet' : 'mainnet');
      console.log('  Circuit:', this.config.circuitPath);
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
      if (this.config.debug) {
        console.log('Program initialized with IDL');
      }
    } else if (this.config.debug) {
      console.warn('No IDL provided - some features may not be available');
    }

    if (this.config.debug) {
      // Security: Truncate public key to avoid full exposure in logs
      const pubkey = wallet.publicKey.toBase58();
      console.log('Wallet initialized:', pubkey.substring(0, 8) + '...' + pubkey.substring(pubkey.length - 4));
    }

    // Initialize privacy client only if program is available
    if (this.program) {
      this.privacyClient = new AgenCPrivacyClient(
        this.connection,
        this.program,
        this.config.circuitPath,
        this.connection.rpcEndpoint
      );
      await this.privacyClient.initPrivacyCash(wallet);
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
   */
  async shield(lamports: number): Promise<{ txSignature: string; amount: number }> {
    if (!this.wallet || !this.privacyClient) {
      throw new Error('Client not initialized. Call init() first.');
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

    return await this.privacyClient.completeTaskPrivate(params, this.wallet);
  }

  /**
   * Get the underlying AgenCPrivacyClient for advanced operations
   */
  getPrivacyClient(): AgenCPrivacyClient | null {
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
   */
  static parseSol(sol: string | number): number {
    const value = typeof sol === 'string' ? parseFloat(sol) : sol;
    return Math.floor(value * LAMPORTS_PER_SOL);
  }
}

export default PrivacyClient;
