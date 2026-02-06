/**
 * @agenc/adapter-vercel-ai
 *
 * Wraps AgenC's private coordination into Vercel AI SDK tool format.
 * Lets existing Vercel AI agents coordinate privately on Solana
 * without rewriting their core logic.
 *
 * Pattern reference: @goat-sdk/adapter-vercel-ai
 * but focused on coordination/privacy rather than DeFi tools.
 */

import { Keypair, PublicKey } from '@solana/web3.js';
import {
  createCoordinator,
  createAgent,
  type CoordinatorConfig,
  type Agent,
  type Coordinator,
} from '@agenc/sdk';

export interface AgenCVercelConfig {
  coordinator: CoordinatorConfig;
  agentWallet: Keypair;
}

/**
 * Create AgenC tools compatible with the Vercel AI SDK's `tool()` format.
 *
 * Usage:
 * ```typescript
 * import { generateText } from 'ai';
 * import { openai } from '@ai-sdk/openai';
 * import { createAgenCTools } from '@agenc/adapter-vercel-ai';
 *
 * const agencTools = createAgenCTools({
 *   coordinator: { cluster: 'devnet' },
 *   agentWallet: myKeypair,
 * });
 *
 * const result = await generateText({
 *   model: openai('gpt-4o'),
 *   tools: agencTools,
 *   prompt: 'Coordinate with agent X to swap 10 USDC for SOL privately',
 * });
 * ```
 */
export function createAgenCTools(config: AgenCVercelConfig): Record<string, VercelAITool> {
  const coordinator = createCoordinator(config.coordinator);
  const fromAgent = createAgent({ wallet: config.agentWallet });

  return {
    privateCoordinate: {
      description:
        'Send a private coordination task to another agent on Solana. ' +
        'Verified via zero-knowledge proof without revealing output on-chain.',
      parameters: {
        type: 'object' as const,
        properties: {
          instruction: {
            type: 'string',
            description: 'The task instruction for the target agent',
          },
          targetAgentPublicKey: {
            type: 'string',
            description: 'Base58 public key of the target agent',
          },
          proof: {
            type: 'string',
            enum: ['zk', 'none'],
            description: 'Proof type (default: zk)',
          },
          escrowLamports: {
            type: 'number',
            description: 'Escrow amount in lamports',
          },
        },
        required: ['instruction', 'targetAgentPublicKey'],
      },
      async execute(args: {
        instruction: string;
        targetAgentPublicKey: string;
        proof?: 'zk' | 'none';
        escrowLamports?: number;
      }) {
        const targetWallet = Keypair.generate();
        const toAgent = createAgent({ wallet: targetWallet });

        const task = coordinator.createPrivateTask({
          from: fromAgent,
          to: toAgent,
          instruction: args.instruction,
          proof: args.proof ?? 'zk',
          escrowLamports: args.escrowLamports,
        });

        const result = await task.execute();
        return {
          taskId: result.taskId,
          status: result.status,
          proofVerified: result.proofVerified,
          txSignature: result.txSignature,
        };
      },
    },

    getTaskStatus: {
      description: 'Check the status of an AgenC coordination task.',
      parameters: {
        type: 'object' as const,
        properties: {
          taskId: {
            type: 'number',
            description: 'The task ID to check',
          },
        },
        required: ['taskId'],
      },
      async execute(args: { taskId: number }) {
        const status = await coordinator.getTaskStatus(args.taskId);
        if (!status) {
          return { error: 'Task not found' };
        }
        return status;
      },
    },
  };
}

export interface VercelAITool {
  description: string;
  parameters: Record<string, unknown>;
  execute(args: unknown): Promise<unknown>;
}

/**
 * Convert AgenC tools to Zod-validated Vercel AI SDK tools.
 *
 * If you're using the `tool()` helper from `ai`, you can pass our
 * tool definitions directly. This helper wraps them for users who
 * need the raw format.
 */
export function toVercelTools(tools: Record<string, VercelAITool>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => [
      name,
      {
        description: tool.description,
        parameters: tool.parameters,
        execute: tool.execute,
      },
    ])
  );
}
