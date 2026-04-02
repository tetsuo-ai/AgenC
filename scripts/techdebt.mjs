#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const SOURCE_EXTENSIONS = new Set([
  '.cjs',
  '.cts',
  '.go',
  '.js',
  '.json',
  '.jsx',
  '.mjs',
  '.mts',
  '.py',
  '.rs',
  '.sh',
  '.ts',
  '.tsx',
  '.yaml',
  '.yml',
]);

const EXCLUDED_SEGMENTS = new Set([
  '.git',
  '.next',
  '.turbo',
  'coverage',
  'dist',
  'build',
  'node_modules',
  'target',
]);

const DUPLICATE_WINDOW_LINES = 10;
const MAX_ITEMS_PER_SECTION = 12;
const LONG_FUNCTION_THRESHOLD = 50;
const HIGH_FUNCTION_THRESHOLD = 100;
const HIGH_DUPLICATE_LINES = 20;
const HIGH_NESTING_DEPTH = 5;
const MEDIUM_NESTING_DEPTH = 4;

function findWorkspaceRoot(startDir) {
  let current = path.resolve(startDir);
  const root = path.parse(current).root;

  while (true) {
    if (existsSync(path.join(current, '.claude', 'notes'))) {
      return current;
    }
    if (current === root) {
      break;
    }
    current = path.dirname(current);
  }

  const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: startDir,
    encoding: 'utf8',
  }).trim();
  mkdirSync(path.join(gitRoot, '.claude', 'notes'), { recursive: true });
  return gitRoot;
}

function getTrackedFiles(repoRoot) {
  const output = execFileSync('git', ['-C', repoRoot, 'ls-files'], { encoding: 'utf8' });
  return output.split('\n').filter(Boolean);
}

function isSourceFile(relPath) {
  if (!relPath || relPath.startsWith('.claude/notes/')) {
    return false;
  }
  const segments = relPath.split('/');
  if (segments.some((segment) => EXCLUDED_SEGMENTS.has(segment))) {
    return false;
  }
  return SOURCE_EXTENSIONS.has(path.extname(relPath));
}

