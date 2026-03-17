# Private Kernel Distribution

This document is the canonical distribution and support-window policy for the
private AgenC kernel package graph.

## Why a separate internal scope is mandatory

The public package scope is already established on npmjs.org:

- `@tetsuo-ai/sdk`
- `@tetsuo-ai/protocol`
- `@tetsuo-ai/plugin-kit`

npm registry routing is scope-based, not package-based. Because of that, the
private kernel packages cannot safely share the same publish scope and still be
routed to a private registry.

The private kernel therefore uses a dedicated internal scope at staging/publish
time. The current checked-in reference scope is:

- `@tetsuo-ai-private/*`

That scope is a staging and distribution identity, not a source-tree identity.
The checked-in workspace manifests remain stable for local monorepo
development.

## Source identities vs staged identities

Local development continues to use the workspace package names already wired
through AgenC:

- `@tetsuo-ai/runtime`
- `@tetsuo-ai/mcp`
- `@tetsuo-ai/docs-mcp`
- `@tetsuo-ai/desktop-tool-contracts`
- `@tetsuo-ai/desktop-server`

The private distribution pipeline stages those artifacts under distinct internal
names:

- `@tetsuo-ai-private/runtime`
- `@tetsuo-ai-private/mcp`
- `@tetsuo-ai-private/docs-mcp`
- `@tetsuo-ai-private/desktop-tool-contracts`
- `@tetsuo-ai-private/desktop-server`

That split is intentional:

- local workspace identities stay stable for development
- the private registry uses names that cannot be confused with the public npm
  surfaces
- deprecation and migration policy for runtime-side public names can be managed
  explicitly instead of silently changing registry behavior

## Backend contract

The backend contract is intentionally registry-agnostic:

- registry type: npm-compatible private registry
- required config:
  - registry URL
  - internal scope
  - auth token environment variable
  - CI auth mode
  - manual publish auth mode

The current repo-owned reference implementation is a local/CI Verdaccio-backed
registry path. That operational setup is documented in:

- [PRIVATE_REGISTRY_SETUP.md](/home/tetsuo/git/AgenC/docs/PRIVATE_REGISTRY_SETUP.md)

That reference path is now implemented and validated locally/CI for:

- service-account bootstrap
- authenticated `npm publish --dry-run`
- private fixture publish/view/install
- staged private-kernel publish/install rehearsal

The checked-in reference config lives at:

- [private-kernel-distribution.json](/home/tetsuo/git/AgenC/config/private-kernel-distribution.json)

The local Verdaccio-backed full config lives at:

- [private-kernel-distribution.local.json](/home/tetsuo/git/AgenC/config/private-kernel-distribution.local.json)

The template copy for external provisioning or future hosted-registry migration lives at:

- [private-kernel-distribution.example.json](/home/tetsuo/git/AgenC/config/private-kernel-distribution.example.json)

## Auth policy

Developer, CI, container, and deployment environments must all authenticate
through the same explicit registry contract.

Required configuration:

- token env var: `PRIVATE_KERNEL_REGISTRY_TOKEN`
- scope registry mapping comes from the checked-in distribution config
- checked-in manifests remain `private: true`
- only staged artifacts become publishable

CI behavior is explicit:

- `required`: missing or rejected auth is a hard failure
- `optional-skip`: dry-run staging remains green, but the dry-run publish step
  exits with a machine-readable skip reason

Supported skip/failure reason codes:

- `missing_token`
- `registry_unreachable`
- `auth_rejected`
- `insufficient_scope`
- `publish_dry_run_disabled`

## Staging contract

Private-kernel distribution is driven through:

- [private-kernel-distribution.mjs](/home/tetsuo/git/AgenC/scripts/private-kernel-distribution.mjs)

The script supports:

- `--check`
- `--stage`
- `--dry-run`

`--stage` is the publication boundary. It:

1. runs `npm pack --json` for each configured source workspace
2. extracts the tarball into a deterministic stage root under `.tmp/`
3. rewrites package metadata to the internal scope
4. rewrites internal package-to-package references
5. validates staged `bin` / `exports` / entrypoint paths
6. strips source-only script metadata that depends on the monorepo workspace or unpublished source tree
7. emits staged tarballs plus a staging manifest with checksums

The staging manifest records:

- source package
- staged package
- source version
- registry URL
- stage output path
- `sha256` for the source tarball
- `sha256` for the rewritten staged manifest
- `sha256` for the final staged tarball

## Transitional support-window policy

The runtime-side public names are not the long-term public product model:

- `@tetsuo-ai/runtime`
- `@tetsuo-ai/mcp`
- `@tetsuo-ai/docs-mcp`
- `@tetsuo-ai/desktop-tool-contracts`
- `@tetsuo-ai/desktop-server`

They are transitional artifacts while the private-kernel distribution path is
being finalized and consumer migration guidance is being tightened.

Current owner:

- `Repository / Platform Architecture`

Current review date:

- `2026-04-17`

Sunset criteria:

1. a real internal registry namespace is provisioned for the dedicated internal
   scope
2. the staged private-kernel packages complete a fully authenticated dry-run
   publish cycle
3. runtime-side transition notices are replaced with final private distribution
   and migration documentation

Until those criteria are met:

- source manifests stay `private: true`
- runtime-side package docs remain available for kernel contributors
- public builder guidance continues to point external builders to:
  - `@tetsuo-ai/sdk`
  - `@tetsuo-ai/protocol`
  - `@tetsuo-ai/plugin-kit`

## Operational rule

Do not publish the source workspace manifests directly.

Private publication must happen only from staged artifacts produced by
`scripts/private-kernel-distribution.mjs`, with the internal scope, staged
publish config, and staged checksum manifest intact.
