---
name: solana
description: Solana CLI operations — balance queries, transfers, program deployment, and account inspection
version: 1.0.0
metadata:
  agenc:
    emoji: "☀️"
    primaryEnv: node
    requires:
      binaries:
        - solana
      os:
        - linux
        - macos
    tags:
      - solana
      - blockchain
      - cli
      - rpc
---

# Solana CLI Operations

Core Solana operations via the `solana` CLI and RPC.

## Check Balance

```bash
solana balance <ADDRESS> --url <RPC_URL>
```

Use `--url mainnet-beta`, `devnet`, or a custom RPC endpoint.

## Transfer SOL

```bash
solana transfer <RECIPIENT> <AMOUNT_SOL> --url <RPC_URL> --allow-unfunded-recipient
```

Always confirm the recipient address before sending. Use `--allow-unfunded-recipient` for new wallets.

## Account Info

```bash
solana account <ADDRESS> --url <RPC_URL> --output json
```

Returns owner, lamports, data length, and executable status. Use `--output json` for machine-readable output.

## Program Deployment

```bash
solana program deploy <PROGRAM_SO_PATH> --url <RPC_URL> --program-id <KEYPAIR>
```

Steps:
1. Build the program (`anchor build` or `cargo build-sbf`)
2. Ensure the deployer has enough SOL for rent-exempt storage
3. Deploy with the program keypair
4. Verify with `solana program show <PROGRAM_ID>`

## Cluster Configuration

```bash
solana config set --url <RPC_URL>
solana config get
```

Common clusters:
- `mainnet-beta` — production
- `devnet` — testing with free SOL
- `localhost` — local validator (`solana-test-validator`)

## Transaction Inspection

```bash
solana confirm <TX_SIGNATURE> --url <RPC_URL>
solana transaction-history <ADDRESS> --url <RPC_URL> --limit 10
```

## Common Pitfalls

- Always specify `--url` explicitly to avoid sending to the wrong cluster
- Check rent-exempt minimum before creating accounts
- Transaction signatures are base58-encoded — don't truncate them
- RPC rate limits vary by provider; use a dedicated endpoint for production
