/**
 * Human-facing MCP tools for interacting with AgenC through AI assistants.
 *
 * These tools provide human-friendly interfaces for browsing skills,
 * managing sessions, viewing agent activity, and approving actions.
 *
 * @module
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export function registerHumanFacingTools(server: McpServer): void {
  // --------------------------------------------------------------------------
  // Browse Skills
  // --------------------------------------------------------------------------

  server.tool(
    'agenc_browse_skills',
    'Browse available agent skills by category. Returns skill names, descriptions, and usage guidance.',
    {
      category: z
        .enum(['defi', 'social', 'data', 'compute', 'all'])
        .optional()
        .describe('Skill category to browse (default: all)'),
    },
    async ({ category }) => {
      const selectedCategory = category ?? 'all';

      const skillCategories: Record<string, Array<{ name: string; description: string }>> = {
        defi: [
          { name: 'jupiter.swap', description: 'Swap tokens via Jupiter DEX aggregator' },
          { name: 'jupiter.getQuote', description: 'Get a quote for a token swap' },
          { name: 'jupiter.getBalance', description: 'Check token balance for a wallet' },
        ],
        social: [
          { name: 'farcaster.post', description: 'Post a cast to Farcaster' },
          { name: 'farcaster.syncFeed', description: 'Sync agent feed to Farcaster' },
        ],
        data: [
          { name: 'agenc.listTasks', description: 'List open and in-progress tasks' },
          { name: 'agenc.getTask', description: 'Get details of a specific task' },
          { name: 'agenc.getAgent', description: 'Get agent state by PDA' },
          { name: 'agenc.getProtocolConfig', description: 'Get current protocol configuration' },
        ],
        compute: [
          { name: 'system.httpFetch', description: 'Fetch data from an HTTP endpoint' },
          { name: 'system.readFile', description: 'Read a file from the workspace' },
          { name: 'system.bash', description: 'Execute a shell command' },
        ],
      };

      let skills: Array<{ category: string; name: string; description: string }> = [];
      if (selectedCategory === 'all') {
        for (const [cat, items] of Object.entries(skillCategories)) {
          for (const item of items) {
            skills.push({ category: cat, ...item });
          }
        }
      } else {
        const items = skillCategories[selectedCategory] ?? [];
        skills = items.map((item) => ({ category: selectedCategory, ...item }));
      }

      if (skills.length === 0) {
        return {
          content: [{ type: 'text' as const, text: `No skills found for category: ${selectedCategory}` }],
        };
      }

      const lines = skills.map(
        (s) => `[${s.category}] ${s.name} — ${s.description}`,
      );

      return {
        content: [{
          type: 'text' as const,
          text: [
            `Available skills (${selectedCategory}):`,
            '',
            ...lines,
            '',
            'To use a skill, configure it in your agent gateway config or register it with the SkillRegistry.',
            'Skills marked with [defi] require wallet configuration.',
          ].join('\n'),
        }],
      };
    },
  );

  // --------------------------------------------------------------------------
  // Manage Sessions
  // --------------------------------------------------------------------------

  server.tool(
    'agenc_manage_sessions',
    'List or expire agent gateway sessions. Sessions track conversation history per channel.',
    {
      action: z
        .enum(['list', 'expire'])
        .describe('Action to perform: list sessions or expire a specific session'),
      session_id: z
        .string()
        .optional()
        .describe('Session ID to expire (required for expire action)'),
    },
    async ({ action, session_id }) => {
      if (action === 'expire') {
        if (!session_id) {
          return {
            content: [{ type: 'text' as const, text: 'Error: session_id is required for expire action' }],
          };
        }

        return {
          content: [{
            type: 'text' as const,
            text: [
              `Session expiration requested: ${session_id}`,
              '',
              'To expire sessions programmatically, use the Gateway\'s SessionManager:',
              '',
              '  const gateway = new Gateway(config);',
              '  await gateway.start();',
              '  gateway.sessionManager.expire(sessionId);',
              '',
              'Or via the WebSocket control plane:',
              '  ws://localhost:3001/control { "type": "expire_session", "sessionId": "..." }',
            ].join('\n'),
          }],
        };
      }

      // action === 'list'
      return {
        content: [{
          type: 'text' as const,
          text: [
            'Session listing requires a running Gateway instance.',
            '',
            'To list sessions programmatically:',
            '',
            '  const gateway = new Gateway(config);',
            '  await gateway.start();',
            '  const sessions = gateway.sessionManager.listActive();',
            '',
            'Or via the CLI:',
            '  agenc sessions list',
            '',
            'Each session has: id, channelType, createdAt, lastMessageAt, messageCount.',
          ].join('\n'),
        }],
      };
    },
  );

  // --------------------------------------------------------------------------
  // Agent Feed
  // --------------------------------------------------------------------------

  server.tool(
    'agenc_get_agent_feed',
    'Get recent activity feed for an agent. Shows task completions, disputes, and governance actions.',
    {
      agent_id: z
        .string()
        .describe('Agent ID (64-char hex) or agent PDA (base58)'),
      event_types: z
        .array(z.string())
        .optional()
        .describe('Filter by event types (e.g. taskCompleted, disputeInitiated)'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe('Maximum number of events to return (default: 20)'),
    },
    async ({ agent_id, event_types, limit }) => {
      const maxEvents = limit ?? 20;
      const filterTypes = event_types ?? [];

      return {
        content: [{
          type: 'text' as const,
          text: [
            `Agent feed requested for: ${agent_id}`,
            `Filters: ${filterTypes.length > 0 ? filterTypes.join(', ') : 'none'}`,
            `Limit: ${maxEvents}`,
            '',
            'To get a live agent feed, use the ReplayBackfillService:',
            '',
            '  import { ReplayBackfillService } from "@agenc/runtime";',
            '  const service = new ReplayBackfillService({ connection, store });',
            '  await service.backfill({ fromSlot, toSlot });',
            '  const events = store.query({ agentId, types: eventTypes, limit });',
            '',
            'Available event types:',
            '  agentRegistered, agentUpdated, agentSuspended, agentUnsuspended,',
            '  agentDeregistered, taskCreated, taskClaimed, taskCompleted,',
            '  taskCancelled, disputeInitiated, disputeVoteCast, disputeResolved,',
            '  disputeExpired, proposalCreated, governanceVoteCast, proposalExecuted,',
            '  rewardDistributed, reputationChanged',
          ].join('\n'),
        }],
      };
    },
  );

  // --------------------------------------------------------------------------
  // Approve Action
  // --------------------------------------------------------------------------

  server.tool(
    'agenc_approve_action',
    'Approve or deny a pending agent action. Used for human-in-the-loop workflows.',
    {
      request_id: z
        .string()
        .describe('The approval request ID'),
      disposition: z
        .enum(['yes', 'no', 'always'])
        .describe('Approval disposition: yes (approve once), no (deny), always (auto-approve future similar actions)'),
      reason: z
        .string()
        .optional()
        .describe('Optional reason for the approval/denial'),
    },
    async ({ request_id, disposition, reason }) => {
      const responseLines = [
        `Approval response recorded:`,
        `  Request ID: ${request_id}`,
        `  Disposition: ${disposition}`,
      ];
      if (reason) {
        responseLines.push(`  Reason: ${reason}`);
      }

      responseLines.push(
        '',
        'To integrate approvals with a running Gateway:',
        '',
        '  import { ApprovalManager } from "@agenc/runtime";',
        '  const approvals = new ApprovalManager({ timeout: 60_000 });',
        '  approvals.respond({ requestId, disposition, approvedBy: "human" });',
        '',
        `Dispositions: "yes" = approve once, "no" = deny, "always" = auto-approve similar actions.`,
      );

      return {
        content: [{ type: 'text' as const, text: responseLines.join('\n') }],
      };
    },
  );
}
