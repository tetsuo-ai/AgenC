---
name: solana
description: Solana blockchain operations and CLI commands
version: 1.0.0
metadata:
  agenc:
    requires:
      binaries:
        - solana
      os:
        - linux
        - macos
    install:
      - type: brew
        package: solana
      - type: download
        url: https://release.anza.xyz/stable/install
    tags:
      - blockchain
      - solana
      - cli
---
# Solana Operations

Common Solana CLI operations for account management, transfers, and program interaction.

## Check Balance

```bash
solana balance
solana balance <WALLET_ADDRESS>
solana balance <WALLET_ADDRESS> --url mainnet-beta
```

## Transfer SOL

```bash
solana transfer <RECIPIENT_ADDRESS> <AMOUNT_SOL>
solana transfer <RECIPIENT_ADDRESS> <AMOUNT_SOL> --allow-unfunded-recipient
solana transfer <RECIPIENT_ADDRESS> <AMOUNT_SOL> --url mainnet-beta --fee-payer <KEYPAIR_PATH>
```

## Get Account Info

```bash
solana account <ADDRESS>
solana account <ADDRESS> --output json
```

## Deploy Program

```bash
solana program deploy <PROGRAM_SO_PATH>
solana program deploy <PROGRAM_SO_PATH> --program-id <KEYPAIR_PATH>
solana program deploy <PROGRAM_SO_PATH> --url mainnet-beta --with-compute-unit-price 1000
```

## View Transaction

```bash
solana confirm <TX_SIGNATURE>
solana confirm <TX_SIGNATURE> -v
```

## Configuration

```bash
solana config get
solana config set --url devnet
solana config set --url mainnet-beta
solana config set --keypair <KEYPAIR_PATH>
```

## Cluster Info

```bash
solana cluster-version
solana slot
solana epoch-info
solana validators --url mainnet-beta
```
