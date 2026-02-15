import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IssueResolver } from '../issue-resolver.js';

export function registerIssueTools(server: McpServer, resolver: IssueResolver): void {
  server.tool(
    'docs_get_issue_context',
    'Get full implementation context for a specific roadmap issue. Returns roadmap description, files to create/modify, dependencies, existing patterns to follow, key interfaces, and phase documentation.',
    { issue_number: z.number().int().describe('GitHub issue number (e.g. 1053, 1092, 1109)') },
    async ({ issue_number }) => {
      const context = resolver.getIssueContext(issue_number);

      if (!context) {
        return {
          content: [{
            type: 'text' as const,
            text: `Issue #${issue_number} not found in the roadmap. Valid issues: 1051-1110.`,
          }],
        };
      }

      return {
        content: [{ type: 'text' as const, text: context }],
      };
    },
  );
}
