import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadDocs } from './loader.js';
import { SearchIndex } from './search.js';
import { registerSearchTools } from './tools/search.js';
import { registerModuleTools } from './tools/modules.js';

function buildResourceUri(docPath: string): string {
  if (docPath.startsWith('docs/architecture/')) {
    return `agenc-docs://architecture/${docPath.slice('docs/architecture/'.length)}`;
  }
  if (docPath.startsWith('docs/')) {
    return `agenc-docs://docs/${docPath.slice('docs/'.length)}`;
  }
  if (docPath.startsWith('runtime/docs/')) {
    return `agenc-docs://runtime-docs/${docPath.slice('runtime/docs/'.length)}`;
  }
  return `agenc-docs://repo/${docPath}`;
}

function buildScopeManifest(loaded: ReturnType<typeof loadDocs>): string {
  const rootCounts = new Map<string, number>();
  const categoryCounts = new Map<string, number>();

  for (const entry of loaded.docs.values()) {
    const root = entry.path.includes('/') ? (entry.path.split('/')[0] ?? entry.path) : '(repo-root)';
    rootCounts.set(root, (rootCounts.get(root) ?? 0) + 1);
    categoryCounts.set(entry.category, (categoryCounts.get(entry.category) ?? 0) + 1);
  }

  const lines: string[] = [];
  lines.push('# Docs MCP Scope Manifest');
  lines.push('');
  lines.push(`Indexed entries: ${loaded.docs.size}`);
  lines.push('');
  lines.push('## Indexed roots');
  lines.push('');
  for (const [root, count] of [...rootCounts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`- ${root}: ${count}`);
  }
  lines.push('');
  lines.push('## Categories');
  lines.push('');
  for (const [category, count] of [...categoryCounts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`- ${category}: ${count}`);
  }
  lines.push('');
  lines.push('## Included surfaces');
  lines.push('');
  lines.push('- `docs/**/*.md`');
  lines.push('- `docs/**/*.json`');
  lines.push('- `runtime/docs/**/*.md`');
  lines.push('- `runtime/idl/**/*.json`');
  lines.push('- `runtime/benchmarks/**/*.json`');
  lines.push('- `scripts/idl/**/*.json`');
  lines.push('- package-local docs and changelogs under top-level packages, apps, platforms, programs, migrations, and `examples/**` when present');
  lines.push('- root docs: `README.md`, `AGENTS.md`, `CODEX.md`, `REFACTOR.MD`, `REFACTOR-MASTER-PROGRAM.md` when present');
  lines.push('');
  lines.push('## Important limits');
  lines.push('');
  lines.push('- This server indexes documentation and contract artifacts, not source code.');
  lines.push('- Legacy runtime-roadmap issue/phase prompts, tools, and special aggregate resources are intentionally not registered.');
  lines.push('- Retired roadmap and issue-map docs are not part of the indexed planning surface.');
  lines.push('- Module template/info/conventions tools remain runtime-scoped helpers and are not whole-repository planning authority.');

  return lines.join('\n');
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'AgenC Docs',
    version: '0.1.0',
  });

  // Load all documentation from disk
  const loaded = loadDocs();

  // Build search index
  const searchIndex = new SearchIndex();
  searchIndex.build(loaded.docs);

  // Register resources — each doc file as an MCP resource
  for (const [docPath, entry] of loaded.docs) {
    const uri = buildResourceUri(docPath);
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

  server.resource(
    'scope',
    'agenc-docs://scope',
    { description: 'Indexed scope manifest for docs-mcp coverage and limits' },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        text: buildScopeManifest(loaded),
      }],
    }),
  );

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
  registerModuleTools(server, loaded.docs);

  return server;
}
