# AgenC Local Dev Environment Runbook

> **Status:** Active  
> **Last updated:** 2026-03-20  
> **Author:** letterj  
> **Purpose:** Reproducible setup for a contributor-ready local AgenC development environment

---

## Context

AgenC completed a whole-repository refactor program on 2026-03-17 (Gates 0–12).
On 2026-03-18 the team adopted ADR-003, making `agenc-core` and `agenc-prover`
public and reframing AgenC as a public framework product.

On 2026-03-20 the first working operator instance was confirmed running in Docker.

### Architecture Decision Records

| ADR | Status | Summary |
|---|---|---|
| ADR-002 | **Superseded** | Public contracts + private kernel boundary |
| ADR-003 | **Current** | AgenC is a public framework product |

### Repository Topology (as of 2026-03-20)

| Repo | Visibility | Role |
|---|---|---|
| `AgenC` | Public | Umbrella — docs, examples, bootstrap scripts |
| `agenc-sdk` | Public | TypeScript SDK (`@tetsuo-ai/sdk`) |
| `agenc-protocol` | Public | Program source, IDL, generated artifacts (`@tetsuo-ai/protocol`) |
| `agenc-plugin-kit` | Public | Plugin/channel adapter ABI (`@tetsuo-ai/plugin-kit`) |
| `agenc-core` | Public | Runtime engine, daemon, MCP, web, mobile, desktop |
| `agenc-prover` | Public | ZK prover service, admin tools |

### Published Package Versions (2026-03-20)

| Package | Version |
|---|---|
| `@tetsuo-ai/sdk` | 1.3.1 |
| `@tetsuo-ai/protocol` | 0.1.1 |
| `@tetsuo-ai/plugin-kit` | 0.1.1 |
| `@tetsuo-ai/agenc` | 0.1.0 |

---

## Prerequisites

```
node      v20.20.1
npm       10.8.2
rustc     1.94.0
solana    3.0.13
anchor    0.32.1
docker    28.5.2
ollama    0.17.7 (optional)
```

---

## Devnet Setup

**Wallet:** `BP3rDSMHG4oHkJsB4voh6xiB3pp2Y2MDcT3yHhaPGxWT`  
**Balance:** ~18.5 SOL  
**Program ID (devnet):** `6UcJzbTEemBz3aY5wK5qKHGMD7bdRsmR4smND29gB2ab`

> ⚠️ Mainnet program ID (`5j9ZbT3...`) is different. Never use mainnet for experiments.

### Known Devnet Drift (as of 2026-03-18)

The happy path works. Edge case error names differ from SDK expectations:

| Scenario | SDK expects | Devnet returns |
|---|---|---|
| Below minimum stake | `InsufficientStake` | `InsufficientFunds` |
| Past deadline task | `InvalidInput` | `UpdateTooFrequent` |
| Self-claim own task | `SelfTaskNotAllowed` | `ProposalUnauthorizedCancel` |
| Complete without claim | `NotClaimed` | `AccountNotInitialized` |

---

## Workspace Layout

```
~/workshop/agencproj/
├── AgenC/               ← tetsuo-ai reference (read only)
├── agenc-sdk/           ← tetsuo-ai reference (read only)
├── agenc-protocol/      ← tetsuo-ai reference (read only)
├── agenc-plugin-kit/    ← tetsuo-ai reference (read only)
├── agenc-core/          ← tetsuo-ai reference (read only)
├── agenc-prover/        ← tetsuo-ai reference (read only)
├── Dockerfile.agenc     ← operator Docker image
├── CLAUDE.md            ← workspace quick reference
└── forks/
    ├── AgenC/           ← letterj fork (work here)
    ├── agenc-sdk/       ← letterj fork (work here)
    ├── agenc-protocol/  ← letterj fork (work here)
    ├── agenc-plugin-kit/ ← letterj fork (work here)
    └── agenc-core/      ← letterj fork (work here)
```

---

## Fork Setup

### Step 1 — Clone reference repos

