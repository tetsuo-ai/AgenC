# Commands And Validation

This file collects the main setup and validation commands for the umbrella
repo and the bootstrap repo set (`AgenC` root, `agenc-core`, `agenc-protocol`,
`agenc-sdk`, `agenc-plugin-kit`, `agenc-prover`). Marketplace usage (hiring,
earning, the agent kit CLI/MCP) is documented at
<https://docs.agenc.tech/docs/> and is not covered here.

Repo access: every repo below is public except `agenc-prover`, which is
private. If you cannot clone a repo, its commands do not apply to your
checkout.

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

Runtime validation:

```bash
npm install
npm run build
npm run typecheck
npm run test
npm run validate:runtime
npm run check:agent-surface-contract
npm run check:unused
npm run check:sbom
```

`validate:runtime` typechecks and builds the runtime workspace and checks TUI
runtime startup; `check:sbom` validates the SPDX SBOM.

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

## `agenc-prover` (private repo)

Rust-first repo, private to the `tetsuo-ai` org; skip this section without
access:

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

Adding `agenc-prover` (the only repo that requires private access):

```bash
./scripts/bootstrap-agenc-repos.sh --root /path/to/agenc --private
```

## Related Docs

- [GETTING_STARTED.md](./GETTING_STARTED.md)
- [DEVELOPER_GUIDE.md](./DEVELOPER_GUIDE.md)
- [CODEBASE_MAP.md](./CODEBASE_MAP.md)
