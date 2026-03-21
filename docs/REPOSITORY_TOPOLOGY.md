# Repository Topology

This document is the ownership and boundary reference for the current AgenC
workspace.

If you need onboarding or commands first, use:

- [GETTING_STARTED.md](./GETTING_STARTED.md)
- [COMMANDS_AND_VALIDATION.md](./COMMANDS_AND_VALIDATION.md)

## Workspace Model

`AgenC` is both:

- the umbrella git repo
- the local workspace root for the canonical nested repos

The root repo owns:

- workspace-level developer docs
- public examples
- bootstrap and boundary scripts
- public assets

It does not own the canonical SDK, protocol, plugin ABI, framework/runtime, or
prover implementations.

## Canonical Repos

| Repo | Owns |
| --- | --- |
| `AgenC` | Workspace docs, examples, bootstrap, boundaries |
| `agenc-core` | Framework/runtime/operator implementation, `packages/agenc`, runtime-side packages, UI surfaces, internal examples, operator tools |
| `agenc-protocol` | Anchor program, committed artifacts, migrations, verifier/router IDL, zkVM guest, `@tetsuo-ai/protocol` |
| `agenc-sdk` | `@tetsuo-ai/sdk`, SDK tests, API baseline, starter example |
| `agenc-plugin-kit` | `@tetsuo-ai/plugin-kit`, compatibility matrix, certification harness, starter template |
| `agenc-prover` | Proving server, guest/method crates, private admin tools |

## Current Layout

```text
AgenC/
  assets/
  docs/
  examples/
  scripts/
  agenc-core/
  agenc-protocol/
  agenc-sdk/
  agenc-plugin-kit/
  agenc-prover/
```

## Cross-Repo Relationships

- `agenc-core` consumes the public protocol artifacts published from
  `agenc-protocol`.
- `agenc-core` provides the framework/runtime/operator implementation and the
  `@tetsuo-ai/agenc` install surface.
- `agenc-sdk` is the supported TypeScript integration surface for external
  apps/services.
- `agenc-plugin-kit` is the supported plugin/add-on authoring surface.
- `agenc-prover` is the separate proving/admin repo for proof-generation and
  private admin flows.
- The root repo documents these relationships and keeps public examples that
  depend only on supported public surfaces.

## Ownership Rules

- Root docs/examples/bootstrap changes belong in `AgenC`.
- SDK changes belong in `agenc-sdk`.
- Protocol changes belong in `agenc-protocol`.
- Plugin ABI changes belong in `agenc-plugin-kit`.
- Runtime/operator/framework changes belong in `agenc-core`.
- Prover/admin changes belong in `agenc-prover`.

## What The Root Repo Must Not Reintroduce

The umbrella repo must not grow back into a shadow monorepo. At the root, do
not reintroduce:

- `runtime/`, `mcp/`, `web/`, `mobile/`, `programs/`, `zkvm/`, or similar
  implementation directories
- build/test/package scripts for nested repos
- private-runtime or protocol source-of-truth code
- local rollback mirrors for extracted public packages

## Related Docs

- [DEVELOPER_GUIDE.md](./DEVELOPER_GUIDE.md)
- [CODEBASE_MAP.md](./CODEBASE_MAP.md)
- [DOCS_INDEX.md](./DOCS_INDEX.md)
- [SDK.md](./SDK.md)
- [PLUGIN_KIT.md](./PLUGIN_KIT.md)
- [VERSION_DOCS_MAP.md](./VERSION_DOCS_MAP.md)
