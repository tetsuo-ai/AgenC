/**
 * Error Code Decoder Tool
 *
 * Decodes AgenC Anchor error codes (6000-6077) into human-readable
 * names, messages, and categories. Sourced from errors.rs.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

/** Error entry with full metadata */
interface ErrorEntry {
  code: number;
  name: string;
  message: string;
  category: string;
  rustVariant: string;
}

/** Complete error code table (78 codes: 6000-6077) */
const ERROR_TABLE: ErrorEntry[] = [
  // Agent errors (6000-6008)
  { code: 6000, name: 'AgentAlreadyRegistered', message: 'Agent is already registered', category: 'Agent', rustVariant: 'AgentAlreadyRegistered' },
  { code: 6001, name: 'AgentNotFound', message: 'Agent not found', category: 'Agent', rustVariant: 'AgentNotFound' },
  { code: 6002, name: 'AgentNotActive', message: 'Agent is not active', category: 'Agent', rustVariant: 'AgentNotActive' },
  { code: 6003, name: 'InsufficientCapabilities', message: 'Agent has insufficient capabilities', category: 'Agent', rustVariant: 'InsufficientCapabilities' },
  { code: 6004, name: 'MaxActiveTasksReached', message: 'Agent has reached maximum active tasks', category: 'Agent', rustVariant: 'MaxActiveTasksReached' },
  { code: 6005, name: 'AgentHasActiveTasks', message: 'Agent has active tasks and cannot be deregistered', category: 'Agent', rustVariant: 'AgentHasActiveTasks' },
  { code: 6006, name: 'UnauthorizedAgent', message: 'Only the agent authority can perform this action', category: 'Agent', rustVariant: 'UnauthorizedAgent' },
  { code: 6007, name: 'AgentRegistrationRequired', message: 'Agent registration required to create tasks', category: 'Agent', rustVariant: 'AgentRegistrationRequired' },
  { code: 6008, name: 'AgentSuspended', message: 'Agent is suspended and cannot change status', category: 'Agent', rustVariant: 'AgentSuspended' },

  // Task errors (6009-6024)
  { code: 6009, name: 'TaskNotFound', message: 'Task not found', category: 'Task', rustVariant: 'TaskNotFound' },
  { code: 6010, name: 'TaskNotOpen', message: 'Task is not open for claims', category: 'Task', rustVariant: 'TaskNotOpen' },
  { code: 6011, name: 'TaskFullyClaimed', message: 'Task has reached maximum workers', category: 'Task', rustVariant: 'TaskFullyClaimed' },
  { code: 6012, name: 'TaskExpired', message: 'Task has expired', category: 'Task', rustVariant: 'TaskExpired' },
  { code: 6013, name: 'TaskNotExpired', message: 'Task deadline has not passed', category: 'Task', rustVariant: 'TaskNotExpired' },
  { code: 6014, name: 'DeadlinePassed', message: 'Task deadline has passed', category: 'Task', rustVariant: 'DeadlinePassed' },
  { code: 6015, name: 'TaskNotInProgress', message: 'Task is not in progress', category: 'Task', rustVariant: 'TaskNotInProgress' },
  { code: 6016, name: 'TaskAlreadyCompleted', message: 'Task is already completed', category: 'Task', rustVariant: 'TaskAlreadyCompleted' },
  { code: 6017, name: 'TaskCannotBeCancelled', message: 'Task cannot be cancelled', category: 'Task', rustVariant: 'TaskCannotBeCancelled' },
  { code: 6018, name: 'UnauthorizedTaskAction', message: 'Only the task creator can perform this action', category: 'Task', rustVariant: 'UnauthorizedTaskAction' },
  { code: 6019, name: 'InvalidCreator', message: 'Invalid creator', category: 'Task', rustVariant: 'InvalidCreator' },
  { code: 6020, name: 'InvalidTaskType', message: 'Invalid task type', category: 'Task', rustVariant: 'InvalidTaskType' },
  { code: 6021, name: 'CompetitiveTaskAlreadyWon', message: 'Competitive task already completed by another worker', category: 'Task', rustVariant: 'CompetitiveTaskAlreadyWon' },
  { code: 6022, name: 'NoWorkers', message: 'Task has no workers', category: 'Task', rustVariant: 'NoWorkers' },
  { code: 6023, name: 'ConstraintHashMismatch', message: "Proof constraint hash does not match task's stored constraint hash", category: 'Task', rustVariant: 'ConstraintHashMismatch' },
  { code: 6024, name: 'NotPrivateTask', message: 'Task is not a private task (no constraint hash set)', category: 'Task', rustVariant: 'NotPrivateTask' },

  // Claim errors (6025-6033)
  { code: 6025, name: 'AlreadyClaimed', message: 'Worker has already claimed this task', category: 'Claim', rustVariant: 'AlreadyClaimed' },
  { code: 6026, name: 'NotClaimed', message: 'Worker has not claimed this task', category: 'Claim', rustVariant: 'NotClaimed' },
  { code: 6027, name: 'ClaimAlreadyCompleted', message: 'Claim has already been completed', category: 'Claim', rustVariant: 'ClaimAlreadyCompleted' },
  { code: 6028, name: 'ClaimNotExpired', message: 'Claim has not expired yet', category: 'Claim', rustVariant: 'ClaimNotExpired' },
  { code: 6029, name: 'InvalidProof', message: 'Invalid proof of work', category: 'Claim', rustVariant: 'InvalidProof' },
  { code: 6030, name: 'ZkVerificationFailed', message: 'ZK proof verification failed', category: 'Claim', rustVariant: 'ZkVerificationFailed' },
  { code: 6031, name: 'InvalidProofSize', message: 'Invalid proof size - expected 256 bytes for RISC Zero seal body', category: 'Claim', rustVariant: 'InvalidProofSize' },
  { code: 6032, name: 'InvalidProofBinding', message: 'Invalid proof binding: expected_binding cannot be all zeros', category: 'Claim', rustVariant: 'InvalidProofBinding' },
  { code: 6033, name: 'InvalidOutputCommitment', message: 'Invalid output commitment: output_commitment cannot be all zeros', category: 'Claim', rustVariant: 'InvalidOutputCommitment' },

  // Dispute errors (6034-6048)
  { code: 6034, name: 'DisputeNotActive', message: 'Dispute is not active', category: 'Dispute', rustVariant: 'DisputeNotActive' },
  { code: 6035, name: 'VotingEnded', message: 'Voting period has ended', category: 'Dispute', rustVariant: 'VotingEnded' },
  { code: 6036, name: 'VotingNotEnded', message: 'Voting period has not ended', category: 'Dispute', rustVariant: 'VotingNotEnded' },
  { code: 6037, name: 'AlreadyVoted', message: 'Already voted on this dispute', category: 'Dispute', rustVariant: 'AlreadyVoted' },
  { code: 6038, name: 'NotArbiter', message: 'Not authorized to vote (not an arbiter)', category: 'Dispute', rustVariant: 'NotArbiter' },
  { code: 6039, name: 'InsufficientVotes', message: 'Insufficient votes to resolve', category: 'Dispute', rustVariant: 'InsufficientVotes' },
  { code: 6040, name: 'DisputeAlreadyResolved', message: 'Dispute has already been resolved', category: 'Dispute', rustVariant: 'DisputeAlreadyResolved' },
  { code: 6041, name: 'UnauthorizedResolver', message: 'Only protocol authority or dispute initiator can resolve disputes', category: 'Dispute', rustVariant: 'UnauthorizedResolver' },
  { code: 6042, name: 'ActiveDisputeVotes', message: 'Agent has active dispute votes pending resolution', category: 'Dispute', rustVariant: 'ActiveDisputeVotes' },
  { code: 6043, name: 'RecentVoteActivity', message: 'Agent must wait 24 hours after voting before deregistering', category: 'Dispute', rustVariant: 'RecentVoteActivity' },
  { code: 6044, name: 'AuthorityAlreadyVoted', message: 'Authority has already voted on this dispute', category: 'Dispute', rustVariant: 'AuthorityAlreadyVoted' },
  { code: 6045, name: 'InsufficientEvidence', message: 'Insufficient dispute evidence provided', category: 'Dispute', rustVariant: 'InsufficientEvidence' },
  { code: 6046, name: 'EvidenceTooLong', message: 'Dispute evidence exceeds maximum allowed length', category: 'Dispute', rustVariant: 'EvidenceTooLong' },
  { code: 6047, name: 'DisputeNotExpired', message: 'Dispute has not expired', category: 'Dispute', rustVariant: 'DisputeNotExpired' },
  { code: 6048, name: 'SlashAlreadyApplied', message: 'Dispute slashing already applied', category: 'Dispute', rustVariant: 'SlashAlreadyApplied' },
  { code: 6049, name: 'DisputeNotResolved', message: 'Dispute has not been resolved', category: 'Dispute', rustVariant: 'DisputeNotResolved' },

  // State errors (6050-6052)
  { code: 6050, name: 'VersionMismatch', message: 'State version mismatch (concurrent modification)', category: 'State', rustVariant: 'VersionMismatch' },
  { code: 6051, name: 'StateKeyExists', message: 'State key already exists', category: 'State', rustVariant: 'StateKeyExists' },
  { code: 6052, name: 'StateNotFound', message: 'State not found', category: 'State', rustVariant: 'StateNotFound' },

  // Protocol errors (6053-6063)
  { code: 6053, name: 'ProtocolAlreadyInitialized', message: 'Protocol is already initialized', category: 'Protocol', rustVariant: 'ProtocolAlreadyInitialized' },
  { code: 6054, name: 'ProtocolNotInitialized', message: 'Protocol is not initialized', category: 'Protocol', rustVariant: 'ProtocolNotInitialized' },
  { code: 6055, name: 'InvalidProtocolFee', message: 'Invalid protocol fee (must be <= 1000 bps)', category: 'Protocol', rustVariant: 'InvalidProtocolFee' },
  { code: 6056, name: 'InvalidDisputeThreshold', message: 'Invalid dispute threshold', category: 'Protocol', rustVariant: 'InvalidDisputeThreshold' },
  { code: 6057, name: 'InsufficientStake', message: 'Insufficient stake for arbiter registration', category: 'Protocol', rustVariant: 'InsufficientStake' },
  { code: 6058, name: 'MultisigInvalidThreshold', message: 'Invalid multisig threshold', category: 'Protocol', rustVariant: 'MultisigInvalidThreshold' },
  { code: 6059, name: 'MultisigInvalidSigners', message: 'Invalid multisig signer configuration', category: 'Protocol', rustVariant: 'MultisigInvalidSigners' },
  { code: 6060, name: 'MultisigNotEnoughSigners', message: 'Not enough multisig signers', category: 'Protocol', rustVariant: 'MultisigNotEnoughSigners' },
  { code: 6061, name: 'MultisigDuplicateSigner', message: 'Duplicate multisig signer provided', category: 'Protocol', rustVariant: 'MultisigDuplicateSigner' },
  { code: 6062, name: 'MultisigDefaultSigner', message: 'Multisig signer cannot be default pubkey', category: 'Protocol', rustVariant: 'MultisigDefaultSigner' },
  { code: 6063, name: 'MultisigSignerNotSystemOwned', message: 'Multisig signer account not owned by System Program', category: 'Protocol', rustVariant: 'MultisigSignerNotSystemOwned' },

  // General errors (6064-6070)
  { code: 6064, name: 'InvalidInput', message: 'Invalid input parameter', category: 'General', rustVariant: 'InvalidInput' },
  { code: 6065, name: 'ArithmeticOverflow', message: 'Arithmetic overflow', category: 'General', rustVariant: 'ArithmeticOverflow' },
  { code: 6066, name: 'VoteOverflow', message: 'Vote count overflow', category: 'General', rustVariant: 'VoteOverflow' },
  { code: 6067, name: 'InsufficientFunds', message: 'Insufficient funds', category: 'General', rustVariant: 'InsufficientFunds' },
  { code: 6068, name: 'CorruptedData', message: 'Account data is corrupted', category: 'General', rustVariant: 'CorruptedData' },
  { code: 6069, name: 'StringTooLong', message: 'String too long', category: 'General', rustVariant: 'StringTooLong' },
  { code: 6070, name: 'InvalidAccountOwner', message: 'Account owner validation failed: account not owned by this program', category: 'General', rustVariant: 'InvalidAccountOwner' },

  // Rate limiting errors (6071-6073)
  { code: 6071, name: 'RateLimitExceeded', message: 'Rate limit exceeded: maximum actions per 24h window reached', category: 'Rate Limiting', rustVariant: 'RateLimitExceeded' },
  { code: 6072, name: 'CooldownNotElapsed', message: 'Cooldown period has not elapsed since last action', category: 'Rate Limiting', rustVariant: 'CooldownNotElapsed' },
  { code: 6073, name: 'InsufficientStakeForDispute', message: 'Insufficient stake to initiate dispute', category: 'Rate Limiting', rustVariant: 'InsufficientStakeForDispute' },

  // Version/upgrade errors (6074-6079)
  { code: 6074, name: 'VersionMismatchProtocol', message: 'Protocol version mismatch: account version incompatible with current program', category: 'Version/Upgrade', rustVariant: 'VersionMismatchProtocol' },
  { code: 6075, name: 'AccountVersionTooOld', message: 'Account version too old: migration required', category: 'Version/Upgrade', rustVariant: 'AccountVersionTooOld' },
  { code: 6076, name: 'AccountVersionTooNew', message: 'Account version too new: program upgrade required', category: 'Version/Upgrade', rustVariant: 'AccountVersionTooNew' },
  { code: 6077, name: 'InvalidMigrationSource', message: 'Migration not allowed: invalid source version', category: 'Version/Upgrade', rustVariant: 'InvalidMigrationSource' },
  { code: 6078, name: 'InvalidMigrationTarget', message: 'Migration not allowed: invalid target version', category: 'Version/Upgrade', rustVariant: 'InvalidMigrationTarget' },
  { code: 6079, name: 'UnauthorizedUpgrade', message: 'Only upgrade authority can perform this action', category: 'Version/Upgrade', rustVariant: 'UnauthorizedUpgrade' },
];

