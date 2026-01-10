# Protocol Migrations

This directory contains migration scripts and documentation for protocol upgrades.

## Directory Structure

```
migrations/
  README.md           - This file
  v1_to_v2.rs         - Template for future v1->v2 migration
  migration_utils.ts  - TypeScript utilities for running migrations
```

## Migration Process

### 1. Pre-Migration Checklist

- [ ] Code changes tested on localnet
- [ ] Code changes tested on devnet
- [ ] Migration script tested on devnet
- [ ] Rollback plan documented
- [ ] Multisig signers coordinated
- [ ] Communication plan for users

### 2. State Migration Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                    Migration Flow                                │
├─────────────────────────────────────────────────────────────────┤
│  1. Deploy new program binary (upgrade)                          │
│     └── solana program deploy --program-id <ID> target/...so    │
│                                                                  │
│  2. Call migrate_protocol instruction                            │
│     └── Requires multisig approval                               │
│     └── Updates protocol_version field                           │
│     └── Applies state transformations                            │
│                                                                  │
│  3. Verify migration success                                     │
│     └── Check protocol_version updated                           │
│     └── Verify state integrity                                   │
│     └── Run smoke tests                                          │
│                                                                  │
│  4. Update min_supported_version (optional)                      │
│     └── After grace period for stragglers                        │
│     └── Deprecates old version support                           │
└─────────────────────────────────────────────────────────────────┘
```

### 3. Adding New Migrations

When adding a new version migration:

1. Add migration logic to `programs/agenc-coordination/src/instructions/migrate.rs`:

```rust
fn apply_migration(config: &mut ProtocolConfig, version: u8) -> Result<()> {
    match version {
        // ... existing versions ...
        3 => {
            // Version 3 migration logic
            // Initialize new fields, transform data, etc.
            config.new_field = default_value;
            Ok(())
        }
        _ => Err(CoordinationError::InvalidMigrationTarget.into())
    }
}
```

2. Update version constants in `state.rs`:

```rust
pub const CURRENT_PROTOCOL_VERSION: u8 = 3;  // Update to new version
// MIN_SUPPORTED_VERSION stays at 1 until old versions are deprecated
```

3. Create a migration script in this directory documenting the changes.

### 4. Version Compatibility

| Program Version | Min Account Version | Max Account Version |
|-----------------|--------------------|--------------------|
| v1.0.0          | 1                  | 1                  |
| v1.1.0          | 1                  | 2                  |
| v2.0.0          | 1                  | 2                  |

### 5. Emergency Rollback

If a migration causes issues:

1. **Do NOT call migrate_protocol again** with a lower version
2. Deploy the previous program binary
3. Accounts remain at their current version
4. Program handles both old and new version accounts

See `docs/UPGRADE_GUIDE.md` for detailed rollback procedures.
