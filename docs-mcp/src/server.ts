import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadDocs } from './loader.js';
import { SearchIndex } from './search.js';
import { IssueResolver } from './issue-resolver.js';
import { registerSearchTools } from './tools/search.js';
import { registerIssueTools } from './tools/issues.js';
import { registerPhaseTools } from './tools/phases.js';
import { registerModuleTools } from './tools/modules.js';
import { registerPrompts } from './prompts/implementation.js';

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'AgenC Architecture Docs',
    version: '0.1.0',
  });

  // Load all documentation from disk
  const loaded = loadDocs();

  // Build search index
  const searchIndex = new SearchIndex();
  searchIndex.build(loaded.docs);

  // Create issue resolver
  const resolver = new IssueResolver(
    loaded.issues,
    loaded.issueMapRaw,
    loaded.roadmapContent,
    loaded.docs,
  );

  // Register resources — each doc file as an MCP resource
  for (const [docPath, entry] of loaded.docs) {
    const uri = `agenc-docs://architecture/${docPath}`;
    const safeName = docPath.replace(/[^a-zA-Z0-9_-]/g, '_');
    server.resource(
      safeName,
      uri,
      { description: entry.title },
      async (resourceUri) => ({
        contents: [{
          uri: resourceUri.href,
          text: entry.content,
        }],
      }),
    );
  }

  // Special aggregate resources
  if (loaded.issueMapRaw) {
    server.resource(
      'issue-map',
      'agenc-docs://issue-map',
      { description: 'Full issue-map.json — machine-readable index of all 58 roadmap issues' },
      async (uri) => ({
        contents: [{
          uri: uri.href,
          text: JSON.stringify(loaded.issueMapRaw, null, 2),
        }],
      }),
    );
  }

  if (loaded.roadmapContent) {
    server.resource(
      'roadmap',
      'agenc-docs://roadmap',
      { description: 'Full ROADMAP.md — source document for all phase guides' },
      async (uri) => ({
        contents: [{
          uri: uri.href,
          text: loaded.roadmapContent,
        }],
      }),
    );
  }

  // Conventions aggregate
  const guideEntries = [...loaded.docs.values()].filter((e) => e.category === 'guide');
  if (guideEntries.length > 0) {
    const conventionsText = guideEntries.map((e) => `---\n\n${e.content}`).join('\n\n');
    server.resource(
      'conventions',
      'agenc-docs://conventions',
      { description: 'All implementation guides concatenated — type conventions, testing patterns, error handling' },
      async (uri) => ({
        contents: [{
          uri: uri.href,
          text: conventionsText,
        }],
      }),
    );
  }

  // Register tools
  registerSearchTools(server, searchIndex);
  registerIssueTools(server, resolver);
  registerPhaseTools(server, resolver);
  registerModuleTools(server, loaded.docs);

  // Register prompts
  registerPrompts(server);

  return server;
}
