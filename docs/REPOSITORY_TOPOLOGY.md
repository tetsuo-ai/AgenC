# Repository Topology

If you are trying to install or use AgenC, start with
[GETTING_STARTED.md](./GETTING_STARTED.md). This document explains repo
ownership and boundaries, not first-run usage.

This document describes the final AgenC repository layout.

## Public Repos

### `AgenC`

Role:

- public umbrella repo
- landing docs
- topology and contributor routing
- bootstrap scripts
- public-safe examples
- historical refactor records

### `agenc-sdk`

Role:

- public TypeScript SDK
- canonical owner of `@tetsuo-ai/sdk`

### `agenc-protocol`

Role:

- public protocol and trust-surface repo
- canonical owner of `@tetsuo-ai/protocol`

### `agenc-plugin-kit`

Role:

- public plugin ABI and certification harness
- canonical owner of `@tetsuo-ai/plugin-kit`

## Private Repos

### `agenc-core`

Role:

- private engine
- runtime
- MCP
- desktop control
- product surfaces
- internal tooling

### `agenc-prover`

Role:

- private prover
- admin tools
- ops surfaces

### `agenc-apps`

Optional later split only if product/UI churn needs its own private repo.

## Private Infrastructure

- Cloudsmith `agenc/private-kernel` for private runtime-side package distribution

## What Stays In `AgenC`

- `README.md`
- public topology and pointer docs
- public examples under `examples/`
- bootstrap and boundary scripts under `scripts/`
- historical program records like `REFACTOR.MD`

## What Does Not Stay In `AgenC`

`AgenC` is not:

- the private engine repo
- the protocol source-of-truth repo
- a shadow workspace for runtime-side packages
- a place where public examples depend on private runtime internals

## Add-On Model

Third-party builders extend AgenC through:

- `@tetsuo-ai/plugin-kit`
- optionally `@tetsuo-ai/sdk`
- optionally `@tetsuo-ai/protocol`

They do not import private engine internals directly.

## Bootstrap

Public-only:

```bash
./scripts/bootstrap-agenc-repos.sh --root /path/to/agenc
```

With private access:

```bash
./scripts/bootstrap-agenc-repos.sh --root /path/to/agenc --private
```

Expected checkout layout:

```text
/path/to/agenc/
  AgenC/
  agenc-sdk/
  agenc-protocol/
  agenc-plugin-kit/
  agenc-core/
  agenc-prover/
```
