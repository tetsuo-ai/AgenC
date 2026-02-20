/**
 * PumpTracks skill type definitions.
 *
 * @module
 */

/**
 * Configuration for PumpTracksSkill.
 */
export interface PumpTracksSkillConfig {
  /** PumpTracks API base URL (default: https://pumptracks.fun/api/v1) */
  apiBaseUrl?: string;
  /** API key for authentication (pt_live_xxxxx) */
  apiKey: string;
  /** Request timeout in milliseconds (default: 60000) */
  timeoutMs?: number;
}

/**
 * Parameters for listing tracks.
 */
export interface ListTracksParams {
  /** Max results, 1-100 (default: 50) */
  limit?: number;
  /** Skip N results (default: 0) */
  offset?: number;
  /** Filter by genre */
  genre?: string;
  /** Filter by artist wallet */
  artist?: string;
  /** Sort field: "createdAt" or "playCount" */
  sort?: 'createdAt' | 'playCount';
  /** Sort order */
  order?: 'asc' | 'desc';
}

/**
 * Parameters for searching tracks.
 */
export interface SearchTracksParams {
  /** Search query (searches title, artist, symbol) */
  q: string;
  /** Max results (default: 20) */
  limit?: number;
}

/**
 * Parameters for minting a new music token.
 */
export interface MintTrackParams {
  /** Path to audio file or Buffer */
  audio: string | Buffer;
  /** Path to artwork file or Buffer */
  artwork: string | Buffer;
  /** Song title (max 32 chars) */
  title: string;
  /** Artist name (max 32 chars) */
  artist: string;
  /** Genre (max 20 chars) */
  genre: string;
  /** Optional audio filename (used when audio is a Buffer) */
  audioFilename?: string;
  /** Optional artwork filename (used when artwork is a Buffer) */
  artworkFilename?: string;
  /** Optional X/Twitter URL */
  twitter?: string;
  /** Optional TikTok URL */
  tiktok?: string;
  /** Optional Instagram URL */
  instagram?: string;
}

/**
 * Track data returned from the API.
 */
export interface Track {
  /** Token mint address */
  mint: string;
  /** Song title */
  title: string;
  /** Artist name */
  artist: string;
  /** Genre */
  genre: string;
  /** Token symbol */
  symbol: string;
  /** Artwork URL */
  artUri?: string;
  /** Audio stream URL */
  trackUri?: string;
  /** IPFS metadata URI */
  metadataUri?: string;
  /** Creator wallet */
  mintedBy: string;
  /** Play count */
  playCount?: number;
  /** Creation timestamp */
  createdAt: string;
  /** PumpTracks play page URL */
  playUrl?: string;
  /** Trading links */
  links?: {
    solscan?: string;
    jupiter?: string;
    raydium?: string;
  };
}

/**
 * Artist profile data.
 */
export interface Artist {
  /** Wallet address */
  wallet: string;
  /** Display name */
  name?: string;
  /** Number of tracks */
  trackCount: number;
  /** Total plays across all tracks */
  totalPlays: number;
  /** Artist's tracks */
  tracks: Track[];
}

/**
 * Result of a successful mint operation.
 */
export interface MintResult {
  /** Token mint address */
  mint: string;
  /** Confirmed Solana transaction signatures */
  txIds: string[];
  /** PumpTracks play page URL */
  playUrl: string;
}

/**
 * Intermediate result from the prepare (mint) step.
 */
export interface PrepareResult {
  /** Base64-encoded unsigned VersionedTransaction(s) */
  transactions: string[];
  /** Token mint address */
  mint: string;
  /** Track info to pass back in submit step */
  trackInfo: {
    title: string;
    artist: string;
    genre: string;
    symbol: string;
    metadataUri: string;
    artUri: string;
    trackUri: string;
    wallet: string;
    twitter?: string;
    tiktok?: string;
    instagram?: string;
  };
}

/**
 * API response wrapper.
 */
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}
