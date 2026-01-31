/**
 * Jupiter API constants and well-known token mints.
 *
 * @module
 */

import type { TokenMint } from './types.js';

/** Jupiter V6 Quote API base URL */
export const JUPITER_API_BASE_URL = 'https://quote-api.jup.ag/v6';

/** Jupiter Price API base URL */
export const JUPITER_PRICE_API_URL = 'https://price.jup.ag/v6';

/** Wrapped SOL mint address */
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/** USDC mint (Solana mainnet) */
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/** USDT mint (Solana mainnet) */
export const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

/** Well-known token registry mapping mint address to symbol and decimals */
export const WELL_KNOWN_TOKENS: ReadonlyMap<string, TokenMint> = new Map<string, TokenMint>([
  [WSOL_MINT, { address: WSOL_MINT, symbol: 'SOL', decimals: 9 }],
  [USDC_MINT, { address: USDC_MINT, symbol: 'USDC', decimals: 6 }],
  [USDT_MINT, { address: USDT_MINT, symbol: 'USDT', decimals: 6 }],
]);