/** Lookup map by code */
const errorByCode = new Map<number, ErrorEntry>(
  ERROR_TABLE.map(e => [e.code, e])
);

/** Lookup map by name (case-insensitive) */
const errorByName = new Map<string, ErrorEntry>(
  ERROR_TABLE.map(e => [e.name.toLowerCase(), e])
);

/**
 * Decode an error code or hex string to its entry.
 */
function decodeError(input: string): ErrorEntry | null {
  // Try numeric code
  let code: number;
  if (input.startsWith('0x')) {
    code = parseInt(input, 16);
  } else if (/^\d+$/.test(input)) {
    code = parseInt(input, 10);
  } else {
    // Try name lookup
    return errorByName.get(input.toLowerCase()) ?? null;
  }

  return errorByCode.get(code) ?? null;
}

/**
 * Format an error entry as a detailed string.
 */
function formatError(entry: ErrorEntry): string {
  return [
    `Error Code: ${entry.code} (0x${entry.code.toString(16)})`,
    `Name: ${entry.name}`,
    `Category: ${entry.category}`,
    `Message: ${entry.message}`,
    `Rust Variant: CoordinationError::${entry.rustVariant}`,
  ].join('\n');
}

/**
 * Get all error codes as a formatted reference.
 */
export function getAllErrorCodes(): string {
  const categories = new Map<string, ErrorEntry[]>();
  for (const entry of ERROR_TABLE) {
    const list = categories.get(entry.category) ?? [];
    list.push(entry);
    categories.set(entry.category, list);
  }

  const sections: string[] = [];
  for (const [category, entries] of categories) {
    const lines = entries.map(
      e => `  ${e.code} (0x${e.code.toString(16).padStart(4, '0')}) ${e.name}: ${e.message}`
    );
    sections.push(`## ${category} Errors\n${lines.join('\n')}`);
  }
  return sections.join('\n\n');
}

/**
 * Register error decoder tools on the MCP server.
 */
export function registerErrorTools(server: McpServer): void {
  server.tool(
    'agenc_decode_error',
    'Decode an AgenC Anchor error code (6000-6079) or name to its description, category, and Rust variant',
    {
      error_code: z.string().describe(
        'Error code (decimal like "6000", hex like "0x1770"), or error name (like "AgentNotFound")'
      ),
    },
    async ({ error_code }) => {
      const entry = decodeError(error_code);
      if (!entry) {
        return {
          content: [{
            type: 'text' as const,
            text: `Unknown error: "${error_code}". Valid range is 6000-6079, or use an error name like "AgentNotFound".`,
          }],
        };
      }
      return {
        content: [{
          type: 'text' as const,
          text: formatError(entry),
        }],
      };
    }
  );
}
