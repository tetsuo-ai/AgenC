import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getConnection,
  getCurrentNetwork,
  setNetwork,
  getCurrentProgramId,
} from "../utils/connection.js";

export function registerConnectionTools(server: McpServer): void {
  server.tool(
    "agenc_set_network",
    "Switch RPC endpoint to localnet, devnet, mainnet, or a custom URL",
    {
      network: z
        .string()
        .describe("Network name (localnet, devnet, mainnet) or custom RPC URL"),
    },
    async ({ network }) => {
      try {
        const result = setNetwork(network);
        return {
          content: [
            {
              type: "text" as const,
              text:
                "Switched to: " +
                result.network +
                "\nRPC URL: " +
                result.rpcUrl +
                "\nProgram ID: " +
                getCurrentProgramId().toBase58(),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: " + (error as Error).message,
            },
          ],
        };
      }
    },
  );

  server.tool(
    "agenc_get_balance",
    "Get SOL balance for any public key",
    {
      pubkey: z.string().describe("Base58-encoded public key"),
    },
    async ({ pubkey }) => {
      try {
        const pk = new PublicKey(pubkey);
        const connection = getConnection();
        const balance = await connection.getBalance(pk);
        const sol = balance / LAMPORTS_PER_SOL;
        return {
          content: [
            {
              type: "text" as const,
              text: sol + " SOL (" + balance + " lamports)",
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: " + (error as Error).message,
            },
          ],
        };
      }
    },
  );

  server.tool(
    "agenc_airdrop",
    "Request SOL airdrop (localnet/devnet only)",
    {
      pubkey: z.string().describe("Base58-encoded public key to fund"),
      amount: z
        .number()
        .positive()
        .default(1)
        .describe("Amount of SOL to airdrop"),
    },
    async ({ pubkey, amount }) => {
      const network = getCurrentNetwork();
      try {
        if (network === "mainnet" || network.includes("mainnet")) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Error: airdrop not available on mainnet",
              },
            ],
          };
        }

        const pk = new PublicKey(pubkey);
        const connection = getConnection();
        const lamports = Math.floor(amount * LAMPORTS_PER_SOL);
        const sig = await connection.requestAirdrop(pk, lamports);
        await connection.confirmTransaction(sig, "confirmed");

        return {
          content: [
            {
              type: "text" as const,
              text:
                "Airdropped " +
                amount +
                " SOL to " +
                pubkey +
                "\nSignature: " +
                sig,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                "Airdrop to " +
                pubkey +
                " failed: " +
                normalizeAirdropError(error, network),
            },
          ],
        };
      }
    },
  );
}

function normalizeAirdropError(error: unknown, network: string): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : String(error);
  const lower = message.toLowerCase();
  const isDevnet = network.includes("devnet");

  if (
    lower.includes("429") ||
    lower.includes("too many requests") ||
    lower.includes("rate limit") ||
    lower.includes("faucet") ||
    lower.includes("airdrop request failed")
  ) {
    return isDevnet
      ? "devnet faucet is rate-limited. Wait 60-120 seconds and retry, or switch RPC endpoint."
      : "RPC provider rate-limited the airdrop request. Retry shortly or switch RPC endpoint.";
  }

  if (lower.includes("internal error") || lower.includes("-32603")) {
    return isDevnet
      ? "RPC returned an internal airdrop error. The faucet may be temporarily unavailable; retry shortly."
      : "RPC returned an internal airdrop error. Retry shortly or switch RPC endpoint.";
  }

  return message;
}
