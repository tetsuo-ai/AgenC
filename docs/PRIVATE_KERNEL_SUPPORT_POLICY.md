# Private Kernel Support Policy

This document is the canonical deprecation, support-window, and migration policy
for the runtime-side package surfaces that remain visible in the AgenC repo but
are no longer the intended long-term public builder model.

## Scope

This policy applies to:

- `@tetsuo-ai/runtime`
- `@tetsuo-ai/mcp`
- `@tetsuo-ai/docs-mcp`
- `@tetsuo-ai/desktop-tool-contracts`
- `@tetsuo-ai/desktop-server`

These packages are part of the private AgenC kernel baseline. They may still be
documented in this repository for kernel contributors, operators, and audit
purposes, but they are transitional surfaces rather than the long-term public
product contract.

Supported public builder surfaces remain:

- `@tetsuo-ai/sdk`
- `@tetsuo-ai/protocol`
- `@tetsuo-ai/plugin-kit`

## Current policy state

Status:

- `transitional private-kernel surfaces`

Current owner:

- `Repository / Platform Architecture`

Current review date:

- `2026-04-17`

Proof-harness ownership:

- `tools/proof-harness` remains part of `agenc-core`
- it is a private operator and integration-validation harness
- it is not a released shared contract unless a later ADR explicitly changes
  that decision

## What is supported during the transition

The transition window supports:

- security fixes
- packaging and distribution fixes
- internal operator and contributor documentation
- migration notes that move builders or operators toward the supported public
  surfaces
- private-registry publication and rehearsal hardening

The transition window does **not** promise:

- new public feature investment in these runtime-side package identities
- new external integration guarantees against these packages
- long-term stability promises for builder-facing usage outside the private
  kernel/operator context

## External migration rule

External builders should not start new work against the runtime-side package
names above.

Use these targets instead:

- `@tetsuo-ai/sdk` for TypeScript integration
- `@tetsuo-ai/protocol` for released protocol and IDL artifacts
- `@tetsuo-ai/plugin-kit` for approved plugin and adapter development

If a workflow still depends on one of the runtime-side package names, the
migration path must be written down in the owning doc or changelog before that
workflow is treated as stable.

## Sunset criteria

This transition remains open until all of the following are true:

1. the protected Cloudsmith hosted validation succeeds against
   `agenc/private-kernel` with a service-scoped credential
2. Cloudsmith service-account auth, GitHub environment protection, and token
   rotation policy are documented and active
3. runtime-side transition notices are replaced with final private
   distribution and migration documentation
4. Gate 11 exit review confirms the implemented repo topology, private
   distribution path, and the retained `agenc-core` proof/localnet validation harness

Hosted proof for criterion `1` is now satisfied in AgenC:

- `Private Kernel Cloudsmith Validation` run `23223356319`
- `Private Kernel Cloudsmith Validation` run `23223573814`

The proof/localnet validation harness ownership is also explicit now:

- `tools/proof-harness` remains part of `agenc-core`
- it is a private operator and integration-validation surface, not a released shared contract

Until all sunset criteria are met:

- source manifests stay `private: true`
- runtime-side docs remain available for kernel contributors and operators
- public builder guidance continues to point external builders to the public
  SDK, protocol, and plugin-kit surfaces

## Required documentation behavior

Every runtime-side transitional doc should do all of the following:

1. state that the package is part of the private kernel
2. point to this policy document
3. point external builders at `sdk`, `protocol`, and `plugin-kit`
4. avoid presenting the package as the default external integration path

## Relationship to distribution policy

This document owns the transition and support-window rules.

The package-staging, registry, auth, and publication mechanics live in:

- [PRIVATE_KERNEL_DISTRIBUTION.md](./PRIVATE_KERNEL_DISTRIBUTION.md)
