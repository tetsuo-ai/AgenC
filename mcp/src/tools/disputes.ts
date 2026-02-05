import { PublicKey } from '@solana/web3.js';
import { SEEDS } from '@agenc/sdk';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getReadOnlyProgram, getCurrentProgramId } from '../utils/connection.js';
import {
  formatTimestamp,
  formatDisputeStatus,
  formatResolutionType,
  safePubkey,
} from '../utils/formatting.js';

function formatDisputeAccount(account: Record<string, unknown>, pda: PublicKey): string {
  const disputeId = account.disputeId as Uint8Array | number[];
  const idHex = Buffer.from(
    disputeId instanceof Uint8Array ? disputeId : new Uint8Array(disputeId),
  ).toString('hex');

  const lines = [
    'Dispute PDA: ' + pda.toBase58(),
    'Dispute ID: ' + idHex,
    'Status: ' + formatDisputeStatus(account.status as number | Record<string, unknown>),
    'Resolution Type: ' + formatResolutionType(account.resolutionType as number | Record<string, unknown>),
    '',
    '--- Parties ---',
    'Task PDA: ' + safePubkey(account.task),
    'Initiator: ' + safePubkey(account.initiator),
    '',
    '--- Voting ---',
    'Votes For: ' + (account.votesFor ?? 0),
    'Votes Against: ' + (account.votesAgainst ?? 0),
    'Voting Deadline: ' + formatTimestamp(Number(account.votingDeadline ?? 0)),
    '',
    '--- Evidence ---',
    'Evidence: ' + ((account.evidence as string) || 'None'),
    '',
    '--- Timestamps ---',
    'Created: ' + formatTimestamp(Number(account.createdAt ?? 0)),
    'Resolved: ' + formatTimestamp(Number(account.resolvedAt ?? 0)),
  ];

  return lines.join('\n');
}

export function registerDisputeTools(server: McpServer): void {
  server.tool(
    'agenc_get_dispute',
    'Get dispute state by dispute ID or PDA',
    {
      dispute_id: z.string().optional().describe('Dispute ID (64-char hex)'),
      dispute_pda: z.string().optional().describe('Dispute PDA (base58)'),
    },
    async ({ dispute_id, dispute_pda }) => {
      try {
        const program = getReadOnlyProgram();
        let pda: PublicKey;

        if (dispute_pda) {
          pda = new PublicKey(dispute_pda);
        } else if (dispute_id) {
          const idBuf = Buffer.from(dispute_id, 'hex');
          [pda] = PublicKey.findProgramAddressSync(
            [SEEDS.DISPUTE, idBuf],
            getCurrentProgramId(),
          );
        } else {
          return {
            content: [{
              type: 'text' as const,
              text: 'Error: provide either dispute_id or dispute_pda',
            }],
          };
        }

        const account = await program.account.dispute.fetch(pda);
        return {
          content: [{
            type: 'text' as const,
            text: formatDisputeAccount(account as unknown as Record<string, unknown>, pda),
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
    'agenc_list_disputes',
    'List disputes (optionally filter by status)',
    {
      status_filter: z
        .enum(['active', 'resolved', 'expired'])
        .optional()
        .describe('Filter by dispute status'),
    },
    async ({ status_filter }) => {
      try {
        const program = getReadOnlyProgram();
        const accounts = await program.account.dispute.all();

        let filtered = accounts;
        if (status_filter) {
          filtered = accounts.filter((a) => {
            const status = a.account.status as Record<string, unknown>;
            if (typeof status === 'object' && status !== null) {
              return Object.keys(status).some((k) => k === status_filter);
            }
            return false;
          });
        }

        if (filtered.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: status_filter
                ? 'No disputes found with status: ' + status_filter
                : 'No disputes found',
            }],
          };
        }

        const lines = filtered.map((a, i) => {
          const acc = a.account as unknown as Record<string, unknown>;
          const disputeId = acc.disputeId as Uint8Array | number[];
          const idHex = Buffer.from(
            disputeId instanceof Uint8Array ? disputeId : new Uint8Array(disputeId),
          ).toString('hex');
          return [
            '[' + (i + 1) + '] Dispute ' + idHex.slice(0, 16) + '...',
            '    PDA: ' + a.publicKey.toBase58(),
            '    Status: ' + formatDisputeStatus(acc.status as number | Record<string, unknown>),
            '    Resolution: ' + formatResolutionType(acc.resolutionType as number | Record<string, unknown>),
            '    Votes: ' + (acc.votesFor ?? 0) + ' for / ' + (acc.votesAgainst ?? 0) + ' against',
            '    Deadline: ' + formatTimestamp(Number(acc.votingDeadline ?? 0)),
          ].join('\n');
        });

        return {
          content: [{
            type: 'text' as const,
            text: 'Found ' + filtered.length + ' dispute(s):\n\n' + lines.join('\n\n'),
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
