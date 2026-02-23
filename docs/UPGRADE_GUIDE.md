# Protocol Upgrade Guide

This guide covers the complete procedure for upgrading the AgenC Coordination Protocol.

## Table of Contents

1. [Overview](#overview)
2. [Pre-Upgrade Checklist](#pre-upgrade-checklist)
3. [Upgrade Procedure](#upgrade-procedure)
4. [Testing Upgrades](#testing-upgrades)
5. [Rollback Procedures](#rollback-procedures)
6. [Version Compatibility](#version-compatibility)
7. [Multisig Approval Flow](#multisig-approval-flow)

## Overview

The AgenC Coordination Protocol uses Solana's BPFLoaderUpgradeable for program upgrades. This allows:

- **Program Binary Updates**: Deploy new code without changing the program ID
- **State Migrations**: Transform account data between versions
- **Backward Compatibility**: Support multiple account versions during transition

### Upgrade Components

| Component | Description |
|-----------|-------------|
| Program Binary | The compiled Solana program (.so file) |
| Protocol Version | Version field in ProtocolConfig account |
| Min Supported Version | Minimum account version the program handles |
| Upgrade Authority | Key authorized to deploy new program binary |

## Pre-Upgrade Checklist

### Code Review

- [ ] All changes reviewed by at least 2 team members
- [ ] Security audit completed (for major versions)
- [ ] No breaking changes to existing account layouts
- [ ] Migration logic handles edge cases

### Testing

- [ ] Unit tests pass
- [ ] Integration tests pass on localnet
- [ ] Full test suite passes on devnet
- [ ] Migration tested on devnet with production-like data
- [ ] Smoke tests documented and passing

### Documentation

- [ ] CHANGELOG updated
- [ ] Migration notes in `migrations/` directory
- [ ] Version compatibility matrix updated
- [ ] User communication prepared

### Coordination

- [ ] Multisig signers available and coordinated
- [ ] Maintenance window scheduled
- [ ] Monitoring alerts configured
- [ ] Rollback plan reviewed

## Upgrade Procedure

### Step 1: Build and Verify

```bash
# Build the program
anchor build

# Verify the build
anchor verify <PROGRAM_ID>

# Check binary size
ls -la target/deploy/agenc_coordination.so
```

### Step 2: Deploy to Devnet (Test)

```bash
# Set cluster to devnet
solana config set --url devnet

# Deploy (upgrade existing program)
anchor upgrade target/deploy/agenc_coordination.so \
  --program-id 5j9ZbT3mnPX5QjWVMrDaWFuaGf8ddji6LW1HVJw6kUE7 \
  --provider.cluster devnet
```

### Step 3: Run Migration on Devnet

```typescript
import { migrateProtocol, verifyMigration } from "./migrations/migration_utils";

// Run migration
const tx = await migrateProtocol(
  program,
  protocolPda,
  TARGET_VERSION,
  multisigSigners
);
console.log("Migration tx:", tx);

// Verify
const result = await verifyMigration(program, protocolPda, TARGET_VERSION);
console.log(result.message);
```

### Step 4: Smoke Test on Devnet

```bash
# Run smoke tests
yarn run smoke-test --cluster devnet

# Manual verification
# - Create a task
# - Claim a task
# - Complete a task
# - Initiate a dispute (if applicable)
```

### Step 5: Deploy to Mainnet

```bash
# IMPORTANT: Ensure upgrade authority is multisig
solana program show 5j9ZbT3mnPX5QjWVMrDaWFuaGf8ddji6LW1HVJw6kUE7

# Deploy with multisig approval
anchor upgrade target/deploy/agenc_coordination.so \
  --program-id 5j9ZbT3mnPX5QjWVMrDaWFuaGf8ddji6LW1HVJw6kUE7 \
  --provider.cluster mainnet
```

### Step 6: Run Migration on Mainnet

```bash
# Execute migration with multisig
# This requires coordination with all signers

# Using CLI (if available)
agenc migrate --version <TARGET_VERSION> --cluster mainnet

# Or via TypeScript script with multisig
yarn run migrate --cluster mainnet --version <TARGET_VERSION>
```

### Step 7: Verify and Monitor

```bash
# Verify version
yarn run check-version --cluster mainnet

# Monitor for errors
# - Check transaction success rate
# - Monitor error logs
# - Verify state integrity
```

## Testing Upgrades

### Localnet Testing

```bash
# Start local validator
solana-test-validator

# Deploy initial version
anchor deploy

# Make changes, rebuild
anchor build

# Upgrade
anchor upgrade target/deploy/agenc_coordination.so \
  --program-id <LOCAL_PROGRAM_ID>

# Test migration
yarn run test tests/upgrades.ts
```

### Devnet Testing

```bash
# Configure for devnet
solana config set --url devnet

# Use the simulate_upgrade.sh script
./scripts/simulate_upgrade.sh devnet
```

### Test Scenarios

1. **Fresh Install**: New protocol initialization
2. **v1 to v2 Migration**: Existing accounts migrate correctly
3. **Partial Migration**: Some accounts migrated, others not
4. **Failed Migration**: Verify rollback behavior
5. **Concurrent Operations**: Migration during active usage

## Rollback Procedures

### Scenario 1: Migration Failed

If `migrate_protocol` fails:

1. **Do NOT retry immediately** - investigate the error
2. Accounts remain at previous version
3. No rollback needed for state
4. Fix the migration logic and retry

### Scenario 2: Post-Migration Bug

If bugs are discovered after migration:

```bash
# Option A: Deploy hotfix
anchor upgrade target/deploy/agenc_coordination_hotfix.so \
  --program-id 5j9ZbT3mnPX5QjWVMrDaWFuaGf8ddji6LW1HVJw6kUE7

# Option B: Roll back program binary
# Deploy the previous version binary
anchor upgrade target/deploy/agenc_coordination_v1.so \
  --program-id 5j9ZbT3mnPX5QjWVMrDaWFuaGf8ddji6LW1HVJw6kUE7
```

**Important**: Rolling back the binary does NOT roll back account state. The old program must handle the new account format.

### Scenario 3: Critical Vulnerability

Emergency procedure:

1. **Freeze program** (if freeze authority is set)
2. Deploy patched version immediately
3. Coordinate with users for any required actions
4. Post-mortem and permanent fix

## Version Compatibility

### Compatibility Matrix

| Program Version | Supports Account v1 | Supports Account v2 | Notes |
|----------------|--------------------|--------------------|-------|
| 1.0.0          | Yes                | No                 | Initial release |
| 1.1.0          | Yes                | Yes                | Migration available |
| 2.0.0          | Yes (deprecated)   | Yes                | v1 support ends soon |
| 2.1.0          | No                 | Yes                | v1 no longer supported |

### Version Constants

```rust
// state.rs
pub const CURRENT_PROTOCOL_VERSION: u8 = 1;
pub const MIN_SUPPORTED_VERSION: u8 = 1;
```

### Deprecation Process

1. Release new version with backward compatibility
2. Announce deprecation timeline (e.g., 30 days)
3. After grace period, call `update_min_version` to disable old version
4. Old accounts will fail with `AccountVersionTooOld` error

## Multisig Approval Flow

### Setup

The upgrade authority should be a multisig. Example using Squads Protocol:

```bash
# Transfer upgrade authority to multisig
solana program set-upgrade-authority 5j9ZbT3mnPX5QjWVMrDaWFuaGf8ddji6LW1HVJw6kUE7 \
  --new-upgrade-authority <SQUADS_MULTISIG_ADDRESS>
```

### Upgrade with Multisig

1. **Propose**: One signer proposes the upgrade transaction
2. **Review**: All signers review the proposed binary
3. **Approve**: Required signers approve the transaction
4. **Execute**: Transaction executes when threshold reached

### Migration with Multisig

The `migrate_protocol` instruction requires multisig approval:

```typescript
// Collect signatures from multisig members
const tx = await program.methods
  .migrateProtocol(targetVersion)
  .accounts({ protocolConfig: protocolPda })
  .remainingAccounts([
    { pubkey: signer1.publicKey, isSigner: true, isWritable: false },
    { pubkey: signer2.publicKey, isSigner: true, isWritable: false },
    { pubkey: signer3.publicKey, isSigner: true, isWritable: false },
  ])
  .signers([signer1, signer2, signer3])
  .rpc();
```

### Best Practices

- Use 3-of-5 or similar threshold
- Geographic distribution of signers
- Hardware wallets for all signers
- Test multisig flow on devnet first
- Document signer availability schedule
