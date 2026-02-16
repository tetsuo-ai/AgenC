---
name: defi-monitor
description: DeFi position monitoring — token balances, LP positions, staking rewards, and portfolio tracking
version: 1.0.0
metadata:
  agenc:
    emoji: "📊"
    primaryEnv: node
    requires:
      binaries:
        - node
      os:
        - linux
        - macos
    tags:
      - defi
      - monitoring
      - solana
      - portfolio
      - staking
---

# DeFi Position Monitoring

Monitor token balances, LP positions, staking rewards, and portfolio status on Solana.

## Token Balance Check

### Native SOL

```typescript
import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';

const connection = new Connection(rpcUrl);
const balance = await connection.getBalance(new PublicKey(address));
console.log('SOL:', balance / LAMPORTS_PER_SOL);
```

### SPL Token Balances

```typescript
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';

const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
  new PublicKey(address),
  { programId: TOKEN_PROGRAM_ID },
);

for (const { account } of tokenAccounts.value) {
  const info = account.data.parsed.info;
  console.log(`Mint: ${info.mint}, Balance: ${info.tokenAmount.uiAmountString}`);
}
```

## Portfolio Valuation

Combine token balances with price data:

```typescript
// Fetch prices from Jupiter
const mints = tokenAccounts.value.map(a => a.account.data.parsed.info.mint);
const priceUrl = `https://price.jup.ag/v6/price?ids=${mints.join(',')}`;
const prices = await fetch(priceUrl).then(r => r.json());

let totalUsd = 0;
for (const { account } of tokenAccounts.value) {
  const info = account.data.parsed.info;
  const price = prices.data[info.mint]?.price ?? 0;
  const value = info.tokenAmount.uiAmount * price;
  totalUsd += value;
}
```

## Staking Positions

### Native SOL Staking

```bash
solana stakes <WALLET_ADDRESS> --url <RPC_URL>
```

### Programmatic Stake Check

```typescript
const stakeAccounts = await connection.getParsedProgramAccounts(
  new PublicKey('Stake11111111111111111111111111111111111111'),
  {
    filters: [
      { memcmp: { offset: 12, bytes: walletAddress } },
    ],
  },
);

for (const { pubkey, account } of stakeAccounts) {
  const parsed = account.data.parsed;
  console.log(`Stake: ${pubkey.toBase58()}, Lamports: ${account.lamports}`);
}
```

## Account Change Monitoring

Subscribe to account changes for real-time monitoring:

```typescript
const subscriptionId = connection.onAccountChange(
  new PublicKey(address),
  (accountInfo) => {
    console.log('Balance changed:', accountInfo.lamports / LAMPORTS_PER_SOL);
  },
  'confirmed',
);

// Clean up when done
connection.removeAccountChangeListener(subscriptionId);
```

## Transaction History

```typescript
const signatures = await connection.getSignaturesForAddress(
  new PublicKey(address),
  { limit: 20 },
);

for (const sig of signatures) {
  console.log(`${sig.signature} — ${sig.confirmationStatus} — ${sig.err ? 'FAILED' : 'OK'}`);
}
```

## Common Pitfalls

- Always divide lamports by `LAMPORTS_PER_SOL` (1e9) for human-readable SOL amounts
- Token decimals vary per mint — use `tokenAmount.uiAmount` for display values
- WebSocket subscriptions need cleanup to avoid memory leaks
- Price APIs may rate-limit — cache prices and batch requests
- Stale RPC data can cause incorrect balance reads — use `confirmed` or `finalized` commitment
