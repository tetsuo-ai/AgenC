/**
 * PumpTracks skill constants.
 *
 * @module
 */

/** Default PumpTracks API base URL */
export const PUMPTRACKS_API_BASE_URL = 'https://pumptracks.fun/api/v1';

/** Default request timeout (60s — minting involves file uploads + IPFS) */
export const DEFAULT_TIMEOUT_MS = 60_000;

/** Supported audio file extensions */
export const ALLOWED_AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.flac', '.m4a']);

/** Supported image file extensions */
export const ALLOWED_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

/** Max audio file size (50MB) */
export const MAX_AUDIO_SIZE = 50 * 1024 * 1024;

/** Max artwork file size (10MB) */
export const MAX_ARTWORK_SIZE = 10 * 1024 * 1024;

/** Minimum SOL required for minting (0.05 SOL initial buy + rent + fees) */
export const MIN_MINT_LAMPORTS = 70_000_000n; // 0.07 SOL

/**
 * Allowlist of Solana program IDs permitted in PumpTracks mint transactions.
 *
 * Any transaction returned by the PumpTracks API is validated against this
 * list before signing. If a transaction contains an instruction targeting
 * a program NOT in this set, signing is refused.
 */
export const ALLOWED_PROGRAM_IDS: ReadonlySet<string> = new Set([
  // Solana system programs
  '11111111111111111111111111111111',                         // System Program
  'ComputeBudget111111111111111111111111111111',              // Compute Budget
  'SysvarRent111111111111111111111111111111111',              // Sysvar Rent

  // SPL Token programs
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',           // Token Program
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',           // Token-2022
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',          // Associated Token Program

  // Raydium LaunchLab (mainnet)
  'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj',          // LaunchLab Program

  // Metaplex
  'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',           // Token Metadata Program
]);

/**
 * Sensitive file path patterns that must never be read.
 * Checked against the resolved absolute path of any file input.
 */
export const BLOCKED_PATH_PATTERNS: readonly RegExp[] = [
  /\.env/i,
  /\.pem$/i,
  /id_rsa/i,
  /id_ed25519/i,
  /\.key$/i,
  /secret/i,
  /credential/i,
  /keypair\.json$/i,
  /wallet\.json$/i,
  /\.ssh\//i,
  /\.gnupg\//i,
  /\.aws\//i,
  /\.kube\//i,
];