```bash
mkdir -p ~/workshop/agencproj
cd ~/workshop/agencproj
git clone https://github.com/tetsuo-ai/AgenC.git
./AgenC/scripts/bootstrap-agenc-repos.sh --root ~/workshop/agencproj
git clone https://github.com/tetsuo-ai/agenc-core.git
git clone https://github.com/tetsuo-ai/agenc-prover.git
```

### Step 2 — Fork all five repos on GitHub

- https://github.com/tetsuo-ai/AgenC/fork
- https://github.com/tetsuo-ai/agenc-sdk/fork
- https://github.com/tetsuo-ai/agenc-protocol/fork
- https://github.com/tetsuo-ai/agenc-plugin-kit/fork
- https://github.com/tetsuo-ai/agenc-core/fork

### Step 3 — Clone forks using SSH

```bash
AGENC_GIT_BASE=https://github.com/letterj \
  ./AgenC/scripts/bootstrap-agenc-repos.sh --root ~/workshop/agencproj/forks

cd ~/workshop/agencproj/forks
git clone git@github.com:letterj/agenc-core.git
```

### Step 4 — Set SSH remotes and add upstream

```bash
for repo in AgenC agenc-sdk agenc-protocol agenc-plugin-kit; do
  git -C ~/workshop/agencproj/forks/$repo remote set-url origin \
    git@github.com:letterj/$repo.git
  git -C ~/workshop/agencproj/forks/$repo remote add upstream \
    https://github.com/tetsuo-ai/$repo.git
done
git -C ~/workshop/agencproj/forks/agenc-core remote add upstream \
  https://github.com/tetsuo-ai/agenc-core.git
```

### Step 5 — Fix agenc-protocol default branch

The fork defaults to `feature/bootstrap-wave1`. Fix in GitHub:
Settings → Default branch → switch to `main`.

### Step 6 — Create working branches

```bash
for repo in AgenC agenc-sdk agenc-protocol agenc-plugin-kit agenc-core; do
  cd ~/workshop/agencproj/forks/$repo
  git checkout main
  git checkout -b experiment/local-dev-setup
done
```

---

## Daily Sync

Run at the start of each session:

```bash
for repo in AgenC agenc-sdk agenc-protocol agenc-plugin-kit agenc-core; do
  echo "=== $repo ==="
  git -C ~/workshop/agencproj/$repo fetch origin --quiet
  git -C ~/workshop/agencproj/$repo log --oneline --since="yesterday" origin/main \
    2>/dev/null || echo "no new commits"
done
```

Sync forks:

```bash
for repo in AgenC agenc-sdk agenc-core; do
  git -C ~/workshop/agencproj/forks/$repo fetch upstream
  git -C ~/workshop/agencproj/forks/$repo checkout main
  git -C ~/workshop/agencproj/forks/$repo merge upstream/main
  git -C ~/workshop/agencproj/forks/$repo push origin main
done
```

---

## agenc-sdk Validation Gates

Before committing or opening a PR against `tetsuo-ai/agenc-sdk`:

```bash
cd ~/workshop/agencproj/forks/agenc-sdk
npm run typecheck
npm test
npm run build
npm run pack:smoke
npx -y node@20 scripts/pack-smoke.mjs
```

The last command specifically tests packaged CJS/ESM interop in Node 20.
Established by PR #10 (2026-03-19).

---

## Operator Instance (Docker)

The `agenc` CLI only supports **Linux x64**. On macOS, run it in Docker.

### Dockerfile

Located at `~/workshop/agencproj/Dockerfile.agenc`:

```dockerfile
FROM --platform=linux/amd64 node:20-slim

RUN apt-get update -qq && \
    apt-get install -y vim curl socat python3 make g++ iproute2 -qq && \
    rm -rf /var/lib/apt/lists/*

RUN npm install -g @tetsuo-ai/agenc

RUN cat > /usr/local/bin/agenc-start.sh << 'SCRIPT'
#!/bin/bash
set -e
if [ ! -f /root/.agenc/config.json ]; then
  agenc onboard || true
fi
SQLITE_PATH=$(find /root/.agenc/runtime -name "better_sqlite3.node" 2>/dev/null | head -1)
if [ -n "$SQLITE_PATH" ]; then
  SQLITE_DIR=$(dirname $(dirname $SQLITE_PATH))
  cd $SQLITE_DIR && npm rebuild 2>/dev/null || true
fi
agenc start
socat TCP-LISTEN:3101,fork,reuseaddr TCP:127.0.0.1:3100 &
echo "✅ AgenC running — UI at http://localhost:3100/ui/"
tail -f /root/.agenc/daemon.log
SCRIPT

RUN chmod +x /usr/local/bin/agenc-start.sh
EXPOSE 3101
CMD ["bash"]
```

