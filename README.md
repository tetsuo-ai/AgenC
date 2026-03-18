<h1 align="center">AgenC</h1>

<p align="center">
  <img src="assets/banner.jpg" alt="AgenC" width="600">
</p>

<p align="center">
  <strong>Public umbrella repo for the AgenC ecosystem</strong>
</p>

## What This Repo Is

`AgenC` is the public front door for the project.

This repo keeps:

- public landing docs
- repository topology and contributor routing
- bootstrap scripts for the multi-repo layout
- public-safe examples
- historical refactor records

It is not the private engine repo and it is not the protocol source of truth.

## Canonical Repos

### Public

- [`agenc-sdk`](https://github.com/tetsuo-ai/agenc-sdk) -> `@tetsuo-ai/sdk`
- [`agenc-protocol`](https://github.com/tetsuo-ai/agenc-protocol) -> `@tetsuo-ai/protocol`
- [`agenc-plugin-kit`](https://github.com/tetsuo-ai/agenc-plugin-kit) -> `@tetsuo-ai/plugin-kit`

### Private

- `agenc-core` -> private runtime, MCP, desktop, apps, and internal tools
- `agenc-prover` -> private prover, admin, and ops

### Private Infrastructure

- Cloudsmith `agenc/private-kernel` for internal package distribution

## Bootstrap The Repo Set

Clone or update the public repos side by side:

```bash
./scripts/bootstrap-agenc-repos.sh --root /path/to/agenc
```

Include private repos if you have access:

```bash
./scripts/bootstrap-agenc-repos.sh --root /path/to/agenc --private
```

Expected layout:

```text
/path/to/agenc/
  AgenC/
  agenc-sdk/
  agenc-protocol/
  agenc-plugin-kit/
  agenc-core/
  agenc-prover/
```

## Public Examples In This Repo

The retained public examples are:

- [examples/simple-usage](examples/simple-usage/)
- [examples/tetsuo-integration](examples/tetsuo-integration/)
- [examples/helius-webhook](examples/helius-webhook/)
- [examples/risc0-proof-demo](examples/risc0-proof-demo/)

Validate them with:

```bash
npm install --no-fund
npm run validate:umbrella
```

## Where To Make Changes

- SDK or client API work -> `agenc-sdk`
- protocol or trust-surface work -> `agenc-protocol`
- plugin ABI work -> `agenc-plugin-kit`
- private runtime, MCP, desktop, apps, operator tooling -> `agenc-core`
- prover, admin, and ops -> `agenc-prover`

Repository topology detail lives in [docs/REPOSITORY_TOPOLOGY.md](docs/REPOSITORY_TOPOLOGY.md).

## Historical Records

The completed refactor program is recorded in:

- [REFACTOR.MD](REFACTOR.MD)
- [REFACTOR-MASTER-PROGRAM.md](REFACTOR-MASTER-PROGRAM.md)

Those files are retained as historical program records, not as active local build instructions.

## License

GPL-3.0. See [LICENSE](LICENSE).
