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

const extractedMirrors = ['sdk', 'plugin-kit', 'examples/private-task-demo'];

for (const relPath of extractedMirrors) {
  if (existsSync(path.join(repoRoot, relPath))) {
    failures.push(`${relPath} still exists as a local extracted-surface mirror`);
  }
}

const rootPkg = readJson('package.json');
const rootWorkspaces = Array.isArray(rootPkg.workspaces) ? rootPkg.workspaces : [];
for (const workspace of extractedMirrors) {
  if (rootWorkspaces.includes(workspace)) {
    failures.push(`root workspaces still include ${workspace}`);
  }
}

for (const [name, value] of Object.entries(rootPkg.scripts ?? {})) {
  if (typeof value === 'string' && value.includes('--workspace=@tetsuo-ai/plugin-kit')) {
    failures.push(`root script ${name} still treats @tetsuo-ai/plugin-kit as a local workspace`);
  }
}

const rootLock = readJson('package-lock.json');
const installedPluginKit = rootLock.packages?.['node_modules/@tetsuo-ai/plugin-kit'];
if (installedPluginKit && (installedPluginKit.link === true || installedPluginKit.resolved === 'plugin-kit')) {
  failures.push('package-lock still resolves @tetsuo-ai/plugin-kit to a local rollback mirror');
}
if (rootLock.packages?.['examples/private-task-demo']) {
  failures.push('package-lock still contains the deleted private-task demo mirror');
}

const forbiddenLocalPathChecks = new Map([
  ['README.md', [/(^|[\s(])sdk\/README\.md/u, /(^|[\s(])plugin-kit\/README\.md/u]],
  ['docs/SDK.md', [/(^|[\s(])sdk\/README\.md/u, /(^|[\s(])sdk\/src\/index\.ts/u]],
  ['docs/PLUGIN_KIT.md', [/(^|[\s(])plugin-kit\/README\.md/u, /(^|[\s(])plugin-kit\/src\/index\.ts/u]],
  ['docs/VERSION_DOCS_MAP.md', [/(^|[\s(])sdk\/README\.md/u, /(^|[\s(])sdk\/src\/index\.ts/u, /(^|[\s(])plugin-kit\/README\.md/u, /(^|[\s(])plugin-kit\/src\/index\.ts/u]],
]);

for (const [relPath, patterns] of forbiddenLocalPathChecks.entries()) {
  const text = readText(relPath);
  for (const pattern of patterns) {
    if (pattern.test(text)) {
      failures.push(`${relPath} still contains local extracted-package path ${pattern}`);
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(`public contract boundary check failed:\n- ${failures.join('\n- ')}\n`);
  process.exit(1);
}

process.stdout.write('public contract boundary check passed.\n');
