# AgenC Developer Guide

This is the workspace-level guide to the full AgenC project.

## Project Model

AgenC is a multi-repo system with one workspace root and several canonical
nested repos:

- `AgenC` - workspace docs, public examples, bootstrap, boundary checks
- `agenc-core` - framework/runtime/operator implementation
- `agenc-protocol` - protocol and committed trust-surface artifacts
- `agenc-sdk` - public TypeScript integration SDK
- `agenc-plugin-kit` - public plugin/add-on authoring ABI
- `agenc-prover` - proving server and private admin tooling

## The Main Surfaces

### Product And Operator Surface

The framework/runtime/operator stack lives in `agenc-core`.

Key areas:

- `runtime/` - the main runtime package
- `mcp/` - runtime-side MCP server
- `docs-mcp/` - docs indexing/search package
- `packages/agenc/` - public `@tetsuo-ai/agenc` CLI/launcher
- `web/`, `mobile/`, `demo-app/` - UI/client surfaces
- `tools/localnet-social/` and `tools/proof-harness/` - operator/integration tools

### Public Builder Surface

External builders should generally start with:

- `@tetsuo-ai/sdk`
- `@tetsuo-ai/protocol`
- `@tetsuo-ai/plugin-kit`

Those packages live in `agenc-sdk`, `agenc-protocol`, and
`agenc-plugin-kit` respectively.

### Protocol Surface

`agenc-protocol` owns:

- `programs/agenc-coordination/`
- `artifacts/anchor/`
- `migrations/`
- `packages/protocol/`
- `scripts/idl/`
- `zkvm/guest/`

### Prover Surface

`agenc-prover` owns:

- `server/`
- `guest/`
- `methods/`
- `admin-tools/`

## Cross-Repo Dependency Shape

At a high level:

- apps/services integrate through `@tetsuo-ai/sdk`
- the SDK consumes released protocol artifacts from `@tetsuo-ai/protocol`
- plugin/add-on authors build against `@tetsuo-ai/plugin-kit`
- the framework/runtime implementation in `agenc-core` hosts the runtime and
  operator surfaces
- private proof-generation and admin flows live in `agenc-prover`

## Where Changes Belong

| Change type | Repo |
| --- | --- |
| workspace docs, public examples, root scripts | `AgenC` |
| framework/runtime/operator code | `agenc-core` |
| protocol, Anchor program, artifacts | `agenc-protocol` |
| public TypeScript integration APIs | `agenc-sdk` |
| plugin ABI and certification tooling | `agenc-plugin-kit` |
| proving/admin flows | `agenc-prover` |

## Fast Navigation

- whole-project source map: [CODEBASE_MAP.md](./CODEBASE_MAP.md)
- build/test commands: [COMMANDS_AND_VALIDATION.md](./COMMANDS_AND_VALIDATION.md)
- active documentation map: [DOCS_INDEX.md](./DOCS_INDEX.md)
- repo boundaries: [REPOSITORY_TOPOLOGY.md](./REPOSITORY_TOPOLOGY.md)
- package doc ownership: [VERSION_DOCS_MAP.md](./VERSION_DOCS_MAP.md)

## Important Current Conventions

- The root repo is a workspace/documentation hub, not a shadow monorepo.
- Public examples stay at the root and must depend only on public surfaces.
- Canonical package/release docs belong to the repo that owns the package.
- Historical planning notes are not part of the active developer doc set; use
  the current docs and git history instead.

## First Reads By Task

| If you are... | Read this first |
| --- | --- |
| onboarding to the whole codebase | [CODEBASE_MAP.md](./CODEBASE_MAP.md) |
| figuring out how to build/test | [COMMANDS_AND_VALIDATION.md](./COMMANDS_AND_VALIDATION.md) |
| tracing docs for a subsystem | [DOCS_INDEX.md](./DOCS_INDEX.md) |
| changing runtime/product behavior | [`agenc-core/docs/DOCS_INDEX.md`](../agenc-core/docs/DOCS_INDEX.md) |
| changing protocol contracts | [`agenc-protocol/docs/DOCS_INDEX.md`](../agenc-protocol/docs/DOCS_INDEX.md) |
| changing SDK behavior | [`agenc-sdk/docs/DOCS_INDEX.md`](../agenc-sdk/docs/DOCS_INDEX.md) |
| changing plugin ABI behavior | [`agenc-plugin-kit/docs/DOCS_INDEX.md`](../agenc-plugin-kit/docs/DOCS_INDEX.md) |
| changing prover/admin behavior | [`agenc-prover/docs/DOCS_INDEX.md`](../agenc-prover/docs/DOCS_INDEX.md) |
