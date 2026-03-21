# Getting Started With The AgenC Workspace

This guide is for developers working across the full AgenC project, not just
the root umbrella repo.

## What You Are Looking At

The local workspace is a multi-repo checkout:

```text
AgenC/
  agenc-core/
  agenc-protocol/
  agenc-sdk/
  agenc-plugin-kit/
  agenc-prover/
```

The root `AgenC` repo owns the workspace-level docs, public examples, bootstrap
script, and boundary checks. The nested repos own the real package and product
surfaces.

## Recommended Prerequisites

Use these as the baseline unless a repo README says otherwise:

- Node.js 20 for the root workspace and most TypeScript validation
- npm 11.7.0 for the npm-managed repos
- Rust and Cargo for `agenc-protocol` and `agenc-prover`
- Solana CLI and Anchor for protocol builds and Anchor tests
- Node.js 22+ when working directly in `agenc-prover/admin-tools`

## Bootstrap The Repo Set

If you only have the root repo, clone or fast-forward the public repo set side
by side:

```bash
./scripts/bootstrap-agenc-repos.sh --root /path/to/agenc
```

If you also have access to the private/sensitive repos in your environment:

```bash
./scripts/bootstrap-agenc-repos.sh --root /path/to/agenc --private
```

## Install The Root Workspace

From the root:

```bash
npm install --no-fund
```

This installs the public example workspaces and root validation tooling.

## Choose The Repo That Owns Your Change

| If you are changing... | Work in... |
| --- | --- |
| root docs, examples, bootstrap, boundary checks | `AgenC` |
| framework/runtime/operator implementation | `agenc-core` |
| Anchor program, protocol artifacts, verifier/router IDL | `agenc-protocol` |
| public TypeScript integration SDK | `agenc-sdk` |
| plugin authoring ABI and certification helpers | `agenc-plugin-kit` |
| proving server and private admin tools | `agenc-prover` |

## First Validation Pass

Run the root checks first:

```bash
npm run validate:umbrella
```

Then use the repo-specific commands from
[COMMANDS_AND_VALIDATION.md](./COMMANDS_AND_VALIDATION.md).

## Useful Root Commands

```bash
npm run example:simple-usage
npm run example:tetsuo-integration
npm run example:risc0-proof-demo
npm run example:helius-webhook:server
npm run example:helius-webhook:subscribe
```

The Helius example needs:

- `HELIUS_API_KEY`
- `HELIUS_WEBHOOK_SECRET` for the server entrypoint

## Read These Next

- [DEVELOPER_GUIDE.md](./DEVELOPER_GUIDE.md)
- [CODEBASE_MAP.md](./CODEBASE_MAP.md)
- [COMMANDS_AND_VALIDATION.md](./COMMANDS_AND_VALIDATION.md)
- [DOCS_INDEX.md](./DOCS_INDEX.md)
- [REPOSITORY_TOPOLOGY.md](./REPOSITORY_TOPOLOGY.md)
