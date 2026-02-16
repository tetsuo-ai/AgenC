---
name: spl-token
description: SPL token operations — create mints, transfer tokens, manage ATAs, and close accounts
version: 1.0.0
metadata:
  agenc:
    emoji: "🪙"
    primaryEnv: node
    requires:
      binaries:
        - spl-token
      os:
        - linux
        - macos
    tags:
      - spl-token
      - solana
      - token
      - mint
      - ata
---

# SPL Token Operations

Manage SPL tokens on Solana — mints, token accounts, transfers, and ATAs.

## Create a Token Mint

```bash
spl-token create-token --url <RPC_URL>
```

With specific decimals:

```bash
spl-token create-token --decimals 6 --url <RPC_URL>
```

## Create a Token Account (ATA)

```bash
spl-token create-account <MINT_ADDRESS> --url <RPC_URL>
```

This creates an Associated Token Account (ATA) for your wallet. ATAs are deterministic — one per wallet per mint.

## Mint Tokens

```bash
spl-token mint <MINT_ADDRESS> <AMOUNT> --url <RPC_URL>
```

Only the mint authority can mint new tokens.

## Transfer Tokens

```bash
spl-token transfer <MINT_ADDRESS> <AMOUNT> <RECIPIENT> --url <RPC_URL> --allow-unfunded-recipient --fund-recipient
```

- `--allow-unfunded-recipient` — Allow sending to a wallet with no SOL
- `--fund-recipient` — Create the recipient's ATA if it doesn't exist

## Check Token Balance

```bash
spl-token balance <MINT_ADDRESS> --url <RPC_URL>
```

List all token accounts:

```bash
spl-token accounts --url <RPC_URL>
```

## Close Empty Token Accounts

Reclaim rent SOL from empty token accounts:

```bash
spl-token close --address <TOKEN_ACCOUNT> --url <RPC_URL>
```

## Token Account Info

```bash
spl-token display <TOKEN_ACCOUNT> --url <RPC_URL>
```

Shows mint, owner, balance, and delegate information.

## Programmatic Usage

```typescript
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  transfer,
} from '@solana/spl-token';

// Create mint
const mint = await createMint(connection, payer, mintAuthority, freezeAuthority, decimals);

// Get or create ATA
const ata = await getOrCreateAssociatedTokenAccount(connection, payer, mint, owner);

// Mint tokens
await mintTo(connection, payer, mint, ata.address, mintAuthority, amount);

// Transfer tokens
await transfer(connection, payer, sourceAta, destAta, owner, amount);
```

## Common Pitfalls

- Token amounts are in smallest units (e.g., 1 USDC = 1_000_000 with 6 decimals)
- Closing a token account with balance will fail — transfer tokens out first
- ATAs are deterministic per (wallet, mint) pair — no need to store addresses
- Mint authority can be set to `null` to make supply fixed
- Always use `--fund-recipient` when transferring to a wallet that may not have an ATA
