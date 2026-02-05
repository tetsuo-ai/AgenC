import { PublicKey } from '@solana/web3.js';
import { SEEDS } from '@agenc/sdk';
import { getCapabilityNames, hexToBytes } from '@agenc/runtime';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  getConnection,
  getReadOnlyProgram,
  getCurrentProgramId,
} from '../utils/connection.js';
import {
  formatSol,
  formatTimestamp,
  formatTaskStatus,
  formatTaskType,
  formatBytes,
  safePubkey,
  safeBigInt,
} from '../utils/formatting.js';

function deriveTaskPda(
  creator: PublicKey,
  taskId: Uint8Array,
  programId: PublicKey,
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [SEEDS.TASK, creator.toBuffer(), Buffer.from(taskId)],
    programId,
  );
  return pda;
}

function deriveEscrowPda(taskPda: PublicKey, programId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [SEEDS.ESCROW, taskPda.toBuffer()],
    programId,
  );
  return pda;
}

function formatTaskAccount(account: Record<string, unknown>, pda: PublicKey): string {
  const taskId = account.taskId as Uint8Array | number[];
  const idHex = Buffer.from(taskId instanceof Uint8Array ? taskId : new Uint8Array(taskId)).toString('hex');

  const reqCaps = safeBigInt(account.requiredCapabilities);
  const capNames = getCapabilityNames(reqCaps);

  const lines = [
    'Task PDA: ' + pda.toBase58(),
    'Task ID: ' + idHex,
    'Creator: ' + safePubkey(account.creator),
    'Status: ' + formatTaskStatus(account.status as number | Record<string, unknown>),
    'Type: ' + formatTaskType(account.taskType as number | Record<string, unknown>),
    '',
    '--- Configuration ---',
    'Required Capabilities: ' + (capNames.length > 0 ? capNames.join(', ') : 'None') + ' (bitmask: ' + reqCaps + ')',
    'Max Workers: ' + (account.maxWorkers ?? 1),
    'Current Workers: ' + (account.currentWorkers ?? 0),
    'Reward: ' + formatSol(Number(account.rewardAmount ?? 0)),
    'Deadline: ' + formatTimestamp(Number(account.deadline ?? 0)),
    '',
    '--- State ---',
    'Completions: ' + (account.completions ?? 0),
    'Constraint Hash: ' + formatBytes(account.constraintHash as Uint8Array | null),
    'Description: ' + ((account.description as string) || 'None'),
    '',
    '--- Timestamps ---',
    'Created: ' + formatTimestamp(Number(account.createdAt ?? 0)),
    'Updated: ' + formatTimestamp(Number(account.updatedAt ?? 0)),
  ];

  return lines.join('\n');
}

