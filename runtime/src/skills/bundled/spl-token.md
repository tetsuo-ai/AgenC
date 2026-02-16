---
name: spl-token
description: SPL token operations for creating, transferring, and managing Solana tokens
version: 1.0.0
metadata:
  agenc:
    requires:
      binaries:
        - spl-token
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
      - spl-token
      - tokens
      - wallet
---
# SPL Token Operations

SPL token CLI operations for creating tokens, managing associated token accounts, minting, and transferring.

## Create a New Token

```bash
spl-token create-token
spl-token create-token --decimals 6
spl-token create-token --decimals 9 --mint-authority <KEYPAIR_PATH>
```

Returns the new token mint address.

## Create Associated Token Account

```bash
spl-token create-account <TOKEN_MINT_ADDRESS>
spl-token create-account <TOKEN_MINT_ADDRESS> --owner <WALLET_ADDRESS>
```

Creates an ATA for the given mint. If the account already exists, returns the existing address.

## Mint Tokens

```bash
spl-token mint <TOKEN_MINT_ADDRESS> <AMOUNT>
spl-token mint <TOKEN_MINT_ADDRESS> <AMOUNT> <RECIPIENT_TOKEN_ACCOUNT>
```

Only the mint authority can mint new tokens.

## Transfer Tokens

```bash
spl-token transfer <TOKEN_MINT_ADDRESS> <AMOUNT> <RECIPIENT_WALLET>
spl-token transfer <TOKEN_MINT_ADDRESS> <AMOUNT> <RECIPIENT_WALLET> --fund-recipient
spl-token transfer <TOKEN_MINT_ADDRESS> ALL <RECIPIENT_WALLET>
```

Use `--fund-recipient` to create the recipient's ATA if it doesn't exist.

## Check Token Balance

```bash
spl-token balance <TOKEN_MINT_ADDRESS>
spl-token accounts
spl-token accounts --owner <WALLET_ADDRESS>
```

## Close Token Account

```bash
spl-token close <TOKEN_ACCOUNT_ADDRESS>
```

Closes an empty token account and reclaims the SOL rent.

## Token Supply and Info

```bash
spl-token supply <TOKEN_MINT_ADDRESS>
spl-token display <TOKEN_MINT_ADDRESS>
```