### Build the image

```bash
docker build --platform linux/amd64 \
  -t agenc-operator \
  -f ~/workshop/agencproj/Dockerfile.agenc \
  ~/workshop/agencproj/
```

### Run the container

```bash
docker run -it --platform linux/amd64 \
  --name agenc-operator \
  -p 3100:3101 \
  agenc-operator
```

### First-time setup inside container

```bash
# 1. Generate default config
agenc onboard

# 2. Edit config — add LLM provider and fix host binding
vim /root/.agenc/config.json
```

Required config additions:

```json
{
  "gateway": {
    "port": 3100,
    "host": "0.0.0.0"
  },
  "agent": {
    "name": "letterj-operator"
  },
  "llm": {
    "provider": "grok",
    "apiKey": "YOUR_GROK_KEY",
    "model": "grok-3"
  },
  "memory": {
    "backend": "sqlite",
    "dbPath": "/root/.agenc/memory.db"
  }
}
```

```bash
# 3. Start daemon, rebuild sqlite, start socat
agenc-start.sh
```

### Subsequent starts (container already configured)

```bash
docker start -ai agenc-operator
# Inside container:
agenc-start.sh
```

### Access the UI

Open in browser: **http://localhost:3100/ui/**

---

## Known Issues

### 1. `gateway.host` config field is ignored (hardcoded to 127.0.0.1)

**Repo:** `agenc-core`  
**Symptom:** The daemon always binds to `127.0.0.1:3100` regardless of
`gateway.host` setting in config. Makes the daemon unreachable from outside
the container even with port mapping.  
**Workaround:** Use `socat TCP-LISTEN:3101,fork,reuseaddr TCP:127.0.0.1:3100 &`
inside the container, then map port 3101.  
**Status:** Not yet filed — candidate for issue + PR against `agenc-core`.

### 2. `better-sqlite3` native addon must be rebuilt in Docker

**Symptom:** `Module did not self-register: better_sqlite3.node` on first start.  
**Fix:** 
```bash
cd /root/.agenc/runtime/releases/0.1.0/linux-x64/node_modules/better-sqlite3
npm rebuild
```
The `agenc-start.sh` script handles this automatically.

### 3. `agenc onboard` is non-interactive and does not prompt for LLM config

**Symptom:** Onboard generates a minimal config with no `llm` block.  
**Fix:** Manually add the `llm` section to `/root/.agenc/config.json` after onboarding.

### 4. `agenc` CLI only supports Linux x64

**Symptom:** `unsupported platform darwin-arm64` on macOS Apple Silicon.  
**Workaround:** Run in Docker with `--platform linux/amd64`.  
**Status:** No macOS issue filed upstream yet.

---

## Confirmed Working (2026-03-20)

- ✅ Agent registered on devnet: `GvXS49pWYMtgThmeVw32L7dPBFyCD1siYsTH4CaobpEs`
- ✅ Daemon running in Docker: `agenc-operator` container
- ✅ Web UI accessible: `http://localhost:3100/ui/`
- ✅ Grok LLM connected: `grok-3`
- ✅ Agent queried live devnet tasks via on-chain tools
- ✅ 4 open tasks visible on devnet with real SOL rewards

---

## Contributions Made

| Repo | PR | Description | Status |
|---|---|---|---|
| `agenc-sdk` | #9 | fix(build): externalize @coral-xyz/anchor, namespace import for BN interop | Merged |
| `agenc-sdk` | Issue #8 | anchor.BN undefined in CJS and ESM contexts | Closed |

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
| Devnet compatibility report | `forks/agenc-sdk/docs/devnet-compatibility.md` |
