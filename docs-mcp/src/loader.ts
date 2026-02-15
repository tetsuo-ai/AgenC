import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DocEntry, IssueEntry, IssueMapData } from './types.js';

/** Find repo root by walking up to Anchor.toml, or use DOCS_ROOT env var */
function findRepoRoot(): string {
  const envRoot = process.env.DOCS_ROOT;
  if (envRoot) {
    return envRoot;
  }

  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'Anchor.toml'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Fallback: assume docs-mcp is at repo-root/docs-mcp
  return path.resolve(__dirname, '..', '..');
}

function extractTitle(content: string, filePath: string): string {
  const match = content.match(/^#\s+(.+)$/m);
  if (match) return match[1].trim();
  return path.basename(filePath, '.md');
}

function categorize(relPath: string): DocEntry['category'] {
  if (relPath.includes('flows/')) return 'flow';
  if (relPath.includes('phases/')) return 'phase';
  if (relPath.includes('guides/')) return 'guide';
  if (relPath.includes('architecture/')) return 'architecture';
  return 'other';
}

function loadMarkdownFiles(dirPath: string, basePath: string): DocEntry[] {
  const entries: DocEntry[] = [];

  if (!fs.existsSync(dirPath)) return entries;

  const items = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const item of items) {
    const fullPath = path.join(dirPath, item.name);
    if (item.isDirectory()) {
      entries.push(...loadMarkdownFiles(fullPath, basePath));
    } else if (item.name.endsWith('.md')) {
      const content = fs.readFileSync(fullPath, 'utf-8');
      const relPath = path.relative(basePath, fullPath);
      entries.push({
        path: relPath,
        title: extractTitle(content, fullPath),
        content,
        category: categorize(relPath),
      });
    }
  }

  return entries;
}

export interface LoadedDocs {
  docs: Map<string, DocEntry>;
  issues: Map<number, IssueEntry>;
  issueMapRaw: IssueMapData | null;
  roadmapContent: string;
  repoRoot: string;
}

export function loadDocs(): LoadedDocs {
  const repoRoot = findRepoRoot();
  const docsDir = path.join(repoRoot, 'docs');
  const archDir = path.join(docsDir, 'architecture');

  // Load all markdown docs
  const docEntries = loadMarkdownFiles(archDir, docsDir);
  const docs = new Map<string, DocEntry>();
  for (const entry of docEntries) {
    docs.set(entry.path, entry);
  }

  // Load ROADMAP.md
  let roadmapContent = '';
  const roadmapPath = path.join(docsDir, 'ROADMAP.md');
  if (fs.existsSync(roadmapPath)) {
    roadmapContent = fs.readFileSync(roadmapPath, 'utf-8');
    docs.set('ROADMAP.md', {
      path: 'ROADMAP.md',
      title: 'AgenC Roadmap: Personal AI Agent Platform',
      content: roadmapContent,
      category: 'other',
    });
  }

  // Load issue-map.json
  const issues = new Map<number, IssueEntry>();
  let issueMapRaw: IssueMapData | null = null;
  const issueMapPath = path.join(archDir, 'issue-map.json');
  if (fs.existsSync(issueMapPath)) {
    const raw = JSON.parse(fs.readFileSync(issueMapPath, 'utf-8')) as IssueMapData;
    issueMapRaw = raw;
    for (const [numStr, entry] of Object.entries(raw.issues)) {
      const issueNumber = parseInt(numStr, 10);
      issues.set(issueNumber, { ...entry, issueNumber });
    }
  }

  return { docs, issues, issueMapRaw, roadmapContent, repoRoot };
}
