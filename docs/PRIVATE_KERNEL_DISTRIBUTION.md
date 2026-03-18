# Private Kernel Distribution

This document is the canonical distribution and registry policy for the
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

The permanent hosted backend is Cloudsmith:

- hosted repository: `agenc/private-kernel`
- npm endpoint: `https://npm.cloudsmith.io/agenc/private-kernel/`

The repo also keeps a local/CI reference backend on Verdaccio for untrusted PR
validation and backend-independent rehearsal. That operational setup is
documented in:

- [PRIVATE_REGISTRY_SETUP.md](/home/tetsuo/git/AgenC/docs/PRIVATE_REGISTRY_SETUP.md)

The Verdaccio reference path is implemented and validated locally/CI for:

- service-account bootstrap
- authenticated `npm publish --dry-run`
- private fixture publish/view/install
- staged private-kernel publish/install rehearsal

The Cloudsmith hosted path is the production/private distribution target. It is
validated through the protected hosted workflow:

- [private-kernel-cloudsmith.yml](/home/tetsuo/git/AgenC/.github/workflows/private-kernel-cloudsmith.yml)

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
- hosted credential owner must be a service-scoped Cloudsmith account, not a
  personal token
- hosted GitHub auth must come from the protected `private-kernel-cloudsmith`
  environment

CI behavior is explicit:

- `required`: missing or rejected auth is a hard failure
- `optional-skip`: dry-run staging remains green, but the dry-run publish step
  exits with a machine-readable skip reason

Important:

- `optional-skip` is for general workflows that must remain safe on untrusted
  PRs
- the protected Cloudsmith hosted workflow hard-fails before execution if
  `PRIVATE_KERNEL_REGISTRY_TOKEN` is missing

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

The transition, deprecation, and support-window rules for the runtime-side
package names now live in:

- [PRIVATE_KERNEL_SUPPORT_POLICY.md](./PRIVATE_KERNEL_SUPPORT_POLICY.md)

This document owns the registry, staging, and publication mechanics only.

## Operational rule

Do not publish the source workspace manifests directly.

Private publication must happen only from staged artifacts produced by
`scripts/private-kernel-distribution.mjs`, with the internal scope, staged
publish config, and staged checksum manifest intact.
