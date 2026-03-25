# Commands And Validation

This file collects the main setup and validation commands for the full AgenC
workspace.

## Root `AgenC`

Install and validate:

```bash
npm install --no-fund
npm run validate:umbrella
npm run techdebt
```

Examples:

```bash
npm run example:simple-usage
npm run example:tetsuo-integration
npm run example:risc0-proof-demo
npm run example:helius-webhook:server
npm run example:helius-webhook:subscribe
```

Documentation-only reviewed-flow walkthrough:

```text
examples/reviewed-task-flow/README.md
```

## `agenc-core`

Core/framework validation:

```bash
npm install
npm run build
npm run typecheck
npm run test
npm run test:cross-repo-integration
npm run build:product-surfaces
npm run typecheck:product-surfaces
npm run test:product-surfaces
npm run typecheck:runtime-examples
npm run check:private-kernel-surface
npm run check:private-kernel-distribution
npm run check:proof-harness-boundary
npm run pack:smoke:skip-build
```

## `agenc-protocol`

Protocol/artifact validation:

```bash
anchor build
npm install
npm run artifacts:refresh
npm run artifacts:check
npm run build
npm run typecheck
npm run pack:smoke
npm run validate
```

## `agenc-sdk`

SDK validation:

```bash
npm run build
npm run typecheck
npm run test
npm run api:baseline:check
npm run pack:smoke
```

## `agenc-plugin-kit`

Plugin-kit validation:

```bash
npm run build
npm run typecheck
npm run test
npm run api:baseline:check
npm run pack:smoke
```

## `agenc-prover`

Rust-first repo:

- build/test the Rust crates through the repo Cargo workflows
- use the admin-tools package for TypeScript validation

Admin tools:

```bash
npm --prefix admin-tools install
npm --prefix admin-tools run typecheck
npm --prefix admin-tools run test
npm --prefix admin-tools run zk:config -- show
npm --prefix admin-tools run devnet:preflight
```

## Root Bootstrap Script

Public-only:

```bash
./scripts/bootstrap-agenc-repos.sh --root /path/to/agenc
```

With private/sensitive repos in your environment:

```bash
./scripts/bootstrap-agenc-repos.sh --root /path/to/agenc --private
```

## Related Docs

- [GETTING_STARTED.md](./GETTING_STARTED.md)
- [DEVELOPER_GUIDE.md](./DEVELOPER_GUIDE.md)
- [CODEBASE_MAP.md](./CODEBASE_MAP.md)
