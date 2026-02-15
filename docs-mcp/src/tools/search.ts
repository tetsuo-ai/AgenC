import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SearchIndex } from '../search.js';

export function registerSearchTools(server: McpServer, searchIndex: SearchIndex): void {
  server.tool(
    'docs_search',
    'Full-text search across AgenC architecture documentation. Returns ranked results with context snippets.',
    { query: z.string().describe('Search query (e.g. "gateway", "dispute resolution", "tool registry")') },
    async ({ query }) => {
      const results = searchIndex.search(query, 10);

      if (results.length === 0) {
        return {
          content: [{ type: 'text' as const, text: `No results found for "${query}".` }],
        };
      }

      const lines: string[] = [];
      lines.push(`## Search Results for "${query}"`);
      lines.push('');

      for (const result of results) {
        lines.push(`### ${result.title} (${Math.round(result.score * 100)}% match)`);
        lines.push(`**Path:** \`docs/${result.path}\``);
        lines.push('');
        lines.push(result.snippet);
        lines.push('');
        lines.push('---');
        lines.push('');
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    },
  );
}
