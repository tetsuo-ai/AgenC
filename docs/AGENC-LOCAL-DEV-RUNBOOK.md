# AgenC Local Dev Environment Runbook

> **Status:** Active  
> **Last updated:** 2026-03-18 (evening — agenc-core went public, ADR-003 adopted)  
> **Author:** letterj  
> **Purpose:** Reproducible setup for a contributor-ready local AgenC development environment

---

## Context

AgenC completed a whole-repository refactor program on 2026-03-17 (Gates 0–12).
On 2026-03-18 the team adopted ADR-003, making `agenc-core` and `agenc-prover`
public and reframing AgenC as a public framework product rather than a private
kernel with a public SDK.

### Architecture Decision Records

| ADR | Status | Summary |
|---|---|---|
| ADR-002 | **Superseded** | Public contracts + private kernel boundary |
| ADR-003 | **Current** | AgenC is a public framework product |

ADR-003 reasoning: *"Source privacy is not the right primary moat for a
local-first agent framework. Product quality, ecosystem, marketplace
participation, operational advantage, and premium network services are."*

### Repository Topology (as of 2026-03-18 evening)

| Repo | Visibility | Role |
|---|---|---|
| `AgenC` | Public | Umbrella — docs, examples, bootstrap scripts |
| `agenc-sdk` | Public | TypeScript SDK (`@tetsuo-ai/sdk`) |
| `agenc-protocol` | Public | Program source, IDL, generated artifacts (`@tetsuo-ai/protocol`) |
| `agenc-plugin-kit` | Public | Plugin/channel adapter ABI (`@tetsuo-ai/plugin-kit`) |
| `agenc-core` | Public ← **went public 2026-03-18** | Runtime engine, daemon, MCP, web, mobile, desktop |
| `agenc-prover` | Public ← **went public 2026-03-18** | ZK prover service, admin tools |
| Private registry | N/A | Cloudsmith `agenc/private-kernel` |

### Published Package Versions (2026-03-18)

| Package | Version |
|---|---|
| `@tetsuo-ai/sdk` | 1.3.1 |
| `@tetsuo-ai/protocol` | 0.1.1 |
| `@tetsuo-ai/plugin-kit` | 0.1.1 |

---

## Prerequisites

Verify all tools before starting:

```bash
node --version      # >= 18 required
npm --version
rustc --version     # stable
solana --version    # 3.0.13
anchor --version    # 0.32.1
docker --version
ollama --version    # optional, for semantic memory
```

Confirmed working versions (2026-03-18):

```
node      v20.20.1
npm       10.8.2
rustc     1.94.0
solana    3.0.13
anchor    0.32.1
docker    28.5.2
ollama    0.17.7
```

---

## Devnet Setup

### Wallet

```bash
solana config set --url devnet
solana address    # your devnet pubkey
solana balance    # confirm SOL balance
```

Contributor wallet used in this setup:
- **Address:** `BP3rDSMHG4oHkJsB4voh6xiB3pp2Y2MDcT3yHhaPGxWT`
- **Balance:** ~18.5 SOL (sufficient for all experiments)

### Program Addresses

| Network | Program ID |
|---|---|
| **Devnet** | `6UcJzbTEemBz3aY5wK5qKHGMD7bdRsmR4smND29gB2ab` |
| Mainnet | `5j9ZbT3mnPX5QjWVMrDaWFuaGf8ddji6LW1HVJw6kUE7` |

> ⚠️ The mainnet address (`5j9Z...`) is **not** the devnet address. Always use `6UcJ...` for devnet work.

Verify the devnet program is live:

```bash
solana program show 6UcJzbTEemBz3aY5wK5qKHGMD7bdRsmR4smND29gB2ab --url devnet
```

### Known Devnet Drift (as of 2026-03-18)

The devnet-deployed program has error name drift vs the current SDK source.
**The happy path works fine.** Edge case error names differ:

| Scenario | SDK expects | Devnet returns |
|---|---|---|
| Below minimum stake | `InsufficientStake` | `InsufficientFunds` |
| Past deadline task | `InvalidInput` | `UpdateTooFrequent` |
| Self-claim own task | `SelfTaskNotAllowed` | `ProposalUnauthorizedCancel` |
| Complete without claim | `NotClaimed` | `AccountNotInitialized` |
| Cancel after complete | `InvalidStatusTransition` | `AccountNotInitialized` |

SDK PR #2 (merged 2026-03-18) added explicit compat/strict test modes:

```bash
cd forks/agenc-sdk
npm run test:devnet:public          # happy path only
npm run test:devnet:deep            # compat mode, known drift logged
npm run test:devnet:deep:strict     # fails until devnet matches local source
```

Issue #6 is open to regenerate the SDK error map from the current protocol IDL.

---

## Workspace Layout

All repos live under a single parent directory:

