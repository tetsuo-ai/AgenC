/**
 * Jupiter DeFi skill implementation.
 *
 * Provides token swap, balance query, transfer, and price lookup
 * operations via the Jupiter V6 aggregator and Solana RPC.
 *
 * @module
 */

import type { Connection } from '@solana/web3.js';
import {
  PublicKey,
  SystemProgram,
  VersionedTransaction,
  TransactionMessage,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import type { Skill, SkillMetadata, SkillAction, SkillContext, SemanticVersion } from '../types.js';
import { SkillState } from '../types.js';
import { SkillNotReadyError } from '../errors.js';
import { JupiterClient } from './jupiter-client.js';
import { JUPITER_API_BASE_URL, WSOL_MINT, WELL_KNOWN_TOKENS } from './constants.js';
import type {
  JupiterSkillConfig,
  SwapQuoteParams,
  SwapQuote,
  SwapResult,
  TokenBalance,
  TransferSolParams,
  TransferTokenParams,
  TransferResult,
  TokenPrice,
} from './types.js';
import type { Logger } from '../../utils/logger.js';
import type { Wallet } from '../../types/wallet.js';
import { Capability } from '../../agent/capabilities.js';

const DEFAULT_SLIPPAGE_BPS = 50;
const DEFAULT_TIMEOUT_MS = 30_000;
const VERSION: SemanticVersion = '0.1.0';

/**
 * Jupiter DeFi skill providing token swap and transfer operations.
 *
 * Actions:
 * - `getQuote` — Fetch swap quote via Jupiter V6 aggregator
 * - `executeSwap` — Execute a token swap (quote + sign + submit)
 * - `getSolBalance` — Check SOL balance for an address
 * - `getTokenBalance` — Check SPL token balance
 * - `transferSol` — Send SOL to a recipient
 * - `transferToken` — Send SPL token (auto-creates recipient ATA)
 * - `getTokenPrice` — Look up token price in USD
 *
 * @example
 * ```typescript
 * const jupiter = new JupiterSkill({ defaultSlippageBps: 100 });
 * const registry = new SkillRegistry();
 * registry.register(jupiter);
 * await registry.initializeAll({ connection, wallet, logger });
 *
 * const quote = await jupiter.getQuote({
 *   inputMint: WSOL_MINT,
 *   outputMint: USDC_MINT,
 *   amount: 1_000_000_000n,
 * });
 * ```
 */
export class JupiterSkill implements Skill {
  readonly metadata: SkillMetadata = {
    name: 'jupiter',
    description: 'Jupiter V6 DEX aggregator skill for token swaps, transfers, and price lookups',
    version: VERSION,
    requiredCapabilities: Capability.COMPUTE | Capability.NETWORK,
    tags: ['defi', 'swap', 'transfer', 'jupiter'],
  };

  private _state: SkillState = SkillState.Created;
  private connection: Connection | null = null;
  private wallet: Wallet | null = null;
  private logger: Logger | null = null;
  private client: JupiterClient | null = null;

  private readonly defaultSlippageBps: number;
  private readonly apiBaseUrl: string;
  private readonly timeoutMs: number;

  private readonly actions: ReadonlyArray<SkillAction>;

  constructor(config?: JupiterSkillConfig) {
    this.apiBaseUrl = config?.apiBaseUrl ?? JUPITER_API_BASE_URL;
    this.defaultSlippageBps = config?.defaultSlippageBps ?? DEFAULT_SLIPPAGE_BPS;
    this.timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // Build action registry (bound to this instance)
    this.actions = [
      {
        name: 'getQuote',
        description: 'Get a swap quote from Jupiter V6 aggregator',
        execute: (params: unknown) => this.getQuote(params as SwapQuoteParams),
      },
      {
        name: 'executeSwap',
        description: 'Execute a token swap via Jupiter V6',
        execute: (params: unknown) => this.executeSwap(params as SwapQuoteParams),
      },
      {
        name: 'getSolBalance',
        description: 'Get SOL balance for an address',
        execute: (params: unknown) => this.getSolBalance(params as PublicKey | undefined),
      },
      {
        name: 'getTokenBalance',
        description: 'Get SPL token balance',
        execute: (params: unknown) => {
          const p = params as { mint: PublicKey; owner?: PublicKey };
          return this.getTokenBalance(p.mint, p.owner);
        },
      },
      {
        name: 'transferSol',
        description: 'Transfer SOL to a recipient',
        execute: (params: unknown) => this.transferSol(params as TransferSolParams),
      },
      {
        name: 'transferToken',
        description: 'Transfer SPL token to a recipient',
        execute: (params: unknown) => this.transferToken(params as TransferTokenParams),
      },
      {
        name: 'getTokenPrice',
        description: 'Get token price in USD via Jupiter Price API',
        execute: (params: unknown) => this.getTokenPrice(params as string[]),
      },
    ];
  }

  get state(): SkillState {
    return this._state;
  }

  async initialize(context: SkillContext): Promise<void> {
    this._state = SkillState.Initializing;
    try {
      this.connection = context.connection;
      this.wallet = context.wallet;
      this.logger = context.logger;
      this.client = new JupiterClient({
        apiBaseUrl: this.apiBaseUrl,
        timeoutMs: this.timeoutMs,
        logger: context.logger,
      });
      this._state = SkillState.Ready;
    } catch (err) {
      this._state = SkillState.Error;
      throw err;
    }
  }

  async shutdown(): Promise<void> {
    this._state = SkillState.ShuttingDown;
    this.client = null;
    this.connection = null;
    this.wallet = null;
    this.logger = null;
    this._state = SkillState.Stopped;
  }

  getActions(): ReadonlyArray<SkillAction> {
    return this.actions;
  }

  getAction(name: string): SkillAction | undefined {
    return this.actions.find((a) => a.name === name);
  }

  // ============================================================================
  // Typed action methods
  // ============================================================================

  /**
   * Fetch a swap quote from Jupiter V6.
   */
  async getQuote(params: SwapQuoteParams): Promise<SwapQuote> {
    this.ensureReady();
    const quoteParams: SwapQuoteParams = {
      ...params,
      slippageBps: params.slippageBps ?? this.defaultSlippageBps,
    };
    return this.client!.getQuote(quoteParams);
  }

  /**
   * Execute a full token swap: fetch quote, build transaction, sign, and submit.
   */
  async executeSwap(params: SwapQuoteParams): Promise<SwapResult> {
    this.ensureReady();

    // 1. Get quote
    const quote = await this.getQuote(params);
    this.logger!.info(
      `Swap quote: ${quote.inAmount} ${quote.inputMint} -> ${quote.outAmount} ${quote.outputMint} (impact: ${quote.priceImpactPct}%)`,
    );

    // 2. Get serialized transaction
    const txBytes = await this.client!.getSwapTransaction(
      quote.rawQuote,
      this.wallet!.publicKey.toBase58(),
    );

    // 3. Deserialize and sign
    const tx = VersionedTransaction.deserialize(txBytes);
    const signedTx = await this.wallet!.signTransaction(tx);

    // 4. Send and confirm
    const rawTx = signedTx.serialize();
    const txSignature = await this.connection!.sendRawTransaction(rawTx, {
      skipPreflight: false,
      maxRetries: 3,
    });

    this.logger!.info(`Swap transaction sent: ${txSignature}`);

    const latestBlockhash = await this.connection!.getLatestBlockhash();
    await this.connection!.confirmTransaction({
      signature: txSignature,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    });

    this.logger!.info(`Swap confirmed: ${txSignature}`);

    return {
      txSignature,
      inputAmount: quote.inAmount,
      outputAmount: quote.outAmount,
      inputMint: quote.inputMint,
      outputMint: quote.outputMint,
    };
  }

  /**
   * Get SOL balance for an address.
   * Defaults to the skill wallet's address.
   */
  async getSolBalance(address?: PublicKey): Promise<TokenBalance> {
    this.ensureReady();

    const owner = address ?? this.wallet!.publicKey;
    const lamports = await this.connection!.getBalance(owner);

    return {
      mint: WSOL_MINT,
      symbol: 'SOL',
      amount: BigInt(lamports),
      decimals: 9,
      uiAmount: lamports / LAMPORTS_PER_SOL,
    };
  }

  /**
   * Get SPL token balance for a mint.
   * Defaults to the skill wallet as owner.
   */
  async getTokenBalance(mint: PublicKey, owner?: PublicKey): Promise<TokenBalance> {
    this.ensureReady();

    const walletOwner = owner ?? this.wallet!.publicKey;
    const tokenAccounts = await this.connection!.getTokenAccountsByOwner(walletOwner, {
      mint,
    });

    let amount = 0n;
    let decimals = 0;

    if (tokenAccounts.value.length > 0) {
      // Parse token account data (SPL Token account layout: 165 bytes)
      // Bytes 64-72: amount (u64 LE)
      const data = tokenAccounts.value[0].account.data;
      if (data.length >= 72) {
        const amountBuf = data.subarray(64, 72);
        amount = amountBuf.readBigUInt64LE(0);
      }

      // Get decimals from mint account
      const mintInfo = await this.connection!.getParsedAccountInfo(mint);
      if (mintInfo.value && 'parsed' in mintInfo.value.data) {
        const parsed = mintInfo.value.data.parsed as Record<string, Record<string, unknown>>;
        decimals = Number(parsed.info?.decimals ?? 0);
      }
    }

    const mintStr = mint.toBase58();
    const knownToken = WELL_KNOWN_TOKENS.get(mintStr);
    const symbol = knownToken?.symbol ?? null;
    const uiAmount = decimals > 0 ? Number(amount) / Math.pow(10, decimals) : Number(amount);

    return { mint: mintStr, symbol, amount, decimals, uiAmount };
  }

  /**
   * Transfer SOL to a recipient.
   */
  async transferSol(params: TransferSolParams): Promise<TransferResult> {
    this.ensureReady();

    const instruction = SystemProgram.transfer({
      fromPubkey: this.wallet!.publicKey,
      toPubkey: params.recipient,
      lamports: params.lamports,
    });

    const latestBlockhash = await this.connection!.getLatestBlockhash();
    const messageV0 = new TransactionMessage({
      payerKey: this.wallet!.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions: [instruction],
    }).compileToV0Message();

    const tx = new VersionedTransaction(messageV0);
    const signedTx = await this.wallet!.signTransaction(tx);

    const txSignature = await this.connection!.sendRawTransaction(signedTx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });

    await this.connection!.confirmTransaction({
      signature: txSignature,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    });

    this.logger!.info(
      `SOL transfer confirmed: ${params.lamports} lamports to ${params.recipient.toBase58()} (${txSignature})`,
    );

    return { txSignature, amount: params.lamports };
  }

  /**
   * Transfer SPL token to a recipient.
   *
   * Creates the recipient's Associated Token Account (ATA) if it doesn't exist.
   * Uses raw instructions instead of @solana/spl-token to avoid the peer dependency.
   */
  async transferToken(params: TransferTokenParams): Promise<TransferResult> {
    this.ensureReady();

    const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
      'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
    );

    // Derive sender ATA
    const senderAta = PublicKey.findProgramAddressSync(
      [this.wallet!.publicKey.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), params.mint.toBuffer()],
      ASSOCIATED_TOKEN_PROGRAM_ID,
    )[0];

    // Derive recipient ATA
    const recipientAta = PublicKey.findProgramAddressSync(
      [params.recipient.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), params.mint.toBuffer()],
      ASSOCIATED_TOKEN_PROGRAM_ID,
    )[0];

    const instructions = [];

    // Check if recipient ATA exists, if not, create it
    const recipientAtaInfo = await this.connection!.getAccountInfo(recipientAta);
    if (!recipientAtaInfo) {
      // Create Associated Token Account instruction (manual to avoid spl-token dep)
      instructions.push({
        programId: ASSOCIATED_TOKEN_PROGRAM_ID,
        keys: [
          { pubkey: this.wallet!.publicKey, isSigner: true, isWritable: true },
          { pubkey: recipientAta, isSigner: false, isWritable: true },
          { pubkey: params.recipient, isSigner: false, isWritable: false },
          { pubkey: params.mint, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data: Buffer.alloc(0),
      });
    }

    // SPL Token transfer instruction (instruction index 3)
    const transferData = Buffer.alloc(9);
    transferData.writeUInt8(3, 0); // Transfer instruction
    transferData.writeBigUInt64LE(params.amount, 1);

    instructions.push({
      programId: TOKEN_PROGRAM_ID,
      keys: [
        { pubkey: senderAta, isSigner: false, isWritable: true },
        { pubkey: recipientAta, isSigner: false, isWritable: true },
        { pubkey: this.wallet!.publicKey, isSigner: true, isWritable: false },
      ],
      data: transferData,
    });

    const latestBlockhash = await this.connection!.getLatestBlockhash();
    const messageV0 = new TransactionMessage({
      payerKey: this.wallet!.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions,
    }).compileToV0Message();

    const tx = new VersionedTransaction(messageV0);
    const signedTx = await this.wallet!.signTransaction(tx);

    const txSignature = await this.connection!.sendRawTransaction(signedTx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });

    await this.connection!.confirmTransaction({
      signature: txSignature,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    });

    this.logger!.info(
      `Token transfer confirmed: ${params.amount} of ${params.mint.toBase58()} to ${params.recipient.toBase58()} (${txSignature})`,
    );

    return { txSignature, amount: params.amount };
  }

  /**
   * Get token prices in USD via Jupiter Price API.
   */
  async getTokenPrice(mints: string[]): Promise<Map<string, TokenPrice>> {
    this.ensureReady();
    return this.client!.getPrice(mints);
  }

  // ============================================================================
  // Private helpers
  // ============================================================================

  private ensureReady(): void {
    if (this._state !== SkillState.Ready) {
      throw new SkillNotReadyError('jupiter');
    }
  }
}
