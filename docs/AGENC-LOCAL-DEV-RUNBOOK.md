# AgenC Local Dev Environment Runbook

> **Status:** Active  
> **Last updated:** 2026-03-18  
> **Author:** letterj  
> **Purpose:** Reproducible setup for a contributor-ready local AgenC development environment

---

## Context

AgenC completed a whole-repository refactor program on 2026-03-17 (Gates 0–12). The repo is now a distributed topology — not a monorepo. This runbook reflects the post-refactor reality.

### Repository Topology

| Repo | Visibility | Role |
|---|---|---|
| `AgenC` | Public | Umbrella — docs, examples, bootstrap scripts |
| `agenc-sdk` | Public | TypeScript SDK (`@tetsuo-ai/sdk`) |
| `agenc-protocol` | Public | Program source, IDL, generated artifacts (`@tetsuo-ai/protocol`) |
| `agenc-plugin-kit` | Public | Plugin/channel adapter ABI (`@tetsuo-ai/plugin-kit`) |
| `agenc-core` | **Private** | Runtime engine, daemon, MCP, product surfaces |
| `agenc-prover` | **Private** | ZK proof tooling, admin ops |

### Published Package Versions (as of 2026-03-18)

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
- **Balance:** 18.5 SOL (sufficient for all experiments)

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

Expected output:
```
Program Id: 6UcJzbTEemBz3aY5wK5qKHGMD7bdRsmR4smND29gB2ab
Owner: BPFLoaderUpgradeab1e11111111111111111111111
Authority: E9ws2V2vuv53HXRh8ydX5PRGAiCsg2QTmsTZAu145Frg
Data Length: 1536480 bytes
```

---

## Workspace Layout

All repos live under a single parent directory:

```
~/workshop/agencproj/
├── AgenC/               ← tetsuo-ai original (reference, do not edit)
├── agenc-sdk/           ← tetsuo-ai original (reference, do not edit)
├── agenc-protocol/      ← tetsuo-ai original (reference, do not edit)
├── agenc-plugin-kit/    ← tetsuo-ai original (reference, do not edit)
└── forks/
    ├── AgenC/           ← letterj fork (work here)
    ├── agenc-sdk/       ← letterj fork (work here)
    ├── agenc-protocol/  ← letterj fork (work here)
    └── agenc-plugin-kit/ ← letterj fork (work here)
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

### Step 3 — Fork all four repos on GitHub

Fork each of these under your GitHub account:

- https://github.com/tetsuo-ai/AgenC/fork
- https://github.com/tetsuo-ai/agenc-sdk/fork
- https://github.com/tetsuo-ai/agenc-protocol/fork
- https://github.com/tetsuo-ai/agenc-plugin-kit/fork

### Step 4 — Clone your forks

```bash
AGENC_GIT_BASE=https://github.com/YOUR_USERNAME \
  ./AgenC/scripts/bootstrap-agenc-repos.sh --root ~/workshop/agencproj/forks
```

Replace `YOUR_USERNAME` with your GitHub username.

### Step 5 — Add upstream remotes to all forks

```bash
for repo in AgenC agenc-sdk agenc-protocol agenc-plugin-kit; do
  git -C ~/workshop/agencproj/forks/$repo remote add upstream \
    https://github.com/tetsuo-ai/$repo.git
  echo "✅ $repo upstream set"
done
```

### Step 6 — Fix agenc-protocol default branch (fork quirk)

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

### Step 7 — Create working branches across all forks

```bash
for repo in AgenC agenc-sdk agenc-protocol agenc-plugin-kit; do
  cd ~/workshop/agencproj/forks/$repo
  git checkout main
  git checkout -b experiment/local-dev-setup
  echo "✅ $repo → experiment/local-dev-setup"
done
```

---

## Verify Setup

```bash
for repo in AgenC agenc-sdk agenc-protocol agenc-plugin-kit; do
  echo "=== $repo ==="
  git -C ~/workshop/agencproj/forks/$repo remote -v | grep -E "origin|upstream"
  git -C ~/workshop/agencproj/forks/$repo branch
done
```

Expected output for each repo:
```
origin    https://github.com/YOUR_USERNAME/REPO.git (fetch)
upstream  https://github.com/tetsuo-ai/REPO.git (fetch)
* experiment/local-dev-setup
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

### Syncing with upstream

```bash
git fetch upstream
git rebase upstream/main
```

### Submitting a PR

1. Push your branch to your fork: `git push origin feature/my-feature`
2. Open a PR from `YOUR_USERNAME/REPO:feature/my-feature` → `tetsuo-ai/REPO:main`

---

## Example Progression

The four public examples in `forks/AgenC/examples/` are designed to be worked through in order:

| Order | Example | What It Teaches |
|---|---|---|
| 1 | `risc0-proof-demo` | Anatomy of a ZK proof — byte fields, account structure |
| 2 | `simple-usage` | How to generate and submit a proof payload |
| 3 | `tetsuo-integration` | Full agent workflow — discover, claim, execute, submit, get paid |
| 4 | `helius-webhook` | Real-time on-chain monitoring of task completions |

Work from your fork:
```bash
cd ~/workshop/agencproj/forks/AgenC/examples/risc0-proof-demo
npm install
```

---

## Key Facts and Gotchas

- **The `sdk/` directory in `AgenC` is deleted** — it was a rollback mirror. Use `@tetsuo-ai/sdk` from npm.
- **The `plugin-kit/` directory in `AgenC` is deleted** — same reason. Use `@tetsuo-ai/plugin-kit` from npm.
- **`agenc-core` is private** — the runtime, MCP server, and product surfaces are not publicly accessible.
- **Devnet and mainnet use different program IDs** — see Program Addresses above.
- **`agenc-protocol` fork default branch quirk** — always fix to `main` after forking (Step 6).
- **`feature/bootstrap-wave1` in agenc-protocol** — historical artifact, 26,700 lines behind `main`. Ignore it.
- **The umbrella `AgenC` root has no `build` script** — it is `agenc-umbrella@1.0.0`, a workspace orchestration shell only.

---

## Reference Links

| Resource | URL |
|---|---|
| AgenC umbrella | https://github.com/tetsuo-ai/AgenC |
| agenc-sdk | https://github.com/tetsuo-ai/agenc-sdk |
| agenc-protocol | https://github.com/tetsuo-ai/agenc-protocol |
| agenc-plugin-kit | https://github.com/tetsuo-ai/agenc-plugin-kit |
| Devnet program (Solscan) | https://solscan.io/account/6UcJzbTEemBz3aY5wK5qKHGMD7bdRsmR4smND29gB2ab?cluster=devnet |
| Refactor program record | `REFACTOR-MASTER-PROGRAM.md` in AgenC repo |