```
~/workshop/agencproj/
├── AgenC/               ← tetsuo-ai original (reference, do not edit)
├── agenc-sdk/           ← tetsuo-ai original (reference, do not edit)
├── agenc-protocol/      ← tetsuo-ai original (reference, do not edit)
├── agenc-plugin-kit/    ← tetsuo-ai original (reference, do not edit)
├── agenc-core/          ← tetsuo-ai original (reference, do not edit) — added 2026-03-18
├── agenc-prover/        ← tetsuo-ai original (reference, do not edit) — added 2026-03-18
├── CLAUDE.md            ← workspace quick reference
└── forks/
    ├── AgenC/           ← letterj fork (work here)
    ├── agenc-sdk/       ← letterj fork (work here)
    ├── agenc-protocol/  ← letterj fork (work here)
    ├── agenc-plugin-kit/ ← letterj fork (work here)
    └── agenc-core/      ← letterj fork (work here) — added 2026-03-18
```

---

## Setup Steps

### Step 1 — Clone the tetsuo-ai reference repos

```bash
mkdir -p ~/workshop/agencproj
cd ~/workshop/agencproj
git clone https://github.com/tetsuo-ai/AgenC.git
```

### Step 2 — Run the bootstrap script to clone all public repos

```bash
cd ~/workshop/agencproj
./AgenC/scripts/bootstrap-agenc-repos.sh --root ~/workshop/agencproj
```

This clones `AgenC`, `agenc-sdk`, `agenc-protocol`, and `agenc-plugin-kit` from tetsuo-ai.

### Step 3 — Clone the additional public repos (went public 2026-03-18)

```bash
cd ~/workshop/agencproj
git clone https://github.com/tetsuo-ai/agenc-core.git
git clone https://github.com/tetsuo-ai/agenc-prover.git
```

### Step 4 — Fork all five repos on GitHub

Fork each of these under your GitHub account:

- https://github.com/tetsuo-ai/AgenC/fork
- https://github.com/tetsuo-ai/agenc-sdk/fork
- https://github.com/tetsuo-ai/agenc-protocol/fork
- https://github.com/tetsuo-ai/agenc-plugin-kit/fork
- https://github.com/tetsuo-ai/agenc-core/fork

### Step 5 — Clone your forks using the bootstrap script

```bash
AGENC_GIT_BASE=https://github.com/YOUR_USERNAME \
  ./AgenC/scripts/bootstrap-agenc-repos.sh --root ~/workshop/agencproj/forks
```

Then clone agenc-core fork manually (not in bootstrap script yet):

```bash
cd ~/workshop/agencproj/forks
git clone git@github.com:YOUR_USERNAME/agenc-core.git
```

### Step 6 — Set all fork remotes to SSH

> ⚠️ HTTPS remotes will fail to push without a credential manager. Always use SSH.

```bash
for repo in AgenC agenc-sdk agenc-protocol agenc-plugin-kit; do
  git -C ~/workshop/agencproj/forks/$repo remote set-url origin \
    git@github.com:YOUR_USERNAME/$repo.git
  echo "✅ $repo remote → SSH"
done
# agenc-core was cloned via SSH so it's already correct
```

### Step 7 — Add upstream remotes to all forks

```bash
for repo in AgenC agenc-sdk agenc-protocol agenc-plugin-kit agenc-core; do
  git -C ~/workshop/agencproj/forks/$repo remote add upstream \
    https://github.com/tetsuo-ai/$repo.git
  echo "✅ $repo upstream set"
done
```

### Step 8 — Fix agenc-protocol default branch (fork quirk)

The `agenc-protocol` fork defaults to `feature/bootstrap-wave1` instead of `main`. Fix it:

1. Go to: `https://github.com/YOUR_USERNAME/agenc-protocol/settings`
2. Under **Default branch**, click the switch icon
3. Select `main` and click **Update**
4. Confirm

Then sync your local clone:

```bash
cd ~/workshop/agencproj/forks/agenc-protocol
git fetch origin
git checkout main
```

### Step 9 — Create working branches across all forks

```bash
for repo in AgenC agenc-sdk agenc-protocol agenc-plugin-kit agenc-core; do
  cd ~/workshop/agencproj/forks/$repo
  git checkout main
  git checkout -b experiment/local-dev-setup
  echo "✅ $repo → experiment/local-dev-setup"
done
```

---

## Verify Setup

```bash
for repo in AgenC agenc-sdk agenc-protocol agenc-plugin-kit agenc-core; do
  echo "=== $repo ==="
  git -C ~/workshop/agencproj/forks/$repo remote -v | grep -E "origin|upstream"
  git -C ~/workshop/agencproj/forks/$repo branch --show-current
  echo ""
done
```

Expected output for each repo:
```
origin    git@github.com:YOUR_USERNAME/REPO.git (fetch)
upstream  https://github.com/tetsuo-ai/REPO.git (fetch)
experiment/local-dev-setup
```

---

## Staying Current

Run this at the start of each session to check for upstream changes:

