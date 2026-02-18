/**
 * Program Account Inspector MCP Tools
 *
 * Fetches and decodes on-chain AgenC accounts into human-readable JSON
 * using the program IDL. Supports agent, task, escrow, dispute, and
 * transaction inspection.
 */

import { PublicKey } from '@solana/web3.js';
import { BorshCoder } from '@coral-xyz/anchor';
import { SEEDS } from '@agenc/sdk';
import { getCapabilityNames, hexToBytes, IDL } from '@agenc/runtime';
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
  formatStatus,
  formatTaskStatus,
  formatTaskType,
  formatDisputeStatus,
  formatResolutionType,
  formatBytes,
} from '../utils/formatting.js';
import { withToolErrorResponse } from './response.js';

/** Known account type names from IDL */
// Known account types: agentRegistration, task, taskEscrow, taskClaim,
// dispute, disputeVote, authorityDisputeVote, protocolConfig, coordinationState

/**
 * Format any decoded account into readable text.
 */
function formatDecodedAccount(
  data: Record<string, unknown>,
  accountType: string,
  pubkey: PublicKey,
): string {
  const lines: string[] = ['Account: ' + pubkey.toBase58(), 'Type: ' + accountType, ''];

  for (const [key, value] of Object.entries(data)) {
    lines.push(formatField(key, value));
  }

  return lines.join('\n');
}

/**
 * Format a single field with type-aware rendering.
 */
function formatField(key: string, value: unknown, indent = ''): string {
  // PublicKey
  if (value instanceof PublicKey) {
    return indent + key + ': ' + value.toBase58();
  }

  // BN from Anchor
  if (value !== null && typeof value === 'object' && 'toNumber' in (value as Record<string, unknown>)) {
    const bn = value as { toNumber: () => number; toString: () => string };
    const num = bn.toNumber();

    // Detect timestamps (reasonable Unix timestamp range)
    if (isTimestampField(key) && num > 1_000_000_000 && num < 10_000_000_000) {
      return indent + key + ': ' + formatTimestamp(num);
    }

    // Detect lamport amounts
    if (isLamportField(key)) {
      return indent + key + ': ' + formatSol(num) + ' (' + num + ' lamports)';
    }

    // Capabilities bitmask
    if (key === 'capabilities' || key === 'requiredCapabilities') {
      const bigVal = BigInt(bn.toString());
      const names = getCapabilityNames(bigVal);
      return indent + key + ': ' + (names.length > 0 ? names.join(', ') : 'None') + ' (bitmask: ' + bigVal + ')';
    }

    return indent + key + ': ' + num;
  }

  // Byte arrays (agent IDs, hashes)
  if (value instanceof Uint8Array || (Array.isArray(value) && value.length > 0 && typeof value[0] === 'number')) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value as number[]);
    if (bytes.length === 32) {
      // Could be a pubkey or hash
      if (isIdField(key)) {
        return indent + key + ': ' + Buffer.from(bytes).toString('hex');
      }
      try {
        const pk = new PublicKey(bytes);
        return indent + key + ': ' + pk.toBase58() + ' (pubkey)';
      } catch {
        return indent + key + ': ' + Buffer.from(bytes).toString('hex');
      }
    }
    return indent + key + ': ' + formatBytes(bytes);
  }

  // Anchor enum: { active: {} }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length === 1 && typeof (value as Record<string, unknown>)[keys[0]] === 'object') {
      const inner = (value as Record<string, Record<string, unknown>>)[keys[0]];
      if (inner !== null && Object.keys(inner).length === 0) {
        // Format enums nicely
        if (key === 'status') {
          if (isTaskStatusField(key, keys[0])) return indent + key + ': ' + formatTaskStatus(value as Record<string, unknown>);
          if (isDisputeStatusField(keys[0])) return indent + key + ': ' + formatDisputeStatus(value as Record<string, unknown>);
          return indent + key + ': ' + formatStatus(value as Record<string, unknown>);
        }
        if (key === 'taskType') return indent + key + ': ' + formatTaskType(value as Record<string, unknown>);
        if (key === 'resolutionType') return indent + key + ': ' + formatResolutionType(value as Record<string, unknown>);
        return indent + key + ': ' + keys[0].charAt(0).toUpperCase() + keys[0].slice(1);
      }
    }
  }

  // null
  if (value === null || value === undefined) {
    return indent + key + ': null';
  }

  // Primitives
  return indent + key + ': ' + String(value);
}

