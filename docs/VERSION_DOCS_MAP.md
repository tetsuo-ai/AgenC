# Package And Release Doc Map

This file maps the important packages in the AgenC project to the repo and docs
that own them.

## Public Builder Packages

### `@tetsuo-ai/sdk`

- canonical repo: `agenc-sdk`
- package docs: [`agenc-sdk/README.md`](../agenc-sdk/README.md)
- changelog: [`agenc-sdk/CHANGELOG.md`](../agenc-sdk/CHANGELOG.md)
- API baseline: `agenc-sdk/docs/api-baseline/sdk.json`

### `@tetsuo-ai/protocol`

- canonical repo: `agenc-protocol`
- package docs: [`agenc-protocol/packages/protocol/README.md`](../agenc-protocol/packages/protocol/README.md)
- repo README: [`agenc-protocol/README.md`](../agenc-protocol/README.md)
- changelog: [`agenc-protocol/CHANGELOG.md`](../agenc-protocol/CHANGELOG.md)
- canonical artifacts:
  - `agenc-protocol/artifacts/anchor/idl/agenc_coordination.json`
  - `agenc-protocol/artifacts/anchor/types/agenc_coordination.ts`
  - `agenc-protocol/scripts/idl/verifier_router.json`

### `@tetsuo-ai/plugin-kit`

- canonical repo: `agenc-plugin-kit`
- package docs: [`agenc-plugin-kit/README.md`](../agenc-plugin-kit/README.md)
- changelog: [`agenc-plugin-kit/CHANGELOG.md`](../agenc-plugin-kit/CHANGELOG.md)
- API baseline: `agenc-plugin-kit/docs/api-baseline/plugin-kit.json`

## Framework And Runtime Packages

### `@tetsuo-ai/agenc`

- canonical repo: `agenc-core`
- package docs: [`agenc-core/packages/agenc/README.md`](../agenc-core/packages/agenc/README.md)
- product contract: [`agenc-core/docs/architecture/product-contract.md`](../agenc-core/docs/architecture/product-contract.md)
- release channel: [`agenc-core/docs/architecture/guides/public-runtime-release-channel.md`](../agenc-core/docs/architecture/guides/public-runtime-release-channel.md)

### `@tetsuo-ai/runtime`

- canonical repo: `agenc-core`
- package docs: [`agenc-core/runtime/README.md`](../agenc-core/runtime/README.md)
- runtime API: [`agenc-core/docs/RUNTIME_API.md`](../agenc-core/docs/RUNTIME_API.md)
- architecture index: [`agenc-core/docs/architecture/README.md`](../agenc-core/docs/architecture/README.md)

### `@tetsuo-ai/mcp`

- canonical repo: `agenc-core`
- package docs: [`agenc-core/mcp/README.md`](../agenc-core/mcp/README.md)
- changelog: [`agenc-core/mcp/CHANGELOG.md`](../agenc-core/mcp/CHANGELOG.md)
- security stack: [`agenc-core/docs/security/mcp-security-stack.md`](../agenc-core/docs/security/mcp-security-stack.md)

### `@tetsuo-ai/docs-mcp`

- canonical repo: `agenc-core`
- package docs: [`agenc-core/docs-mcp/README.md`](../agenc-core/docs-mcp/README.md)
- related docs corpus: [`agenc-core/docs/architecture/README.md`](../agenc-core/docs/architecture/README.md)

## Prover And Admin Surfaces

### `agenc-prover-server`

- canonical repo: `agenc-prover`
- repo docs: [`agenc-prover/README.md`](../agenc-prover/README.md)

### `agenc-prover-admin-tools`

- canonical repo: `agenc-prover`
- package docs: [`agenc-prover/admin-tools/README.md`](../agenc-prover/admin-tools/README.md)

## Related Docs

- [DEVELOPER_GUIDE.md](./DEVELOPER_GUIDE.md)
- [CODEBASE_MAP.md](./CODEBASE_MAP.md)
- [DOCS_INDEX.md](./DOCS_INDEX.md)
