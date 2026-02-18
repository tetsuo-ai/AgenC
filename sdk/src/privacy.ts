import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import type { Program } from '@coral-xyz/anchor';
import type { PrivacyCash, PrivacyCashConfig } from 'privacycash';
import { createLogger, type Logger } from './logger';

// Re-export types for external use.
export type { PrivacyCashConfig };

let PrivacyCashClass: typeof PrivacyCash | null = null;
let loadAttempted = false;
let loadError: Error | null = null;

async function loadPrivacyCash(): Promise<typeof PrivacyCash | null> {
  if (loadAttempted) {
    if (loadError) {
      throw loadError;
    }
    return PrivacyCashClass;
  }
  loadAttempted = true;

  try {
    const module = await import('privacycash');
    if (!module.PrivacyCash) {
      loadError = new Error('privacycash module loaded but PrivacyCash class not found');
      throw loadError;
    }
    PrivacyCashClass = module.PrivacyCash;
    return PrivacyCashClass;
  } catch (err) {
    if (
      err instanceof Error &&
      (err.message.includes('Cannot find module') || err.message.includes('Cannot find package'))
    ) {
      return null;
    }
    loadError = err instanceof Error ? err : new Error(String(err));
    throw loadError;
  }
}

function createPrivacyCash(config: PrivacyCashConfig): PrivacyCash {
  if (!PrivacyCashClass) {
    throw new Error(
      'privacycash package not installed. Install it with: npm install privacycash'
    );
  }
  return new PrivacyCashClass(config);
}

export interface PrivateCompletionParams {
  taskId: number;
  output: bigint[];
  salt: bigint;
  recipientWallet: PublicKey;
  escrowLamports: number;
}

export interface ShieldEscrowResult {
  txSignature: string;
  shieldedAmount: number;
}

/**
 * Result of a private task completion withdrawal.
 */
export interface WithdrawResult {
  signature?: string;
  success?: boolean;
  amount?: number;
  [key: string]: unknown;
}

/**
 * @deprecated Legacy compatibility wrapper.
 * Use `generateProof()` + task helpers from `sdk/src/tasks.ts` for private completion.
 */
export class AgenCPrivacyClient {
  private connection: Connection;
  private program: Program;
  private privacyCash: PrivacyCash | null = null;
  private rpcUrl: string;
  private privacyCashLoaded = false;
  private logger: Logger;

  constructor(
    connection: Connection,
    program: Program,
    _deprecatedPath?: string,
    rpcUrl?: string,
    logger?: Logger,
  ) {
    this.connection = connection;
    this.program = program;
    this.rpcUrl = rpcUrl || connection.rpcEndpoint;
    this.logger = logger ?? createLogger('info');
  }

  async initPrivacyCash(owner: Keypair): Promise<void> {
    if (!this.privacyCashLoaded) {
      await loadPrivacyCash();
      this.privacyCashLoaded = true;
    }

    const enableDebug = process.env.AGENC_DEBUG === 'true';
    this.privacyCash = createPrivacyCash({
      RPC_url: this.rpcUrl,
      owner,
      enableDebug,
    });

    const pubkeyStr = owner.publicKey.toBase58();
    this.logger.info(
      `Privacy Cash client initialized for: ${pubkeyStr.substring(0, 8)}...${pubkeyStr.substring(pubkeyStr.length - 4)}`
    );
  }

  async shieldEscrow(creator: Keypair, lamports: number): Promise<ShieldEscrowResult> {
    if (!this.privacyCash || this.privacyCash.publicKey.toBase58() !== creator.publicKey.toBase58()) {
      await this.initPrivacyCash(creator);
    }
    if (!this.privacyCash) {
      throw new Error('Privacy Cash not initialized');
    }

    this.logger.info(`Shielding ${lamports / LAMPORTS_PER_SOL} SOL into privacy pool...`);
    const result = await this.privacyCash.deposit({ lamports });

    return {
      txSignature: result?.signature || 'deposited',
      shieldedAmount: lamports,
    };
  }

  async getShieldedBalance(): Promise<{ lamports: number }> {
    if (!this.privacyCash) {
      throw new Error('Privacy Cash not initialized. Call initPrivacyCash first.');
    }
    return this.privacyCash.getPrivateBalance();
  }

  async completeTaskPrivate(
    _params: PrivateCompletionParams,
    _worker: Keypair,
  ): Promise<{ proofTxSignature: string; withdrawResult: WithdrawResult }> {
    throw new Error(
      'AgenCPrivacyClient.completeTaskPrivate is deprecated. Use generateProof() and completeTaskPrivate() task helpers with router accounts.'
    );
  }

  getProgram(): Program {
    return this.program;
  }

  getConnection(): Connection {
    return this.connection;
  }
}
