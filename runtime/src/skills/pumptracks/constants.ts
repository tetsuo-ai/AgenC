/**
 * PumpTracks skill constants.
 *
 * @module
 */

/** Default PumpTracks API base URL */
export const PUMPTRACKS_API_BASE_URL = 'https://pumptracks.fun/api/v1';

/** Default request timeout (60s — minting involves file uploads + IPFS) */
export const DEFAULT_TIMEOUT_MS = 60_000;

/** Supported audio formats */
export const SUPPORTED_AUDIO_TYPES = ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/flac', 'audio/mp4'];

/** Supported image formats */
export const SUPPORTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

/** Max audio file size (50MB) */
export const MAX_AUDIO_SIZE = 50 * 1024 * 1024;

/** Max artwork file size (10MB) */
export const MAX_ARTWORK_SIZE = 10 * 1024 * 1024;

/** Minimum SOL required for minting (0.05 SOL initial buy + fees) */
export const MIN_MINT_SOL = 0.07;
