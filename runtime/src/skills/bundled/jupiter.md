---
name: jupiter
description: Jupiter DEX operations — token swaps, price quotes, route optimization, and limit orders
version: 1.0.0
metadata:
  agenc:
    emoji: "🪐"
    primaryEnv: node
    requires:
      binaries:
        - node
      os:
        - linux
        - macos
    tags:
      - jupiter
      - dex
      - swap
      - solana
      - defi
---

# Jupiter DEX Operations

Token swaps and price discovery on Jupiter, Solana's leading DEX aggregator.

## Get a Swap Quote

```typescript
const quoteUrl = 'https://quote-api.jup.ag/v6/quote';
const params = new URLSearchParams({
  inputMint: 'So11111111111111111111111111111111111111112', // SOL
  outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  amount: '1000000000', // 1 SOL in lamports
  slippageBps: '50', // 0.5% slippage
});

const response = await fetch(`${quoteUrl}?${params}`);
const quote = await response.json();
console.log('Output amount:', quote.outAmount);
console.log('Price impact:', quote.priceImpactPct);
```

## Execute a Swap

```typescript
const swapUrl = 'https://quote-api.jup.ag/v6/swap';
const swapResponse = await fetch(swapUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    quoteResponse: quote,
    userPublicKey: wallet.publicKey.toBase58(),
    wrapAndUnwrapSol: true,
  }),
});

const { swapTransaction } = await swapResponse.json();
// Deserialize, sign, and send the transaction
```

## Price Lookup

```typescript
const priceUrl = 'https://price.jup.ag/v6/price';
const priceResponse = await fetch(`${priceUrl}?ids=SOL&vsToken=USDC`);
const priceData = await priceResponse.json();
console.log('SOL/USDC:', priceData.data.SOL.price);
```

## Token List

```typescript
const tokensUrl = 'https://token.jup.ag/all';
const tokens = await fetch(tokensUrl).then(r => r.json());
// Filter by symbol or address
const usdc = tokens.find(t => t.symbol === 'USDC');
```

## Route Optimization

Jupiter automatically finds the best route across multiple DEXs. Key parameters:

- `slippageBps` — Maximum acceptable slippage in basis points
- `onlyDirectRoutes` — Skip multi-hop routes for faster execution
- `asLegacyTransaction` — Use legacy transactions for compatibility
- `maxAccounts` — Limit accounts for transaction size constraints

## Common Pitfalls

- Always check `priceImpactPct` before executing large swaps
- Set reasonable `slippageBps` — too low causes failures, too high causes losses
- Verify token mint addresses independently; don't trust user input
- Use `wrapAndUnwrapSol: true` when swapping native SOL
- Quote amounts are in smallest units (lamports for SOL, 1e6 for USDC)
- Quotes expire quickly — fetch a fresh quote immediately before swapping
