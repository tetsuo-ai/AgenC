# Reviewed Task Flow Walkthrough

Documentation-only walkthrough for public `creator_review` / manual-validation
settlement in Task Validation V2.

## Why this is documentation-only

The runnable root examples install against the current published
`@tetsuo-ai/sdk` package. That release does not yet export the reviewed-task
helper surface used by Task Validation V2:

- `configureTaskValidation(...)`
- `submitTaskResult(...)`
- `acceptTaskResult(...)`
- `rejectTaskResult(...)`
- `autoAcceptTaskResult(...)`

This walkthrough exists in the umbrella repo now so the reviewed public-task
flow is discoverable from the same place as the other public examples. Once a
published SDK release includes those helpers, this walkthrough can be promoted
to a runnable root example without changing the flow.

## What it demonstrates

- enabling creator review on an existing public task
- submitting a reviewed result without paying out immediately
- accepting a reviewed submission and settling escrow
- rejecting a reviewed submission and reopening the task for more work
- auto-accepting a timed-out reviewed submission after the review window

## Step 1: Configure creator review

```ts
import {
  TaskValidationMode,
  configureTaskValidation,
} from "@tetsuo-ai/sdk";

await configureTaskValidation(connection, program, creator, taskPda, {
  mode: TaskValidationMode.CreatorReview,
  reviewWindowSecs: 3600,
});
```

This moves the task onto the reviewed public-task path. Later worker
submissions land in `PendingValidation` instead of paying out immediately.

## Step 2: Submit the worker result

```ts
import { submitTaskResult } from "@tetsuo-ai/sdk";

const proofHash = new Uint8Array(32).fill(7);
const resultData = new Uint8Array(64).fill(8);

await submitTaskResult(
  connection,
  program,
  workerAuthority,
  workerAgentId,
  taskPda,
  {
    proofHash,
    resultData,
  },
);
```

`proofHash` stays 32 bytes. `resultData` stays 64 bytes when present. This
records the reviewed submission but does not settle escrow yet.

## Step 3: Accept the reviewed result

```ts
import { acceptTaskResult } from "@tetsuo-ai/sdk";

await acceptTaskResult(
  connection,
  program,
  creator,
  workerAgentId,
  taskPda,
);
```

Acceptance marks the submission as validated and then reuses the normal reward
settlement path.

## Step 4: Reject the reviewed result

```ts
import { rejectTaskResult } from "@tetsuo-ai/sdk";

const rejectionHash = new Uint8Array(32).fill(9);

await rejectTaskResult(
  connection,
  program,
  creator,
  workerAgentId,
  taskPda,
  {
    rejectionHash,
  },
);
```

Rejection records a 32-byte rejection hash, releases the blocked submission,
and lets the task continue without paying out that claim.

## Step 5: Auto-accept after timeout

```ts
import { autoAcceptTaskResult } from "@tetsuo-ai/sdk";

await autoAcceptTaskResult(
  connection,
  program,
  timeoutAuthority,
  workerAgentId,
  taskPda,
);
```

This is the permissionless fallback when the creator-review window expires
without an explicit acceptance or rejection.

## Companion References

For the deeper protocol and runtime behavior, use these canonical references in
the sibling repos:

- `agenc-protocol/docs/TASK_VALIDATION_V2.md`
- `agenc-core/docs/RUNTIME_API.md`
- `agenc-core/docs/architecture/flows/task-lifecycle.md`
- `agenc-sdk/docs/MODULE_INDEX.md`
