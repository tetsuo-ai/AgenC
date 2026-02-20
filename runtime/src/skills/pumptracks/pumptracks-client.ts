/**
 * Low-level HTTP client for PumpTracks API v1.
 *
 * Handles authentication, request serialization, and error handling
 * for all PumpTracks endpoints (tracks, artists, minting).
 *
 * @module
 */

import type { Logger } from '../../utils/logger.js';
import type {
  ListTracksParams,
  SearchTracksParams,
  Track,
  Artist,
  PrepareResult,
  MintResult,
  ApiResponse,
} from './types.js';
import { PUMPTRACKS_API_BASE_URL } from './constants.js';

/**
 * Configuration for PumpTracksClient.
 */
export interface PumpTracksClientConfig {
  /** PumpTracks API base URL */
  apiBaseUrl: string;
  /** API key for authentication */
  apiKey: string;
  /** Request timeout in milliseconds */
  timeoutMs: number;
  /** Logger */
  logger: Logger;
}

/**
 * Error thrown when a PumpTracks API request fails.
 */
export class PumpTracksApiError extends Error {
  public readonly statusCode: number | undefined;
  public readonly endpoint: string;

  constructor(message: string, endpoint: string, statusCode?: number) {
    super(message);
    this.name = 'PumpTracksApiError';
    this.endpoint = endpoint;
    this.statusCode = statusCode;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, PumpTracksApiError);
    }
  }
}

/**
 * Low-level HTTP client for PumpTracks API v1.
 *
 * @example
 * ```typescript
 * const client = new PumpTracksClient({
 *   apiBaseUrl: 'https://pumptracks.fun/api/v1',
 *   apiKey: 'pt_live_xxxxx',
 *   timeoutMs: 60000,
 *   logger,
 * });
 *
 * const tracks = await client.listTracks({ genre: 'Electronic', limit: 10 });
 * ```
 */
export class PumpTracksClient {
  private readonly apiBaseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly logger: Logger;

  constructor(config: PumpTracksClientConfig) {
    this.apiBaseUrl = config.apiBaseUrl;
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs;
    this.logger = config.logger;
  }

  /**
   * List tracks with optional filters.
   */
  async listTracks(params?: ListTracksParams): Promise<Track[]> {
    const url = new URL('/tracks', this.apiBaseUrl);
    if (params?.limit) url.searchParams.set('limit', params.limit.toString());
    if (params?.offset) url.searchParams.set('offset', params.offset.toString());
    if (params?.genre) url.searchParams.set('genre', params.genre);
    if (params?.artist) url.searchParams.set('artist', params.artist);
    if (params?.sort) url.searchParams.set('sort', params.sort);
    if (params?.order) url.searchParams.set('order', params.order);

    const data = await this.get<{ tracks: Track[] }>(url.toString(), '/tracks');
    return data.tracks;
  }

  /**
   * Get a single track by mint address.
   */
  async getTrack(mint: string): Promise<Track> {
    const url = `${this.apiBaseUrl}/tracks/${mint}`;
    return this.get<Track>(url, `/tracks/${mint}`);
  }

  /**
   * Search tracks by title, artist, or symbol.
   */
  async searchTracks(params: SearchTracksParams): Promise<Track[]> {
    const url = new URL('/tracks/search', this.apiBaseUrl);
    url.searchParams.set('q', params.q);
    if (params.limit) url.searchParams.set('limit', params.limit.toString());

    const data = await this.get<{ tracks: Track[] }>(url.toString(), '/tracks/search');
    return data.tracks;
  }

  /**
   * Get artist profile by wallet address.
   */
  async getArtist(wallet: string): Promise<Artist> {
    const url = `${this.apiBaseUrl}/artists/${wallet}`;
    return this.get<Artist>(url, `/artists/${wallet}`);
  }

  /**
   * Prepare a mint: upload files, build unsigned transaction.
   *
   * @param formData - FormData with audio, artwork, title, artist, genre, wallet
   * @returns Unsigned transactions + mint address + track info
   */
  async prepareMint(formData: FormData): Promise<PrepareResult> {
    this.logger.debug('PumpTracks: preparing mint...');

    const response = await this.fetchWithTimeout(`${this.apiBaseUrl}/tracks/mint`, {
      method: 'POST',
      headers: { 'X-API-Key': this.apiKey },
      body: formData,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => 'unknown');
      throw new PumpTracksApiError(
        `Prepare mint failed (${response.status}): ${body}`,
        '/tracks/mint',
        response.status,
      );
    }

    const result = await response.json() as ApiResponse<PrepareResult>;
    if (!result.success || !result.data) {
      throw new PumpTracksApiError(
        result.error || 'Prepare mint returned no data',
        '/tracks/mint',
      );
    }

    return result.data;
  }

  /**
   * Submit signed transactions to finalize the mint.
   *
   * @param transactions - Base64-encoded signed VersionedTransaction(s)
   * @param mint - Token mint address
   * @param trackInfo - Track info from prepare step
   * @returns Confirmed tx IDs + play URL
   */
  async submitMint(
    transactions: string[],
    mint: string,
    trackInfo: PrepareResult['trackInfo'],
  ): Promise<MintResult> {
    this.logger.debug('PumpTracks: submitting signed transactions...');

    const response = await this.fetchWithTimeout(`${this.apiBaseUrl}/tracks/submit`, {
      method: 'POST',
      headers: {
        'X-API-Key': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ transactions, mint, trackInfo }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => 'unknown');
      throw new PumpTracksApiError(
        `Submit mint failed (${response.status}): ${body}`,
        '/tracks/submit',
        response.status,
      );
    }

    const result = await response.json() as ApiResponse<MintResult>;
    if (!result.success || !result.data) {
      throw new PumpTracksApiError(
        result.error || 'Submit mint returned no data',
        '/tracks/submit',
      );
    }

    return result.data;
  }

  // ─── Private helpers ──────────────────────────────────

  private async get<T>(url: string, endpoint: string): Promise<T> {
    const response = await this.fetchWithTimeout(url, {
      method: 'GET',
      headers: {
        'X-API-Key': this.apiKey,
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => 'unknown');
      throw new PumpTracksApiError(
        `Request failed (${response.status}): ${body}`,
        endpoint,
        response.status,
      );
    }

    const result = await response.json() as ApiResponse<T>;
    if (!result.success || !result.data) {
      throw new PumpTracksApiError(
        result.error || 'Request returned no data',
        endpoint,
      );
    }

    return result.data;
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new PumpTracksApiError(
          `Request timed out after ${this.timeoutMs}ms`,
          url,
        );
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
