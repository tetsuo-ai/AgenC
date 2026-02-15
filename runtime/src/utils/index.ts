/**
 * Utility exports for @agenc/runtime
 * @module
 */

export { Logger, LogLevel, createLogger, silentLogger } from './logger.js';

export {
  generateAgentId,
  hexToBytes,
  bytesToHex,
  agentIdFromString,
  agentIdToString,
  agentIdToShortString,
  agentIdsEqual,
  lamportsToSol,
  solToLamports,
  bigintsToProofHash,
  proofHashToBigints,
  toAnchorBytes,
  toUint8Array,
} from './encoding.js';

export { PdaWithBump, derivePda, validateIdLength } from './pda.js';

export { encodeStatusByte, queryWithFallback } from './query.js';

export { fetchTreasury } from './treasury.js';

export { ensureLazyModule } from './lazy-import.js';

export { isRecord, isStringArray } from './type-guards.js';

export {
  isTokenTask,
  buildCompleteTaskTokenAccounts,
  buildResolveDisputeTokenAccounts,
  buildExpireDisputeTokenAccounts,
  buildApplyDisputeSlashTokenAccounts,
  buildCreateTaskTokenAccounts,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from './token.js';
