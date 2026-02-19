# AgenC Speculative Execution - SDK API Specification

> Client SDK methods for interacting with the speculative execution system.

## Table of Contents

1. [Overview](#overview)
2. [Installation & Setup](#installation--setup)
3. [Core SDK Methods](#core-sdk-methods)
   - [createDependentTask](#createdependenttask)
   - [createSpeculativeCommitment](#createspeculativecommitment)
   - [bondSpeculationStake](#bondspeculationstake)
   - [slashSpeculationStake](#slashspeculationstake)
   - [claimSlashDistribution](#claimslashdistribution)
   - [releaseSpeculationStake](#releasespeculationstake)
4. [Query Methods](#query-methods)
5. [Utility Functions](#utility-functions)
6. [Event Subscription](#event-subscription)
7. [Error Handling](#error-handling)
8. [Examples](#examples)

---

## Overview

The AgenC Speculation SDK provides a TypeScript interface for creating and managing speculative commitments on Solana. It handles:

- Transaction construction and signing
- PDA derivation
- Account deserialization
- Event subscription
- Error translation

### Package

```
@agenc/speculation-sdk
```

### Peer Dependencies

```json
{
  "@solana/web3.js": "^1.90.0",
  "@coral-xyz/anchor": "^0.29.0",
  "@agenc/sdk": "^1.0.0"
}
```

---

## Installation & Setup

### Installation

```bash
npm install @agenc/speculation-sdk
# or
yarn add @agenc/speculation-sdk
```

### Initialization

```typescript
import { Connection, Keypair } from '@solana/web3.js';
import { SpeculationClient } from '@agenc/speculation-sdk';

// Create client
const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
const wallet = Keypair.fromSecretKey(/* your secret key */);

const client = new SpeculationClient({
  connection,
  wallet,
  programId: '5j9ZbT3mnPX5QjWVMrDaWFuaGf8ddji6LW1HVJw6kUE7',
});

// Initialize (loads program and config)
await client.initialize();
```

### Client Configuration

```typescript
interface SpeculationClientConfig {
  /** Solana connection */
  connection: Connection;
  
  /** Wallet keypair for signing */
  wallet: Keypair;
  
  /** AgenC program ID (optional, uses default) */
  programId?: string;
  
  /** Enable debug logging */
  debug?: boolean;
  
  /** Custom commitment level */
  commitment?: 'processed' | 'confirmed' | 'finalized';
  
  /** Transaction confirmation timeout in ms */
  confirmationTimeout?: number;
  
  /** Custom Anchor provider (optional) */
  provider?: AnchorProvider;
}
```

---

## Core SDK Methods

### createDependentTask

Create a task that depends on speculative output from another task.

#### Signature

```typescript
async createDependentTask(
  params: CreateDependentTaskParams
): Promise<CreateDependentTaskResult>
```

#### Parameters

```typescript
interface CreateDependentTaskParams {
  /**
   * Task description/title.
   * @maxLength 256 characters
   */
  description: string;
  
  /**
   * Escrow amount in lamports.
   * @min 1000 (minimum rent)
   */
  escrowLamports: bigint;
  
  /**
   * Task deadline as Unix timestamp.
   * @validation Must be in the future
   */
  deadline: number;
  
  /**
   * ID of the prerequisite task.
   * @validation Must exist and be Open or InProgress
   */
  prerequisiteTaskId: number;
  
  /**
   * Speculative commitment to rely on.
   * @validation Must be Active
   */
  commitmentId: PublicKey;
  
  /**
   * Hash of the speculated input.
   * Must match commitment's outputHash.
   * @format 32-byte Buffer
   */
  speculatedInputHash: Buffer;
  
  /**
   * Constraint hash for ZK verification.
   * @optional
   * @format 32-byte Buffer
   */
  constraintHash?: Buffer;
  
  /**
   * Required agent skills.
   * @optional
   * @maxLength 10 skills
   */
  requiredSkills?: string[];
  
  /**
   * Auto-invalidate on speculation failure.
   * @default true
   */
  autoInvalidate?: boolean;
  
  /**
   * Failure handling policy.
   * @default 'refund'
   */
  failurePolicy?: 'refund' | 'partial_refund' | 'worker_keeps' | 'slash_claim';
}
```

#### Return Type

```typescript
interface CreateDependentTaskResult {
  /** Created task ID */
  taskId: number;
  
  /** Task PDA */
  taskPda: PublicKey;
  
  /** Dependent metadata PDA */
  metadataPda: PublicKey;
  
  /** Transaction signature */
  txSignature: string;
  
  /** Confirmation slot */
  slot: number;
}
```

#### Errors

| Error | Description |
|-------|-------------|
| `SpeculationError.CommitmentNotFound` | Commitment does not exist |
| `SpeculationError.CommitmentNotActive` | Commitment not in Active state |
| `SpeculationError.SpeculatedInputMismatch` | Input hash doesn't match commitment |
| `SpeculationError.CircularDependency` | Would create dependency cycle |
| `SpeculationError.SystemPaused` | Speculation system is paused |
| `InsufficientFundsError` | Wallet lacks escrow balance |

#### Example

```typescript
import { SpeculationClient } from '@agenc/speculation-sdk';
import { PublicKey } from '@solana/web3.js';

const client = new SpeculationClient({ connection, wallet });
await client.initialize();

// Get an active commitment
const commitment = await client.getCommitment(commitmentPda);

const result = await client.createDependentTask({
  description: 'Process output from task 42',
  escrowLamports: BigInt(1_000_000_000), // 1 SOL
  deadline: Math.floor(Date.now() / 1000) + 86400, // 24 hours
  prerequisiteTaskId: 42,
  commitmentId: commitment.id,
  speculatedInputHash: commitment.outputHash,
  failurePolicy: 'refund',
  autoInvalidate: true,
});

console.log(`Created dependent task ${result.taskId}`);
console.log(`Transaction: ${result.txSignature}`);
```

#### Preconditions

1. Client must be initialized
2. Commitment must exist and be in `Active` state
3. `speculatedInputHash` must exactly match `commitment.outputHash`
4. `prerequisiteTaskId` must reference a valid, non-completed task
5. No circular dependency path exists
6. Wallet must have balance >= `escrowLamports` + transaction fees

#### Postconditions

1. Task account created with standard task fields
2. DependentTaskMetadata account created linking to commitment
3. Escrow funded with `escrowLamports`
4. Commitment's `dependentTaskId` updated (if first dependent task)
5. `DependentTaskCreated` event emitted on-chain

---

### createSpeculativeCommitment

Create a new speculative commitment for a task's output.

#### Signature

```typescript
async createSpeculativeCommitment(
  params: CreateSpeculativeCommitmentParams
): Promise<CreateSpeculativeCommitmentResult>
```

#### Parameters

```typescript
interface CreateSpeculativeCommitmentParams {
  /**
   * ID of the task to speculate on.
   * @validation Must be valid, non-completed task
   */
  taskId: number;
  
  /**
   * Predicted output data.
   * Will be hashed with Poseidon to create outputHash.
   * @format Array of BigInt field elements
   */
  predictedOutput: bigint[];
  
  /**
   * Random salt for commitment hiding.
   * If not provided, cryptographically random salt is generated.
   * @optional
   * @format 32-byte Buffer
   */
  salt?: Buffer;
  
  /**
   * Amount to stake in lamports.
   * @validation Must be within config bounds
   */
  stakeAmount: bigint;
  
  /**
   * Commitment duration in seconds.
   * @validation Must be within config bounds
   * @default 3600 (1 hour)
   */
  durationSeconds?: number;
  
  /**
   * Confidence level (0-100).
   * Higher values indicate stronger certainty.
   * @default 50
   * @min 0
   * @max 100
   */
  confidence?: number;
  
  /**
   * Whether to automatically bond stake after creation.
   * @default true
   */
  autoBond?: boolean;
}
```

#### Return Type

```typescript
interface CreateSpeculativeCommitmentResult {
  /** Commitment account */
  commitment: SpeculativeCommitment;
  
  /** Commitment PDA */
  commitmentPda: PublicKey;
  
  /** Stake escrow PDA */
  stakeEscrowPda: PublicKey;
  
  /** Salt used (save this for revealing!) */
  salt: Buffer;
  
  /** Create transaction signature */
  createTxSignature: string;
  
  /** Bond transaction signature (if autoBond) */
  bondTxSignature?: string;
  
  /** Whether commitment is active */
  isActive: boolean;
}
```

#### Errors

| Error | Description |
|-------|-------------|
| `SpeculationError.InvalidPrerequisiteTask` | Task doesn't exist or is completed |
| `SpeculationError.CommitmentAlreadyExists` | Already committed to this task |
| `SpeculationError.StakeBelowMinimum` | Stake below minimum |
| `SpeculationError.StakeExceedsMaximum` | Stake above maximum |
| `SpeculationError.DurationOutOfRange` | Duration outside allowed range |
| `SpeculationError.SystemPaused` | System is paused |

#### Example

```typescript
import { SpeculationClient, poseidonHash } from '@agenc/speculation-sdk';

const client = new SpeculationClient({ connection, wallet });
await client.initialize();

// Predict the output of task 42
const predictedOutput = [
  BigInt('0x1234567890abcdef'),
  BigInt('0xfedcba0987654321'),
  BigInt(0),
  BigInt(0),
];

const result = await client.createSpeculativeCommitment({
  taskId: 42,
  predictedOutput,
  stakeAmount: BigInt(500_000_000), // 0.5 SOL
  durationSeconds: 7200, // 2 hours
  confidence: 85,
  autoBond: true,
});

// IMPORTANT: Save the salt for later verification!
console.log(`Commitment created: ${result.commitmentPda.toBase58()}`);
console.log(`Salt (SAVE THIS): ${result.salt.toString('hex')}`);
console.log(`Active: ${result.isActive}`);
```

#### Preconditions

1. Client initialized
2. Task exists and is in Open or InProgress state
3. No existing commitment from this wallet for this task
4. Stake amount within config bounds
5. Duration within config bounds
6. Wallet has balance >= stakeAmount (if autoBond)

#### Postconditions

1. Commitment account created with `Pending` state
2. If autoBond: stake transferred and state changed to `Active`
3. Salt returned (MUST be saved for future operations)
4. `CommitmentCreated` event emitted
5. If autoBond: `CommitmentActivated` event emitted

---

### bondSpeculationStake

Deposit stake to activate a pending commitment.

#### Signature

```typescript
async bondSpeculationStake(
  commitmentId: PublicKey
): Promise<BondSpeculationStakeResult>
```

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `commitmentId` | `PublicKey` | Commitment PDA to activate |

#### Return Type

```typescript
interface BondSpeculationStakeResult {
  /** Amount bonded in lamports */
  amount: bigint;
  
  /** Transaction signature */
  txSignature: string;
  
  /** Updated commitment state */
  commitment: SpeculativeCommitment;
}
```

#### Errors

| Error | Description |
|-------|-------------|
| `SpeculationError.CommitmentNotFound` | Commitment doesn't exist |
| `SpeculationError.InvalidCommitmentState` | Not in Pending state |
| `SpeculationError.CommitmentExpired` | Commitment has expired |
| `InsufficientFundsError` | Wallet lacks stake balance |

#### Example

```typescript
// Create commitment without auto-bonding
const createResult = await client.createSpeculativeCommitment({
  taskId: 42,
  predictedOutput: [...],
  stakeAmount: BigInt(500_000_000),
  autoBond: false, // Create in Pending state
});

// Later, bond the stake
const bondResult = await client.bondSpeculationStake(
  createResult.commitmentPda
);

console.log(`Bonded ${bondResult.amount} lamports`);
console.log(`Commitment now active: ${bondResult.commitment.state}`);
```

#### Preconditions

1. Commitment exists and is in `Pending` state
2. Caller is the commitment owner
3. Commitment not expired
4. Wallet has balance >= commitment.stakeAmount

#### Postconditions

1. Stake transferred from wallet to escrow PDA
2. Commitment state changed to `Active`
3. Config's `totalStaked` incremented
4. `CommitmentActivated` event emitted

---

### slashSpeculationStake

Slash a commitment that provided incorrect speculation.

#### Signature

```typescript
async slashSpeculationStake(
  params: SlashSpeculationStakeParams
): Promise<SlashSpeculationStakeResult>
```

#### Parameters

```typescript
interface SlashSpeculationStakeParams {
  /**
   * Commitment to slash.
   */
  commitmentId: PublicKey;
  
  /**
   * Actual output hash from completed task.
   * @format 32-byte Buffer
   */
  actualOutputHash: Buffer;
  
  /**
   * ZK fraud proof (required if not task completer).
   * @optional
   * @format Variable-length Buffer
   */
  fraudProof?: Buffer;
}
```

#### Return Type

```typescript
interface SlashSpeculationStakeResult {
  /** Created slash distribution */
  distribution: SlashDistribution;
  
  /** Distribution PDA */
  distributionPda: PublicKey;
  
  /** Total amount slashed */
  slashedAmount: bigint;
  
  /** Amount going to protocol */
  protocolShare: bigint;
  
  /** Amount going to whistleblower (if applicable) */
  whistleblowerShare: bigint;
  
  /** Amount available for affected parties */
  affectedPartiesPool: bigint;
  
  /** Transaction signature */
  txSignature: string;
}
```

#### Errors

| Error | Description |
|-------|-------------|
| `SpeculationError.CommitmentNotFound` | Commitment doesn't exist |
| `SpeculationError.CommitmentNotActive` | Commitment not active |
| `SpeculationError.AlreadySlashed` | Already been slashed |
| `SpeculationError.OutputMatchesCommitment` | Output actually matches |
| `SpeculationError.SlashWindowExpired` | Slash window has passed |
| `SpeculationError.FraudProofRequired` | Need fraud proof |
| `SpeculationError.InvalidFraudProof` | Fraud proof invalid |

#### Example

```typescript
// As task completer, slash incorrect commitment
const task = await client.getTask(42);
const actualOutputHash = task.resultHash!;

const commitment = await client.getCommitment(commitmentPda);

// Check if output differs
if (!actualOutputHash.equals(commitment.outputHash)) {
  const result = await client.slashSpeculationStake({
    commitmentId: commitmentPda,
    actualOutputHash,
    // No fraud proof needed - we completed the task
  });
  
  console.log(`Slashed ${result.slashedAmount} lamports`);
  console.log(`Protocol gets: ${result.protocolShare}`);
  console.log(`Available for claims: ${result.affectedPartiesPool}`);
}
```

#### Example with Fraud Proof

```typescript
import { generateFraudProof } from '@agenc/speculation-sdk/proofs';

// As whistleblower with fraud proof
const fraudProof = await generateFraudProof({
  commitmentId: commitmentPda,
  speculatedOutput: commitment.outputHash,
  actualOutput: actualOutputHash,
  taskId: 42,
});

const result = await client.slashSpeculationStake({
  commitmentId: commitmentPda,
  actualOutputHash,
  fraudProof,
});

// Whistleblower gets their share automatically
console.log(`Whistleblower reward: ${result.whistleblowerShare}`);
```

#### Preconditions

1. Commitment exists and is in `Active` state
2. `actualOutputHash` differs from `commitment.outputHash`
3. Within slash window (before `expiresAt + finalizationGracePeriod`)
4. If caller is not task completer, valid fraud proof required

#### Postconditions

1. Commitment state changed to `Slashed`
2. SlashDistribution account created
3. Protocol share transferred to treasury
4. Whistleblower share transferred (if applicable)
5. Remaining stake held in escrow for claims
6. Config's `totalSlashed` incremented
7. `CommitmentSlashed` event emitted

---

### claimSlashDistribution

Claim entitlement from a slash distribution.

#### Signature

```typescript
async claimSlashDistribution(
  distributionId: PublicKey
): Promise<ClaimSlashDistributionResult>
```

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `distributionId` | `PublicKey` | SlashDistribution PDA |

#### Return Type

```typescript
interface ClaimSlashDistributionResult {
  /** Amount claimed in lamports */
  amount: bigint;
  
  /** Claim reason */
  reason: SlashClaimReason;
  
  /** Transaction signature */
  txSignature: string;
  
  /** Updated distribution state */
  distribution: SlashDistribution;
}
```

#### Errors

| Error | Description |
|-------|-------------|
| `SpeculationError.ClaimNotFound` | No entitlement for caller |
| `SpeculationError.ClaimAlreadyProcessed` | Already claimed |
| `InsufficientFundsError` | Distribution lacks funds |

#### Example

```typescript
// Check if you're entitled to a claim
const distribution = await client.getSlashDistribution(distributionPda);
const myClaimPda = await client.deriveSlashClaimPda(
  distributionPda,
  wallet.publicKey
);

try {
  const claim = await client.getSlashClaim(myClaimPda);
  
  if (!claim.claimed) {
    const result = await client.claimSlashDistribution(distributionPda);
    console.log(`Claimed ${result.amount} lamports`);
    console.log(`Reason: ${result.reason}`);
  }
} catch (e) {
  console.log('Not entitled to this distribution');
}
```

#### Preconditions

1. Distribution exists
2. Claim record exists for caller's address
3. Claim not already processed
4. Sufficient funds in escrow

#### Postconditions

1. Claim amount transferred from escrow to caller
2. Claim marked as claimed
3. Distribution's `claimsProcessed` incremented
4. If all claims processed, distribution `finalized` = true
5. `SlashClaimed` event emitted

---

### releaseSpeculationStake

Release stake from a fulfilled commitment.

#### Signature

```typescript
async releaseSpeculationStake(
  commitmentId: PublicKey
): Promise<ReleaseSpeculationStakeResult>
```

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `commitmentId` | `PublicKey` | Commitment PDA |

#### Return Type

```typescript
interface ReleaseSpeculationStakeResult {
  /** Amount released in lamports */
  amount: bigint;
  
  /** Transaction signature */
  txSignature: string;
  
  /** Rent recovered from closed accounts */
  rentRecovered: bigint;
}
```

#### Errors

| Error | Description |
|-------|-------------|
| `SpeculationError.CommitmentNotFound` | Commitment doesn't exist |
| `SpeculationError.InvalidCommitmentState` | Not in Fulfilled state |
| `SpeculationError.StakeNotBonded` | No stake to release |

#### Example

```typescript
// After speculation was validated as correct
const commitment = await client.getCommitment(commitmentPda);

if (commitment.state === SpeculativeCommitmentState.Fulfilled) {
  const result = await client.releaseSpeculationStake(commitmentPda);
  
  console.log(`Released ${result.amount} lamports`);
  console.log(`Rent recovered: ${result.rentRecovered}`);
}
```

#### Preconditions

1. Commitment exists and is in `Fulfilled` state
2. Caller is the commitment owner
3. Escrow has stake balance

#### Postconditions

1. Stake transferred from escrow to caller
2. Commitment account closed (rent returned to caller)
3. Escrow account closed (rent returned)
4. Config's `totalStaked` decremented
5. `StakeReleased` event emitted

---

## Query Methods

### getCommitment

Fetch a speculative commitment by ID.

```typescript
async getCommitment(
  commitmentId: PublicKey
): Promise<SpeculativeCommitment | null>
```

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `commitmentId` | `PublicKey` | Commitment PDA |

#### Returns

`SpeculativeCommitment` object or `null` if not found.

#### Example

```typescript
const commitment = await client.getCommitment(commitmentPda);

if (commitment) {
  console.log(`Task ID: ${commitment.taskId}`);
  console.log(`State: ${commitment.state}`);
  console.log(`Stake: ${commitment.stakeAmount}`);
  console.log(`Expires: ${new Date(commitment.expiresAt * 1000)}`);
}
```

---

### getCommitmentsForTask

Fetch all commitments for a specific task.

```typescript
async getCommitmentsForTask(
  taskId: number
): Promise<SpeculativeCommitment[]>
```

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `taskId` | `number` | Task ID |

#### Returns

Array of `SpeculativeCommitment` objects (empty if none).

#### Example

```typescript
const commitments = await client.getCommitmentsForTask(42);

console.log(`Found ${commitments.length} commitments for task 42`);
for (const c of commitments) {
  console.log(`- ${c.committer.toBase58()}: ${c.confidence}% confidence`);
}
```

---

### getCommitmentsByCommitter

Fetch all commitments made by a specific address.

```typescript
async getCommitmentsByCommitter(
  committer: PublicKey
): Promise<SpeculativeCommitment[]>
```

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `committer` | `PublicKey` | Committer address |

#### Returns

Array of `SpeculativeCommitment` objects.

#### Example

```typescript
const myCommitments = await client.getCommitmentsByCommitter(
  wallet.publicKey
);

const active = myCommitments.filter(
  c => c.state === SpeculativeCommitmentState.Active
);
console.log(`You have ${active.length} active commitments`);
```

---

### getActiveCommitments

Fetch all currently active commitments.

```typescript
async getActiveCommitments(
  options?: GetActiveCommitmentsOptions
): Promise<SpeculativeCommitment[]>
```

#### Parameters

```typescript
interface GetActiveCommitmentsOptions {
  /** Filter by minimum stake amount */
  minStake?: bigint;
  
  /** Filter by maximum stake amount */
  maxStake?: bigint;
  
  /** Filter by minimum confidence */
  minConfidence?: number;
  
  /** Filter by task ID */
  taskId?: number;
  
  /** Maximum results to return */
  limit?: number;
}
```

#### Example

```typescript
const highConfidence = await client.getActiveCommitments({
  minConfidence: 80,
  minStake: BigInt(1_000_000_000), // At least 1 SOL staked
  limit: 10,
});
```

---

### getDependentTask

Fetch dependent task metadata.

```typescript
async getDependentTask(
  taskId: number
): Promise<DependentTaskMetadata | null>
```

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `taskId` | `number` | Task ID |

#### Returns

`DependentTaskMetadata` or `null` if task is not dependent.

#### Example

```typescript
const metadata = await client.getDependentTask(43);

if (metadata) {
  console.log(`Depends on task: ${metadata.prerequisiteTaskId}`);
  console.log(`Uses commitment: ${metadata.commitmentId.toBase58()}`);
  console.log(`Validated: ${metadata.speculationValidated}`);
}
```

---

### getSlashDistribution

Fetch a slash distribution.

```typescript
async getSlashDistribution(
  distributionId: PublicKey
): Promise<SlashDistribution | null>
```

---

### getSlashClaim

Fetch a specific slash claim.

```typescript
async getSlashClaim(
  claimPda: PublicKey
): Promise<SlashClaim | null>
```

---

### getSpeculationConfig

Fetch current speculation system configuration.

```typescript
async getSpeculationConfig(): Promise<SpeculationConfig>
```

#### Example

```typescript
const config = await client.getSpeculationConfig();

console.log(`Min stake: ${config.minStakeLamports} lamports`);
console.log(`Max stake: ${config.maxStakeLamports} lamports`);
console.log(`Min duration: ${config.minCommitmentDuration} seconds`);
console.log(`System paused: ${config.paused}`);
```

---

## Utility Functions

### PDA Derivation

```typescript
import {
  deriveCommitmentPda,
  deriveStakeEscrowPda,
  deriveSlashDistributionPda,
  deriveSlashClaimPda,
  deriveDependentTaskMetadataPda,
  deriveSpeculationConfigPda,
} from '@agenc/speculation-sdk';

// Derive commitment PDA
const [commitmentPda, bump] = deriveCommitmentPda(
  42, // taskId
  wallet.publicKey,
  programId
);

// Derive escrow for commitment
const [escrowPda] = deriveStakeEscrowPda(commitmentPda, programId);
```

---

### Hash Functions

```typescript
import {
  poseidonHash,
  computeOutputHash,
  computeCommitmentHash,
} from '@agenc/speculation-sdk';

// Hash predicted output
const predictedOutput = [BigInt(1), BigInt(2), BigInt(3), BigInt(4)];
const outputHash = computeOutputHash(predictedOutput);

// Compute hiding commitment
const salt = crypto.randomBytes(32);
const commitment = computeCommitmentHash(
  outputHash,
  salt,
  wallet.publicKey
);
```

---

### Validation

```typescript
import {
  validateCreateCommitmentParams,
  validateStakeAmount,
  validateDuration,
  checkCircularDependency,
} from '@agenc/speculation-sdk';

// Validate parameters before submission
const config = await client.getSpeculationConfig();

const validation = validateCreateCommitmentParams({
  taskId: 42,
  stakeAmount: BigInt(500_000_000),
  durationSeconds: 3600,
}, config);

if (!validation.valid) {
  console.error('Invalid params:', validation.errors);
}
```

---

### Time Utilities

```typescript
import {
  isCommitmentExpired,
  getTimeUntilExpiry,
  isWithinSlashWindow,
  getSlashWindowEnd,
} from '@agenc/speculation-sdk';

// Check expiration status
const expired = isCommitmentExpired(commitment);
const remaining = getTimeUntilExpiry(commitment); // in seconds

// Check slash window
const canSlash = isWithinSlashWindow(commitment, config);
const slashDeadline = getSlashWindowEnd(commitment, config);
```

---

## Event Subscription

### Subscribe to Events

```typescript
import { SpeculationEventType } from '@agenc/speculation-sdk';

// Subscribe to all events
const subscriptionId = await client.subscribe((event, context) => {
  console.log(`Event: ${event.type}`);
  console.log(`Slot: ${event.slot}`);
  console.log(`Signature: ${context.signature}`);
});

// Subscribe to specific events
const slashSubId = await client.subscribe(
  (event) => {
    if (event.type === SpeculationEventType.CommitmentSlashed) {
      console.log(`Slashed: ${event.slashedAmount} lamports`);
    }
  },
  {
    eventTypes: [
      SpeculationEventType.CommitmentSlashed,
      SpeculationEventType.DependentTaskInvalidated,
    ],
    commitment: 'confirmed',
  }
);

// Filter by commitment
const myCommitmentSubId = await client.subscribe(
  (event) => console.log(event),
  { commitmentId: myCommitmentPda }
);

// Unsubscribe
await client.unsubscribe(subscriptionId);
```

### Event Types

```typescript
type SpeculationEvent =
  | CommitmentCreatedEvent
  | CommitmentActivatedEvent
  | CommitmentFulfilledEvent
  | CommitmentSlashedEvent
  | CommitmentCancelledEvent
  | CommitmentExpiredEvent
  | DependentTaskCreatedEvent
  | DependentTaskValidatedEvent
  | DependentTaskInvalidatedEvent
  | SlashClaimedEvent
  | ConfigUpdatedEvent;
```

---

## Error Handling

### Error Classes

```typescript
import {
  SpeculationError,
  SpeculationErrorCode,
  isSpeculationError,
} from '@agenc/speculation-sdk';

try {
  await client.createSpeculativeCommitment({...});
} catch (error) {
  if (isSpeculationError(error)) {
    switch (error.code) {
      case SpeculationErrorCode.CommitmentAlreadyExists:
        console.log('You already have a commitment for this task');
        break;
      case SpeculationErrorCode.StakeBelowMinimum:
        console.log('Stake too low, minimum:', error.details?.minimum);
        break;
      case SpeculationErrorCode.SystemPaused:
        console.log('System is temporarily paused');
        break;
      default:
        console.log('Error:', error.message);
    }
  } else {
    // Network or other error
    throw error;
  }
}
```

### Retry Logic

```typescript
import { withRetry, RetryOptions } from '@agenc/speculation-sdk';

const retryOptions: RetryOptions = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
  retryIf: (error) => {
    // Retry on network errors, not business errors
    return !isSpeculationError(error);
  },
};

const result = await withRetry(
  () => client.createSpeculativeCommitment({...}),
  retryOptions
);
```

---

## Examples

### Complete Speculation Flow

```typescript
import {
  SpeculationClient,
  SpeculativeCommitmentState,
} from '@agenc/speculation-sdk';
import { Connection, Keypair } from '@solana/web3.js';

async function speculateOnTask(
  taskId: number,
  predictedOutput: bigint[],
  stakeAmount: bigint
) {
  const connection = new Connection('https://api.devnet.solana.com');
  const wallet = Keypair.generate(); // Your wallet
  
  const client = new SpeculationClient({ connection, wallet });
  await client.initialize();
  
  // 1. Create and activate commitment
  const { commitment, salt, commitmentPda } = await client.createSpeculativeCommitment({
    taskId,
    predictedOutput,
    stakeAmount,
    durationSeconds: 3600,
    confidence: 80,
    autoBond: true,
  });
  
  console.log('Commitment created and activated');
  console.log('SAVE THIS SALT:', salt.toString('hex'));
  
  // 2. Wait for task completion and validation
  const subscription = await client.subscribe(
    async (event) => {
      if (event.type === 'CommitmentFulfilled' && 
          event.commitmentId.equals(commitmentPda)) {
        console.log('Speculation was correct!');
        
        // 3. Release stake
        const { amount } = await client.releaseSpeculationStake(commitmentPda);
        console.log(`Released ${amount} lamports`);
        
        await client.unsubscribe(subscription);
      } else if (event.type === 'CommitmentSlashed' &&
                 event.commitmentId.equals(commitmentPda)) {
        console.log('Speculation was incorrect, stake slashed');
        await client.unsubscribe(subscription);
      }
    },
    { commitmentId: commitmentPda }
  );
}
```

### Creating a Dependent Task Pipeline

```typescript
async function createSpeculativePipeline(
  prerequisiteTaskId: number,
  speculatedOutput: bigint[]
) {
  const client = new SpeculationClient({ connection, wallet });
  await client.initialize();
  
  // 1. Create speculation for prerequisite output
  const { commitmentPda, commitment } = await client.createSpeculativeCommitment({
    taskId: prerequisiteTaskId,
    predictedOutput: speculatedOutput,
    stakeAmount: BigInt(1_000_000_000), // 1 SOL
    confidence: 90,
  });
  
  // 2. Create dependent task using speculation
  const { taskId: dependentTaskId } = await client.createDependentTask({
    description: 'Process speculated output',
    escrowLamports: BigInt(500_000_000),
    deadline: Math.floor(Date.now() / 1000) + 86400,
    prerequisiteTaskId,
    commitmentId: commitmentPda,
    speculatedInputHash: commitment.outputHash,
    failurePolicy: 'slash_claim',
  });
  
  console.log(`Created dependent task ${dependentTaskId}`);
  console.log(`It will execute speculatively using commitment ${commitmentPda.toBase58()}`);
  
  return { commitmentPda, dependentTaskId };
}
```

### Monitoring and Claiming Slashes

```typescript
async function monitorForSlashOpportunities(taskIds: number[]) {
  const client = new SpeculationClient({ connection, wallet });
  await client.initialize();
  
  // Subscribe to task completions
  const taskClient = new TaskClient({ connection, wallet });
  
  for (const taskId of taskIds) {
    const commitments = await client.getCommitmentsForTask(taskId);
    
    for (const commitment of commitments) {
      if (commitment.state !== SpeculativeCommitmentState.Active) continue;
      
      // Check if task is completed
      const task = await taskClient.getTask(taskId);
      if (task?.state !== TaskState.Completed) continue;
      
      // Check if speculation was correct
      const actualOutputHash = task.resultHash!;
      
      if (!actualOutputHash.equals(commitment.outputHash)) {
        console.log(`Found slashable commitment: ${commitment.id.toBase58()}`);
        
        const { distribution } = await client.slashSpeculationStake({
          commitmentId: commitment.id,
          actualOutputHash,
        });
        
        console.log(`Slashed ${distribution.totalSlashed} lamports`);
      }
    }
  }
}
```

---

## Type Definitions Reference

Full type definitions are available in the package:

```typescript
import type {
  // Core types
  SpeculativeCommitment,
  SpeculativeCommitmentState,
  DependentTaskMetadata,
  SlashDistribution,
  SlashClaim,
  SlashClaimReason,
  SpeculationConfig,
  SpeculationFailurePolicy,
  SpeculationInvalidationReason,
  
  // Method params
  CreateDependentTaskParams,
  CreateSpeculativeCommitmentParams,
  SlashSpeculationStakeParams,
  
  // Method results
  CreateDependentTaskResult,
  CreateSpeculativeCommitmentResult,
  BondSpeculationStakeResult,
  SlashSpeculationStakeResult,
  ClaimSlashDistributionResult,
  ReleaseSpeculationStakeResult,
  
  // Events
  SpeculationEvent,
  SpeculationEventType,
  CommitmentCreatedEvent,
  CommitmentSlashedEvent,
  DependentTaskCreatedEvent,
  
  // Errors
  SpeculationError,
  SpeculationErrorCode,
} from '@agenc/speculation-sdk';
```

---

## References

- [Runtime API](./RUNTIME-API.md)
- [On-Chain API](./ONCHAIN-API.md)
- [AgenC SDK Documentation](../../../sdk/README.md)
- [Solana Web3.js](https://solana-labs.github.io/solana-web3.js/)
- [Anchor Documentation](https://www.anchor-lang.com/)
