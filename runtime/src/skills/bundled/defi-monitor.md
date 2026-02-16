---
name: defi-monitor
description: DeFi position monitoring for balances, LP positions, and staking rewards on Solana
version: 1.0.0
metadata:
  agenc:
    tags:
      - defi
      - monitoring
      - analytics
---
# DeFi Monitoring Operations

Monitor DeFi positions, token balances, LP positions, staking rewards, and price data on Solana.

## Get Token Balances

Query all token balances for a wallet.

```typescript
const balances = await connection.getParsedTokenAccountsByOwner(
  walletPubkey,
  { programId: TOKEN_PROGRAM_ID },
);

for (const account of balances.value) {
  const info = account.account.data.parsed.info;
  console.log(`Mint: ${info.mint}, Balance: ${info.tokenAmount.uiAmount}`);
}
```

## Check SOL Balance

```bash
solana balance <WALLET_ADDRESS> --url mainnet-beta
```

```typescript
const balance = await connection.getBalance(walletPubkey);
console.log(`SOL balance: ${balance / 1e9}`);
```

## Monitor DEX Prices

Query current token prices via Jupiter.

```typescript
const response = await fetch(
  "https://price.jup.ag/v6/price?ids=SOL,BONK,JUP"
);
const data = await response.json();
for (const [token, info] of Object.entries(data.data)) {
  console.log(`${token}: $${info.price}`);
}
```

## Check LP Positions

Query liquidity pool positions for a wallet using the Raydium or Orca SDKs.

```typescript
const positions = await fetchLPPositions(walletPubkey);
for (const pos of positions) {
  console.log(`Pool: ${pos.pool}, Liquidity: $${pos.valueUsd}`);
}
```

## View Staking Rewards

Query native SOL staking info.

```bash
solana stakes <WALLET_ADDRESS>
solana stake-account <STAKE_ACCOUNT_ADDRESS>
```

```typescript
const stakeAccounts = await connection.getParsedProgramAccounts(
  STAKE_PROGRAM_ID,
  { filters: [{ memcmp: { offset: 12, bytes: walletPubkey.toBase58() } }] },
);
```

## Transaction History

Query recent transactions for a wallet.

```typescript
const signatures = await connection.getSignaturesForAddress(walletPubkey, {
  limit: 20,
});
for (const sig of signatures) {
  console.log(`${sig.signature} — ${sig.blockTime}`);
}
```
