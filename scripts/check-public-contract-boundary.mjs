#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const repoRoot = process.cwd();

function readJson(relPath) {
  return JSON.parse(readFileSync(path.join(repoRoot, relPath), 'utf8'));
}

function readText(relPath) {
  return readFileSync(path.join(repoRoot, relPath), 'utf8');
}

const failures = [];

function hasExactWorkspaceReference(scriptValue) {
  return /(^|[\s&|;])--workspace=@tetsuo-ai\/plugin-kit(?=$|[\s&|;])/u.test(scriptValue);
}

const rootPkg = readJson('package.json');
const rootWorkspaces = Array.isArray(rootPkg.workspaces) ? rootPkg.workspaces : [];
for (const workspace of ['sdk', 'plugin-kit', 'examples/private-task-demo']) {
  if (rootWorkspaces.includes(workspace)) {
    failures.push(`root workspaces still include ${workspace}`);
  }
}

const rootLock = readJson('package-lock.json');
const installedPluginKit = rootLock.packages?.['node_modules/@tetsuo-ai/plugin-kit'];
if (!installedPluginKit || installedPluginKit.link === true || installedPluginKit.resolved === 'plugin-kit') {
  failures.push('package-lock still resolves @tetsuo-ai/plugin-kit to the local rollback mirror');
}
if (rootLock.packages?.['examples/private-task-demo']) {
  failures.push('package-lock still contains the deleted private-task demo mirror');
}

for (const [name, value] of Object.entries(rootPkg.scripts ?? {})) {
  if (typeof value === 'string' && hasExactWorkspaceReference(value)) {
    failures.push(`root script ${name} still invokes @tetsuo-ai/plugin-kit as a workspace`);
  }
}

const runtimePkg = readJson('runtime/package.json');
for (const scriptName of ['prebuild', 'pretypecheck', 'pretest']) {
  const value = runtimePkg.scripts?.[scriptName];
  if (typeof value === 'string' && hasExactWorkspaceReference(value)) {
    failures.push(`runtime script ${scriptName} still builds local @tetsuo-ai/plugin-kit workspace`);
  }
}

const docsLoader = readText('docs-mcp/src/loader.ts');
if (docsLoader.includes("'plugin-kit'")) {
  failures.push('docs-mcp loader still indexes plugin-kit as a local package root');
}
if (docsLoader.includes("'sdk'")) {
  failures.push('docs-mcp loader still indexes sdk as a local package root');
}

const breakingChanges = readText('scripts/check-breaking-changes.ts');
if (
  breakingChanges.includes("target: 'sdk' | 'runtime' | 'mcp' | 'plugin-kit'")
  || breakingChanges.includes('<sdk|runtime|mcp|plugin-kit>')
  || breakingChanges.includes('<sdk|runtime|mcp>')
  || breakingChanges.includes("path.join(root, 'sdk', 'node_modules', 'typescript')")
  || breakingChanges.includes("path.join(root, 'plugin-kit', 'node_modules', 'typescript')")
) {
  failures.push('breaking-change gate still treats sdk or plugin-kit as a local target');
}

const versionMap = readText('docs/VERSION_DOCS_MAP.md');
if (versionMap.includes('plugin-kit/README.md') || versionMap.includes('plugin-kit/src/index.ts')) {
  failures.push('version map still points plugin-kit docs at local monorepo paths');
}
if (
  versionMap.includes('sdk/README.md')
  || versionMap.includes('sdk/CHANGELOG.md')
  || versionMap.includes('sdk/src/index.ts')
) {
  failures.push('version map still points sdk docs at local monorepo paths');
}

try {
  readText('docs/api-baseline/plugin-kit.json');
  failures.push('local plugin-kit API baseline still exists in the monorepo');
} catch {
  // expected: authority moved to the standalone repo
}
try {
  readText('docs/api-baseline/sdk.json');
  failures.push('local sdk API baseline still exists in the monorepo');
} catch {
  // expected: authority moved to the standalone repo
}

for (const relPath of ['sdk', 'plugin-kit', 'examples/private-task-demo']) {
  if (existsSync(path.join(repoRoot, relPath))) {
    failures.push(`${relPath} still exists as a local extracted-surface mirror`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`public contract boundary check failed:\n- ${failures.join('\n- ')}\n`);
  process.exit(1);
}

process.stdout.write('public contract extraction boundary check passed.\n');
