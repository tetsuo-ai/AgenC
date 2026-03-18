# Repository Topology

This document describes the intended end-state repository layout for AgenC.

## Repo Roles

### Public

- `AgenC`
  - public umbrella repo
  - landing docs
  - compatibility matrix
  - public examples
  - bootstrap scripts
  - links to the canonical public and private repos
- `agenc-sdk`
  - public TypeScript SDK
- `agenc-protocol`
  - public protocol and trust-surface repo
- `agenc-plugin-kit`
  - public plugin ABI and certification harness

### Private

- `agenc-core`
  - private engine repo
  - runtime, MCP, docs-MCP, desktop server, orchestration, eval, internal tooling
- `agenc-prover`
  - private prover, admin, and ops repo
- `agenc-apps`
  - optional later private split for `web`, `mobile`, and `demo-app`

### Private Infra

- Cloudsmith `agenc/private-kernel`
  - private package registry for internal runtime-side packages

## Current State

`agenc-core` has now been bootstrapped as a private repository. During the
cutover period, some core-owned directories are still mirrored in `AgenC` so
that migration can proceed mirror-first and cutover-second.

Current canonical public repos:

- `https://github.com/tetsuo-ai/agenc-sdk`
- `https://github.com/tetsuo-ai/agenc-protocol`
- `https://github.com/tetsuo-ai/agenc-plugin-kit`

Current canonical private repos:

- `https://github.com/tetsuo-ai/agenc-core`
- `https://github.com/tetsuo-ai/agenc-prover`

## Setup

For public-only development:

```bash
./scripts/bootstrap-agenc-repos.sh --root /path/to/agenc
```

For internal development with private repos:

```bash
./scripts/bootstrap-agenc-repos.sh --root /path/to/agenc --private
```

This creates a side-by-side checkout like:

```text
/path/to/agenc/
  AgenC/
  agenc-sdk/
  agenc-protocol/
  agenc-plugin-kit/
  agenc-core/
  agenc-prover/
```

## Add-On Model

Third-party developers extend AgenC only through:

- `@tetsuo-ai/plugin-kit`
- optionally `@tetsuo-ai/sdk`
- optionally `@tetsuo-ai/protocol`

They do not import `runtime` internals. Plugins are loaded by `agenc-core`
through the plugin ABI only.
