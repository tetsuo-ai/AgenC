/**
 * PumpTracks skill module for @agenc/runtime
 *
 * Launch, browse, and search music tokens on Solana via PumpTracks.
 *
 * @module
 */

export { PumpTracksSkill } from './pumptracks-skill.js';
export { PumpTracksClient, PumpTracksApiError } from './pumptracks-client.js';
export type { PumpTracksClientConfig } from './pumptracks-client.js';

export type {
  PumpTracksSkillConfig,
  ListTracksParams,
  SearchTracksParams,
  MintTrackParams,
  Track,
  Artist,
  MintResult,
  PrepareResult,
  ApiResponse,
} from './types.js';

export {
  PUMPTRACKS_API_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  ALLOWED_AUDIO_EXTENSIONS,
  ALLOWED_IMAGE_EXTENSIONS,
  MAX_AUDIO_SIZE,
  MAX_ARTWORK_SIZE,
  MIN_MINT_LAMPORTS,
  ALLOWED_PROGRAM_IDS,
  BLOCKED_PATH_PATTERNS,
} from './constants.js';
