/**
 * PumpTracks music token skill implementation.
 *
 * Provides track browsing, searching, artist lookup, and full
 * music token minting via the PumpTracks API + Raydium LaunchLab.
 *
 * Security:
 * - Transaction instruction validation against program ID allowlist
 * - Transaction simulation before signing
 * - File path traversal protection with blocked-path patterns
 * - SOL balance guard before minting
 *
 * @module
 */

import {
  LAMPORTS_PER_SOL,
  VersionedTransaction,
} from '@solana/web3.js';
import type { Connection } from '@solana/web3.js';
import type { Skill, SkillMetadata, SkillAction, SkillContext, SemanticVersion } from '../types.js';
import { SkillState } from '../types.js';
import { SkillNotReadyError } from '../errors.js';
import { PumpTracksClient } from './pumptracks-client.js';
import {
  PUMPTRACKS_API_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  ALLOWED_PROGRAM_IDS,
  ALLOWED_AUDIO_EXTENSIONS,
  ALLOWED_IMAGE_EXTENSIONS,
  MAX_AUDIO_SIZE,
  MAX_ARTWORK_SIZE,
  MIN_MINT_LAMPORTS,
  BLOCKED_PATH_PATTERNS,
} from './constants.js';
import type {
  PumpTracksSkillConfig,
  ListTracksParams,
  SearchTracksParams,
  MintTrackParams,
  Track,
  Artist,
  MintResult,
} from './types.js';
import type { Logger } from '../../utils/logger.js';
import type { Wallet } from '../../types/wallet.js';
import { Capability } from '../../agent/capabilities.js';
import * as fs from 'fs';
import * as path from 'path';

const VERSION: SemanticVersion = '0.1.0';

/**
 * PumpTracks skill for launching music tokens on Solana.
 *
 * Actions:
 * - `getTracks`    — List tracks with optional filters (genre, artist, sort)
 * - `getTrack`     — Get a single track by mint address
 * - `searchTracks` — Search tracks by title, artist, or symbol
 * - `getArtist`    — Get artist profile and their tracks
 * - `mintTrack`    — Full end-to-end mint: upload files, sign transaction, submit
 *
 * @example
 * ```typescript
 * const pumptracks = new PumpTracksSkill({
 *   apiKey: 'pt_live_xxxxxxxxxxxxx',
 * });
 * const registry = new SkillRegistry();
 * registry.register(pumptracks);
 * await registry.initializeAll({ connection, wallet, logger });
 *
 * // Browse tracks
 * const tracks = await pumptracks.getTracks({ genre: 'Electronic', limit: 10 });
 *
 * // Mint a new music token
 * const result = await pumptracks.mintTrack({
 *   audio: './song.mp3',
 *   artwork: './cover.jpg',
 *   title: 'My Song',
 *   artist: 'Artist Name',
 *   genre: 'Electronic',
 * });
 * console.log(`Track live at: ${result.playUrl}`);
 * ```
 */
export class PumpTracksSkill implements Skill {
  readonly metadata: SkillMetadata = {
    name: 'pumptracks',
    description: 'PumpTracks music token launchpad — mint, browse, and search music tokens on Solana',
    version: VERSION,
    requiredCapabilities: Capability.COMPUTE | Capability.NETWORK,
    tags: ['music', 'nft', 'token', 'mint', 'solana', 'pumptracks'],
  };

  private _state: SkillState = SkillState.Created;
  private connection: Connection | null = null;
  private wallet: Wallet | null = null;
  private logger: Logger | null = null;
  private client: PumpTracksClient | null = null;

  private readonly apiKey: string;
  private readonly apiBaseUrl: string;
  private readonly timeoutMs: number;

  private readonly actions: ReadonlyArray<SkillAction>;

