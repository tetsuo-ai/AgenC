import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { buildDisputeDriftPrompt } from './dispute-drift.js';
import { buildPayoutMismatchPrompt } from './payout-mismatch.js';
import { buildReplayAnomalyPrompt } from './replay-anomaly.js';

export function registerPrompts(server: McpServer): void {
  server.prompt(
    'debug-task',
    'Guided task debugging workflow',
    { task_pda: z.string().describe('Task PDA to debug') },
    ({ task_pda }) => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: 'Debug the AgenC task at PDA ' + task_pda + '. Steps:\n'
            + '1. Use agenc_get_task to fetch the task state\n'
            + '2. Check the task status and identify any issues\n'
            + '3. Use agenc_get_escrow to verify escrow balance\n'
            + '4. If disputed, use agenc_get_dispute to check dispute state\n'
            + '5. Summarize findings and suggest next steps',
        },
      }],
    }),
  );

  server.prompt(
    'inspect-agent',
    'Agent state inspection with decoded fields',
    { agent_id: z.string().describe('Agent ID (hex) or PDA (base58)') },
    ({ agent_id }) => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: 'Inspect the AgenC agent with ID/PDA ' + agent_id + '. Steps:\n'
            + '1. Use agenc_get_agent to fetch full agent state\n'
            + '2. Use agenc_decode_capabilities to explain the capability bitmask\n'
            + '3. Check rate limit state and active tasks\n'
            + '4. Summarize the agent health and any concerns',
        },
      }],
    }),
  );

  server.prompt(
    'escrow-audit',
    'Escrow balance verification checklist',
    { task_pda: z.string().describe('Task PDA to audit') },
    ({ task_pda }) => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: 'Audit the escrow for AgenC task at PDA ' + task_pda + '. Steps:\n'
            + '1. Use agenc_get_task to fetch the task reward amount and status\n'
            + '2. Use agenc_get_escrow to check actual escrow balance\n'
            + '3. Compare expected vs actual balance\n'
            + '4. Check if completions match distributed amounts\n'
            + '5. Use agenc_get_protocol_config to verify fee calculations\n'
            + '6. Report any discrepancies',
        },
      }],
    }),
  );

  server.prompt(
    'dispute-drift-triage',
    'Guided dispute drift investigation workflow',
    {
      dispute_pda: z.string().describe('Dispute PDA to investigate'),
      trace_id: z.string().optional().describe('Trace ID for correlation'),
    },
    ({ dispute_pda, trace_id }) => buildDisputeDriftPrompt({ dispute_pda, trace_id }),
  );

  server.prompt(
    'payout-mismatch',
    'Guided payout discrepancy investigation',
    {
      task_pda: z.string().describe('Task PDA with payout issue'),
      expected_payout_lamports: z.string().optional().describe('Expected payout in lamports'),
      trace_id: z.string().optional().describe('Trace ID for correlation'),
    },
    ({ task_pda, expected_payout_lamports, trace_id }) => buildPayoutMismatchPrompt({
      task_pda,
      expected_payout_lamports,
      trace_id,
    }),
  );

  server.prompt(
    'replay-anomaly-root-cause',
    'Guided replay anomaly investigation',
    {
      anomaly_id: z.string().describe('Anomaly ID from replay tool output'),
      task_pda: z.string().optional().describe('Related task PDA'),
      dispute_pda: z.string().optional().describe('Related dispute PDA'),
      anomaly_code: z.string().optional().describe('Anomaly code (e.g., replay.missing_event)'),
      anomaly_message: z.string().optional().describe('Original anomaly message'),
      trace_id: z.string().optional().describe('Trace ID for correlation'),
    },
    (params) => buildReplayAnomalyPrompt(params),
  );
}

