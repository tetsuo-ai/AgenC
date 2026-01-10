# Mainnet Deployment Runbook

**Protocol:** AgenC Coordination Protocol
**Anchor Version:** 0.30.1
**Current Program ID:** `EopUaCV2svxj9j4hd7KjbrWfdjkspmm2BCBe7jGpKzKZ`

This document provides step-by-step instructions for deploying the AgenC Coordination Protocol to Solana mainnet-beta.

---

## 1. Pre-Deployment Checklist

Complete all items before proceeding with mainnet deployment:

### Security Requirements
- [ ] External security audit complete (see `docs/SECURITY_AUDIT_MAINNET.md`)
- [ ] All Critical severity findings fixed and verified
- [ ] All High severity findings fixed and verified
- [ ] Medium/Low findings addressed or documented with accepted risk

### Testing Requirements
- [ ] All unit tests passing (`anchor test`)
- [ ] All integration tests passing on testnet
- [ ] Fuzz testing complete (issue #39)
- [ ] Internal security review complete (issue #46)
- [ ] Smoke tests validated on devnet (see `docs/DEVNET_VALIDATION.md`)

### Infrastructure Requirements
- [ ] Multisig wallet created (Squads Protocol or similar)
- [ ] All multisig signers have hardware wallets
- [ ] Treasury wallet created and secured
- [ ] RPC provider account set up (Helius, Triton, or QuickNode recommended)
- [ ] Monitoring infrastructure ready

### Documentation
- [ ] All protocol parameters finalized and documented
- [ ] Emergency procedures documented and distributed to team
- [ ] User communication prepared

---

## 2. Key Management

### 2.1 Generate Fresh Deploy Keypair

Never reuse devnet/testnet keys for mainnet.

```bash
# Create a new keypair for mainnet deployment
solana-keygen new --outfile ~/.config/solana/mainnet-deploy.json

# Display the public key (this will be the initial authority)
solana-keygen pubkey ~/.config/solana/mainnet-deploy.json

# Fund the keypair (requires ~3-5 SOL for deployment + rent)
# Transfer SOL from exchange or existing wallet
```

### 2.2 Set Up Multisig Upgrade Authority

Use Squads Protocol (squads.so) for multisig management:

1. Create a new Squad on mainnet with desired threshold (recommended: 3-of-5)
2. Add all authorized signers
3. Record the Squad vault address (this becomes the upgrade authority)

```bash
# After deployment, transfer upgrade authority to multisig
solana program set-upgrade-authority <PROGRAM_ID> \
  --new-upgrade-authority <SQUADS_VAULT_ADDRESS> \
  --keypair ~/.config/solana/mainnet-deploy.json
```

### 2.3 Key Rotation Procedures

| Key Type | Rotation Frequency | Procedure |
|----------|-------------------|-----------|
| Deploy keypair | One-time use | Archive securely after authority transfer |
| Multisig signers | As needed | Use Squads UI to add/remove members |
| Treasury | Rarely | Requires `update_protocol_fee` with multisig |
| RPC API keys | Quarterly | Rotate in provider dashboard |

### 2.4 Emergency Key Procedures

In case of suspected key compromise:

1. **Immediate:** Pause all protocol operations (if circuit breaker exists)
2. **Within 1 hour:** Convene multisig signers for emergency session
3. **If upgrade authority compromised:** Deploy new program, migrate state
4. **If treasury compromised:** Cannot recover lost funds; update treasury address for future fees
5. **Document:** Create incident report within 24 hours

---

## 3. Cluster Switch Steps

### 3.1 Update Anchor.toml

Current configuration (localnet):
```toml
[toolchain]
anchor_version = "0.30.1"

[features]
seeds = true
skip-lint = false

[programs.localnet]
agenc_coordination = "EopUaCV2svxj9j4hd7KjbrWfdjkspmm2BCBe7jGpKzKZ"

[provider]
cluster = "localnet"
wallet = "~/.config/solana/id.json"
```

Add mainnet configuration:
```toml
[programs.mainnet]
agenc_coordination = "EopUaCV2svxj9j4hd7KjbrWfdjkspmm2BCBe7jGpKzKZ"

[provider]
cluster = "mainnet"
wallet = "~/.config/solana/mainnet-deploy.json"
```

### 3.2 Update RPC Endpoints

Update all client configurations:

| Environment | RPC Endpoint |
|-------------|--------------|
| Localnet | `http://localhost:8899` |
| Devnet | `https://api.devnet.solana.com` |
| Testnet | `https://api.testnet.solana.com` |
| Mainnet | `https://api.mainnet-beta.solana.com` (or private RPC) |

**Recommended:** Use a private RPC provider for mainnet:
- Helius: `https://mainnet.helius-rpc.com/?api-key=<KEY>`
- Triton: `https://<PROJECT>.rpcpool.com`
- QuickNode: `https://<ENDPOINT>.solana-mainnet.quiknode.pro/<TOKEN>`

### 3.3 Program ID Considerations

**Option A: Keep Same Program ID**
- Requires the deploy keypair used for devnet
- Simpler for existing integrations
- IDL address remains consistent

**Option B: Fresh Program ID**
- Generate new keypair: `solana-keygen new --outfile mainnet-program.json`
- Update `declare_id!` in `programs/agenc-coordination/src/lib.rs`
- Update all Anchor.toml program entries
- Rebuild before deployment

### 3.4 Update IDL On-Chain

After deployment, publish the IDL:

```bash
# Initialize IDL account (first time)
anchor idl init <PROGRAM_ID> --filepath target/idl/agenc_coordination.json \
  --provider.cluster mainnet

# Or upgrade existing IDL
anchor idl upgrade <PROGRAM_ID> --filepath target/idl/agenc_coordination.json \
  --provider.cluster mainnet
```

---

## 4. Deployment Commands

### 4.1 Build for Mainnet

```bash
# Clean previous builds
anchor clean

# Build with verifiable flag for reproducibility
anchor build --verifiable

# Verify the build hash
solana-verify get-executable-hash target/deploy/agenc_coordination.so
```

Record the executable hash for audit verification.

### 4.2 Deploy Program

```bash
# Configure Solana CLI for mainnet
solana config set --url https://api.mainnet-beta.solana.com
solana config set --keypair ~/.config/solana/mainnet-deploy.json

# Check deployer balance (need ~3-5 SOL)
solana balance

# Deploy the program
anchor deploy --provider.cluster mainnet

# Or with explicit program keypair
solana program deploy target/deploy/agenc_coordination.so \
  --program-id <PROGRAM_KEYPAIR_PATH>
```

### 4.3 Initialize Protocol Configuration

Create an initialization script or use anchor test with custom script:

```typescript
// scripts/init-mainnet.ts
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";

const MAINNET_CONFIG = {
  disputeThreshold: 51,           // 51% majority required
  protocolFeeBps: 100,            // 1% protocol fee
  minArbiterStake: 10 * LAMPORTS_PER_SOL,  // 10 SOL minimum stake
  multisigThreshold: 3,           // 3-of-5 multisig
  multisigOwners: [
    new PublicKey("OWNER_1_PUBKEY"),
    new PublicKey("OWNER_2_PUBKEY"),
    new PublicKey("OWNER_3_PUBKEY"),
    new PublicKey("OWNER_4_PUBKEY"),
    new PublicKey("OWNER_5_PUBKEY"),
  ],
  treasury: new PublicKey("TREASURY_PUBKEY"),
};

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.AgencCoordination;

  const [protocolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol")],
    program.programId
  );

  const tx = await program.methods
    .initializeProtocol(
      MAINNET_CONFIG.disputeThreshold,
      MAINNET_CONFIG.protocolFeeBps,
      MAINNET_CONFIG.minArbiterStake,
      MAINNET_CONFIG.multisigThreshold,
      MAINNET_CONFIG.multisigOwners
    )
    .accounts({
      protocolConfig: protocolPda,
      treasury: MAINNET_CONFIG.treasury,
      authority: provider.wallet.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .remainingAccounts(
      MAINNET_CONFIG.multisigOwners.map(owner => ({
        pubkey: owner,
        isSigner: true,
        isWritable: false,
      }))
    )
    .rpc();

  console.log("Protocol initialized:", tx);
  console.log("Protocol PDA:", protocolPda.toBase58());
}

main().catch(console.error);
```

Run initialization:
```bash
# Using ts-node
npx ts-node scripts/init-mainnet.ts

# Or add to Anchor.toml scripts
# [scripts]
# init-mainnet = "npx ts-node scripts/init-mainnet.ts"
# Then run: anchor run init-mainnet --provider.cluster mainnet
```

### 4.4 Transfer Upgrade Authority

After successful initialization:

```bash
# Transfer to multisig
solana program set-upgrade-authority <PROGRAM_ID> \
  --new-upgrade-authority <SQUADS_VAULT_ADDRESS> \
  --keypair ~/.config/solana/mainnet-deploy.json

# Verify authority transfer
solana program show <PROGRAM_ID>
```

---

## 5. Post-Deployment Verification

### 5.1 Verify Program on Solana Explorer

1. Navigate to `https://explorer.solana.com/address/<PROGRAM_ID>`
2. Confirm:
   - Program is deployed and executable
   - Upgrade authority matches expected multisig
   - Data account shows correct size

### 5.2 Verify Protocol Configuration

```bash
# Fetch and display protocol config
solana account <PROTOCOL_PDA_ADDRESS> --output json
```

Verify:
- `authority` matches deployer
- `treasury` matches expected address
- `dispute_threshold` = 51
- `protocol_fee_bps` = 100
- `multisig_threshold` = 3
- `multisig_owners` contains all expected keys

### 5.3 Test Basic Instructions

Execute minimal test transactions with small amounts:

```bash
# 1. Register a test agent (use small stake)
# 2. Create a task with minimal reward (0.01 SOL)
# 3. Claim the task
# 4. Complete the task
# 5. Verify escrow distribution

# Run smoke test against mainnet (with caution)
anchor test --provider.cluster mainnet --skip-build -- --grep "smoke"
```

### 5.4 Verify PDA Derivations

Confirm all PDAs derive correctly on mainnet:

```typescript
const pdaChecklist = [
  { name: "protocol", seeds: [Buffer.from("protocol")] },
  { name: "agent", seeds: [Buffer.from("agent"), agentId] },
  { name: "task", seeds: [Buffer.from("task"), creator.toBuffer(), taskId] },
  { name: "escrow", seeds: [Buffer.from("escrow"), taskPda.toBuffer()] },
  { name: "claim", seeds: [Buffer.from("claim"), taskPda.toBuffer(), workerPda.toBuffer()] },
  { name: "state", seeds: [Buffer.from("state"), stateKey] },
  { name: "dispute", seeds: [Buffer.from("dispute"), disputeId] },
  { name: "vote", seeds: [Buffer.from("vote"), disputePda.toBuffer(), voterPda.toBuffer()] },
];
```

### 5.5 Verify Fee Recipient

```typescript
const config = await program.account.protocolConfig.fetch(protocolPda);
console.log("Treasury:", config.treasury.toBase58());
// Verify this matches expected treasury address
```

---

## 6. Monitoring Integration

### 6.1 Solana Explorer Alerts

Set up transaction monitoring:
- Monitor program address for all transactions
- Alert on failed transactions
- Alert on large value transfers

### 6.2 Metrics Collection (Prometheus/Grafana)

Key metrics to export:

```yaml
# prometheus.yml metrics
agenc_tasks_created_total:
  type: counter
  help: Total tasks created

agenc_tasks_completed_total:
  type: counter
  help: Total tasks completed

agenc_disputes_initiated_total:
  type: counter
  help: Total disputes initiated

agenc_escrow_balance_sol:
  type: gauge
  help: Total SOL held in escrow accounts

agenc_agents_registered_total:
  type: counter
  help: Total registered agents

agenc_protocol_fees_collected_sol:
  type: counter
  help: Total protocol fees collected
```

### 6.3 Discord/Slack Webhooks

Configure event notifications:

```typescript
// Event listener for protocol events
program.addEventListener("ProtocolInitialized", (event) => {
  sendWebhook("Protocol initialized", event);
});

program.addEventListener("TaskCreated", (event) => {
  if (event.rewardAmount > threshold) {
    sendWebhook("Large task created", event);
  }
});

program.addEventListener("DisputeInitiated", (event) => {
  sendWebhook("Dispute initiated", event);  // Always alert
});
```

### 6.4 Key Metrics Dashboard

| Metric | Warning Threshold | Critical Threshold |
|--------|------------------|-------------------|
| Task creation rate | < 10/hour | < 1/hour |
| Dispute rate | > 5% of tasks | > 10% of tasks |
| Escrow balance | Sudden 50% drop | Sudden 90% drop |
| Failed transactions | > 5% | > 20% |
| Average completion time | > 24 hours | > 72 hours |

---

## 7. Rollback Plan

### 7.1 Pause Protocol (If Circuit Breaker Exists)

Currently no on-chain circuit breaker. Mitigation options:

1. **Upgrade with pause:** Deploy new version with all instructions returning error
2. **Frontend pause:** Disable UI/API access while maintaining on-chain state
3. **Communication:** Immediately notify users via all channels

### 7.2 Critical Bug Migration

If a critical vulnerability is discovered:

1. **Assess:** Determine if funds are at immediate risk
2. **Pause:** Use available pause mechanisms
3. **Deploy:** Create and deploy patched program to new address
4. **Migrate:** Execute state migration (if possible)
5. **Communicate:** Provide users with migration instructions

State migration approach:
```bash
# Deploy new program
anchor deploy --provider.cluster mainnet --program-id new-program-keypair.json

# Migration script reads old state, writes to new program
npx ts-node scripts/migrate-state.ts
```

### 7.3 Communication Plan

| Severity | Channels | Timeline |
|----------|----------|----------|
| Critical (funds at risk) | Twitter, Discord, Email, In-app | Immediate |
| High (functionality broken) | Discord, Email | Within 1 hour |
| Medium (degraded service) | Discord | Within 4 hours |
| Low (minor issues) | Discord, Changelog | Next business day |

Template:
```
[SEVERITY] AgenC Protocol Incident

Status: [Investigating/Identified/Resolved]
Impact: [Description]
Action Required: [User actions if any]
Updates: [Channel/URL]
```

---

## 8. Testnet Dry-Run Procedure

Before mainnet deployment, execute a full dry run on testnet.

### 8.1 Testnet Deployment

```bash
# Configure for testnet
solana config set --url https://api.testnet.solana.com

# Airdrop SOL for deployment
solana airdrop 5

# Deploy to testnet
anchor deploy --provider.cluster testnet

# Initialize with testnet multisig
anchor run init-testnet --provider.cluster testnet
```

### 8.2 Testnet Verification Checklist

- [ ] Program deploys successfully
- [ ] `initialize_protocol` executes with correct parameters
- [ ] Agent registration works
- [ ] Task creation with escrow funding works
- [ ] Task claim validates capabilities
- [ ] Task completion distributes rewards correctly
- [ ] Protocol fee deducted and sent to treasury
- [ ] Task cancellation returns funds
- [ ] Dispute flow (initiate -> vote -> resolve) works
- [ ] Multisig-gated operations require threshold signatures
- [ ] All PDAs derive with expected addresses
- [ ] Events emit correctly
- [ ] IDL published and fetchable

### 8.3 Testnet Soak Test

Run extended test for 24-48 hours:
- Create 100+ tasks with varying parameters
- Register 20+ agents
- Execute full task lifecycle on 50+ tasks
- Initiate 5+ disputes
- Monitor for memory leaks or state corruption

### 8.4 Sign-Off Requirements

Before proceeding to mainnet, obtain sign-off from:

| Role | Name | Date | Signature |
|------|------|------|-----------|
| Engineering Lead | | | |
| Security Lead | | | |
| Operations Lead | | | |
| Product Lead | | | |

---

## Appendix A: Quick Reference

### Key Addresses (Fill After Deployment)

| Account | Address |
|---------|---------|
| Program ID | `EopUaCV2svxj9j4hd7KjbrWfdjkspmm2BCBe7jGpKzKZ` |
| Protocol PDA | |
| Treasury | |
| Upgrade Authority (Multisig) | |
| IDL Account | |

### Protocol Parameters

| Parameter | Value | Constraint |
|-----------|-------|------------|
| dispute_threshold | 51 | 1-100 |
| protocol_fee_bps | 100 | 0-1000 (max 10%) |
| min_arbiter_stake | 10 SOL | >= 0 |
| multisig_threshold | 3 | 1 to len(owners) |
| multisig_owners | 5 | max 5 |

### Emergency Contacts

| Role | Contact |
|------|---------|
| On-call Engineer | |
| Security Lead | |
| Multisig Signer 1 | |
| Multisig Signer 2 | |
| Multisig Signer 3 | |

---

## Appendix B: Deployment Checklist Summary

```
PRE-DEPLOYMENT
[ ] Security audit complete, Critical/High fixed
[ ] All tests passing
[ ] Fuzz testing complete (issue #39)
[ ] Internal review complete (issue #46)
[ ] Multisig wallet created
[ ] Treasury wallet created
[ ] Fresh deploy keypair generated
[ ] RPC provider configured

DEPLOYMENT
[ ] Anchor.toml updated for mainnet
[ ] Program built with --verifiable
[ ] Executable hash recorded
[ ] Program deployed to mainnet
[ ] Protocol initialized with correct parameters
[ ] Upgrade authority transferred to multisig
[ ] IDL published on-chain

POST-DEPLOYMENT
[ ] Program verified on Explorer
[ ] Protocol config verified
[ ] Basic instructions tested
[ ] PDAs verified
[ ] Fee recipient verified
[ ] Monitoring configured
[ ] Team notified
[ ] Public announcement made
```

---

*Last updated: [DATE]*
*Document owner: [TEAM]*
