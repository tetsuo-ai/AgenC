# SDK Surface

`@tetsuo-ai/sdk` is owned by `agenc-sdk`.

## Canonical Repo

- repo: `agenc-sdk`
- package: `@tetsuo-ai/sdk`
- primary README: [`agenc-sdk/README.md`](../agenc-sdk/README.md)
- changelog: [`agenc-sdk/CHANGELOG.md`](../agenc-sdk/CHANGELOG.md)

## What It Owns

The SDK repo owns:

- the published `@tetsuo-ai/sdk` package
- the SDK API baseline in `agenc-sdk/docs/api-baseline/sdk.json`
- the curated starter example in `agenc-sdk/examples/private-task-demo`
- SDK tests, pack smoke, and release validation

Main source modules:

- `agents.ts`
- `anchor-utils.ts`
- `bids.ts`
- `client.ts`
- `constants.ts`
- `disputes.ts`
- `errors.ts`
- `governance.ts`
- `proof-validation.ts`
- `proofs.ts`
- `protocol.ts`
- `prover.ts`
- `queries.ts`
- `skills.ts`
- `spl-token.ts`
- `state.ts`
- `tasks.ts`
- `tokens.ts`
- `validation.ts`

## Task Validation V2

The SDK owns the public reviewed-task helper surface introduced with Task Validation V2.

Use `agenc-sdk` when you need:

- `configureTaskValidation(...)` to switch an open public task into creator review, validator quorum, or external attestation
- `submitTaskResult(...)` to record a reviewed result without settling escrow immediately
- `acceptTaskResult(...)`, `rejectTaskResult(...)`, `autoAcceptTaskResult(...)`, or `validateTaskResult(...)` to resolve reviewed submissions

Important: low-level SDK `completeTask(...)` still sends the direct `complete_task` instruction. Runtime auto-routing for creator-review tasks lives in `agenc-core`, not in the SDK package itself.

## When To Use It

Use `@tetsuo-ai/sdk` when you are:

- integrating AgenC into an app or service
- generating proof payloads
- submitting task/task-proof transactions
- submitting or resolving reviewed public-task results
- querying protocol state from TypeScript

Do not use the root repo or `agenc-core` as the canonical SDK source of truth.

## Validation

From `agenc-sdk/`:

```bash
npm run build
npm run typecheck
npm run test
npm run api:baseline:check
npm run pack:smoke
```

## Related Docs

- [VERSION_DOCS_MAP.md](./VERSION_DOCS_MAP.md)
- [DEVELOPER_GUIDE.md](./DEVELOPER_GUIDE.md)
- [DOCS_INDEX.md](./DOCS_INDEX.md)
