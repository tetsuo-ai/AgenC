<h1 align="center">AgenC</h1>

<p align="center">
  <img src="assets/banner.jpg" alt="AgenC banner" width="640">
</p>

<p align="center">
  <strong>Build, integrate, and extend agent systems on top of AgenC.</strong><br>
  This repository is the public front door for the AgenC ecosystem.
</p>

<p align="center">
  <a href="https://agenc.tech/">
    <img alt="Website" src="https://img.shields.io/badge/Website-agenc.tech-0f172a?style=for-the-badge&logo=googlechrome&logoColor=white">
  </a>
  <a href="https://docs.agenc.tech/docs/">
    <img alt="Documentation" src="https://img.shields.io/badge/Docs-agenc.tech-111827?style=for-the-badge&logo=gitbook&logoColor=white">
  </a>
  <a href="https://t.me/agenc_community">
    <img alt="Telegram" src="https://img.shields.io/badge/Telegram-Community-229ED9?style=for-the-badge&logo=telegram&logoColor=white">
  </a>
  <a href="https://x.com/a_g_e_n_c">
    <img alt="X" src="https://img.shields.io/badge/X-@a__g__e__n__c-000000?style=for-the-badge&logo=x&logoColor=white">
  </a>
</p>

<p align="center">
  <code>CA: 5yC9BM8KUsJTPbWPLfA2N8qH1s9V8DQ3Vcw1G6Jdpump</code>
</p>

## What AgenC Is

AgenC is an ecosystem for building agent workflows with stable public contracts
and a private execution core.

Public builders get:

- a TypeScript SDK for integration work
- released protocol and IDL artifacts
- a plugin authoring surface for add-ons and adapters

The full private operator stack, including the runtime, TUI, daemon, web
surfaces, desktop control, and internal tooling, lives outside this repo.

## Start Here

| I want to... | Go here |
| --- | --- |
| Integrate AgenC into an app or service | [`agenc-sdk`](https://github.com/tetsuo-ai/agenc-sdk) / `@tetsuo-ai/sdk` |
| Consume the protocol, IDL, or trust-surface artifacts | [`agenc-protocol`](https://github.com/tetsuo-ai/agenc-protocol) / `@tetsuo-ai/protocol` |
| Build add-ons, adapters, or plugins | [`agenc-plugin-kit`](https://github.com/tetsuo-ai/agenc-plugin-kit) / `@tetsuo-ai/plugin-kit` |
| Work on the private runtime, TUI, daemon, web portal, or desktop surfaces | `agenc-core` (private access required) |
| Work on proving, admin, or operator prover flows | `agenc-prover` (private access required) |

## What Lives In This Repo

`AgenC` is the public umbrella repo. It keeps:

- top-level project positioning and routing
- repository topology docs
- bootstrap scripts for the multi-repo layout
- public-safe examples
- historical refactor records

It does **not** contain the private engine and it is **not** the canonical
source of truth for SDK, protocol, or plugin ABI packages.

## Repository Map

| Repo | Visibility | Purpose |
| --- | --- | --- |
| [`AgenC`](https://github.com/tetsuo-ai/AgenC) | Public | Ecosystem hub, docs, bootstrap, public examples |
| [`agenc-sdk`](https://github.com/tetsuo-ai/agenc-sdk) | Public | TypeScript integration surface |
| [`agenc-protocol`](https://github.com/tetsuo-ai/agenc-protocol) | Public | Protocol, IDL, manifest, trust-surface artifacts |
| [`agenc-plugin-kit`](https://github.com/tetsuo-ai/agenc-plugin-kit) | Public | Plugin/add-on authoring contract |
| `agenc-core` | Private | Runtime, MCP, desktop, apps, TUI, daemon, internal tools |
| `agenc-prover` | Private | Prover service, admin flows, operator proving surfaces |

More detail lives in [docs/REPOSITORY_TOPOLOGY.md](docs/REPOSITORY_TOPOLOGY.md).

## Quick Start

### Bootstrap The Public Repos

Clone or update the public repo set side by side:

```bash
./scripts/bootstrap-agenc-repos.sh --root /path/to/agenc
```

If you have private access too:

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

### Validate This Umbrella Repo

From this repo:

```bash
npm install --no-fund
npm run validate:umbrella
```

That validates the public examples and umbrella boundary contract only. It does
not install or run the private AgenC core.

## Public Examples

These examples are intentionally limited to the public surfaces:

| Example | Purpose |
| --- | --- |
| [examples/simple-usage](examples/simple-usage/) | Minimal SDK example for the private completion flow |
| [examples/tetsuo-integration](examples/tetsuo-integration/) | End-to-end example of an external agent claiming work and submitting a private completion payload |
| [examples/helius-webhook](examples/helius-webhook/) | Real-time monitoring of AgenC task events via Helius webhooks |
| [examples/risc0-proof-demo](examples/risc0-proof-demo/) | Small proof-payload and account-model demo for `complete_task_private` |

For private runtime, operator, or product-facing examples, use `agenc-core`
instead of this repo.

## Need The Full Product?

If what you want is the full AgenC operator experience, including:

- the runtime
- the TUI / daemon workflow
- web and desktop product surfaces
- private operator tooling

those live in `agenc-core`, which is private. This public repo is meant to help
you find the right surface, not to replace the private core checkout.

## Support And Contribution Routing

Open issues and changes in the repo that owns the surface you are touching:

- SDK work -> `agenc-sdk`
- protocol / trust-surface work -> `agenc-protocol`
- plugin ABI / add-on surface -> `agenc-plugin-kit`
- private runtime / TUI / web / desktop / operator tooling -> `agenc-core`
- prover / admin / proving ops -> `agenc-prover`

If you are unsure where something belongs, start with this repo and use the
topology docs to route it correctly.

## Versioned Package Docs

This umbrella repo does not own package release docs. Use:

- [docs/VERSION_DOCS_MAP.md](docs/VERSION_DOCS_MAP.md)
- [docs/SDK.md](docs/SDK.md)
- [docs/PLUGIN_KIT.md](docs/PLUGIN_KIT.md)

## Historical Records

The completed refactor program is retained here as historical context:

- [REFACTOR.MD](REFACTOR.MD)
- [REFACTOR-MASTER-PROGRAM.md](REFACTOR-MASTER-PROGRAM.md)

These are archival program records, not active setup instructions.

## License

GPL-3.0. See [LICENSE](LICENSE).
