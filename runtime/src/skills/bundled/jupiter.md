---
name: jupiter
description: Jupiter DEX operations for token swaps and liquidity on Solana
version: 1.0.0
metadata:
  agenc:
    tags:
      - defi
      - jupiter
      - dex
      - swaps
---
# Jupiter DEX Operations

Jupiter aggregator operations for getting swap quotes, executing swaps, and querying liquidity pools on Solana.

## Get Swap Quote

Fetch the best swap route for a token pair.

```typescript
const quote = await jupiter.getQuote({
  inputMint: "So11111111111111111111111111111111111111112",  // SOL
  outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  amount: 1_000_000_000, // 1 SOL in lamports
  slippageBps: 50,       // 0.5% slippage
});
```

The quote returns the best route, expected output amount, and price impact.

## Execute Swap

Execute a swap using a fetched quote.

```typescript
const result = await jupiter.executeSwap({
  quoteResponse: quote,
  userPublicKey: wallet.publicKey,
});

console.log("Transaction signature:", result.txid);
```

## Get Token Price

Look up current token price via Jupiter price API.

```typescript
const price = await jupiter.getTokenPrice("SOL");
const prices = await jupiter.getTokenPrice(["SOL", "BONK", "JUP"]);
```

## List Tradeable Tokens

```typescript
const tokens = await jupiter.getTokenList();
// Filter by tag
const stablecoins = tokens.filter(t => t.tags.includes("stablecoin"));
```

## Get Liquidity Pools

```typescript
const pools = await jupiter.getPools({
  inputMint: "So11111111111111111111111111111111111111112",
  outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
});
```

## API Endpoints

- Quote: `GET https://quote-api.jup.ag/v6/quote`
- Swap: `POST https://quote-api.jup.ag/v6/swap`
- Price: `GET https://price.jup.ag/v6/price`
- Token list: `GET https://token.jup.ag/all`
