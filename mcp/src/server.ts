import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerAgentTools } from './tools/agents.js';
import { registerTaskTools } from './tools/tasks.js';
import { registerProtocolTools } from './tools/protocol.js';
import { registerDisputeTools } from './tools/disputes.js';
import { registerConnectionTools } from './tools/connection.js';
import { registerTestingTools } from './tools/testing.js';
import { registerCircuitTools } from './tools/circuits.js';
import { registerInspectorTools } from './tools/inspector.js';
import { registerReplayTools } from './tools/replay.js';

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'AgenC Protocol Tools',
    version: '0.1.0',
  });

  // Register all tool modules
  registerConnectionTools(server);
  registerAgentTools(server);
  registerTaskTools(server);
  registerProtocolTools(server);
  registerDisputeTools(server);
  registerTestingTools(server);
  registerCircuitTools(server);
  registerInspectorTools(server);
  registerReplayTools(server);

  // Register MCP resources
  registerResources(server);

  // Register MCP prompts
  registerPrompts(server);

  return server;
}

function registerResources(server: McpServer): void {
  server.resource(
    'errorCodes',
    'agenc://error-codes',
    { description: 'Full AgenC error code reference (6000-6077)' },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        text: ERROR_CODES_REFERENCE,
      }],
    }),
  );

  server.resource(
    'capabilities',
    'agenc://capabilities',
    { description: 'Agent capability bitmask reference' },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        text: CAPABILITIES_REFERENCE,
      }],
    }),
  );

  server.resource(
    'pdaSeeds',
    'agenc://pda-seeds',
    { description: 'PDA seed format reference for all account types' },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        text: PDA_SEEDS_REFERENCE,
      }],
    }),
  );

  server.resource(
    'taskStates',
    'agenc://task-states',
    { description: 'Task state machine documentation' },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        text: TASK_STATES_REFERENCE,
      }],
    }),
  );
}

function registerPrompts(server: McpServer): void {
  server.prompt(
    'debug-task',
    'Guided task debugging workflow',
    { task_pda: z.string().describe('Task PDA to debug') },
    ({ task_pda }) => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: 'Debug the AgenC task at PDA ' + task_pda + '. Steps:\n'
            + '1. Use agenc_get_task to fetch the task state\n'
            + '2. Check the task status and identify any issues\n'
            + '3. Use agenc_get_escrow to verify escrow balance\n'
            + '4. If disputed, use agenc_get_dispute to check dispute state\n'
            + '5. Summarize findings and suggest next steps',
        },
      }],
    }),
  );

  server.prompt(
    'inspect-agent',
    'Agent state inspection with decoded fields',
    { agent_id: z.string().describe('Agent ID (hex) or PDA (base58)') },
    ({ agent_id }) => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: 'Inspect the AgenC agent with ID/PDA ' + agent_id + '. Steps:\n'
            + '1. Use agenc_get_agent to fetch full agent state\n'
            + '2. Use agenc_decode_capabilities to explain the capability bitmask\n'
            + '3. Check rate limit state and active tasks\n'
            + '4. Summarize the agent health and any concerns',
        },
      }],
    }),
  );

  server.prompt(
    'escrow-audit',
    'Escrow balance verification checklist',
    { task_pda: z.string().describe('Task PDA to audit') },
    ({ task_pda }) => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: 'Audit the escrow for AgenC task at PDA ' + task_pda + '. Steps:\n'
            + '1. Use agenc_get_task to fetch the task reward amount and status\n'
            + '2. Use agenc_get_escrow to check actual escrow balance\n'
            + '3. Compare expected vs actual balance\n'
            + '4. Check if completions match distributed amounts\n'
            + '5. Use agenc_get_protocol_config to verify fee calculations\n'
            + '6. Report any discrepancies',
        },
      }],
    }),
  );
}

// ---------------------------------------------------------------------------
// Static reference content for MCP resources
// ---------------------------------------------------------------------------

