# Deployment Guide

This guide covers deploying the AgenC Coordination Protocol to Solana devnet and mainnet.

## Prerequisites

### Required Tools

```bash
# Solana CLI
sh -c "$(curl -sSfL https://release.solana.com/v1.18.0/install)"

# Anchor Framework
cargo install --git https://github.com/coral-xyz/anchor anchor-cli --locked

# Node.js (for Anchor tests)
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### Verify Installation

```bash
solana --version    # Should be 1.18+
anchor --version    # Should be 0.30+
node --version      # Should be 18+
```

## Devnet Deployment

### Step 1: Configure Wallet

```bash
# Create new keypair (or use existing)
solana-keygen new -o ~/.config/solana/deployer.json

# Set as default
solana config set --keypair ~/.config/solana/deployer.json

# Set to devnet
solana config set --url https://api.devnet.solana.com

# Verify
solana config get
```

### Step 2: Fund Wallet

```bash
# Airdrop SOL (may need multiple attempts)
solana airdrop 2
solana airdrop 2
solana airdrop 2

# Check balance (need ~6 SOL for deployment)
solana balance
```

### Step 3: Build Program

```bash
cd programs/agenc-coordination

# Build
anchor build

# Get program keypair
ls -la target/deploy/

# View program ID
solana-keygen pubkey target/deploy/agenc_coordination-keypair.json
```

### Step 4: Update Program ID

Edit `programs/agenc-coordination/src/lib.rs`:

```rust
declare_id!("YOUR_PROGRAM_ID_HERE");
```

Edit `Anchor.toml`:

```toml
[programs.devnet]
agenc_coordination = "YOUR_PROGRAM_ID_HERE"
```

Rebuild after updating:

```bash
anchor build
```

### Step 5: Deploy

```bash
# Deploy to devnet
anchor deploy --provider.cluster devnet

# Or using solana CLI directly
solana program deploy \
  --program-id target/deploy/agenc_coordination-keypair.json \
  target/deploy/agenc_coordination.so
```

### Step 6: Initialize Protocol

Create initialization script `scripts/initialize.ts`:

```typescript
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AgencCoordination } from "../target/types/agenc_coordination";

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.AgencCoordination as Program<AgencCoordination>;

  const [protocolConfig] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("protocol")],
    program.programId
  );

  const treasury = anchor.web3.Keypair.generate();

  await program.methods
    .initializeProtocol(
      51,        // dispute_threshold (51%)
      100,       // protocol_fee_bps (1%)
      new anchor.BN(1_000_000)  // min_stake (0.001 SOL)
    )
    .accounts({
      protocolConfig,
      treasury: treasury.publicKey,
      authority: provider.wallet.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .rpc();

  console.log("Protocol initialized!");
  console.log("Protocol config:", protocolConfig.toBase58());
  console.log("Treasury:", treasury.publicKey.toBase58());
}

main().catch(console.error);
```

Run:

```bash
npx ts-node scripts/initialize.ts
```

### Step 7: Verify Deployment

```bash
# Check program
solana program show YOUR_PROGRAM_ID

# Check protocol config account
solana account PROTOCOL_CONFIG_PDA
```

## Mainnet Deployment

### Important Considerations

1. **Security Audit**: Have the program audited before mainnet
2. **Upgrade Authority**: Decide on upgrade authority strategy
3. **Testing**: Extensive testing on devnet first
4. **Monitoring**: Set up monitoring and alerting

### Step 1: Prepare Mainnet Wallet

```bash
# Use a hardware wallet for mainnet
solana config set --keypair usb://ledger

# Or use a secure file keypair
solana-keygen new -o ~/.config/solana/mainnet-deployer.json --force
```

### Step 2: Configure for Mainnet

```bash
solana config set --url https://api.mainnet-beta.solana.com
```

Update `Anchor.toml`:

```toml
[programs.mainnet]
agenc_coordination = "YOUR_MAINNET_PROGRAM_ID"

[provider]
cluster = "mainnet"
```

### Step 3: Deploy

```bash
# Ensure sufficient SOL (~10 SOL recommended)
solana balance

# Deploy
anchor deploy --provider.cluster mainnet
```

### Step 4: Initialize with Production Parameters

```typescript
await program.methods
  .initializeProtocol(
    66,           // Higher threshold for mainnet (66%)
    50,           // Lower fee (0.5%)
    new anchor.BN(100_000_000)  // Higher stake (0.1 SOL)
  )
  // ...
```

### Step 5: Renounce or Transfer Upgrade Authority

```bash
# Option 1: Make program immutable (cannot upgrade)
solana program set-upgrade-authority YOUR_PROGRAM_ID --final

# Option 2: Transfer to multisig
solana program set-upgrade-authority YOUR_PROGRAM_ID \
  --new-upgrade-authority MULTISIG_ADDRESS
```

## Upgrading the Program

### Devnet Upgrade

```bash
# Build new version
anchor build

# Deploy upgrade
anchor upgrade target/deploy/agenc_coordination.so \
  --program-id YOUR_PROGRAM_ID \
  --provider.cluster devnet
```

### Mainnet Upgrade (with Multisig)

```bash
# Create upgrade proposal
solana program write-buffer target/deploy/agenc_coordination.so

# Transfer buffer authority to multisig
solana program set-buffer-authority BUFFER_ADDRESS \
  --new-buffer-authority MULTISIG_ADDRESS

# Execute upgrade via multisig
```

## Environment Configuration

### Devnet `.env`

```env
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com
ANCHOR_WALLET=~/.config/solana/deployer.json
PROGRAM_ID=YOUR_DEVNET_PROGRAM_ID
```

### Mainnet `.env`

```env
ANCHOR_PROVIDER_URL=https://api.mainnet-beta.solana.com
ANCHOR_WALLET=~/.config/solana/mainnet-deployer.json
PROGRAM_ID=YOUR_MAINNET_PROGRAM_ID
```

## Troubleshooting

### Deployment Fails with Insufficient Funds

```bash
# Check rent requirements
solana rent 500000  # Size in bytes

# Airdrop more (devnet only)
solana airdrop 2
```

### Transaction Simulation Failed

```bash
# Enable verbose logging
RUST_LOG=solana_runtime::system_instruction_processor=trace anchor deploy
```

### Program Account Already Exists

```bash
# Close and reclaim rent (devnet only)
solana program close YOUR_PROGRAM_ID
```

## Post-Deployment Checklist

- [ ] Verify program deployed correctly
- [ ] Initialize protocol configuration
- [ ] Test all instructions on devnet
- [ ] Document program ID and PDAs
- [ ] Set up monitoring
- [ ] Update C client with program ID
- [ ] Run integration tests
- [ ] Create operational runbook