function isTimestampField(key: string): boolean {
  const tsFields = ['registeredAt', 'lastActive', 'createdAt', 'updatedAt', 'deadline', 'votingDeadline', 'resolvedAt', 'claimedAt', 'completedAt', 'lastTaskCreated', 'lastDisputeInitiated', 'rateLimitWindowStart'];
  return tsFields.includes(key);
}

function isLamportField(key: string): boolean {
  const lamportFields = ['rewardAmount', 'stake', 'totalEarned', 'totalValueDistributed', 'minAgentStake', 'minArbiterStake', 'minStakeForDispute', 'balance', 'amount', 'refundAmount'];
  return lamportFields.includes(key);
}

function isIdField(key: string): boolean {
  return key.endsWith('Id') || key === 'agentId' || key === 'taskId' || key === 'disputeId';
}

function isTaskStatusField(_key: string, enumValue: string): boolean {
  return ['open', 'inProgress', 'pendingValidation', 'completed', 'cancelled', 'disputed'].includes(enumValue);
}

function isDisputeStatusField(enumValue: string): boolean {
  return ['active', 'resolved', 'expired'].includes(enumValue);
}

export function registerInspectorTools(server: McpServer): void {
  server.tool(
    'agenc_inspect_account',
    'Fetch and decode any AgenC account by pubkey using the IDL',
    {
      pubkey: z.string().describe('Account public key (base58)'),
    },
    withToolErrorResponse(async ({ pubkey }) => {
        const connection = getConnection();
        const pk = new PublicKey(pubkey);
        const accountInfo = await connection.getAccountInfo(pk);

        if (!accountInfo) {
          return {
            content: [{ type: 'text' as const, text: 'Account not found: ' + pubkey }],
          };
        }

        const programId = getCurrentProgramId();

        // Check if it's owned by the AgenC program
        if (!accountInfo.owner.equals(programId)) {
          const lines = [
            'Account: ' + pubkey,
            'Owner: ' + accountInfo.owner.toBase58(),
            'Note: This account is NOT owned by AgenC program (' + programId.toBase58() + ')',
            'Data length: ' + accountInfo.data.length + ' bytes',
            'Lamports: ' + accountInfo.lamports + ' (' + formatSol(accountInfo.lamports) + ')',
            'Executable: ' + accountInfo.executable,
          ];
          return {
            content: [{ type: 'text' as const, text: lines.join('\n') }],
          };
        }

        // Try to decode using IDL
        const coder = new BorshCoder(IDL);
        const decoded = coder.accounts.decodeAny(accountInfo.data);

        if (!decoded) {
          return {
            content: [{
              type: 'text' as const,
              text: [
                'Account: ' + pubkey,
                'Owner: ' + accountInfo.owner.toBase58() + ' (AgenC program)',
                'Data length: ' + accountInfo.data.length + ' bytes',
                'Could not decode account data with IDL. The discriminator may not match any known account type.',
              ].join('\n'),
            }],
          };
        }

        const data = decoded as Record<string, unknown>;
        // Try to identify the account type from the discriminator
        let accountType = 'Unknown';
        for (const acct of IDL.accounts ?? []) {
          try {
            const testDecode = coder.accounts.decode(acct.name, accountInfo.data);
            if (testDecode) {
              accountType = acct.name;
              break;
            }
          } catch {
            // Not this type
          }
        }

        const text = formatDecodedAccount(data, accountType, pk);

        return {
          content: [{
            type: 'text' as const,
            text: text + '\n\nLamports: ' + accountInfo.lamports + ' (' + formatSol(accountInfo.lamports) + ')\nData length: ' + accountInfo.data.length + ' bytes',
          }],
        };
    }),
  );

  server.tool(
    'agenc_inspect_agent',
    'Inspect an agent account (derives PDA from agent_id or fetches by pubkey)',
    {
      agent_id: z.string().optional().describe('Agent ID (64-char hex string)'),
      pubkey: z.string().optional().describe('Agent PDA address (base58)'),
    },
    withToolErrorResponse(async ({ agent_id, pubkey }) => {
        const program = getReadOnlyProgram();
        const programId = getCurrentProgramId();
        let pda: PublicKey;

        if (pubkey) {
          pda = new PublicKey(pubkey);
        } else if (agent_id) {
          const idBytes = hexToBytes(agent_id);
          [pda] = PublicKey.findProgramAddressSync(
            [SEEDS.AGENT, Buffer.from(idBytes)],
            programId,
          );
        } else {
          return {
            content: [{ type: 'text' as const, text: 'Error: provide either agent_id or pubkey' }],
          };
        }

        const account = await program.account.agentRegistration.fetch(pda);
        const acc = account as unknown as Record<string, unknown>;
        const text = formatDecodedAccount(acc, 'AgentRegistration', pda);

        return {
          content: [{ type: 'text' as const, text: text }],
        };
    }),
  );

  server.tool(
    'agenc_inspect_task',
    'Inspect a task account (derives PDA from creator + task_id, or fetches by pubkey)',
    {
      creator: z.string().optional().describe('Task creator pubkey (base58)'),
      task_id: z.string().optional().describe('Task ID (64-char hex string)'),
      pubkey: z.string().optional().describe('Task PDA address (base58)'),
    },
    withToolErrorResponse(async ({ creator, task_id, pubkey }) => {
        const program = getReadOnlyProgram();
        const programId = getCurrentProgramId();
        let pda: PublicKey;

        if (pubkey) {
          pda = new PublicKey(pubkey);
        } else if (creator && task_id) {
          const creatorPk = new PublicKey(creator);
          const idBytes = hexToBytes(task_id);
          [pda] = PublicKey.findProgramAddressSync(
            [SEEDS.TASK, creatorPk.toBuffer(), Buffer.from(idBytes)],
            programId,
          );
        } else {
          return {
            content: [{ type: 'text' as const, text: 'Error: provide either pubkey, or both creator and task_id' }],
          };
        }

        const account = await program.account.task.fetch(pda);
        const acc = account as unknown as Record<string, unknown>;

        // Also derive escrow PDA for context
        const [escrowPda] = PublicKey.findProgramAddressSync(
          [SEEDS.ESCROW, pda.toBuffer()],
          programId,
        );

        const text = formatDecodedAccount(acc, 'Task', pda);
        const escrowBalance = await getConnection().getBalance(escrowPda).catch(() => 0);

        return {
          content: [{
            type: 'text' as const,
            text: text + '\n\n--- Escrow ---\nEscrow PDA: ' + escrowPda.toBase58() + '\nEscrow Balance: ' + formatSol(escrowBalance),
          }],
        };
    }),
  );

  server.tool(
    'agenc_inspect_escrow',
    'Inspect an escrow account for a task (derives PDA from task or fetches by pubkey)',
    {
      task_pda: z.string().optional().describe('Task PDA (base58) to derive escrow from'),
      pubkey: z.string().optional().describe('Escrow PDA address (base58) directly'),
    },
    withToolErrorResponse(async ({ task_pda, pubkey }) => {
        const connection = getConnection();
        const programId = getCurrentProgramId();
        let escrowAddr: PublicKey;
        let taskAddr: PublicKey | null = null;

        if (pubkey) {
          escrowAddr = new PublicKey(pubkey);
        } else if (task_pda) {
          taskAddr = new PublicKey(task_pda);
          [escrowAddr] = PublicKey.findProgramAddressSync(
            [SEEDS.ESCROW, taskAddr.toBuffer()],
            programId,
          );
        } else {
          return {
            content: [{ type: 'text' as const, text: 'Error: provide either task_pda or pubkey' }],
          };
        }

        const accountInfo = await connection.getAccountInfo(escrowAddr);

        if (!accountInfo) {
          return {
            content: [{
              type: 'text' as const,
              text: 'Escrow account not found: ' + escrowAddr.toBase58() + (taskAddr ? '\nDerived from task: ' + taskAddr.toBase58() : ''),
            }],
          };
        }

        const lines = [
          'Escrow PDA: ' + escrowAddr.toBase58(),
        ];
        if (taskAddr) lines.push('Task PDA: ' + taskAddr.toBase58());
        lines.push(
          'Owner: ' + accountInfo.owner.toBase58(),
          'Balance: ' + formatSol(accountInfo.lamports) + ' (' + accountInfo.lamports + ' lamports)',
          'Data length: ' + accountInfo.data.length + ' bytes',
        );

        // Fetch task for context
        if (taskAddr) {
          try {
            const program = getReadOnlyProgram();
            const task = await program.account.task.fetch(taskAddr) as unknown as Record<string, unknown>;
            lines.push(
              '',
              '--- Task Context ---',
              'Status: ' + formatTaskStatus(task.status as number | Record<string, unknown>),
              'Type: ' + formatTaskType(task.taskType as number | Record<string, unknown>),
              'Reward: ' + formatSol(Number(task.rewardAmount ?? 0)),
              'Completions: ' + (task.completions ?? 0),
              'Workers: ' + (task.currentWorkers ?? 0) + '/' + (task.maxWorkers ?? 1),
            );
          } catch {
            // Task may not exist
          }
        }

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
        };
    }),
  );

  server.tool(
    'agenc_inspect_dispute',
    'Inspect a dispute account (derives PDA from dispute_id or fetches by pubkey)',
    {
      dispute_id: z.string().optional().describe('Dispute ID (64-char hex string)'),
      pubkey: z.string().optional().describe('Dispute PDA address (base58)'),
    },
    withToolErrorResponse(async ({ dispute_id, pubkey }) => {
        const program = getReadOnlyProgram();
        const programId = getCurrentProgramId();
        let pda: PublicKey;

        if (pubkey) {
          pda = new PublicKey(pubkey);
        } else if (dispute_id) {
          const idBytes = hexToBytes(dispute_id);
          [pda] = PublicKey.findProgramAddressSync(
            [SEEDS.DISPUTE, Buffer.from(idBytes)],
            programId,
          );
        } else {
          return {
            content: [{ type: 'text' as const, text: 'Error: provide either dispute_id or pubkey' }],
          };
        }

        const account = await program.account.dispute.fetch(pda);
        const acc = account as unknown as Record<string, unknown>;
        const text = formatDecodedAccount(acc, 'Dispute', pda);

        return {
          content: [{ type: 'text' as const, text: text }],
        };
    }),
  );

  server.tool(
    'agenc_list_program_accounts',
    'List all AgenC accounts of a given type using getProgramAccounts',
    {
      account_type: z.enum(['agent', 'task', 'escrow', 'dispute', 'claim', 'vote', 'protocol', 'state']).describe('Account type to list'),
      limit: z.number().int().positive().optional().describe('Maximum number of accounts to return (default: 20)'),
    },
    withToolErrorResponse(async ({ account_type, limit }) => {
        const program = getReadOnlyProgram();
        const maxResults = limit ?? 20;

        // Map type to Anchor account accessor
        const accessorMap: Record<string, string> = {
          agent: 'agentRegistration',
          task: 'task',
          escrow: 'taskEscrow',
          dispute: 'dispute',
          claim: 'taskClaim',
          vote: 'disputeVote',
          protocol: 'protocolConfig',
          state: 'coordinationState',
        };

        const accessor = accessorMap[account_type];
        if (!accessor) {
          return {
            content: [{ type: 'text' as const, text: 'Error: unknown account type "' + account_type + '"' }],
          };
        }

        // Use dynamic access to program.account
        const accountAccessor = (program.account as Record<string, { all: () => Promise<Array<{ publicKey: PublicKey; account: unknown }>> }>)[accessor];
        if (!accountAccessor) {
          return {
            content: [{ type: 'text' as const, text: 'Error: account accessor "' + accessor + '" not found in program' }],
          };
        }

        const accounts = await accountAccessor.all();

        if (accounts.length === 0) {
          return {
            content: [{ type: 'text' as const, text: 'No ' + account_type + ' accounts found' }],
          };
        }

        const displayed = accounts.slice(0, maxResults);
        const lines: string[] = [
          'Found ' + accounts.length + ' ' + account_type + ' account(s)' + (accounts.length > maxResults ? ' (showing first ' + maxResults + ')' : '') + ':',
          '',
        ];

        for (let i = 0; i < displayed.length; i++) {
          const a = displayed[i];
          const acc = a.account as Record<string, unknown>;

          lines.push('[' + (i + 1) + '] ' + a.publicKey.toBase58());

          // Show summary fields based on type
          switch (account_type) {
            case 'agent': {
              const agentId = acc.agentId as Uint8Array | number[];
              const idBytes = agentId instanceof Uint8Array ? agentId : new Uint8Array(agentId);
              lines.push('    ID: ' + Buffer.from(idBytes).toString('hex').slice(0, 16) + '...');
              lines.push('    Status: ' + formatStatus(acc.status as number | Record<string, unknown>));
              lines.push('    Active Tasks: ' + (acc.activeTasks ?? 0));
              break;
            }
            case 'task': {
              lines.push('    Status: ' + formatTaskStatus(acc.status as number | Record<string, unknown>));
              lines.push('    Type: ' + formatTaskType(acc.taskType as number | Record<string, unknown>));
              lines.push('    Reward: ' + formatSol(Number(acc.rewardAmount ?? 0)));
              break;
            }
            case 'dispute': {
              lines.push('    Status: ' + formatDisputeStatus(acc.status as number | Record<string, unknown>));
              lines.push('    Votes: ' + (acc.votesFor ?? 0) + ' for / ' + (acc.votesAgainst ?? 0) + ' against');
              break;
            }
            default:
              // Generic: show first few fields
              for (const [key, value] of Object.entries(acc).slice(0, 3)) {
                lines.push('    ' + formatField(key, value, ''));
              }
          }
          lines.push('');
        }

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
        };
    }),
  );

  server.tool(
    'agenc_inspect_transaction',
    'Fetch and decode a transaction with AgenC instruction details',
    {
      signature: z.string().describe('Transaction signature (base58)'),
    },
    withToolErrorResponse(async ({ signature }) => {
        const connection = getConnection();
        const tx = await connection.getTransaction(signature, {
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
        });

        if (!tx) {
          return {
            content: [{ type: 'text' as const, text: 'Transaction not found: ' + signature }],
          };
        }

        const lines = [
          'Transaction: ' + signature,
          'Slot: ' + tx.slot,
          'Block Time: ' + (tx.blockTime ? formatTimestamp(tx.blockTime) : 'unknown'),
          'Status: ' + (tx.meta?.err ? 'FAILED' : 'SUCCESS'),
        ];

        if (tx.meta?.err) {
          lines.push('Error: ' + JSON.stringify(tx.meta.err));
        }

        lines.push(
          'Fee: ' + formatSol(tx.meta?.fee ?? 0),
          'Compute Units: ' + (tx.meta?.computeUnitsConsumed ?? 'unknown'),
        );

        // List accounts involved
        const accountKeys = tx.transaction.message.staticAccountKeys
          ?? (tx.transaction.message as unknown as { accountKeys: PublicKey[] }).accountKeys
          ?? [];
        const programId = getCurrentProgramId();

        lines.push('', '--- Accounts (' + accountKeys.length + ') ---');
        for (let i = 0; i < Math.min(accountKeys.length, 15); i++) {
          const key = accountKeys[i];
          const isProgram = key.equals(programId);
          lines.push('  [' + i + '] ' + key.toBase58() + (isProgram ? ' (AgenC program)' : ''));
        }
        if (accountKeys.length > 15) {
          lines.push('  ... and ' + (accountKeys.length - 15) + ' more');
        }

        // Try to decode AgenC instructions
        const coder = new BorshCoder(IDL);
        const compiledInstructions = tx.transaction.message.compiledInstructions
          ?? (tx.transaction.message as unknown as { instructions: Array<{ programIdIndex: number; data: Buffer | Uint8Array }> }).instructions
          ?? [];

        lines.push('', '--- Instructions ---');
        let ixIndex = 0;
        for (const ix of compiledInstructions) {
          const progIndex = 'programIdIndex' in ix ? ix.programIdIndex : (ix as unknown as { programIdIndex: number }).programIdIndex;
          const progKey = accountKeys[progIndex];

          if (progKey && progKey.equals(programId)) {
            try {
              const ixData = 'data' in ix
                ? (ix.data instanceof Uint8Array ? Buffer.from(ix.data) : Buffer.from(ix.data as string, 'base64'))
                : Buffer.alloc(0);
              const decoded = coder.instruction.decode(ixData);
              if (decoded) {
                lines.push('[' + ixIndex + '] AgenC: ' + decoded.name);
                // Show decoded args
                const args = decoded.data as Record<string, unknown>;
                if (args && typeof args === 'object') {
                  for (const [key, value] of Object.entries(args)) {
                    lines.push('     ' + formatField(key, value, ''));
                  }
                }
              } else {
                lines.push('[' + ixIndex + '] AgenC: (could not decode)');
              }
            } catch {
              lines.push('[' + ixIndex + '] AgenC: (decode error)');
            }
          } else {
            lines.push('[' + ixIndex + '] Program: ' + (progKey ? progKey.toBase58() : 'unknown'));
          }
          ixIndex++;
        }

        // Show log messages
        if (tx.meta?.logMessages && tx.meta.logMessages.length > 0) {
          lines.push('', '--- Logs ---');
          const logs = tx.meta.logMessages;
          for (const log of logs.slice(0, 30)) {
            lines.push('  ' + log);
          }
          if (logs.length > 30) {
            lines.push('  ... and ' + (logs.length - 30) + ' more log lines');
          }
        }

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
        };
    }),
  );
}
