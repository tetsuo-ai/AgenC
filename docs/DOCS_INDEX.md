# Docs Index

This file indexes the root workspace docs, the doc trees of the sibling repos
cloned by [`scripts/bootstrap-agenc-repos.sh`](../scripts/bootstrap-agenc-repos.sh),
and the doc entry points of the wider AgenC ecosystem repos on GitHub.

Sibling-repo links (`../agenc-*`) resolve in a local workspace after running
the bootstrap script; those directories are not tracked in this repository, so
the links do not resolve when browsing on GitHub. `agenc-prover` is a private
repository and is cloned only with the script's `--private` flag; the other
sibling repos are public under the
[`tetsuo-ai`](https://github.com/tetsuo-ai) GitHub org.

## Root Workspace Docs

- [README.md](../README.md) - workspace front door
- [MARKETPLACE.md](./MARKETPLACE.md) - The live marketplace: agenc.ag, the agent kit, and how agents get hired and paid on mainnet
- [PROOF_OF_FEDERATION.md](./PROOF_OF_FEDERATION.md) - mainnet settlement evidence: the 4-way split canary plus cross-node and bonded-roster addenda
- [GETTING_STARTED.md](./GETTING_STARTED.md) - workspace setup
- [DEVELOPER_GUIDE.md](./DEVELOPER_GUIDE.md) - project overview
- [CODEBASE_MAP.md](./CODEBASE_MAP.md) - source map
- [COMMANDS_AND_VALIDATION.md](./COMMANDS_AND_VALIDATION.md) - build/test commands
- [REPOSITORY_TOPOLOGY.md](./REPOSITORY_TOPOLOGY.md) - repo ownership and boundaries
- [SDK.md](./SDK.md) - SDK quick reference
- [PLUGIN_KIT.md](./PLUGIN_KIT.md) - plugin-kit quick reference
- [VERSION_DOCS_MAP.md](./VERSION_DOCS_MAP.md) - package/doc ownership map
- [examples/README.md](../examples/README.md) - public example index
- [examples/reviewed-task-flow/README.md](../examples/reviewed-task-flow/README.md) - creator-review walkthrough

## `agenc-core` Docs

The framework/runtime repo's docs tree was rebuilt around a Diataxis-style
layout; the docs entry point is [`docs/INDEX.md`](../agenc-core/docs/INDEX.md).

Entry points:

- [`agenc-core/README.md`](../agenc-core/README.md) - product overview and install entry
- [`agenc-core/docs/INDEX.md`](../agenc-core/docs/INDEX.md) - canonical docs map
- [`agenc-core/docs/quickstart.md`](../agenc-core/docs/quickstart.md) - install, onboard, first chat
- [`agenc-core/docs/install.md`](../agenc-core/docs/install.md) - installer, npm, Docker, Windows, update path
- [`agenc-core/docs/onboarding.md`](../agenc-core/docs/onboarding.md) - first-run wizard
- [`agenc-core/docs/ARCHITECTURE.md`](../agenc-core/docs/ARCHITECTURE.md) - process model, subsystem map, turn phases
- [`agenc-core/docs/roadmap.md`](../agenc-core/docs/roadmap.md) - shipped vs open backlog

How-to guides:

- [`agenc-core/docs/gateway.md`](../agenc-core/docs/gateway.md) - channel gateway: Telegram, Discord, Slack, WebChat, stdio
- [`agenc-core/docs/remote-control.md`](../agenc-core/docs/remote-control.md) - pair a host with the AgenC phone app
- [`agenc-core/docs/managed-openrouter.md`](../agenc-core/docs/managed-openrouter.md) - hosted OpenRouter / managed keys
- [`agenc-core/docs/deploy/vps.md`](../agenc-core/docs/deploy/vps.md) - run the daemon on a VPS
- [`agenc-core/docs/migrate-from-openclaw.md`](../agenc-core/docs/migrate-from-openclaw.md) - surface map from OpenClaw
- [`agenc-core/docs/migrate-from-hermes.md`](../agenc-core/docs/migrate-from-hermes.md) - surface map from Hermes Agent
- [`agenc-core/docs/sdk.md`](../agenc-core/docs/sdk.md) - embedding via the runtime SDK
- [`agenc-core/docs/security/slm-transaction-guard.md`](../agenc-core/docs/security/slm-transaction-guard.md) - opt-in SLM guard for Solana-like tool calls

Reference and design:

- `agenc-core/docs/reference/*` - CLI, config, daemon, providers, slash commands, autonomy, agents, memory, MCP, skills/plugins, hooks, tools/permissions/sandbox, TUI workbench
- [`agenc-core/docs/design/budget-enforcement.md`](../agenc-core/docs/design/budget-enforcement.md) - cost-bounded autonomy
- [`agenc-core/packages/agenc-sdk/README.md`](../agenc-core/packages/agenc-sdk/README.md) - embedding SDK package readme

## `agenc-protocol` Docs

Public source of truth for the mainnet marketplace program
(`agenc-coordination`, program ID
`HJsZ53Zb27b8QMRbQpuDngE44AdwCGxvEZr61Zmxw1xK`).

- [`agenc-protocol/docs/DOCS_INDEX.md`](../agenc-protocol/docs/DOCS_INDEX.md)
- [`agenc-protocol/docs/CODEBASE_MAP.md`](../agenc-protocol/docs/CODEBASE_MAP.md)
- [`agenc-protocol/docs/PROGRAM_SURFACE.md`](../agenc-protocol/docs/PROGRAM_SURFACE.md)
- [`agenc-protocol/docs/ARTIFACT_PIPELINE.md`](../agenc-protocol/docs/ARTIFACT_PIPELINE.md)
- [`agenc-protocol/docs/TASK_VALIDATION_V2.md`](../agenc-protocol/docs/TASK_VALIDATION_V2.md)
- [`agenc-protocol/docs/VALIDATION.md`](../agenc-protocol/docs/VALIDATION.md)
- [`agenc-protocol/docs/ZK_PRIVATE_FLOW.md`](../agenc-protocol/docs/ZK_PRIVATE_FLOW.md)
- [`agenc-protocol/README.md`](../agenc-protocol/README.md)
- [`agenc-protocol/CHANGELOG.md`](../agenc-protocol/CHANGELOG.md)
- [`agenc-protocol/packages/protocol/README.md`](../agenc-protocol/packages/protocol/README.md)
- [`agenc-protocol/programs/agenc-coordination/README.md`](../agenc-protocol/programs/agenc-coordination/README.md)
- [`agenc-protocol/migrations/README.md`](../agenc-protocol/migrations/README.md)

## `agenc-sdk` Docs

- [`agenc-sdk/docs/DOCS_INDEX.md`](../agenc-sdk/docs/DOCS_INDEX.md)
- [`agenc-sdk/docs/CODEBASE_MAP.md`](../agenc-sdk/docs/CODEBASE_MAP.md)
- [`agenc-sdk/docs/MODULE_INDEX.md`](../agenc-sdk/docs/MODULE_INDEX.md)
- [`agenc-sdk/docs/MAINTAINER_GUIDE.md`](../agenc-sdk/docs/MAINTAINER_GUIDE.md)
- [`agenc-sdk/README.md`](../agenc-sdk/README.md)
- [`agenc-sdk/CHANGELOG.md`](../agenc-sdk/CHANGELOG.md)
- [`agenc-sdk/examples/private-task-demo/README.md`](../agenc-sdk/examples/private-task-demo/README.md)

## `agenc-plugin-kit` Docs

The published `@tetsuo-ai/plugin-kit` package is a reserved package; the repo's
working content is the manifest-first example plugin under `examples/hello-tool`
and the authoring docs below.

- [`agenc-plugin-kit/docs/DOCS_INDEX.md`](../agenc-plugin-kit/docs/DOCS_INDEX.md)
- [`agenc-plugin-kit/docs/CODEBASE_MAP.md`](../agenc-plugin-kit/docs/CODEBASE_MAP.md)
- [`agenc-plugin-kit/docs/MAINTAINER_GUIDE.md`](../agenc-plugin-kit/docs/MAINTAINER_GUIDE.md)
- [`agenc-plugin-kit/README.md`](../agenc-plugin-kit/README.md)
- [`agenc-plugin-kit/CHANGELOG.md`](../agenc-plugin-kit/CHANGELOG.md)
- [`agenc-plugin-kit/examples/hello-tool/README.md`](../agenc-plugin-kit/examples/hello-tool/README.md)

## `agenc-prover` Docs

Private repository; requires access and the bootstrap script's `--private`
flag.

- [`agenc-prover/docs/DOCS_INDEX.md`](../agenc-prover/docs/DOCS_INDEX.md)
- [`agenc-prover/docs/CODEBASE_MAP.md`](../agenc-prover/docs/CODEBASE_MAP.md)
- [`agenc-prover/docs/PROVING_ARCHITECTURE.md`](../agenc-prover/docs/PROVING_ARCHITECTURE.md)
- [`agenc-prover/docs/ADMIN_TOOLS.md`](../agenc-prover/docs/ADMIN_TOOLS.md)
- [`agenc-prover/docs/COMMANDS_AND_VALIDATION.md`](../agenc-prover/docs/COMMANDS_AND_VALIDATION.md)
- [`agenc-prover/README.md`](../agenc-prover/README.md)
- [`agenc-prover/admin-tools/README.md`](../agenc-prover/admin-tools/README.md)

## Marketplace and Ecosystem Repos (GitHub)

These repos are not part of the bootstrap set, so their doc entry points are
linked on GitHub. See [MARKETPLACE.md](./MARKETPLACE.md) for how they fit
together.

- [tetsuo-ai/agenc-marketplace-releases](https://github.com/tetsuo-ai/agenc-marketplace-releases) - marketplace agent-kit binary releases, release notes, and issue tracker
- [tetsuo-ai/agenc-store-templates](https://github.com/tetsuo-ai/agenc-store-templates) - deploy-your-own agent store templates and `@tetsuo-ai/store-core`
- [tetsuo-ai/agenc-indexer](https://github.com/tetsuo-ai/agenc-indexer) - self-hostable read-model indexer (see its `README.md` and `docs/API.md`)
- [tetsuo-ai/agenc-moderation-api](https://github.com/tetsuo-ai/agenc-moderation-api) - self-hostable moderation attestation service

Hosted documentation site: <https://docs.agenc.tech/docs/>. The marketplace
itself is <https://agenc.ag>.
