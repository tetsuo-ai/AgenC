import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DocEntry } from './types.js';

const ROOT_DOC_FILES = [
  'README.md',
  'AGENTS.md',
  'CODEX.md',
  'REFACTOR.MD',
  'REFACTOR-MASTER-PROGRAM.md',
] as const;

const PACKAGE_DOC_ROOTS = [
  'runtime',
  'sdk',
  'mcp',
  'docs-mcp',
  'plugin-kit',
  'migrations',
  'examples',
  'programs',
  'web',
  'mobile',
  'demo-app',
  'demo',
  'demos',
  'containers',
  'zkvm',
] as const;

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
  return path.basename(filePath, path.extname(filePath));
}

function normalizeRelPath(relPath: string): string {
  return relPath.replaceAll(path.sep, '/');
}

function categorize(relPath: string): DocEntry['category'] {
  const normalized = normalizeRelPath(relPath);

  if (normalized.startsWith('docs/architecture/flows/')) return 'flow';
  if (normalized.startsWith('docs/architecture/phases/')) return 'phase';
  if (normalized.startsWith('docs/architecture/guides/')) return 'guide';
  if (normalized.startsWith('docs/architecture/') || normalized === 'docs/architecture.md') return 'architecture';
  if (normalized.startsWith('docs/api-baseline/')) return 'baseline';
  if (
    normalized.startsWith('runtime/idl/')
    || normalized.startsWith('runtime/benchmarks/')
    || normalized.startsWith('scripts/idl/')
  ) {
    return 'artifact';
  }
  if (
    normalized === 'REFACTOR.MD'
    || normalized === 'REFACTOR-MASTER-PROGRAM.md'
  ) {
    return 'planning';
  }
  if (
    normalized.startsWith('runtime/docs/')
    || normalized.startsWith('docs/DEPLOY')
    || normalized.startsWith('docs/MAINNET')
    || normalized.startsWith('docs/DEVNET')
    || normalized.startsWith('docs/INCIDENT')
    || normalized.startsWith('docs/SMOKE')
    || normalized.startsWith('docs/SECURITY')
    || normalized.startsWith('docs/UPGRADE')
    || normalized.startsWith('docs/EMERGENCY')
    || normalized.startsWith('docs/AUTONOMY')
    || normalized.startsWith('docs/FUZZ')
    || normalized.startsWith('docs/EVENTS')
    || normalized.startsWith('docs/STATIC')
    || normalized.startsWith('docs/PRIVACY')
    || normalized.startsWith('docs/whitepaper/')
    || normalized.startsWith('docs/audit/')
    || normalized.startsWith('docs/security/')
  ) {
    return 'runbook';
  }
  if (
    normalized === 'README.md'
    || normalized === 'AGENTS.md'
    || normalized === 'CODEX.md'
  ) {
    return 'repo-meta';
  }
  return 'other';
}

function loadTextFiles(dirPath: string, repoRoot: string, extensions: ReadonlySet<string>): DocEntry[] {
  const entries: DocEntry[] = [];

  if (!fs.existsSync(dirPath)) return entries;

  const items = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const item of items) {
    const fullPath = path.join(dirPath, item.name);
    if (item.isDirectory()) {
      entries.push(...loadTextFiles(fullPath, repoRoot, extensions));
    } else if (extensions.has(path.extname(item.name))) {
      const content = fs.readFileSync(fullPath, 'utf-8');
      const relPath = normalizeRelPath(path.relative(repoRoot, fullPath));
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

function loadExplicitFile(repoRoot: string, relPath: string): DocEntry | null {
  const normalized = normalizeRelPath(relPath);
  const fullPath = path.join(repoRoot, normalized);
  if (!fs.existsSync(fullPath)) return null;

  const content = fs.readFileSync(fullPath, 'utf-8');
  return {
    path: normalized,
    title: extractTitle(content, fullPath),
    content,
    category: categorize(normalized),
  };
}

function loadNamedFiles(dirPath: string, repoRoot: string, allowedNames: ReadonlySet<string>): DocEntry[] {
  const entries: DocEntry[] = [];
  if (!fs.existsSync(dirPath)) return entries;

  const items = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const item of items) {
    const fullPath = path.join(dirPath, item.name);
    if (item.isDirectory()) {
      if (item.name === 'node_modules' || item.name === 'dist' || item.name === 'target') {
        continue;
      }
      entries.push(...loadNamedFiles(fullPath, repoRoot, allowedNames));
      continue;
    }
    if (!allowedNames.has(item.name)) continue;

    const content = fs.readFileSync(fullPath, 'utf-8');
    const relPath = normalizeRelPath(path.relative(repoRoot, fullPath));
    entries.push({
      path: relPath,
      title: extractTitle(content, fullPath),
      content,
      category: categorize(relPath),
    });
  }

  return entries;
}

export interface LoadedDocs {
  docs: Map<string, DocEntry>;
  repoRoot: string;
}

export function loadDocs(): LoadedDocs {
  const repoRoot = findRepoRoot();
  const docsDir = path.join(repoRoot, 'docs');

  const docEntries: DocEntry[] = [
    ...loadTextFiles(docsDir, repoRoot, new Set(['.md', '.json'])),
    ...loadTextFiles(path.join(repoRoot, 'runtime', 'docs'), repoRoot, new Set(['.md'])),
    ...loadTextFiles(path.join(repoRoot, 'runtime', 'idl'), repoRoot, new Set(['.json'])),
    ...loadTextFiles(path.join(repoRoot, 'runtime', 'benchmarks'), repoRoot, new Set(['.json'])),
    ...loadTextFiles(path.join(repoRoot, 'scripts', 'idl'), repoRoot, new Set(['.json'])),
  ];

  for (const relPath of ROOT_DOC_FILES) {
    const entry = loadExplicitFile(repoRoot, relPath);
    if (entry) {
      docEntries.push(entry);
    }
  }

  for (const relRoot of PACKAGE_DOC_ROOTS) {
    docEntries.push(
      ...loadNamedFiles(path.join(repoRoot, relRoot), repoRoot, new Set(['README.md', 'CHANGELOG.md'])),
    );
  }

  const docs = new Map<string, DocEntry>();
  for (const entry of docEntries) {
    docs.set(entry.path, entry);
  }

  return { docs, repoRoot };
}
