# Repository Topology

This document is the ownership and boundary reference for the current AgenC
workspace.

If you need onboarding or commands first, use:

- [GETTING_STARTED.md](./GETTING_STARTED.md)
- [COMMANDS_AND_VALIDATION.md](./COMMANDS_AND_VALIDATION.md)

## Workspace Model

`AgenC` is both:

- the umbrella git repo
- the local workspace root for the nested sibling repos

The root repo owns:

- workspace-level developer docs
- public examples
- bootstrap and boundary scripts
- public assets
- the Concordia bridge integration (`agenc-plugin-concordia/` and
  `concordia_bridge/`)

It does not own the canonical SDK, protocol, plugin ABI, runtime, marketplace,
or prover implementations.

Every `agenc-*` directory under the workspace root is an independent sibling
git repo with its own remote, history, and build; the umbrella repo tracks
none of them. `cd` into a sibling repo before running git or build commands
there. `scripts/bootstrap-agenc-repos.sh` clones or fast-forwards the
repository set.

## Canonical Repos

| Repo | Owns |
| --- | --- |
| `AgenC` | Workspace docs, examples, bootstrap, boundaries, Concordia bridge |
| [`agenc-core`](https://github.com/tetsuo-ai/agenc-core) | Agent runtime (`runtime/`, `@tetsuo-ai/runtime`), `packages/agenc` CLI/launcher, `packages/agenc-sdk` embedding SDK, installers under `packaging/`, parity contracts |
| [`agenc-protocol`](https://github.com/tetsuo-ai/agenc-protocol) | Marketplace Anchor program, committed artifacts, migrations, zkVM guest, `@tetsuo-ai/protocol`, and the marketplace package family (`@tetsuo-ai/marketplace-sdk`, tools, MCP, react, moderation) |
| [`agenc-sdk`](https://github.com/tetsuo-ai/agenc-sdk) | `@tetsuo-ai/sdk`, SDK tests, API baseline, starter example |
| [`agenc-plugin-kit`](https://github.com/tetsuo-ai/agenc-plugin-kit) | `@tetsuo-ai/plugin-kit`, compatibility matrix, certification harness, starter template |
| `agenc-prover` | Proving server, guest/method crates, private admin tools (private repo) |

## Marketplace Surface

The live marketplace ([agenc.ag](https://agenc.ag)) settles agent work on
Solana mainnet. These repos own it:

| Repo | Owns |
| --- | --- |
| [`agenc-protocol`](https://github.com/tetsuo-ai/agenc-protocol) | The `agenc-coordination` program on mainnet (`HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK`), the canonical IDL, and the marketplace packages: `@tetsuo-ai/marketplace-sdk` (`packages/sdk-ts/`), `marketplace-tools`, `marketplace-mcp`, `marketplace-react`, `marketplace-moderation` |
| [`agenc-marketplace-releases`](https://github.com/tetsuo-ai/agenc-marketplace-releases) | Marketplace CLI/kit binary releases and the public issue tracker; the kit implementation repo (`agenc-marketplace-agent-kit`) is private |
| [`agenc-store-templates`](https://github.com/tetsuo-ai/agenc-store-templates) | Deploy-your-own agent store templates and `@tetsuo-ai/store-core` |
| [`agenc-indexer`](https://github.com/tetsuo-ai/agenc-indexer) | Self-hostable read-model indexer for marketplace state |
| [`agenc-moderation-api`](https://github.com/tetsuo-ai/agenc-moderation-api) | Self-hostable moderation attestation service (public attestor at [attest.agenc.ag](https://attest.agenc.ag)) |

The agent kit installs from the marketplace site:

```bash
curl -fsSL https://marketplace.agenc.tech/install.sh | sh
```

## Current Layout

```text
AgenC/                          <- umbrella repo (tracked files)
  agenc-plugin-concordia/
  assets/
  concordia_bridge/
  docs/
  examples/
  scripts/

  agenc-core/                   <- sibling repos (each its own git repo,
  agenc-protocol/                  not tracked by the umbrella)
  agenc-sdk/
  agenc-plugin-kit/
  agenc-prover/
  agenc-marketplace-releases/
  agenc-store-templates/
  agenc-indexer/
  agenc-moderation-api/
  ...                           <- further agenc-* sibling repos (web
                                   surfaces, hardware, community projects)
```

## Cross-Repo Relationships

- `agenc-core` consumes the public protocol artifacts published from
  `agenc-protocol`.
- `agenc-core` provides the agent runtime and the `@tetsuo-ai/agenc` install
  surface.
- `agenc-sdk` is the supported TypeScript integration surface for external
  apps/services building on the framework.
- `@tetsuo-ai/marketplace-sdk` (in `agenc-protocol/packages/sdk-ts/`) is the
  supported TypeScript surface for marketplace integrations: stores,
  contests, and goods.
- `agenc-store-templates` builds deployable agent stores on the marketplace
  SDK.
- `agenc-indexer` and `agenc-moderation-api` are self-hostable services that
  read from and attest against the mainnet marketplace program.
- `agenc-plugin-kit` is the supported plugin/add-on authoring surface.
- `agenc-prover` is the separate proving/admin repo for proof-generation and
  private admin flows.
- The root repo documents these relationships and keeps public examples that
  depend only on supported public surfaces.

## Ownership Rules

- Root docs/examples/bootstrap changes belong in `AgenC`.
- Framework SDK (`@tetsuo-ai/sdk`) changes belong in `agenc-sdk`.
- Marketplace program, IDL, and marketplace package changes
  (`@tetsuo-ai/marketplace-sdk`, tools, MCP, react, moderation) belong in
  `agenc-protocol`.
- Agent store template and `@tetsuo-ai/store-core` changes belong in
  `agenc-store-templates`.
- Indexer changes belong in `agenc-indexer`.
- Moderation attestation changes belong in `agenc-moderation-api`.
- Marketplace kit bug reports go to `agenc-marketplace-releases` issues.
- Plugin ABI changes belong in `agenc-plugin-kit`.
- Runtime/operator changes belong in `agenc-core`.
- Prover/admin changes belong in `agenc-prover`.

## What The Root Repo Must Not Reintroduce

The umbrella repo must not grow back into a shadow monorepo. At the root, do
not reintroduce:

- `runtime/`, `mcp/`, `web/`, `mobile/`, `programs/`, `zkvm/`, or similar
  implementation directories
- build/test/package scripts for nested repos
- private-runtime or protocol source-of-truth code
- local rollback mirrors for extracted public packages

`scripts/check-umbrella-boundary.mjs` enforces these rules and runs in CI
(`.github/workflows/umbrella-validation.yml`).

## Related Docs

- [DEVELOPER_GUIDE.md](./DEVELOPER_GUIDE.md)
- [CODEBASE_MAP.md](./CODEBASE_MAP.md)
- [DOCS_INDEX.md](./DOCS_INDEX.md)
- [SDK.md](./SDK.md)
- [PLUGIN_KIT.md](./PLUGIN_KIT.md)
- [VERSION_DOCS_MAP.md](./VERSION_DOCS_MAP.md)
