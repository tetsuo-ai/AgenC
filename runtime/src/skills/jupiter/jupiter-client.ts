/**
 * Low-level HTTP client for Jupiter V6 API.
 *
 * Handles request serialization, response parsing, and error handling
 * for the Jupiter Quote, Swap, and Price APIs.
 *
 * @module
 */

import type { Logger } from '../../utils/logger.js';
import type { SwapQuoteParams, SwapQuote, TokenPrice } from './types.js';
import { JUPITER_PRICE_API_URL } from './constants.js';

/**
 * Configuration for JupiterClient.
 */
export interface JupiterClientConfig {
  /** Jupiter V6 API base URL */
  apiBaseUrl: string;
  /** Request timeout in milliseconds */
  timeoutMs: number;
  /** Logger */
  logger: Logger;
}

/**
 * Error thrown when a Jupiter API request fails.
 */
export class JupiterApiError extends Error {
  /** HTTP status code, if available */
  public readonly statusCode: number | undefined;
  /** The API endpoint that failed */
  public readonly endpoint: string;

  constructor(message: string, endpoint: string, statusCode?: number) {
    super(message);
    this.name = 'JupiterApiError';
    this.endpoint = endpoint;
    this.statusCode = statusCode;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, JupiterApiError);
    }
  }
}

/**
 * Low-level HTTP client for Jupiter V6 API.
 *
 * @example
 * ```typescript
 * const client = new JupiterClient({
 *   apiBaseUrl: 'https://quote-api.jup.ag/v6',
 *   timeoutMs: 30000,
 *   logger,
 * });
 *
 * const quote = await client.getQuote({
 *   inputMint: WSOL_MINT,
 *   outputMint: USDC_MINT,
 *   amount: 1_000_000_000n,
 * });
 * ```
 */
export class JupiterClient {
  private readonly apiBaseUrl: string;
  private readonly timeoutMs: number;
  private readonly logger: Logger;

  constructor(config: JupiterClientConfig) {
    this.apiBaseUrl = config.apiBaseUrl;
    this.timeoutMs = config.timeoutMs;
    this.logger = config.logger;
  }

  /**
   * Fetch a swap quote from Jupiter V6.
   *
   * @param params - Quote request parameters
   * @returns The swap quote
   * @throws JupiterApiError on request failure
   */
  async getQuote(params: SwapQuoteParams): Promise<SwapQuote> {
    const url = new URL('/quote', this.apiBaseUrl);
    url.searchParams.set('inputMint', params.inputMint);
    url.searchParams.set('outputMint', params.outputMint);
    url.searchParams.set('amount', params.amount.toString());

    if (params.slippageBps !== undefined) {
      url.searchParams.set('slippageBps', params.slippageBps.toString());
    }
    if (params.onlyDirectRoutes) {
      url.searchParams.set('onlyDirectRoutes', 'true');
    }

    this.logger.debug(`Jupiter quote request: ${url.toString()}`);

    const response = await this.fetchWithTimeout(url.toString(), {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => 'unknown');
      throw new JupiterApiError(
        `Quote request failed (${response.status}): ${body}`,
        '/quote',
        response.status,
      );
    }

    const data = await response.json() as Record<string, unknown>;

    return {
      inputMint: String(data.inputMint),
      outputMint: String(data.outputMint),
      inAmount: BigInt(data.inAmount as string),
      outAmount: BigInt(data.outAmount as string),
      otherAmountThreshold: BigInt(data.otherAmountThreshold as string),
      priceImpactPct: Number(data.priceImpactPct),
      rawQuote: data,
    };
  }

  /**
   * Get a serialized swap transaction from Jupiter.
   *
   * @param quoteResponse - The raw quote response from getQuote
   * @param userPublicKey - The user's wallet public key (base58)
   * @param wrapUnwrapSol - Whether to wrap/unwrap SOL automatically (default true)
   * @returns Serialized transaction as Uint8Array
   * @throws JupiterApiError on request failure
   */
  async getSwapTransaction(
    quoteResponse: Record<string, unknown>,
    userPublicKey: string,
    wrapUnwrapSol = true,
  ): Promise<Uint8Array> {
    const url = new URL('/swap', this.apiBaseUrl);

    this.logger.debug('Jupiter swap transaction request');

    const response = await this.fetchWithTimeout(url.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        quoteResponse,
        userPublicKey,
        wrapAndUnwrapSol: wrapUnwrapSol,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => 'unknown');
      throw new JupiterApiError(
        `Swap transaction request failed (${response.status}): ${body}`,
        '/swap',
        response.status,
      );
    }

    const data = await response.json() as Record<string, unknown>;
    const swapTransaction = data.swapTransaction as string | undefined;

    if (!swapTransaction) {
      throw new JupiterApiError(
        'Swap response missing swapTransaction field',
        '/swap',
      );
    }

    return Buffer.from(swapTransaction, 'base64');
  }

  /**
   * Fetch token prices from Jupiter Price API.
   *
   * @param mints - Array of token mint addresses (base58)
   * @returns Map of mint address to price info
   * @throws JupiterApiError on request failure
   */
  async getPrice(mints: string[]): Promise<Map<string, TokenPrice>> {
    if (mints.length === 0) {
      return new Map();
    }

    const url = new URL('/price', JUPITER_PRICE_API_URL);
    url.searchParams.set('ids', mints.join(','));

    this.logger.debug(`Jupiter price request for ${mints.length} token(s)`);

    const response = await this.fetchWithTimeout(url.toString(), {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => 'unknown');
      throw new JupiterApiError(
        `Price request failed (${response.status}): ${body}`,
        '/price',
        response.status,
      );
    }

    const data = await response.json() as Record<string, unknown>;
    const priceData = data.data as Record<string, Record<string, unknown>> | undefined;
    const result = new Map<string, TokenPrice>();

    if (priceData) {
      for (const [mint, info] of Object.entries(priceData)) {
        if (info && typeof info.price === 'number') {
          result.set(mint, { mint, priceUsd: info.price });
        }
      }
    }

    return result;
  }

  /**
   * Execute fetch with timeout using AbortController.
   */
  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new JupiterApiError(
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
