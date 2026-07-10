# Package And Release Doc Map

This file maps the published AgenC packages to the repo and docs that own them.
Each owning repo is an independent repository, not a subdirectory of this one,
so cross-repo links point at GitHub. Private repos are named without links.
npm versions are the `latest` dist-tags as of 2026-07-10.

## Marketplace Packages

### `@tetsuo-ai/marketplace-sdk`

- npm latest: 0.11.0
- canonical repo: [`agenc-protocol`](https://github.com/tetsuo-ai/agenc-protocol), package home [`packages/sdk-ts`](https://github.com/tetsuo-ai/agenc-protocol/tree/main/packages/sdk-ts)
- package docs: [`packages/sdk-ts/README.md`](https://github.com/tetsuo-ai/agenc-protocol/blob/main/packages/sdk-ts/README.md)
- changelog: [`packages/sdk-ts/CHANGELOG.md`](https://github.com/tetsuo-ai/agenc-protocol/blob/main/packages/sdk-ts/CHANGELOG.md)
- target program: `agenc-coordination`, program ID `HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK`, live on Solana mainnet
- embeddable marketplace SDK: Codama-generated `@solana/kit` client plus an ergonomic facade covering stores, contests, and goods

### `@tetsuo-ai/protocol`

- npm latest: 0.3.0
- canonical repo: [`agenc-protocol`](https://github.com/tetsuo-ai/agenc-protocol)
- package docs: [`packages/protocol/README.md`](https://github.com/tetsuo-ai/agenc-protocol/blob/main/packages/protocol/README.md)
- repo README: [`agenc-protocol/README.md`](https://github.com/tetsuo-ai/agenc-protocol/blob/main/README.md)
- changelog: [`agenc-protocol/CHANGELOG.md`](https://github.com/tetsuo-ai/agenc-protocol/blob/main/CHANGELOG.md)
- canonical artifacts:
  - [`artifacts/anchor/idl/agenc_coordination.json`](https://github.com/tetsuo-ai/agenc-protocol/blob/main/artifacts/anchor/idl/agenc_coordination.json)
  - [`artifacts/anchor/types/agenc_coordination.ts`](https://github.com/tetsuo-ai/agenc-protocol/blob/main/artifacts/anchor/types/agenc_coordination.ts)
  - [`scripts/idl/verifier_router.json`](https://github.com/tetsuo-ai/agenc-protocol/blob/main/scripts/idl/verifier_router.json)

### `@tetsuo-ai/store-core`

- npm latest: 0.6.0
- canonical repo: [`agenc-store-templates`](https://github.com/tetsuo-ai/agenc-store-templates), package home [`packages/store-core`](https://github.com/tetsuo-ai/agenc-store-templates/tree/main/packages/store-core)
- package docs: [`packages/store-core/README.md`](https://github.com/tetsuo-ai/agenc-store-templates/blob/main/packages/store-core/README.md)
- repo README: [`agenc-store-templates/README.md`](https://github.com/tetsuo-ai/agenc-store-templates/blob/main/README.md)

### Marketplace kit binaries (`agenc-marketplace` CLI)

- releases and issue tracker: [`agenc-marketplace-releases`](https://github.com/tetsuo-ai/agenc-marketplace-releases/releases)
- installer: `curl -fsSL https://marketplace.agenc.tech/install.sh | sh`

## Public Builder Packages

### `@tetsuo-ai/sdk`

- npm latest: 1.4.0
- canonical repo: [`agenc-sdk`](https://github.com/tetsuo-ai/agenc-sdk)
- package docs: [`agenc-sdk/README.md`](https://github.com/tetsuo-ai/agenc-sdk/blob/main/README.md)
- changelog: [`agenc-sdk/CHANGELOG.md`](https://github.com/tetsuo-ai/agenc-sdk/blob/main/CHANGELOG.md)
- API baseline: [`agenc-sdk/docs/api-baseline/sdk.json`](https://github.com/tetsuo-ai/agenc-sdk/blob/main/docs/api-baseline/sdk.json)
- framework SDK for the devnet-only legacy framework program; see [SDK.md](./SDK.md) for choosing between this and `@tetsuo-ai/marketplace-sdk`

### `@tetsuo-ai/plugin-kit`

- npm latest: 0.2.0
- canonical repo: [`agenc-plugin-kit`](https://github.com/tetsuo-ai/agenc-plugin-kit)
- package docs: [`agenc-plugin-kit/README.md`](https://github.com/tetsuo-ai/agenc-plugin-kit/blob/main/README.md)
- plugin contract reference: [`docs/PLUGIN_CONTRACT_REFERENCE.md`](https://github.com/tetsuo-ai/agenc-plugin-kit/blob/main/docs/PLUGIN_CONTRACT_REFERENCE.md)
- changelog: [`agenc-plugin-kit/CHANGELOG.md`](https://github.com/tetsuo-ai/agenc-plugin-kit/blob/main/CHANGELOG.md)
- API baseline: [`agenc-plugin-kit/docs/api-baseline/plugin-kit.json`](https://github.com/tetsuo-ai/agenc-plugin-kit/blob/main/docs/api-baseline/plugin-kit.json)

## Framework And Runtime Packages

### `@tetsuo-ai/agenc`

- npm latest: 0.3.0
- canonical repo: [`agenc-core`](https://github.com/tetsuo-ai/agenc-core), package home [`packages/agenc`](https://github.com/tetsuo-ai/agenc-core/tree/main/packages/agenc)
- repo docs: [`agenc-core/README.md`](https://github.com/tetsuo-ai/agenc-core/blob/main/README.md) and the docs index at [`docs/INDEX.md`](https://github.com/tetsuo-ai/agenc-core/blob/main/docs/INDEX.md)

### `@tetsuo-ai/runtime`

- npm latest: 0.1.0 (published 2026-03-16; the repo's runtime package on `main` is ahead of the npm release)
- canonical repo: [`agenc-core`](https://github.com/tetsuo-ai/agenc-core), package home [`runtime/`](https://github.com/tetsuo-ai/agenc-core/tree/main/runtime)
- architecture: [`docs/ARCHITECTURE.md`](https://github.com/tetsuo-ai/agenc-core/blob/main/docs/ARCHITECTURE.md)
- docs index: [`docs/INDEX.md`](https://github.com/tetsuo-ai/agenc-core/blob/main/docs/INDEX.md)

### `@tetsuo-ai/mcp`

- npm latest: 0.1.0 (frozen snapshot, last published 2026-03-16)
- canonical repo: [`agenc-core`](https://github.com/tetsuo-ai/agenc-core)
- the standalone package directory no longer exists; MCP code now lives inside the runtime at [`runtime/src/mcp`](https://github.com/tetsuo-ai/agenc-core/tree/main/runtime/src/mcp)
- docs: [`agenc-core/docs/INDEX.md`](https://github.com/tetsuo-ai/agenc-core/blob/main/docs/INDEX.md)

### `@tetsuo-ai/docs-mcp`

- npm latest: 0.1.0 (frozen snapshot, last published 2026-03-16)
- canonical repo: [`agenc-core`](https://github.com/tetsuo-ai/agenc-core)
- the standalone package directory no longer exists; docs tooling was folded into the runtime tree
- docs: [`agenc-core/docs/INDEX.md`](https://github.com/tetsuo-ai/agenc-core/blob/main/docs/INDEX.md)

## Prover And Admin Surfaces

`agenc-prover` is a private repo, so the paths below are plain text, not links.

### `agenc-prover-server`

- canonical repo: `agenc-prover` (private)
- repo docs: `agenc-prover/README.md`

### `agenc-prover-admin-tools`

- canonical repo: `agenc-prover` (private)
- package docs: `agenc-prover/admin-tools/README.md`

## Related Docs

- [SDK.md](./SDK.md)
- [DEVELOPER_GUIDE.md](./DEVELOPER_GUIDE.md)
- [CODEBASE_MAP.md](./CODEBASE_MAP.md)
- [DOCS_INDEX.md](./DOCS_INDEX.md)
