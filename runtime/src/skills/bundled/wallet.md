---
name: wallet
description: Solana wallet operations for keypair management, airdrops, and signing
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
      - wallet
      - keys
      - solana
---
# Wallet Operations

Solana wallet operations for keypair generation, airdrop requests, transaction signing, and signature verification.

## Generate Keypair

```bash
solana-keygen new --outfile ~/my-keypair.json
solana-keygen new --outfile ~/my-keypair.json --no-bip39-passphrase
```

### Generate Vanity Address

```bash
solana-keygen grind --starts-with ABC:1
```

## Get Wallet Address

```bash
solana-keygen pubkey ~/my-keypair.json
solana address
```

## Request Airdrop (Devnet/Testnet)

```bash
solana airdrop 2
solana airdrop 2 <WALLET_ADDRESS> --url devnet
```

Limited to 2 SOL per request on devnet. May be rate-limited.

## Sign a Message

```typescript
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";

const keypair = Keypair.fromSecretKey(secretKeyBytes);
const message = Buffer.from("Hello, AgenC!");
const signature = nacl.sign.detached(message, keypair.secretKey);
```

## Verify a Signature

```typescript
import nacl from "tweetnacl";

const valid = nacl.sign.detached.verify(
  message,
  signature,
  publicKey.toBytes(),
);
console.log("Signature valid:", valid);
```

## Recover Keypair from Seed Phrase

```bash
solana-keygen recover --outfile ~/recovered.json
```

Prompts for the BIP39 seed phrase interactively.

## Set Default Keypair

```bash
solana config set --keypair ~/my-keypair.json
solana config get
```