const ERROR_CODES_REFERENCE = `# AgenC Error Codes (6000-6077)

## Agent Errors (6000-6007)
- 6000 AgentAlreadyRegistered: Agent is already registered
- 6001 AgentNotFound: Agent not found
- 6002 AgentNotActive: Agent is not active
- 6003 InsufficientCapabilities: Agent has insufficient capabilities
- 6004 MaxActiveTasksReached: Agent has reached maximum active tasks
- 6005 AgentHasActiveTasks: Agent has active tasks and cannot be deregistered
- 6006 UnauthorizedAgent: Only the agent authority can perform this action
- 6007 AgentRegistrationRequired: Agent registration required to create tasks

## Task Errors (6008-6023)
- 6008 TaskNotFound: Task not found
- 6009 TaskNotOpen: Task is not open for claims
- 6010 TaskFullyClaimed: Task has reached maximum workers
- 6011 TaskExpired: Task has expired
- 6012 TaskNotExpired: Task deadline has not passed
- 6013 DeadlinePassed: Task deadline has passed
- 6014 TaskNotInProgress: Task is not in progress
- 6015 TaskAlreadyCompleted: Task is already completed
- 6016 TaskCannotBeCancelled: Task cannot be cancelled
- 6017 UnauthorizedTaskAction: Only the task creator can perform this action
- 6018 InvalidCreator: Invalid creator
- 6019 InvalidTaskType: Invalid task type
- 6020 CompetitiveTaskAlreadyWon: Competitive task already completed by another worker
- 6021 NoWorkers: Task has no workers
- 6022 ConstraintHashMismatch: Proof constraint hash does not match task
- 6023 NotPrivateTask: Task is not a private task (no constraint hash set)

## Claim Errors (6024-6032)
- 6024 AlreadyClaimed: Worker has already claimed this task
- 6025 NotClaimed: Worker has not claimed this task
- 6026 ClaimAlreadyCompleted: Claim has already been completed
- 6027 ClaimNotExpired: Claim has not expired yet
- 6028 InvalidProof: Invalid proof of work
- 6029 ZkVerificationFailed: ZK proof verification failed
- 6030 InvalidProofSize: Invalid proof size - expected 388 bytes for Groth16
- 6031 InvalidProofBinding: Invalid proof binding: expected_binding cannot be all zeros
- 6032 InvalidOutputCommitment: Invalid output commitment: output_commitment cannot be all zeros

## Dispute Errors (6033-6047)
- 6033 DisputeNotActive: Dispute is not active
- 6034 VotingEnded: Voting period has ended
- 6035 VotingNotEnded: Voting period has not ended
- 6036 AlreadyVoted: Already voted on this dispute
- 6037 NotArbiter: Not authorized to vote (not an arbiter)
- 6038 InsufficientVotes: Insufficient votes to resolve
- 6039 DisputeAlreadyResolved: Dispute has already been resolved
- 6040 UnauthorizedResolver: Only protocol authority or dispute initiator can resolve
- 6041 ActiveDisputeVotes: Agent has active dispute votes pending resolution
- 6042 RecentVoteActivity: Agent must wait 24 hours after voting before deregistering
- 6043 InsufficientEvidence: Insufficient dispute evidence provided
- 6044 EvidenceTooLong: Dispute evidence exceeds maximum allowed length
- 6045 DisputeNotExpired: Dispute has not expired
- 6046 SlashAlreadyApplied: Dispute slashing already applied
- 6047 DisputeNotResolved: Dispute has not been resolved

## State Errors (6048-6050)
- 6048 VersionMismatch: State version mismatch (concurrent modification)
- 6049 StateKeyExists: State key already exists
- 6050 StateNotFound: State not found

## Protocol Errors (6051-6061)
- 6051 ProtocolAlreadyInitialized: Protocol is already initialized
- 6052 ProtocolNotInitialized: Protocol is not initialized
- 6053 InvalidProtocolFee: Invalid protocol fee (must be <= 1000 bps)
- 6054 InvalidDisputeThreshold: Invalid dispute threshold
- 6055 InsufficientStake: Insufficient stake for arbiter registration
- 6056 MultisigInvalidThreshold: Invalid multisig threshold
- 6057 MultisigInvalidSigners: Invalid multisig signer configuration
- 6058 MultisigNotEnoughSigners: Not enough multisig signers
- 6059 MultisigDuplicateSigner: Duplicate multisig signer provided
- 6060 MultisigDefaultSigner: Multisig signer cannot be default pubkey
- 6061 MultisigSignerNotSystemOwned: Multisig signer account not owned by System Program

## General Errors (6062-6068)
- 6062 InvalidInput: Invalid input parameter
- 6063 ArithmeticOverflow: Arithmetic overflow
- 6064 VoteOverflow: Vote count overflow
- 6065 InsufficientFunds: Insufficient funds
- 6066 CorruptedData: Account data is corrupted
- 6067 StringTooLong: String too long
- 6068 InvalidAccountOwner: Account not owned by this program

## Rate Limiting Errors (6069-6071)
- 6069 RateLimitExceeded: Maximum actions per 24h window reached
- 6070 CooldownNotElapsed: Cooldown period has not elapsed since last action
- 6071 InsufficientStakeForDispute: Insufficient stake to initiate dispute

## Version/Upgrade Errors (6072-6077)
- 6072 VersionMismatchProtocol: Protocol version incompatible
- 6073 AccountVersionTooOld: Account version too old, migration required
- 6074 AccountVersionTooNew: Account version too new, program upgrade required
- 6075 InvalidMigrationSource: Migration not allowed from source version
- 6076 InvalidMigrationTarget: Migration not allowed to target version
- 6077 UnauthorizedUpgrade: Only upgrade authority can perform this action
`;

