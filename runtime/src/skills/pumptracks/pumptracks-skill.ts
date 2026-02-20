/**
 * PumpTracks music token skill implementation.
 *
 * Provides track browsing, searching, artist lookup, and full
 * music token minting via the PumpTracks API + Raydium LaunchLab.
 *
 * @module
 */

import { VersionedTransaction } from '@solana/web3.js';
import type { Skill, SkillMetadata, SkillAction, SkillContext, SemanticVersion } from '../types.js';
import { SkillState } from '../types.js';
import { SkillNotReadyError } from '../errors.js';
import { PumpTracksClient } from './pumptracks-client.js';
import { PUMPTRACKS_API_BASE_URL, DEFAULT_TIMEOUT_MS } from './constants.js';
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
        description: 'Mint a new music token on PumpTracks. Uploads audio + artwork, builds the Raydium LaunchLab transaction, signs it, and submits. The wallet used by this agent becomes the on-chain creator. Requires ~0.07 SOL.',
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
   * Full end-to-end mint flow:
   * 1. Upload audio + artwork to PumpTracks (which handles Firebase + IPFS)
   * 2. Receive unsigned Raydium LaunchLab transaction
   * 3. Sign with the agent's wallet
   * 4. Submit signed transaction back to PumpTracks
   * 5. PumpTracks verifies on-chain and registers the track
   *
   * @returns Mint address, tx IDs, and play URL
   */
  async mintTrack(params: MintTrackParams): Promise<MintResult> {
    this.ensureReady();

    const walletAddress = this.wallet!.publicKey.toBase58();
    this.logger!.info(`PumpTracks: minting "${params.title}" by ${params.artist}...`);

    // ── Step 1: Build form data ──
    const formData = new FormData();

    // Handle audio — file path or Buffer
    if (typeof params.audio === 'string') {
      const audioBuffer = fs.readFileSync(params.audio);
      const audioFilename = path.basename(params.audio);
      formData.append('audio', new Blob([audioBuffer]), audioFilename);
    } else {
      formData.append('audio', new Blob([params.audio]), params.audioFilename || 'track.mp3');
    }

    // Handle artwork — file path or Buffer
    if (typeof params.artwork === 'string') {
      const artBuffer = fs.readFileSync(params.artwork);
      const artFilename = path.basename(params.artwork);
      formData.append('artwork', new Blob([artBuffer]), artFilename);
    } else {
      formData.append('artwork', new Blob([params.artwork]), params.artworkFilename || 'cover.jpg');
    }

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

    // ── Step 3: Sign each transaction with agent wallet ──
    this.logger!.info('PumpTracks: signing transactions...');
    const signedTransactions: string[] = [];

    for (let i = 0; i < prepared.transactions.length; i++) {
      const txBytes = Buffer.from(prepared.transactions[i], 'base64');
      const tx = VersionedTransaction.deserialize(txBytes);
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
  // Private helpers
  // ============================================================================

  private ensureReady(): void {
    if (this._state !== SkillState.Ready) {
      throw new SkillNotReadyError('pumptracks');
    }
  }
}
