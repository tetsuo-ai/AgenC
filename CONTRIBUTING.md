# Contributing to AgenC

## Setup

```bash
git clone https://github.com/tetsuo-ai/AgenC.git
cd AgenC
npm install
```

### Prerequisites

- Node.js 18+
- Rust 1.79+ with `rustup target add sbf-solana-solana`
- Solana CLI 1.18+ (`sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"`)
- Anchor 0.32+ (`avm install 0.32.1 && avm use 0.32.1`)

Optional (for ZK circuit development):
- Circom 2.1.6+ (`npm install -g circom`)
- snarkjs (`npm install -g snarkjs`)

### Build

```bash
# TypeScript packages
npm run build

# On-chain program
anchor build

# ZK circuits
cd circuits-circom/task_completion && npm run build
```

### Type Check

```bash
npm run typecheck
```

## Run Tests

```bash
# Everything
npm test

# Anchor integration tests (requires solana-test-validator)
npm run test:anchor

# SDK unit tests
cd sdk && npm test

# Runtime unit tests
cd runtime && npm test
```

## Project Structure

```
programs/agenc-coordination/    Anchor on-chain program (Rust)
sdk/                            @agenc/sdk - Core TypeScript SDK
runtime/                        @agenc/runtime - Agent lifecycle + skills
mcp/                            @agenc/mcp - Model Context Protocol server
adapters/
  langchain/                    LangChain adapter
  vercel-ai/                    Vercel AI SDK adapter
circuits-circom/                Groth16 ZK circuits
examples/                       Example implementations
tests/                          Anchor integration tests
docs/                           Documentation
```

## Making Changes

### On-Chain Program (Rust)

Program source is in `programs/agenc-coordination/src/`. After changes:

```bash
anchor build
npm run test:anchor
```

Security requirements for on-chain code:
- All authority accounts must use `Signer<'info>`
- Use `checked_add`/`checked_sub` for arithmetic (no raw operators)
- Prefer `init` over `init_if_needed` to prevent reinitialization
- Validate account owners before data access
- Add duplicate account checks when processing `remaining_accounts`
- See `docs/audit/solana-dev-skill-audit.md` for the full checklist

### SDK (TypeScript)

SDK source is in `sdk/src/`. After changes:

```bash
cd sdk
npm run build
npm test
```

### Runtime (TypeScript)

Runtime source is in `runtime/src/`. After changes:

```bash
cd runtime
npm run build
npm test
```

### Adapters

Adapter source is in `adapters/<framework>/src/`. Each adapter is an independent package:

```bash
cd adapters/langchain
npm install
npm run build
npm test
```

## Code Style

- No AI-generated comments that state the obvious
- No emoji in code
- No `// This function does X` when the function name says X
- Keep dependencies minimal
- Use `@solana/web3.js` only in boundary/adapter modules; core types should not depend on it directly (see migration plan in audit report)
- All new on-chain code must pass the security checklist from `.agents/skills/solana-dev/security.md`

## Pull Requests

1. Create a feature branch from `main`
2. Make your changes with clear, focused commits
3. Ensure all tests pass (`npm test`)
4. Ensure type checking passes (`npm run typecheck`)
5. Write a PR description explaining what changed and why
6. Link any related issues

### PR Title Convention

```
feat: add CrewAI adapter
fix: prevent reinitialization in claim_task
docs: update quickstart with new API
test: add LiteSVM unit tests for SDK
refactor: isolate web3.js types behind compat boundary
```

## Reporting Issues

Open an issue at https://github.com/tetsuo-ai/AgenC/issues with:

- Steps to reproduce
- Expected vs actual behavior
- Solana cluster (devnet/mainnet)
- SDK version (`npm list @agenc/sdk`)

## License

GPL-3.0. By contributing, you agree that your contributions will be licensed under the same license.
