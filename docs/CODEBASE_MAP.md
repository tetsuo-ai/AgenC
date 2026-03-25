# Codebase Map

This is the high-level source map for the full AgenC workspace.

## Root Workspace

```text
AgenC/
  assets/     public media and support assets
  docs/       workspace-level developer docs
  examples/   public-surface-only examples
  scripts/    bootstrap and boundary checks
  agenc-core/
  agenc-protocol/
  agenc-sdk/
  agenc-plugin-kit/
  agenc-prover/
```

## `agenc-core`

Repo-local navigation:

- `agenc-core/docs/DOCS_INDEX.md`
- `agenc-core/docs/CODEBASE_MAP.md`
- `agenc-core/runtime/docs/MODULE_MAP.md`

Top-level implementation areas:

- `runtime/`
- `mcp/`
- `docs-mcp/`
- `packages/agenc/`
- `contracts/desktop-tool-contracts/`
- `containers/desktop/server/`
- `web/`
- `mobile/`
- `demo-app/`
- `examples/`
- `tools/localnet-social/`
- `tools/proof-harness/`
- `tests/`
- `scripts/`
- `docs/`
- `config/`

### `agenc-core/runtime/src`

Top-level runtime modules:

- `agent`
- `autonomous`
- `bin`
- `bridges`
- `channels`
- `cli`
- `connection`
- `desktop`
- `dispute`
- `eval`
- `events`
- `gateway`
- `governance`
- `llm`
- `marketplace`
- `mcp-client`
- `memory`
- `observability`
- `plugins`
- `policy`
- `proof`
- `replay`
- `reputation`
- `skills`
- `social`
- `task`
- `team`
- `telemetry`
- `tools`
- `types`
- `utils`
- `voice`
- `watch`
- `workflow`

Runtime root files:

- `browser.ts`
- `builder.ts`
- `idl.ts`
- `index.ts`
- `operator-events.ts`
- `project-doc.ts`
- `runtime.ts`

Largest dense areas from the current crawl:

- `gateway`
- `llm`
- `eval`
- `autonomous`
- `watch`
- `task`

### `agenc-core/docs`

Main doc groups:

- `docs/architecture/`
- `docs/audit/`
- `docs/design/`
- `docs/security/`
- `docs/whitepaper/`
- `runtime/docs/`

## `agenc-protocol`

Repo-local navigation:

- `agenc-protocol/docs/DOCS_INDEX.md`
- `agenc-protocol/docs/CODEBASE_MAP.md`
- `agenc-protocol/docs/PROGRAM_SURFACE.md`
- `agenc-protocol/docs/ARTIFACT_PIPELINE.md`
- `agenc-protocol/docs/ZK_PRIVATE_FLOW.md`

Top-level source areas:

- `programs/agenc-coordination/`
- `artifacts/anchor/`
- `migrations/`
- `packages/protocol/`
- `scripts/idl/`
- `zkvm/guest/`

### `programs/agenc-coordination/src`

- `instructions/`
- `utils/`
- `errors.rs`
- `events.rs`
- `lib.rs`
- `state.rs`

## `agenc-sdk`

Repo-local navigation:

- `agenc-sdk/docs/DOCS_INDEX.md`
- `agenc-sdk/docs/CODEBASE_MAP.md`
- `agenc-sdk/docs/MODULE_INDEX.md`
- `agenc-sdk/docs/MAINTAINER_GUIDE.md`

Top-level source files:

- `agents.ts`
- `anchor-utils.ts`
- `bids.ts`
- `client.ts`
- `constants.ts`
- `disputes.ts`
- `errors.ts`
- `governance.ts`
- `index.ts`
- `logger.ts`
- `nullifier-cache.ts`
- `process-identity.ts`
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
- `version.ts`

Support directories:

- `src/__tests__/`
- `src/types/`
- `src/utils/`
- `docs/api-baseline/`
- `examples/private-task-demo/`

## `agenc-plugin-kit`

Repo-local navigation:

- `agenc-plugin-kit/docs/DOCS_INDEX.md`
- `agenc-plugin-kit/docs/CODEBASE_MAP.md`
- `agenc-plugin-kit/docs/PLUGIN_CONTRACT_REFERENCE.md`
- `agenc-plugin-kit/docs/MAINTAINER_GUIDE.md`

Top-level source files:

- `certification.ts`
- `channel-host-matrix.ts`
- `channel-manifest.ts`
- `channel-runtime.ts`
- `compatibility.ts`
- `errors.ts`
- `index.ts`

Support directories:

- `src/__tests__/`
- `src/compatibility/`
- `templates/channel-adapter-starter/`
- `docs/api-baseline/`

## `agenc-prover`

Repo-local navigation:

- `agenc-prover/docs/DOCS_INDEX.md`
- `agenc-prover/docs/CODEBASE_MAP.md`
- `agenc-prover/docs/PROVING_ARCHITECTURE.md`
- `agenc-prover/docs/ADMIN_TOOLS.md`
- `agenc-prover/docs/COMMANDS_AND_VALIDATION.md`

Top-level source areas:

- `server/`
- `guest/`
- `methods/`
- `admin-tools/`
- `scripts/`

Important entrypoints:

- `server/src/main.rs`
- `server/src/prover.rs`
- `admin-tools/zk-config-admin.ts`
- `admin-tools/devnet-preflight.ts`

## Root Public Examples

- `examples/simple-usage/`
- `examples/tetsuo-integration/`
- `examples/helius-webhook/`
- `examples/risc0-proof-demo/`
- `examples/reviewed-task-flow/`

## Related Docs

- [DEVELOPER_GUIDE.md](./DEVELOPER_GUIDE.md)
- [COMMANDS_AND_VALIDATION.md](./COMMANDS_AND_VALIDATION.md)
- [DOCS_INDEX.md](./DOCS_INDEX.md)