```bash
for repo in AgenC agenc-sdk agenc-protocol agenc-plugin-kit agenc-core; do
  echo "=== $repo ==="
  git -C ~/workshop/agencproj/$repo fetch origin --quiet
  git -C ~/workshop/agencproj/$repo log --oneline --since="yesterday" origin/main \
    2>/dev/null || echo "no new commits"
done
```

To sync a fork with upstream:

```bash
cd ~/workshop/agencproj/forks/REPO
git fetch upstream
git checkout main
git merge upstream/main
git push origin main
```

---

## Contributor Workflow

### Starting new work

```bash
cd ~/workshop/agencproj/forks/REPO
git checkout main
git pull upstream main        # sync with tetsuo-ai
git push origin main          # update your fork
git checkout -b feature/my-feature
```

### Submitting a PR

1. Push your branch: `git push origin feature/my-feature`
2. Open a PR from `YOUR_USERNAME/REPO:feature/my-feature` → `tetsuo-ai/REPO:main`
3. Reference ADR-003 for any runtime/product surface changes
4. Include passing gate check evidence

---

## Example Progression

The four public examples in `forks/AgenC/examples/` are designed to be worked
through in order:

| Order | Example | What It Teaches |
|---|---|---|
| 1 | `risc0-proof-demo` | Anatomy of a ZK proof — byte fields, account structure |
| 2 | `simple-usage` | How to generate and submit a proof payload |
| 3 | `tetsuo-integration` | Full agent workflow — discover, claim, execute, submit, get paid |
| 4 | `helius-webhook` | Real-time on-chain monitoring of task completions |

```bash
cd ~/workshop/agencproj/forks/AgenC/examples/EXAMPLE_NAME
npm install
# follow the example's README
```

---

## agenc-core Development

`agenc-core` is now a public framework repo. Build and test it locally:

```bash
cd ~/workshop/agencproj/forks/agenc-core
npm install
npm run build
npm run typecheck
npm run test
npm run test:cross-repo-integration  # requires protocol workspace fixture
```

Key directories inside `agenc-core`:

| Path | What it is |
|---|---|
| `runtime/src/` | Full agent runtime — 32 modules |
| `packages/agenc/` | Public `agenc` CLI install surface |
| `mcp/` | MCP server |
| `web/` | Browser UI |
| `containers/desktop/` | Docker desktop sandbox |
| `docs/architecture/adr/` | Architecture decision records |

---

## Key Facts and Gotchas

- **ADR-003 is current** — `agenc-core` is public as of 2026-03-18; ADR-002 is superseded
- **`@tetsuo-ai/runtime` is still a private kernel package** — source is visible in `agenc-core` but the npm package is distributed via Cloudsmith, not public npm
- **All fork remotes must use SSH** — HTTPS pushes fail without a credential manager
- **The `sdk/` and `plugin-kit/` directories in `AgenC` are deleted** — use npm packages
- **Devnet and mainnet use different program IDs** — see Program Addresses above
- **`agenc-protocol` fork default branch quirk** — always fix to `main` after forking (Step 8)
- **`feature/bootstrap-wave1` in agenc-protocol** — historical artifact, 26,700 lines behind `main`
- **The umbrella `AgenC` root has no `build` script** — it is `agenc-umbrella@1.0.0`
- **Devnet error names drift from SDK** — happy path works, edge case error names do not match
- **SDK issue #6 is open** — regenerating error map from current protocol IDL

---

## Reference Links

| Resource | URL |
|---|---|
| AgenC umbrella | https://github.com/tetsuo-ai/AgenC |
| agenc-core | https://github.com/tetsuo-ai/agenc-core |
| agenc-sdk | https://github.com/tetsuo-ai/agenc-sdk |
| agenc-protocol | https://github.com/tetsuo-ai/agenc-protocol |
| agenc-plugin-kit | https://github.com/tetsuo-ai/agenc-plugin-kit |
| Devnet program (Solscan) | https://solscan.io/account/6UcJzbTEemBz3aY5wK5qKHGMD7bdRsmR4smND29gB2ab?cluster=devnet |
| ADR-003 | `forks/agenc-core/docs/architecture/adr/adr-003-public-framework-product.md` |
| Refactor program record | `REFACTOR-MASTER-PROGRAM.md` in AgenC repo |
| Devnet compatibility report | `forks/agenc-sdk/docs/devnet-compatibility.md` |

---

## agenc-sdk Validation Gates

Before committing or opening a PR against `tetsuo-ai/agenc-sdk`, run these in order.
Established by PR #10 (2026-03-19) as the canonical validation suite:
```bash
cd ~/workshop/agencproj/forks/agenc-sdk
npm run typecheck
npm test
npm run build
npm run pack:smoke
npx -y node@20 scripts/pack-smoke.mjs
```

The `node@20 scripts/pack-smoke.mjs` step specifically tests packaged CJS/ESM
interop in Node 20 — the regression that catches the anchor.BN issue fixed in PR #9.