  constructor(config: PumpTracksSkillConfig) {
    this.apiKey = config.apiKey;
    this.apiBaseUrl = config.apiBaseUrl ?? PUMPTRACKS_API_BASE_URL;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    this.actions = [
      {
        name: 'getTracks',
        description: 'List music tracks on PumpTracks with optional filters (genre, artist, sort)',
        execute: (params: unknown) => this.getTracks(params as ListTracksParams),
      },
      {
        name: 'getTrack',
        description: 'Get a single track by its Solana mint address',
        execute: (params: unknown) => {
          const p = params as { mint: string };
          return this.getTrack(p.mint);
        },
      },
      {
        name: 'searchTracks',
        description: 'Search for tracks by title, artist name, or token symbol',
        execute: (params: unknown) => this.searchTracks(params as SearchTracksParams),
      },
      {
        name: 'getArtist',
        description: 'Get an artist profile and their tracks by wallet address',
        execute: (params: unknown) => {
          const p = params as { wallet: string };
          return this.getArtist(p.wallet);
        },
      },
      {
        name: 'mintTrack',
        description: 'Mint a new music token on PumpTracks. Uploads audio + artwork, validates the returned transaction against a program allowlist, simulates it, signs it, and submits. The wallet used by this agent becomes the on-chain creator. Requires ~0.07 SOL.',
        execute: (params: unknown) => this.mintTrack(params as MintTrackParams),
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
      this.client = new PumpTracksClient({
        apiBaseUrl: this.apiBaseUrl,
        apiKey: this.apiKey,
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
   * List tracks with optional filters.
   */
  async getTracks(params?: ListTracksParams): Promise<Track[]> {
    this.ensureReady();
    return this.client!.listTracks(params);
  }

  /**
   * Get a single track by mint address.
   */
  async getTrack(mint: string): Promise<Track> {
    this.ensureReady();
    return this.client!.getTrack(mint);
  }

  /**
   * Search tracks by title, artist, or symbol.
   */
  async searchTracks(params: SearchTracksParams): Promise<Track[]> {
    this.ensureReady();
    return this.client!.searchTracks(params);
  }

  /**
   * Get artist profile by wallet address.
   */
  async getArtist(wallet: string): Promise<Artist> {
    this.ensureReady();
    return this.client!.getArtist(wallet);
  }

  /**
   * Full end-to-end mint flow with security validation:
   *
   * 1. Validate file paths (no traversal, no sensitive files)
   * 2. Check SOL balance (must have >= 0.07 SOL)
   * 3. Upload audio + artwork to PumpTracks API
   * 4. Receive unsigned Raydium LaunchLab transaction
   * 5. Validate every instruction's program ID against allowlist
   * 6. Simulate transaction before signing
   * 7. Sign with the agent's wallet
   * 8. Submit signed transaction back to PumpTracks
   *
   * @returns Mint address, tx IDs, and play URL
   * @throws Error if transaction contains disallowed programs
   * @throws Error if simulation fails
   * @throws Error if insufficient SOL balance
   * @throws Error if file path is blocked or invalid
   */
  async mintTrack(params: MintTrackParams): Promise<MintResult> {
    this.ensureReady();

    const walletAddress = this.wallet!.publicKey.toBase58();
    this.logger!.info(`PumpTracks: minting "${params.title}" by ${params.artist}...`);

    // ── Security: Validate & read files ──
    const { audioBlob, audioFilename, artBlob, artFilename } = this.loadAndValidateFiles(params);

    // ── Security: Check SOL balance ──
    await this.ensureSufficientBalance();

    // ── Step 1: Build form data ──
    const formData = new FormData();
    formData.append('audio', audioBlob, audioFilename);
    formData.append('artwork', artBlob, artFilename);
    formData.append('title', params.title);
    formData.append('artist', params.artist);
    formData.append('genre', params.genre);
    formData.append('wallet', walletAddress);
    if (params.twitter) formData.append('twitter', params.twitter);
    if (params.tiktok) formData.append('tiktok', params.tiktok);
    if (params.instagram) formData.append('instagram', params.instagram);

    // ── Step 2: Prepare mint (upload files + build unsigned tx) ──
    this.logger!.info('PumpTracks: uploading files and preparing transaction...');
    const prepared = await this.client!.prepareMint(formData);

    this.logger!.info(`PumpTracks: mint address = ${prepared.mint}`);
    this.logger!.info(`PumpTracks: ${prepared.transactions.length} transaction(s) to sign`);

    // ── Step 3: Validate, simulate, and sign each transaction ──
    this.logger!.info('PumpTracks: validating and signing transactions...');
    const signedTransactions: string[] = [];

    for (let i = 0; i < prepared.transactions.length; i++) {
      const txBytes = Buffer.from(prepared.transactions[i], 'base64');
      const tx = VersionedTransaction.deserialize(txBytes);

      // Security: Validate all program IDs against allowlist
      this.validateTransactionPrograms(tx, i);

      // Security: Simulate before signing
      await this.simulateTransaction(tx, i);

      // Sign
      const signedTx = await this.wallet!.signTransaction(tx);
      signedTransactions.push(Buffer.from(signedTx.serialize()).toString('base64'));
      this.logger!.debug(`PumpTracks: signed transaction ${i + 1}/${prepared.transactions.length}`);
    }

    // ── Step 4: Submit signed transactions ──
    this.logger!.info('PumpTracks: submitting to Solana...');
    const result = await this.client!.submitMint(
      signedTransactions,
      prepared.mint,
      prepared.trackInfo,
    );

    this.logger!.info(`PumpTracks: track live at ${result.playUrl}`);
    this.logger!.info(`PumpTracks: tx(s): ${result.txIds.join(', ')}`);

    return result;
  }

  // ============================================================================
  // Security: Transaction validation
  // ============================================================================

  /**
   * Validate that every instruction in the transaction targets a program
   * in the ALLOWED_PROGRAM_IDS allowlist. Refuses to sign if any
   * instruction targets an unknown program.
   *
   * @throws Error if any instruction targets a disallowed program
   */
  private validateTransactionPrograms(tx: VersionedTransaction, txIndex: number): void {
    const message = tx.message;
    const accountKeys = message.getAccountKeys();

    for (const instruction of message.compiledInstructions) {
      const programId = accountKeys.get(instruction.programIdIndex);
      if (!programId) {
        throw new Error(
          `Transaction ${txIndex + 1}: instruction references invalid account index ${instruction.programIdIndex}`,
        );
      }

      const programIdStr = programId.toBase58();
      if (!ALLOWED_PROGRAM_IDS.has(programIdStr)) {
        throw new Error(
          `Transaction ${txIndex + 1}: disallowed program ${programIdStr}. ` +
          `Only Raydium LaunchLab, SPL Token, System, Metaplex, and Compute Budget programs are permitted. ` +
          `This transaction was NOT signed.`,
        );
      }
    }

    this.logger!.debug(
      `PumpTracks: transaction ${txIndex + 1} passed program allowlist validation ` +
      `(${message.compiledInstructions.length} instructions)`,
    );
  }

  /**
   * Simulate a transaction before signing to verify it won't fail or
   * behave unexpectedly.
   *
   * @throws Error if simulation returns an error
   */
  private async simulateTransaction(tx: VersionedTransaction, txIndex: number): Promise<void> {
    this.logger!.debug(`PumpTracks: simulating transaction ${txIndex + 1}...`);

    const simulation = await this.connection!.simulateTransaction(tx, {
      sigVerify: false,
      replaceRecentBlockhash: true,
    });

    if (simulation.value.err) {
      const logs = simulation.value.logs?.join('\n') || 'no logs';
      throw new Error(
        `Transaction ${txIndex + 1} simulation failed: ${JSON.stringify(simulation.value.err)}\nLogs:\n${logs}`,
      );
    }

    this.logger!.debug(`PumpTracks: transaction ${txIndex + 1} simulation passed`);
  }

  // ============================================================================
  // Security: File path validation
  // ============================================================================

  /**
   * Validate and load file inputs. When given file paths (strings):
   * - Resolves to absolute path to prevent traversal
   * - Checks against blocked path patterns (secrets, keys, etc.)
   * - Validates file extension against allowed types
   * - Checks file size against limits
   *
   * When given Buffers, validates size only.
   *
   * @throws Error on blocked path, wrong extension, or size limit
   */
  private loadAndValidateFiles(params: MintTrackParams): {
    audioBlob: Blob;
    audioFilename: string;
    artBlob: Blob;
    artFilename: string;
  } {
    let audioBlob: Blob;
    let audioFilename: string;
    let artBlob: Blob;
    let artFilename: string;

    if (typeof params.audio === 'string') {
      const { buffer, filename } = this.validateAndReadFile(
        params.audio,
        ALLOWED_AUDIO_EXTENSIONS,
        MAX_AUDIO_SIZE,
        'audio',
      );
      audioBlob = new Blob([buffer]);
      audioFilename = filename;
    } else {
      if (params.audio.byteLength > MAX_AUDIO_SIZE) {
        throw new Error(`Audio buffer exceeds maximum size of ${MAX_AUDIO_SIZE} bytes`);
      }
      audioBlob = new Blob([params.audio]);
      audioFilename = params.audioFilename || 'track.mp3';
    }

    if (typeof params.artwork === 'string') {
      const { buffer, filename } = this.validateAndReadFile(
        params.artwork,
        ALLOWED_IMAGE_EXTENSIONS,
        MAX_ARTWORK_SIZE,
        'artwork',
      );
      artBlob = new Blob([buffer]);
      artFilename = filename;
    } else {
      if (params.artwork.byteLength > MAX_ARTWORK_SIZE) {
        throw new Error(`Artwork buffer exceeds maximum size of ${MAX_ARTWORK_SIZE} bytes`);
      }
      artBlob = new Blob([params.artwork]);
      artFilename = params.artworkFilename || 'cover.jpg';
    }

    return { audioBlob, audioFilename, artBlob, artFilename };
  }

  /**
   * Validate a file path and read its contents.
   *
   * @throws Error if path matches a blocked pattern, has wrong extension,
   *         doesn't exist, or exceeds size limit
   */
  private validateAndReadFile(
    filePath: string,
    allowedExtensions: ReadonlySet<string>,
    maxSize: number,
    label: string,
  ): { buffer: Buffer; filename: string } {
    // Resolve to absolute path to normalize traversal attempts
    const resolved = path.resolve(filePath);

    // Check against blocked patterns
    for (const pattern of BLOCKED_PATH_PATTERNS) {
      if (pattern.test(resolved)) {
        throw new Error(
          `Refused to read ${label} file: path "${filePath}" matches blocked pattern. ` +
          `This may be a sensitive file (keys, credentials, env).`,
        );
      }
    }

    // Validate extension
    const ext = path.extname(resolved).toLowerCase();
    if (!allowedExtensions.has(ext)) {
      throw new Error(
        `Invalid ${label} file extension "${ext}". Allowed: ${[...allowedExtensions].join(', ')}`,
      );
    }

    // Check existence
    if (!fs.existsSync(resolved)) {
      throw new Error(`${label} file not found: ${filePath}`);
    }

    // Check size before reading
    const stats = fs.statSync(resolved);
    if (stats.size > maxSize) {
      throw new Error(
        `${label} file too large: ${stats.size} bytes (max ${maxSize} bytes)`,
      );
    }

    const buffer = fs.readFileSync(resolved);
    const filename = path.basename(resolved);

    return { buffer, filename };
  }

  // ============================================================================
  // Security: Balance guard
  // ============================================================================

  /**
   * Check that the wallet has enough SOL to cover minting costs
   * (0.05 SOL initial buy + rent + transaction fees).
   *
   * @throws Error if balance is below MIN_MINT_LAMPORTS (0.07 SOL)
   */
  private async ensureSufficientBalance(): Promise<void> {
    const balance = await this.connection!.getBalance(this.wallet!.publicKey);
    const balanceBigInt = BigInt(balance);

    if (balanceBigInt < MIN_MINT_LAMPORTS) {
      const balanceSol = balance / LAMPORTS_PER_SOL;
      const requiredSol = Number(MIN_MINT_LAMPORTS) / LAMPORTS_PER_SOL;
      throw new Error(
        `Insufficient SOL balance: ${balanceSol.toFixed(4)} SOL. ` +
        `Minting requires at least ${requiredSol} SOL (0.05 initial buy + rent/fees).`,
      );
    }

    this.logger!.debug(
      `PumpTracks: balance check passed (${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL)`,
    );
  }

  // ============================================================================
  // Private helpers
  // ============================================================================

  private ensureReady(): void {
    if (this._state !== SkillState.Ready) {
      throw new SkillNotReadyError('pumptracks');
    }
  }
}
