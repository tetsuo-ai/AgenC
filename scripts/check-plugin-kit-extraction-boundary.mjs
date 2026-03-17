#!/usr/bin/env node

import { readFileSync } from 'node:fs';
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
if (Array.isArray(rootPkg.workspaces) && rootPkg.workspaces.includes('plugin-kit')) {
  failures.push('root workspaces still include plugin-kit');
}

const rootLock = readJson('package-lock.json');
const installedPluginKit = rootLock.packages?.['node_modules/@tetsuo-ai/plugin-kit'];
if (!installedPluginKit || installedPluginKit.link === true || installedPluginKit.resolved === 'plugin-kit') {
  failures.push('package-lock still resolves @tetsuo-ai/plugin-kit to the local rollback mirror');
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

const breakingChanges = readText('scripts/check-breaking-changes.ts');
if (
  breakingChanges.includes("target: 'sdk' | 'runtime' | 'mcp' | 'plugin-kit'")
  || breakingChanges.includes('<sdk|runtime|mcp|plugin-kit>')
  || breakingChanges.includes("path.join(root, 'plugin-kit', 'node_modules', 'typescript')")
) {
  failures.push('breaking-change gate still treats plugin-kit as a local target');
}

const versionMap = readText('docs/VERSION_DOCS_MAP.md');
if (versionMap.includes('plugin-kit/README.md') || versionMap.includes('plugin-kit/src/index.ts')) {
  failures.push('version map still points plugin-kit docs at local monorepo paths');
}

try {
  readText('docs/api-baseline/plugin-kit.json');
  failures.push('local plugin-kit API baseline still exists in the monorepo');
} catch {
  // expected: authority moved to the standalone repo
}

const pluginKitMirrorPkg = readJson('plugin-kit/package.json');
if (pluginKitMirrorPkg.private !== true) {
  failures.push('local plugin-kit rollback mirror is still publishable');
}

if (pluginKitMirrorPkg.name === '@tetsuo-ai/plugin-kit') {
  failures.push('local plugin-kit rollback mirror still uses the canonical npm package name');
}

if (failures.length > 0) {
  process.stderr.write(`plugin-kit extraction boundary check failed:\n- ${failures.join('\n- ')}\n`);
  process.exit(1);
}

process.stdout.write('plugin-kit extraction boundary check passed.\n');
