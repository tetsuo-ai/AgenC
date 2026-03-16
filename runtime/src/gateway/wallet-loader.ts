/**
 * Wallet loading from gateway config.
 *
 * Extracts keypair loading and wallet adapter construction from daemon.ts.
 *
 * Gate 3 — prerequisite reduction.
 */

import type { GatewayConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WalletResult {
  keypair: import("@solana/web3.js").Keypair;
  agentId: Uint8Array;
  wallet: {
    publicKey: import("@solana/web3.js").PublicKey;
    signTransaction: (tx: any) => Promise<any>;
    signAllTransactions: (txs: any[]) => Promise<any[]>;
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Load keypair from config and build a wallet adapter.
 * Returns null when keypair is unavailable (read-only mode).
 */
export async function loadWallet(
  config: GatewayConfig,
): Promise<WalletResult | null> {
  try {
    const { loadKeypairFromFile, getDefaultKeypairPath } =
      await import("../types/wallet.js");
    const kpPath = config.connection?.keypairPath ?? getDefaultKeypairPath();
    const keypair = await loadKeypairFromFile(kpPath);
    return {
      keypair,
      agentId: keypair.publicKey.toBytes(),
      wallet: {
        publicKey: keypair.publicKey,
        signTransaction: async (tx: any) => {
          tx.sign(keypair);
          return tx;
        },
        signAllTransactions: async (txs: any[]) => {
          txs.forEach((tx) => tx.sign(keypair));
          return txs;
        },
      },
    };
  } catch {
    return null;
  }
}
