/**
 * Farcaster bridge adapter.
 *
 * Posts casts to Farcaster via the Neynar REST API using native `fetch()`.
 * No external SDK dependency required (Node >= 18).
 *
 * @module
 */

import type { Logger } from '../utils/logger.js';
import { silentLogger } from '../utils/logger.js';
import { ValidationError } from '../types/errors.js';
import type {
  FarcasterPostParams,
  FarcasterPostResult,
  FarcasterBridgeConfig,
} from './types.js';
import { BridgeError } from './errors.js';

const DEFAULT_API_BASE_URL = 'https://api.neynar.com/v2';
const DEFAULT_DELAY_BETWEEN_POSTS_MS = 1000;
const MAX_CAST_LENGTH = 320;

/**
 * Bridge that posts casts to Farcaster via the Neynar REST API.
 *
 * @example
 * ```typescript
 * const bridge = new FarcasterBridge({
 *   apiKey: process.env.NEYNAR_API_KEY!,
 *   signerUuid: process.env.NEYNAR_SIGNER_UUID!,
 * });
 * await bridge.postCast({ text: 'Hello from AgenC!' });
 * ```
 */
export class FarcasterBridge {
  private readonly apiKey: string;
  private readonly signerUuid: string;
  private readonly apiBaseUrl: string;
  private readonly delayBetweenPostsMs: number;
  private readonly logger: Logger;

  constructor(config: FarcasterBridgeConfig) {
    if (!config.apiKey) {
      throw new ValidationError('Farcaster bridge requires apiKey');
    }
    if (!config.signerUuid) {
      throw new ValidationError('Farcaster bridge requires signerUuid');
    }

    this.apiKey = config.apiKey;
    this.signerUuid = config.signerUuid;
    this.apiBaseUrl = config.apiBaseUrl ?? DEFAULT_API_BASE_URL;
    this.delayBetweenPostsMs = config.delayBetweenPostsMs ?? DEFAULT_DELAY_BETWEEN_POSTS_MS;
    this.logger = config.logger ?? silentLogger;
  }

  /**
   * Post a single cast to Farcaster.
   *
   * @throws {ValidationError} If text is empty or exceeds max length.
   * @throws {BridgeError} If the Neynar API returns an error.
   */
  async postCast(params: FarcasterPostParams): Promise<FarcasterPostResult> {
    if (!params.text || params.text.length === 0) {
      throw new ValidationError('Cast text cannot be empty');
    }
    if (params.text.length > MAX_CAST_LENGTH) {
      throw new ValidationError(
        `Cast text exceeds maximum length of ${MAX_CAST_LENGTH} characters`,
      );
    }

    const url = `${this.apiBaseUrl}/farcaster/cast`;

    const body: Record<string, unknown> = {
      signer_uuid: this.signerUuid,
      text: params.text,
    };
    if (params.channelId) {
      body.channel_id = params.channelId;
    }
    if (params.parentUrl) {
      body.parent = params.parentUrl;
    }

    this.logger.debug(`Posting cast to Farcaster (${params.text.length} chars)`);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          accept: 'application/json',
          'x-api-key': this.apiKey,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new BridgeError('farcaster', `API request failed: ${message}`);
    }

    if (!response.ok) {
      let errorDetail: string;
      try {
        const errorBody = (await response.json()) as Record<string, unknown>;
        errorDetail = (errorBody.message as string) ?? response.statusText;
      } catch {
        errorDetail = response.statusText;
      }
      throw new BridgeError(
        'farcaster',
        `API returned ${response.status}: ${errorDetail}`,
      );
    }

    const data = (await response.json()) as {
      cast?: { hash?: string };
    };

    this.logger.info(`Cast posted: ${data.cast?.hash ?? 'unknown'}`);

    return {
      success: true,
      castHash: data.cast?.hash,
    };
  }

  /**
   * Post multiple messages to Farcaster sequentially.
   *
   * Posts with a configurable delay between each cast to respect rate limits.
   * Continues on error — failed posts are logged but do not stop the batch.
   *
   * @returns The number of successfully posted casts.
   */
  async syncFeedToFarcaster(messages: ReadonlyArray<string>): Promise<number> {
    let successCount = 0;

    for (let i = 0; i < messages.length; i++) {
      try {
        await this.postCast({ text: messages[i] });
        successCount++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Failed to post message ${i + 1}/${messages.length}: ${message}`);
      }

      // Delay between posts (skip after last)
      if (i < messages.length - 1) {
        await delay(this.delayBetweenPostsMs);
      }
    }

    this.logger.info(
      `Sync complete: ${successCount}/${messages.length} casts posted`,
    );
    return successCount;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