function normalizeLine(line) {
  return line
    .replace(/\/\/.*$/u, '')
    .replace(/#.*$/u, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function mdEscape(text) {
  return String(text).replace(/\|/gu, '\\|').replace(/\n/gu, '<br>');
}

function formatLocation(relPath, line) {
  return `${relPath}:${line}`;
}

function addIssue(list, issue, location, impact, fix) {
  list.push({ issue, location, impact, fix });
}

function addDuplication(list, pattern, locations, lines, refactorTo) {
  list.push({ pattern, locations, lines, refactorTo });
}

function analyzeFile(relPath, text, aggregate) {
  const lines = text.split('\n');
  const extension = path.extname(relPath);

  for (let index = 0; index < lines.length; index += 1) {
    const todoMatch = lines[index].match(/\b(TODO|FIXME|HACK)\b[:\s-]*(.*)$/u);
    if (!todoMatch) {
      continue;
    }
    addIssue(
      aggregate.medium,
      `${todoMatch[1]} comment remains`,
      formatLocation(relPath, index + 1),
      'Open implementation debt can hide unfinished behavior or missing safeguards.',
      'Resolve the note or convert it into a tracked issue with a short context comment.',
    );
  }

  for (let index = 0; index <= lines.length - DUPLICATE_WINDOW_LINES; index += 1) {
    const normalizedWindow = lines
      .slice(index, index + DUPLICATE_WINDOW_LINES)
      .map(normalizeLine);
    if (normalizedWindow.some((line) => !line)) {
      continue;
    }
    const fingerprint = normalizedWindow.join('\n');
    if (fingerprint.length < 160) {
      continue;
    }
    const existing = aggregate.duplicateMap.get(fingerprint);
    if (existing) {
      existing.locations.push(formatLocation(relPath, index + 1));
    } else {
      aggregate.duplicateMap.set(fingerprint, {
        locations: [formatLocation(relPath, index + 1)],
        lines: DUPLICATE_WINDOW_LINES,
      });
    }
  }

  analyzeLongFunctions(relPath, extension, lines, aggregate);
  analyzeNesting(relPath, extension, lines, aggregate);
  analyzeMagicNumbers(relPath, lines, aggregate);
}

function analyzeLongFunctions(relPath, extension, lines, aggregate) {
  if (['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.rs', '.go', '.sh'].includes(extension)) {
    analyzeBraceFunctions(relPath, lines, aggregate);
    return;
  }
  if (extension === '.py') {
    analyzePythonFunctions(relPath, lines, aggregate);
  }
}

function analyzeBraceFunctions(relPath, lines, aggregate) {
  const functionStartPattern =
    /^\s*(?:export\s+)?(?:pub\s+)?(?:async\s+)?(?:fn\s+\w+|function\s+\w+|const\s+\w+\s*=\s*(?:async\s*)?\(|let\s+\w+\s*=\s*(?:async\s*)?\(|var\s+\w+\s*=\s*(?:async\s*)?\(|\w+\s*:\s*(?:async\s*)?\(|\w+\s*\([^;]*\)\s*\{)/u;
  const controlPattern = /^\s*(?:if|for|while|switch|catch|else)\b/u;

  for (let index = 0; index < lines.length; index += 1) {
    if (!functionStartPattern.test(lines[index]) || controlPattern.test(lines[index])) {
      continue;
    }

    let depth = 0;
    let sawOpeningBrace = false;
    let endIndex = index;

    for (let cursor = index; cursor < lines.length; cursor += 1) {
      const currentLine = lines[cursor];
      const opens = (currentLine.match(/\{/gu) || []).length;
      const closes = (currentLine.match(/\}/gu) || []).length;
      if (opens > 0) {
        sawOpeningBrace = true;
      }
      depth += opens - closes;
      endIndex = cursor;
      if (sawOpeningBrace && depth <= 0) {
        break;
      }
    }

    const span = endIndex - index + 1;
    if (span <= LONG_FUNCTION_THRESHOLD) {
      continue;
    }
    addIssue(
      span > HIGH_FUNCTION_THRESHOLD ? aggregate.high : aggregate.medium,
      `Long function (${span} lines)`,
      formatLocation(relPath, index + 1),
      'Large functions are harder to review, test, and modify safely.',
      'Split the function into smaller helpers around validation, state mutation, and side effects.',
    );
  }
}

function analyzePythonFunctions(relPath, lines, aggregate) {
  const functionStartPattern = /^\s*(?:async\s+)?def\s+\w+\s*\(/u;

  for (let index = 0; index < lines.length; index += 1) {
    if (!functionStartPattern.test(lines[index])) {
      continue;
    }

    const indent = lines[index].match(/^\s*/u)?.[0].length ?? 0;
    let endIndex = index;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      if (!line.trim()) {
        continue;
      }
      const nextIndent = line.match(/^\s*/u)?.[0].length ?? 0;
      if (nextIndent <= indent && !line.trimStart().startsWith('#')) {
        break;
      }
      endIndex = cursor;
    }

    const span = endIndex - index + 1;
    if (span <= LONG_FUNCTION_THRESHOLD) {
      continue;
    }
    addIssue(
      span > HIGH_FUNCTION_THRESHOLD ? aggregate.high : aggregate.medium,
      `Long function (${span} lines)`,
      formatLocation(relPath, index + 1),
      'Large functions make it easier to miss edge cases.',
      'Split the function into focused helpers and isolate error handling.',
    );
  }
}

function analyzeNesting(relPath, extension, lines, aggregate) {
  if (!['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.rs', '.go', '.sh'].includes(extension)) {
    return;
  }

  const controlBlockPattern = /^\s*(?:if|else\b|for|while|switch|try|catch|finally|do)\b/u;
  const blockStack = [];
  let controlDepth = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const closes = (line.match(/\}/gu) || []).length;
    for (let closeIndex = 0; closeIndex < closes; closeIndex += 1) {
      const kind = blockStack.pop();
      if (kind === 'control') {
        controlDepth = Math.max(0, controlDepth - 1);
      }
    }

    const opens = (line.match(/\{/gu) || []).length;
    const controlOpens = opens > 0 && controlBlockPattern.test(line) ? 1 : 0;
    const effectiveDepth = controlDepth + controlOpens;

    if (effectiveDepth >= HIGH_NESTING_DEPTH) {
      addIssue(
        aggregate.high,
        `Deep nesting (depth ${effectiveDepth})`,
        formatLocation(relPath, index + 1),
        'Heavily nested control flow is error-prone and obscures failure paths.',
        'Introduce guard clauses or extract nested branches into helpers.',
      );
    } else if (effectiveDepth >= MEDIUM_NESTING_DEPTH) {
      addIssue(
        aggregate.medium,
        `Nested control flow (depth ${effectiveDepth})`,
        formatLocation(relPath, index + 1),
        'Nested branches increase cognitive load during review.',
        'Flatten the control flow with early returns or smaller helper functions.',
      );
    }

    for (let openIndex = 0; openIndex < opens; openIndex += 1) {
      const kind = openIndex < controlOpens ? 'control' : 'other';
      blockStack.push(kind);
      if (kind === 'control') {
        controlDepth += 1;
      }
    }
  }
}

function analyzeMagicNumbers(relPath, lines, aggregate) {
  const ignoredValues = new Set(['0', '1', '2', '8', '10', '16', '32', '64', '100', '256', '1024']);
  const perFileCounts = new Map();

  for (let index = 0; index < lines.length; index += 1) {
    const matches = lines[index].match(/\b\d{3,}\b/gu) || [];
    for (const value of matches) {
      if (ignoredValues.has(value)) {
        continue;
      }
      const existing = perFileCounts.get(value);
      if (existing) {
        existing.count += 1;
      } else {
        perFileCounts.set(value, { count: 1, firstLine: index + 1 });
      }
    }
  }

  for (const [value, info] of perFileCounts.entries()) {
    if (info.count < 3) {
      continue;
    }
    addIssue(
      aggregate.medium,
      `Repeated numeric literal ${value}`,
      formatLocation(relPath, info.firstLine),
      'Repeated literals drift over time when not centralized.',
      'Promote the value to a named constant if it represents a stable protocol or business rule.',
    );
  }
}

function renderIssueTable(rows, emptyFix) {
  if (rows.length === 0) {
    return '| None found. | n/a | n/a | n/a |';
  }
  return rows
    .slice(0, MAX_ITEMS_PER_SECTION)
    .map(
      (row) =>
        `| ${mdEscape(row.issue)} | ${mdEscape(row.location)} | ${mdEscape(row.impact)} | ${mdEscape(
          row.fix || emptyFix,
        )} |`,
    )
    .join('\n');
}

function renderDuplicationTable(rows) {
  if (rows.length === 0) {
    return '| None found. | n/a | n/a | n/a |';
  }
  return rows
    .slice(0, MAX_ITEMS_PER_SECTION)
    .map(
      (row) =>
        `| ${mdEscape(row.pattern)} | ${mdEscape(row.locations)} | ${mdEscape(row.lines)} | ${mdEscape(
          row.refactorTo,
        )} |`,
    )
    .join('\n');
}

function dedupeIssues(issues) {
  const seen = new Set();
  return issues.filter((issue) => {
    const key = `${issue.issue}::${issue.location}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

const repoRoot = findWorkspaceRoot(process.cwd());
const trackedFiles = getTrackedFiles(repoRoot).filter(isSourceFile);
const aggregate = {
  critical: [],
  high: [],
  medium: [],
  duplicateMap: new Map(),
};

for (const relPath of trackedFiles) {
  const absPath = path.join(repoRoot, relPath);
  let text;
  try {
    text = readFileSync(absPath, 'utf8');
  } catch {
    continue;
  }
  if (text.includes('\0')) {
    continue;
  }
  analyzeFile(relPath, text, aggregate);
}

const duplications = [];
for (const [fingerprint, info] of aggregate.duplicateMap.entries()) {
  if (info.locations.length < 2) {
    continue;
  }
  const lineCount = fingerprint.split('\n').length;
  addDuplication(
    duplications,
    `Exact duplicate window (${lineCount} normalized lines)`,
    info.locations.slice(0, 4).join(', '),
    `${lineCount} lines`,
    'Extract a shared helper or reduce the repeated validation/state-update block.',
  );
  if (lineCount >= HIGH_DUPLICATE_LINES) {
    addIssue(
      aggregate.high,
      `Exact duplicate block (${lineCount} lines)`,
      info.locations.slice(0, 2).join(', '),
      'Duplicated logic increases regression risk because fixes can diverge.',
      'Centralize the shared block behind one helper or shared module.',
    );
  }
}

const critical = dedupeIssues(aggregate.critical);
const high = dedupeIssues(aggregate.high);
const medium = dedupeIssues(aggregate.medium);
const totalIssues = critical.length + high.length + medium.length;
const estimatedCleanupFiles = new Set(
  [...critical, ...high, ...medium].map((issue) => issue.location.split(':')[0]),
).size;
const recommendedPriority =
  critical[0]?.issue || high[0]?.issue || medium[0]?.issue || 'No significant issues detected';

const reportDate = new Date().toISOString().slice(0, 10);
const outputPath = path.join(repoRoot, '.claude', 'notes', `techdebt-${reportDate}.md`);
mkdirSync(path.dirname(outputPath), { recursive: true });

const report = `## Tech Debt Report - ${reportDate}

### Critical (Fix Now)
| Issue | Location | Impact | Suggested Fix |
|-------|----------|--------|---------------|
${renderIssueTable(critical, 'Fix the issue before merging further changes in the same area.')}

### High (Fix This Sprint)
| Issue | Location | Impact | Suggested Fix |
|-------|----------|--------|---------------|
${renderIssueTable(high, 'Refactor the affected area before more logic accumulates around it.')}

### Medium (Backlog)
| Issue | Location | Impact | Suggested Fix |
|-------|----------|--------|---------------|
${renderIssueTable(medium, 'Track it and clean it up when the surrounding file is touched next.')}

### Duplications Found
| Pattern | Locations | Lines | Refactor To |
|---------|-----------|-------|-------------|
${renderDuplicationTable(duplications)}

### Summary
- Total issues: ${totalIssues}
- Estimated cleanup: ${estimatedCleanupFiles} files
- Recommended priority: ${recommendedPriority}
`;

writeFileSync(outputPath, `${report}\n`, 'utf8');
process.stdout.write(`Wrote ${path.relative(repoRoot, outputPath)}\n`);
process.stdout.write(`Found ${totalIssues} issues. Recommended priority: ${recommendedPriority}\n`);
