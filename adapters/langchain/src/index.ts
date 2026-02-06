/**
 * @agenc/adapter-langchain
 *
 * Wraps AgenC's private coordination into LangChain-compatible tools
 * so existing LangChain agents can coordinate privately without
 * rewriting their core logic.
 *
 * Pattern reference: @goat-sdk/adapter-langchain (tool wrapping pattern)
 * but focused on coordination/privacy rather than DeFi tools.
 */

import { Keypair, PublicKey } from '@solana/web3.js';
import {
  createCoordinator,
  createAgent,
  type CoordinatorConfig,
  type TaskResult,
  type Agent,
  type Coordinator,
} from '@agenc/sdk';

interface PrivateCoordinationToolInput {
  instruction: string;
  targetAgentPublicKey: string;
  proof?: 'zk' | 'none';
  escrowLamports?: number;
}

interface GetTaskStatusInput {
  taskId: number;
}

export interface AgenCLangChainConfig {
  coordinator: CoordinatorConfig;
  agentWallet: Keypair;
}

export class AgenCToolkit {
  private coordinator: Coordinator;
  private agent: Agent;
  private config: AgenCLangChainConfig;

  constructor(config: AgenCLangChainConfig) {
    this.config = config;
    this.coordinator = createCoordinator(config.coordinator);
    this.agent = createAgent({ wallet: config.agentWallet });
  }

  getTools(): LangChainToolDefinition[] {
    return [
      this.createPrivateCoordinationTool(),
      this.getTaskStatusTool(),
    ];
  }

  private createPrivateCoordinationTool(): LangChainToolDefinition {
    const coordinator = this.coordinator;
    const fromAgent = this.agent;

    return {
      name: 'agenc_private_coordinate',
      description:
        'Send a private coordination task to another agent on Solana. ' +
        'The task instruction is verified via zero-knowledge proof without ' +
        'revealing the actual output on-chain.',
      schema: {
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
            description: 'Proof type: "zk" for zero-knowledge verified, "none" for public',
            default: 'zk',
          },
          escrowLamports: {
            type: 'number',
            description: 'Escrow amount in lamports (default: 100000)',
          },
        },
        required: ['instruction', 'targetAgentPublicKey'],
      },
      async invoke(input: PrivateCoordinationToolInput): Promise<string> {
        const targetWallet = Keypair.generate();
        const toAgent = createAgent({ wallet: targetWallet });

        const task = coordinator.createPrivateTask({
          from: fromAgent,
          to: toAgent,
          instruction: input.instruction,
          proof: input.proof ?? 'zk',
          escrowLamports: input.escrowLamports,
        });

        const result = await task.execute();
        return JSON.stringify({
          taskId: result.taskId,
          status: result.status,
          proofVerified: result.proofVerified,
          txSignature: result.txSignature,
        });
      },
    };
  }

  private getTaskStatusTool(): LangChainToolDefinition {
    const coordinator = this.coordinator;

    return {
      name: 'agenc_get_task_status',
      description: 'Check the status of an AgenC coordination task by its ID.',
      schema: {
        type: 'object' as const,
        properties: {
          taskId: {
            type: 'number',
            description: 'The task ID to check',
          },
        },
        required: ['taskId'],
      },
      async invoke(input: GetTaskStatusInput): Promise<string> {
        const status = await coordinator.getTaskStatus(input.taskId);
        if (!status) {
          return JSON.stringify({ error: 'Task not found' });
        }
        return JSON.stringify(status);
      },
    };
  }
}

export interface LangChainToolDefinition {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  invoke(input: unknown): Promise<string>;
}

/**
 * Convert AgenC tool definitions to LangChain DynamicStructuredTool format.
 *
 * Usage with LangChain:
 * ```typescript
 * import { DynamicStructuredTool } from '@langchain/core/tools';
 * import { AgenCToolkit, toLangChainTools } from '@agenc/adapter-langchain';
 *
 * const toolkit = new AgenCToolkit({
 *   coordinator: { cluster: 'devnet' },
 *   agentWallet: myKeypair,
 * });
 *
 * const tools = toLangChainTools(toolkit.getTools());
 * const agent = createReactAgent({ llm, tools });
 * ```
 */
export function toLangChainTools(tools: LangChainToolDefinition[]): unknown[] {
  // This returns plain objects matching the DynamicStructuredTool shape.
  // The actual DynamicStructuredTool import is a peer dependency to avoid
  // version conflicts with the user's LangChain installation.
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    schema: tool.schema,
    func: tool.invoke,
  }));
}
