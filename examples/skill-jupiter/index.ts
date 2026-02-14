/**
 * Jupiter Skill Example
 *
 * Demonstrates standalone usage of the skill library system
 * with the Jupiter DeFi skill for token swaps, balance queries,
 * and price lookups on Solana.
 *
 * Prerequisites:
 *   - A funded Solana wallet (devnet or mainnet)
 *   - RPC endpoint (defaults to devnet)
 *
 * Usage:
 *   npx tsx examples/skill-jupiter/index.ts
 *
 * Environment variables:
 *   SOLANA_RPC_URL - RPC endpoint (default: https://api.devnet.solana.com)
 *   KEYPAIR_PATH - Path to keypair JSON file (default: ~/.config/solana/id.json)
 */

import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import {
  SkillRegistry,
  JupiterSkill,
  WSOL_MINT,
  USDC_MINT,
  createLogger,
  keypairToWallet,
  loadDefaultKeypair,
} from '@agenc/runtime';

async function main(): Promise<void> {
  const logger = createLogger('info', '[Jupiter Example]');

  // ── 1. Setup connection and wallet ──────────────────────────────────
  const rpcUrl = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
  const connection = new Connection(rpcUrl, 'confirmed');
  logger.info(`Connected to: ${rpcUrl}`);

  let keypair: Keypair;
  try {
    keypair = await loadDefaultKeypair();
  } catch {
    logger.warn('No default keypair found, generating ephemeral keypair');
    keypair = Keypair.generate();
  }
  const wallet = keypairToWallet(keypair);
  logger.info(`Wallet: ${wallet.publicKey.toBase58()}`);

  // ── 2. Create and register skills ──────────────────────────────────
  const registry = new SkillRegistry({ logger });

  const jupiter = new JupiterSkill({
    defaultSlippageBps: 100, // 1% slippage for devnet
    timeoutMs: 30_000,
  });
  registry.register(jupiter);

  logger.info(`Registered skills: ${registry.listNames().join(', ')}`);

  // ── 3. Initialize all skills ───────────────────────────────────────
  await registry.initializeAll({ connection, wallet, logger });
  logger.info(`Registry ready: ${registry.isReady()}`);

  try {
    // ── 4. Check SOL balance ───────────────────────────────────────────
    const solBalance = await jupiter.getSolBalance();
    logger.info(`SOL balance: ${solBalance.uiAmount} SOL (${solBalance.amount} lamports)`);

    // ── 5. Get token prices ────────────────────────────────────────────
    logger.info('Fetching token prices...');
    const prices = await jupiter.getTokenPrice([WSOL_MINT, USDC_MINT]);
    for (const [mint, price] of prices) {
      logger.info(`  ${mint}: $${price.priceUsd}`);
    }

    // ── 6. Get a swap quote (SOL → USDC) ──────────────────────────────
    logger.info('Fetching swap quote: 0.01 SOL → USDC...');
    const quote = await jupiter.getQuote({
      inputMint: WSOL_MINT,
      outputMint: USDC_MINT,
      amount: BigInt(0.01 * LAMPORTS_PER_SOL),
    });
    logger.info(`  Input:  ${quote.inAmount} (${WSOL_MINT})`);
    logger.info(`  Output: ${quote.outAmount} (${USDC_MINT})`);
    logger.info(`  Price impact: ${quote.priceImpactPct}%`);
    logger.info(`  Min output (with slippage): ${quote.otherAmountThreshold}`);

    // ── 7. Action registry demo ────────────────────────────────────────
    logger.info('Available actions:');
    for (const action of jupiter.getActions()) {
      logger.info(`  - ${action.name}: ${action.description}`);
    }

    // ── 8. Registry lookup demo ────────────────────────────────────────
    const defiSkills = registry.findByTag('defi');
    logger.info(`Skills tagged "defi": ${defiSkills.map((s) => s.metadata.name).join(', ')}`);

    // NOTE: To execute a swap, uncomment the following:
    // const result = await jupiter.executeSwap({
    //   inputMint: WSOL_MINT,
    //   outputMint: USDC_MINT,
    //   amount: BigInt(0.01 * LAMPORTS_PER_SOL),
    // });
    // logger.info(`Swap executed: ${result.txSignature}`);
  } finally {
    // ── 9. Shutdown ──────────────────────────────────────────────────
    await registry.shutdownAll();
    logger.info('Skills shut down. Done.');
  }
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