const CAPABILITIES_REFERENCE = `# AgenC Agent Capabilities

Capabilities are stored as a u64 bitmask on the AgentRegistration account.

| Bit | Name        | Value | Description              |
|-----|-------------|-------|--------------------------|
| 0   | COMPUTE     | 1     | General computation      |
| 1   | INFERENCE   | 2     | ML inference             |
| 2   | STORAGE     | 4     | Data storage             |
| 3   | NETWORK     | 8     | Network relay            |
| 4   | SENSOR      | 16    | Sensor data collection   |
| 5   | ACTUATOR    | 32    | Physical actuation       |
| 6   | COORDINATOR | 64    | Task coordination        |
| 7   | ARBITER     | 128   | Dispute resolution       |
| 8   | VALIDATOR   | 256   | Result validation        |
| 9   | AGGREGATOR  | 512   | Data aggregation         |

## Examples

- COMPUTE + INFERENCE = 3 (0x03)
- All capabilities = 1023 (0x3FF)
- ARBITER only = 128 (0x80)

## Usage in Tasks

Tasks specify \`required_capabilities\` as a bitmask. An agent must have
ALL required capabilities set to claim a task.
`;

const PDA_SEEDS_REFERENCE = `# AgenC PDA Seeds

All PDAs are derived from the program ID: EopUaCV2svxj9j4hd7KjbrWfdjkspmm2BCBe7jGpKzKZ

| Account          | Seeds                              | Notes                       |
|------------------|------------------------------------|-----------------------------|
| ProtocolConfig   | ["protocol"]                       | Singleton                   |
| AgentRegistration| ["agent", agent_id]                | agent_id: [u8; 32]          |
| Task             | ["task", creator, task_id]         | creator: Pubkey, task_id: [u8; 32] |
| Escrow           | ["escrow", task_pda]               | task_pda: Pubkey             |
| Claim            | ["claim", task_pda, worker_pda]    | Both are Pubkeys             |
| Dispute          | ["dispute", dispute_id]            | dispute_id: [u8; 32]        |
| Vote             | ["vote", dispute_pda, voter]       | Both are Pubkeys             |
| AuthorityVote    | ["authority_vote", dispute_pda, authority] | Both are Pubkeys      |

## Derivation in TypeScript

\`\`\`typescript
import { PublicKey } from '@solana/web3.js';

const [pda, bump] = PublicKey.findProgramAddressSync(
  [Buffer.from('task'), creator.toBuffer(), taskIdBuffer],
  programId
);
\`\`\`

Use the \`agenc_derive_pda\` tool to derive any PDA without writing code.
`;

const TASK_STATES_REFERENCE = `# AgenC Task State Machine

## States

| Value | Name              | Description                          |
|-------|-------------------|--------------------------------------|
| 0     | Open              | Task is open for claims              |
| 1     | InProgress        | Task has been claimed, work underway |
| 2     | PendingValidation | Work submitted, awaiting validation  |
| 3     | Completed         | Task successfully completed          |
| 4     | Cancelled         | Task cancelled by creator            |
| 5     | Disputed          | Task is in dispute resolution        |

## Transitions

Open -> InProgress       (claim_task: worker claims the task)
Open -> Cancelled        (cancel_task: creator cancels before any claims)
InProgress -> Completed  (complete_task / complete_task_private: worker submits proof)
InProgress -> Cancelled  (cancel_task: creator cancels, refund minus fee)
InProgress -> Disputed   (initiate_dispute: either party disputes)
Disputed -> Completed    (resolve_dispute: resolved in worker's favor)
Disputed -> Cancelled    (resolve_dispute: resolved in creator's favor / refund)

## Task Types

| Type          | Behavior                                              |
|---------------|-------------------------------------------------------|
| Exclusive     | Single worker claims and completes                    |
| Collaborative | Multiple workers contribute (up to max_workers)       |
| Competitive   | First completion wins — checks completions == 0       |

## Key Constraints

- Deadline: Tasks expire after deadline (Unix timestamp)
- Max Workers: Limits concurrent claims
- Constraint Hash: Required for private (ZK proof) completion
- Escrow: Reward locked in escrow PDA on creation
`;
