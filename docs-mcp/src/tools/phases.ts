import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IssueResolver } from '../issue-resolver.js';

export function registerPhaseTools(server: McpServer, resolver: IssueResolver): void {
  server.tool(
    'docs_get_phase_graph',
    'Get the dependency graph and implementation order for a specific phase. Returns a Mermaid flowchart of issue dependencies and a recommended build sequence.',
    { phase: z.number().int().min(1).max(10).describe('Phase number (1-10)') },
    async ({ phase }) => {
      const graph = resolver.getPhaseDependencyGraph(phase);
      const issues = resolver.getPhaseIssues(phase);

      if (issues.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `No issues found for phase ${phase}.`,
          }],
        };
      }

      const lines: string[] = [];
      lines.push(`# Phase ${phase} Dependency Graph`);
      lines.push('');
      lines.push(graph);
      lines.push('');
      lines.push('## Issue Summary');
      lines.push('');
      lines.push('| # | Section | Title | Scope | Dependencies |');
      lines.push('|---|---------|-------|-------|-------------|');
      for (const issue of issues) {
        const deps = issue.dependsOnIssues.map((d) => `#${d}`).join(', ') || 'none';
        lines.push(`| #${issue.issueNumber} | ${issue.section} | ${issue.title} | ${issue.estimatedScope} | ${deps} |`);
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    },
  );
}
