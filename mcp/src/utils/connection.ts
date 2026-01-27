/**
 * RPC Connection Management
 *
 * Manages Solana RPC connections with support for localnet, devnet, and mainnet.
 * Configuration via environment variables or runtime switching.
 */

import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { AnchorProvider, Program } from '@coral-xyz/anchor';
import {
  PROGRAM_ID,
  DEVNET_RPC,
  MAINNET_RPC,
  createProgram,
  createReadOnlyProgram,
  keypairToWallet,
  loadKeypairFromFile,
  getDefaultKeypairPath,
  type AgencCoordination,
} from '@agenc/runtime';

/** Supported network names */
export type NetworkName = 'localnet' | 'devnet' | 'mainnet';

/** RPC endpoints for each network */
const NETWORK_URLS: Record<NetworkName, string> = {
  localnet: 'http://localhost:8899',
  devnet: DEVNET_RPC,
  mainnet: MAINNET_RPC,
};

/** Current connection state */
let currentConnection: Connection | null = null;
let currentNetwork: NetworkName | string = 'localnet';
let currentProgramId: PublicKey = PROGRAM_ID;

/**
 * Get the RPC URL from environment or default to localnet.
 */
function getConfiguredRpcUrl(): string {
  return process.env.SOLANA_RPC_URL || NETWORK_URLS.localnet;
}

/**
 * Get the configured program ID (override via env or default).
 */
function getConfiguredProgramId(): PublicKey {
  const envId = process.env.AGENC_PROGRAM_ID;
  if (envId) {
    return new PublicKey(envId);
  }
  return PROGRAM_ID;
}

/**
 * Get or create the current RPC connection.
 */
export function getConnection(): Connection {
  if (!currentConnection) {
    currentConnection = new Connection(getConfiguredRpcUrl(), 'confirmed');
    currentProgramId = getConfiguredProgramId();
  }
  return currentConnection;
}

/**
 * Get the current network name.
 */
export function getCurrentNetwork(): string {
  return currentNetwork;
}

/**
 * Get the current program ID.
 */
export function getCurrentProgramId(): PublicKey {
  return currentProgramId;
}

/**
 * Switch to a different network or custom RPC URL.
 */
export function setNetwork(networkOrUrl: string): { rpcUrl: string; network: string } {
  const isKnownNetwork = networkOrUrl in NETWORK_URLS;
  const rpcUrl = isKnownNetwork
    ? NETWORK_URLS[networkOrUrl as NetworkName]
    : networkOrUrl;

  currentConnection = new Connection(rpcUrl, 'confirmed');
  currentNetwork = isKnownNetwork ? networkOrUrl : rpcUrl;
  currentProgramId = getConfiguredProgramId();

  return { rpcUrl, network: currentNetwork };
}

/**
 * Get a read-only program instance for querying account data.
 */
export function getReadOnlyProgram(): Program<AgencCoordination> {
  return createReadOnlyProgram(getConnection(), currentProgramId);
}

/**
 * Get the keypair path for signing operations.
 */
function getKeypairPath(): string {
  return process.env.SOLANA_KEYPAIR_PATH || getDefaultKeypairPath();
}

/**
 * Get a program instance with signing capabilities.
 * Loads keypair from SOLANA_KEYPAIR_PATH env var or default location.
 * Returns both the program and the keypair for operations that need the signer.
 */
export async function getSigningProgram(): Promise<{ program: Program<AgencCoordination>; keypair: import('@solana/web3.js').Keypair }> {
  const keypairPath = getKeypairPath();
  const keypair = await loadKeypairFromFile(keypairPath);
  const wallet = keypairToWallet(keypair);
  const provider = new AnchorProvider(getConnection(), wallet, { commitment: 'confirmed' });
  const program = createProgram(provider, currentProgramId);
  return { program, keypair };
}

/**
 * Get the wallet public key from the configured keypair.
 */
export async function getWalletPublicKey(): Promise<PublicKey> {
  const keypairPath = getKeypairPath();
  const keypair = await loadKeypairFromFile(keypairPath);
  return keypair.publicKey;
}

/**
 * Get SOL balance for a public key.
 */
export async function getSolBalance(pubkey: PublicKey): Promise<{ lamports: number; sol: number }> {
  const lamports = await getConnection().getBalance(pubkey);
  return { lamports, sol: lamports / LAMPORTS_PER_SOL };
}

/**
 * Request an airdrop (localnet/devnet only).
 */
export async function requestAirdrop(
  pubkey: PublicKey,
  solAmount: number
): Promise<string> {
  const lamports = Math.floor(solAmount * LAMPORTS_PER_SOL);
  const sig = await getConnection().requestAirdrop(pubkey, lamports);
  await getConnection().confirmTransaction(sig, 'confirmed');
  return sig;
}
