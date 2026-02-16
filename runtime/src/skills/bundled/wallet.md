---
name: wallet
description: Solana wallet operations — keypair management, airdrop, message signing, and verification
version: 1.0.0
metadata:
  agenc:
    emoji: "🔑"
    primaryEnv: node
    requires:
      binaries:
        - solana
      os:
        - linux
        - macos
    tags:
      - wallet
      - solana
      - keypair
      - signing
      - airdrop
---

# Solana Wallet Operations

Keypair management, airdrops, message signing, and signature verification.

## Keypair Generation

### CLI

```bash
# Generate a new keypair
solana-keygen new --outfile ~/.config/solana/my-keypair.json

# Generate with no passphrase
solana-keygen new --outfile keypair.json --no-bip39-passphrase

# Show public key from keypair file
solana-keygen pubkey ~/.config/solana/id.json

# Verify a keypair file
solana-keygen verify <PUBKEY> keypair.json
```

### Programmatic

```typescript
import { Keypair } from '@solana/web3.js';

// Generate random keypair
const keypair = Keypair.generate();
console.log('Public key:', keypair.publicKey.toBase58());

// From secret key bytes
const restored = Keypair.fromSecretKey(secretKeyBytes);

// From seed (deterministic)
const seeded = Keypair.fromSeed(seed32Bytes);
```

## Airdrop (Devnet/Testnet)

### CLI

```bash
solana airdrop 2 --url devnet
solana airdrop 1 <ADDRESS> --url devnet
```

### Programmatic

```typescript
const signature = await connection.requestAirdrop(
  publicKey,
  2 * LAMPORTS_PER_SOL,
);
await connection.confirmTransaction(signature);
```

Rate limits apply — typically 2 SOL per request on devnet.

## Message Signing

### Sign a Message

```typescript
import { sign } from 'tweetnacl';

const message = new TextEncoder().encode('Hello, Solana!');
const signature = sign.detached(message, keypair.secretKey);
```

### Verify a Signature

```typescript
const isValid = sign.detached.verify(
  message,
  signature,
  keypair.publicKey.toBytes(),
);
console.log('Valid:', isValid);
```

## Wallet Configuration

```bash
# Set default keypair
solana config set --keypair ~/.config/solana/id.json

# View current config
solana config get

# Show current address
solana address
```

## Transaction Signing

```typescript
import { Transaction, SystemProgram } from '@solana/web3.js';

const tx = new Transaction().add(
  SystemProgram.transfer({
    fromPubkey: sender.publicKey,
    toPubkey: recipientPubkey,
    lamports: amount,
  }),
);

tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
tx.feePayer = sender.publicKey;
tx.sign(sender);

const txid = await connection.sendRawTransaction(tx.serialize());
```

## HD Wallets and Derivation

```typescript
import { derivePath } from 'ed25519-hd-key';

// BIP44 derivation path for Solana
const path = "m/44'/501'/0'/0'";
const seed = mnemonicToSeedSync(mnemonic);
const derived = derivePath(path, seed.toString('hex'));
const keypair = Keypair.fromSeed(derived.key);
```

## Common Pitfalls

- Never expose secret keys in logs, environment variables, or source code
- Keypair JSON files contain the full secret key — treat as highly sensitive
- Airdrop only works on devnet/testnet — mainnet airdrops will fail
- Always confirm transactions after sending — use `confirmTransaction`
- Message signing uses Ed25519 — not compatible with Ethereum's secp256k1 signatures
- Recent blockhash expires after ~60 seconds — don't cache it
