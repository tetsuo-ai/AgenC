import { PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  getConnection,
  getCurrentNetwork,
  setNetwork,
  getCurrentProgramId,
} from '../utils/connection.js';

export function registerConnectionTools(server: McpServer): void {
  server.tool(
    'agenc_set_network',
    'Switch RPC endpoint to localnet, devnet, mainnet, or a custom URL',
    {
      network: z
        .string()
        .describe('Network name (localnet, devnet, mainnet) or custom RPC URL'),
    },
    async ({ network }) => {
      try {
        const result = setNetwork(network);
        return {
          content: [{
            type: 'text' as const,
            text: 'Switched to: ' + result.network + '\nRPC URL: ' + result.rpcUrl + '\nProgram ID: ' + getCurrentProgramId().toBase58(),
          }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: 'Error: ' + (error as Error).message }],
        };
      }
    },
  );

  server.tool(
    'agenc_get_balance',
    'Get SOL balance for any public key',
    {
      pubkey: z.string().describe('Base58-encoded public key'),
    },
    async ({ pubkey }) => {
      try {
        const pk = new PublicKey(pubkey);
        const connection = getConnection();
        const balance = await connection.getBalance(pk);
        const sol = balance / LAMPORTS_PER_SOL;
        return {
          content: [{
            type: 'text' as const,
            text: sol + ' SOL (' + balance + ' lamports)',
          }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: 'Error: ' + (error as Error).message }],
        };
      }
    },
  );

  server.tool(
    'agenc_airdrop',
    'Request SOL airdrop (localnet/devnet only)',
    {
      pubkey: z.string().describe('Base58-encoded public key to fund'),
      amount: z.number().positive().default(1).describe('Amount of SOL to airdrop'),
    },
    async ({ pubkey, amount }) => {
      try {
        const network = getCurrentNetwork();
        if (network === 'mainnet' || network.includes('mainnet')) {
          return {
            content: [{ type: 'text' as const, text: 'Error: airdrop not available on mainnet' }],
          };
        }

        const pk = new PublicKey(pubkey);
        const connection = getConnection();
        const lamports = Math.floor(amount * LAMPORTS_PER_SOL);
        const sig = await connection.requestAirdrop(pk, lamports);
        await connection.confirmTransaction(sig, 'confirmed');

        return {
          content: [{
            type: 'text' as const,
            text: 'Airdropped ' + amount + ' SOL to ' + pubkey + '\nSignature: ' + sig,
          }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: 'Error: ' + (error as Error).message }],
        };
      }
    },
  );
}