export function registerTaskTools(server: McpServer): void {
  server.tool(
    'agenc_get_task',
    'Get task state by PDA address or by creator + task ID',
    {
      task_pda: z.string().optional().describe('Task PDA (base58)'),
      creator: z.string().optional().describe('Task creator public key (base58)'),
      task_id: z.string().optional().describe('Task ID (64-char hex)'),
    },
    async ({ task_pda, creator, task_id }) => {
      try {
        const program = getReadOnlyProgram();
        let pda: PublicKey;

        if (task_pda) {
          pda = new PublicKey(task_pda);
        } else if (creator && task_id) {
          const creatorPk = new PublicKey(creator);
          const idBytes = hexToBytes(task_id);
          pda = deriveTaskPda(creatorPk, idBytes, getCurrentProgramId());
        } else {
          return {
            content: [{
              type: 'text' as const,
              text: 'Error: provide either task_pda or both creator and task_id',
            }],
          };
        }

        const account = await program.account.task.fetch(pda);
        return {
          content: [{
            type: 'text' as const,
            text: formatTaskAccount(account as unknown as Record<string, unknown>, pda),
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
    'agenc_list_tasks',
    'List tasks by creator public key',
    {
      creator: z.string().describe('Task creator public key (base58)'),
    },
    async ({ creator }) => {
      try {
        const program = getReadOnlyProgram();
        const creatorPk = new PublicKey(creator);

        const accounts = await program.account.task.all([
          {
            memcmp: {
              offset: 8, // discriminator
              bytes: creatorPk.toBase58(),
            },
          },
        ]);

        if (accounts.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: 'No tasks found for creator: ' + creator,
            }],
          };
        }

        const lines = accounts.map((a, i) => {
          const acc = a.account as unknown as Record<string, unknown>;
          const taskId = acc.taskId as Uint8Array | number[];
          const idHex = Buffer.from(
            taskId instanceof Uint8Array ? taskId : new Uint8Array(taskId),
          ).toString('hex');
          return [
            '[' + (i + 1) + '] Task ' + idHex.slice(0, 16) + '...',
            '    PDA: ' + a.publicKey.toBase58(),
            '    Status: ' + formatTaskStatus(acc.status as number | Record<string, unknown>),
            '    Type: ' + formatTaskType(acc.taskType as number | Record<string, unknown>),
            '    Reward: ' + formatSol(Number(acc.rewardAmount ?? 0)),
            '    Workers: ' + (acc.currentWorkers ?? 0) + '/' + (acc.maxWorkers ?? 1),
          ].join('\n');
        });

        return {
          content: [{
            type: 'text' as const,
            text: 'Found ' + accounts.length + ' task(s):\n\n' + lines.join('\n\n'),
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
    'agenc_get_escrow',
    'Get escrow balance and state for a task',
    {
      task_pda: z.string().optional().describe('Task PDA (base58)'),
      escrow_pda: z.string().optional().describe('Escrow PDA (base58) — if known directly'),
    },
    async ({ task_pda, escrow_pda }) => {
      try {
        let escrowAddr: PublicKey;
        let taskAddr: PublicKey | null = null;

        if (escrow_pda) {
          escrowAddr = new PublicKey(escrow_pda);
        } else if (task_pda) {
          taskAddr = new PublicKey(task_pda);
          escrowAddr = deriveEscrowPda(taskAddr, getCurrentProgramId());
        } else {
          return {
            content: [{
              type: 'text' as const,
              text: 'Error: provide either task_pda or escrow_pda',
            }],
          };
        }

        const connection = getConnection();
        const balance = await connection.getBalance(escrowAddr);

        const lines = [
          'Escrow PDA: ' + escrowAddr.toBase58(),
        ];
        if (taskAddr) {
          lines.push('Task PDA: ' + taskAddr.toBase58());
        }
        lines.push(
          'Balance: ' + formatSol(balance),
          'Lamports: ' + balance,
        );

        // Try to fetch task for additional context
        if (taskAddr) {
          try {
            const program = getReadOnlyProgram();
            const task = await program.account.task.fetch(taskAddr) as unknown as Record<string, unknown>;
            lines.push(
              '',
              '--- Task Context ---',
              'Status: ' + formatTaskStatus(task.status as number | Record<string, unknown>),
              'Reward Amount: ' + formatSol(Number(task.rewardAmount ?? 0)),
              'Completions: ' + (task.completions ?? 0),
            );
          } catch {
            // Task may not exist or be accessible
          }
        }

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: 'Error: ' + (error as Error).message }],
        };
      }
    },
  );

  server.tool(
    'agenc_create_task',
    'Create a new task with escrow reward (requires signing keypair)',
    {
      capabilities: z.array(z.string()).describe('Required capability names'),
      reward: z.number().positive().describe('Reward amount in SOL'),
      task_type: z
        .enum(['exclusive', 'collaborative', 'competitive'])
        .default('exclusive')
        .describe('Task type'),
      max_workers: z.number().int().positive().default(1).describe('Maximum workers'),
      deadline_minutes: z.number().positive().default(60).describe('Deadline in minutes from now'),
      description: z.string().optional().describe('Task description (max 64 bytes)'),
    },
    async ({ capabilities: _capabilities, reward: _reward, task_type: _task_type, max_workers: _max_workers, deadline_minutes: _deadline_minutes, description: _description }) => {
      // Task creation requires full transaction building which depends on
      // the specific Anchor instruction accounts. This is a placeholder
      // that returns the derived parameters for manual transaction building.
      return {
        content: [{
          type: 'text' as const,
          text: [
            'Task creation via MCP requires a running validator and funded keypair.',
            'Use the SDK directly for transaction submission:',
            '',
            '  import { createTask } from "@agenc/sdk";',
            '  await createTask(connection, program, creator, params);',
            '',
            'Or use anchor test to run the full integration test suite.',
          ].join('\n'),
        }],
      };
    },
  );

  server.tool(
    'agenc_claim_task',
    'Claim a task as a worker (requires signing keypair)',
    {
      task_pda: z.string().describe('Task PDA (base58)'),
      agent_id: z.string().describe('Agent ID (64-char hex)'),
    },
    async ({ task_pda: _task_pda, agent_id: _agent_id }) => {
      return {
        content: [{
          type: 'text' as const,
          text: [
            'Task claiming via MCP requires a running validator and funded keypair.',
            'Use the SDK directly for transaction submission:',
            '',
            '  import { claimTask } from "@agenc/sdk";',
            '  await claimTask(connection, program, agent, taskId);',
          ].join('\n'),
        }],
      };
    },
  );

  server.tool(
    'agenc_complete_task',
    'Complete a claimed task with proof (requires signing keypair)',
    {
      task_pda: z.string().describe('Task PDA (base58)'),
      agent_id: z.string().describe('Agent ID (64-char hex)'),
      proof_hash: z.string().describe('Proof hash (64-char hex)'),
    },
    async ({ task_pda: _task_pda, agent_id: _agent_id, proof_hash: _proof_hash }) => {
      return {
        content: [{
          type: 'text' as const,
          text: [
            'Task completion via MCP requires a running validator and funded keypair.',
            'Use the SDK directly for transaction submission:',
            '',
            '  import { completeTask } from "@agenc/sdk";',
            '  await completeTask(connection, program, worker, taskId, resultHash);',
          ].join('\n'),
        }],
      };
    },
  );

  server.tool(
    'agenc_cancel_task',
    'Cancel a task (creator only, requires signing keypair)',
    {
      task_pda: z.string().describe('Task PDA (base58)'),
    },
    async ({ task_pda: _task_pda }) => {
      return {
        content: [{
          type: 'text' as const,
          text: [
            'Task cancellation via MCP requires a running validator and funded keypair.',
            'Use the SDK or Anchor test suite for transaction submission.',
          ].join('\n'),
        }],
      };
    },
  );
}
