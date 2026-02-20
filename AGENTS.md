# Repository Guidelines

## Project Structure & Module Organization
- `programs/agenc-coordination/`: Anchor Solana program (Rust). Instruction handlers live in `src/instructions/`; fuzz targets live in `fuzz/`.
- `sdk/`, `runtime/`, `mcp/`, and `docs-mcp/`: core TypeScript packages built and tested independently.
- `tests/`: root integration suite (LiteSVM + Anchor flows).
- `zkvm/`: RISC Zero guest/host programs for ZK proof generation and verification.
- App surfaces: `web/`, `mobile/`, `demo-app/`, and `examples/`.
- Operational docs/scripts: `docs/` and `scripts/`.

## Build, Test, and Development Commands
- `npm install`: install repository dependencies.
- `npm run build`: build SDK, Runtime, MCP, and Docs MCP packages.
- `anchor build`: compile the on-chain program.
- `npm run typecheck`: run TypeScript checks across core packages.
- `npm run test`: run SDK + Runtime unit tests.
- `npm run test:fast`: run fast LiteSVM integration coverage.
- `npm run test:anchor`: run full Anchor tests (requires local validator tooling).
- `./scripts/setup-dev.sh`: full bootstrap (env checks, builds, tests).

## Coding Style & Naming Conventions
- TypeScript uses strict typing and 2-space indentation; preserve existing per-package style.
- In runtime/sdk code, keep ESM relative imports with `.js` suffixes.
- Use `bigint` for on-chain u64 values; use `BN` only at Anchor instruction boundaries.
- Runtime module layout should follow: `types.ts`, `errors.ts`, `<module>.ts`, `<module>.test.ts`, `index.ts`.
- Rust changes should pass `cargo fmt --check` and `cargo clippy`.

## Testing Guidelines
- Unit tests are co-located as `*.test.ts` (primarily under `runtime/src/**` and `sdk/src/**`, run via Vitest).
- Root `tests/*.ts` covers protocol/integration behavior with LiteSVM and Anchor test utilities.
- Add or update regression tests with behavior changes; run `npm run test:fast && npm run typecheck` before opening a PR.

## Commit & Pull Request Guidelines
- Use Conventional Commits (examples: `feat(runtime): add replay gate`, `fix(program): validate deadline`).
- Work from a focused branch such as `feature/<short-name>`.
- Follow `.github/PULL_REQUEST_TEMPLATE.md`: include summary, change list, testing checklist, security/risk checklist, and linked issue(s).
- Update docs when protocol APIs, operational behavior, or developer workflows change.
