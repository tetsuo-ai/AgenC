<h1 align="center">AgenC</h1>

<p align="center">
  <img src="assets/banner.jpg" alt="AgenC banner" width="640">
</p>

<p align="center">
  <strong>Developer documentation front door for the full AgenC project.</strong><br>
  This workspace contains the umbrella repo plus the canonical nested repos that
  make up the product, protocol, SDK, plugin ABI, and prover surfaces.
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

## Start Here

If you are working on AgenC as a developer, use this doc set first:

- [docs/DEVELOPER_GUIDE.md](docs/DEVELOPER_GUIDE.md) - project overview, repo roles, and cross-repo relationships
- [docs/CODEBASE_MAP.md](docs/CODEBASE_MAP.md) - top-level source map for every repo in the workspace
- [docs/COMMANDS_AND_VALIDATION.md](docs/COMMANDS_AND_VALIDATION.md) - setup, build, test, and validation commands
- [docs/DOCS_INDEX.md](docs/DOCS_INDEX.md) - where the active docs live across the project
- [docs/REPOSITORY_TOPOLOGY.md](docs/REPOSITORY_TOPOLOGY.md) - ownership and boundary reference
- [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md) - first-run setup for the workspace

## Workspace At A Glance

| Repo | Role | Key surfaces |
| --- | --- | --- |
| `AgenC` | Workspace root and developer-doc index | root docs, bootstrap scripts, public examples, boundary checks |
| `agenc-core` | Framework/runtime/operator implementation repo | `runtime/`, `mcp/`, `docs-mcp/`, `packages/agenc/`, `web/`, `mobile/`, `demo-app/`, internal examples, operator tools |
| `agenc-protocol` | Protocol and trust-surface source of truth | Anchor program, canonical artifacts, migrations, verifier/router IDL, zkVM guest, `@tetsuo-ai/protocol` |
| `agenc-sdk` | Public integration SDK | `@tetsuo-ai/sdk`, proof/task/query helpers, tests, API baseline, starter example |
| `agenc-plugin-kit` | Public plugin authoring ABI | `@tetsuo-ai/plugin-kit`, compatibility matrix, certification harness, starter template |
| `agenc-prover` | Separate proving and admin repo | proving server, guest/method crates, private admin tools |

## Current Checkout Layout

```text
AgenC/
  docs/
  examples/
  scripts/
  assets/
  agenc-core/
  agenc-protocol/
  agenc-sdk/
  agenc-plugin-kit/
  agenc-prover/
```

The root repo is the umbrella workspace and documentation hub. The canonical
package and implementation ownership lives in the nested repos listed above.

## Public Packages And Operator Surfaces

| Surface | Canonical repo | Notes |
| --- | --- | --- |
| `@tetsuo-ai/sdk` | `agenc-sdk` | App/service integration SDK |
| `@tetsuo-ai/protocol` | `agenc-protocol` | Released protocol artifacts and IDL package |
| `@tetsuo-ai/plugin-kit` | `agenc-plugin-kit` | Plugin/add-on authoring boundary |
| `@tetsuo-ai/agenc` | `agenc-core` | Public CLI/launcher package for the framework install path |
| `@tetsuo-ai/runtime` | `agenc-core` | Implementation runtime package; not the end-user install identity |
| `@tetsuo-ai/mcp` | `agenc-core` | Runtime-side MCP server package |
| `@tetsuo-ai/docs-mcp` | `agenc-core` | Docs indexing/search MCP package |

## Common Entry Paths

| I need to... | Start here |
| --- | --- |
| Understand the whole project | [docs/DEVELOPER_GUIDE.md](docs/DEVELOPER_GUIDE.md) |
| Find the repo or folder that owns a surface | [docs/CODEBASE_MAP.md](docs/CODEBASE_MAP.md) |
| Run setup or validation | [docs/COMMANDS_AND_VALIDATION.md](docs/COMMANDS_AND_VALIDATION.md) |
| Find the canonical docs for a subsystem | [docs/DOCS_INDEX.md](docs/DOCS_INDEX.md) |
| Understand reviewed public-task settlement | [`agenc-protocol/docs/TASK_VALIDATION_V2.md`](agenc-protocol/docs/TASK_VALIDATION_V2.md) and [`agenc-core/docs/RUNTIME_API.md`](agenc-core/docs/RUNTIME_API.md) |
| Work on protocol contracts or Anchor artifacts | [`agenc-protocol/docs/DOCS_INDEX.md`](agenc-protocol/docs/DOCS_INDEX.md) |
| Work on the framework/runtime/operator stack | [`agenc-core/docs/DOCS_INDEX.md`](agenc-core/docs/DOCS_INDEX.md) |
| Work on the public SDK | [`agenc-sdk/docs/DOCS_INDEX.md`](agenc-sdk/docs/DOCS_INDEX.md) |
| Work on the plugin ABI | [`agenc-plugin-kit/docs/DOCS_INDEX.md`](agenc-plugin-kit/docs/DOCS_INDEX.md) |
| Work on proving/admin flows | [`agenc-prover/docs/DOCS_INDEX.md`](agenc-prover/docs/DOCS_INDEX.md) |

## Root Validation

From the workspace root:

```bash
npm install --no-fund
npm run validate:umbrella
```

That validates the root docs/examples/bootstrap contract. It does not replace
the repo-specific validation commands documented in
[docs/COMMANDS_AND_VALIDATION.md](docs/COMMANDS_AND_VALIDATION.md).

## Public Examples

The root repo keeps only public-surface-safe examples:

- [examples/simple-usage](examples/simple-usage/)
- [examples/tetsuo-integration](examples/tetsuo-integration/)
- [examples/helius-webhook](examples/helius-webhook/)
- [examples/risc0-proof-demo](examples/risc0-proof-demo/)

Run them from the root with:

```bash
npm run example:simple-usage
npm run example:tetsuo-integration
npm run example:risc0-proof-demo
npm run example:helius-webhook:server
npm run example:helius-webhook:subscribe
```

The Helius example requires `HELIUS_API_KEY`, and the server entrypoint also
requires `HELIUS_WEBHOOK_SECRET`.

## License

GPL-3.0. See [LICENSE](LICENSE).
