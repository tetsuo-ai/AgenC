#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const repoRoot = process.cwd();
const failures = [];

function readJson(relPath) {
  return JSON.parse(readFileSync(path.join(repoRoot, relPath), 'utf8'));
}

function readText(relPath) {
  return readFileSync(path.join(repoRoot, relPath), 'utf8');
}

function requirePrivateManifest(relPath) {
  const pkg = readJson(relPath);
  if (pkg.private !== true) {
    failures.push(`${relPath} must set private=true`);
  }
  if (pkg.publishConfig?.access === 'public') {
    failures.push(`${relPath} still advertises publishConfig.access=public`);
  }
}

function requirePatterns(relPath, patterns) {
  const text = readText(relPath);
  for (const pattern of patterns) {
    if (!pattern.test(text)) {
      failures.push(`${relPath} is missing required pattern: ${pattern}`);
    }
  }
}

function forbidPatterns(relPath, patterns) {
  const text = readText(relPath);
  for (const pattern of patterns) {
    if (pattern.test(text)) {
      failures.push(`${relPath} still matches forbidden pattern: ${pattern}`);
    }
  }
}

for (const relPath of [
  'runtime/package.json',
  'mcp/package.json',
  'docs-mcp/package.json',
  'contracts/desktop-tool-contracts/package.json',
]) {
  requirePrivateManifest(relPath);
}

const requiredDocPatterns = {
  'README.md': [
    /### Public Builder Entry Points/u,
    /@tetsuo-ai\/sdk/u,
    /@tetsuo-ai\/protocol/u,
    /@tetsuo-ai\/plugin-kit/u,
    /@tetsuo-ai\/runtime.*Private kernel package.*not a supported public builder API/u,
    /@tetsuo-ai\/mcp.*Private kernel MCP package.*not a public extension target/u,
    /Private kernel package policy/u,
    /PRIVATE_KERNEL_DISTRIBUTION\.md/u,
  ],
  'docs/RUNTIME_API.md': [
    /^# Internal Runtime API Reference$/mu,
    /not a supported public builder target/u,
    /PRIVATE_KERNEL_DISTRIBUTION\.md/u,
  ],
  'docs/VERSION_DOCS_MAP.md': [
    /## @tetsuo-ai\/runtime v0\.1\.0[\s\S]*Classification: Transitional private-kernel artifact; not a supported public builder target[\s\S]*Distribution policy: `docs\/PRIVATE_KERNEL_DISTRIBUTION\.md`/u,
    /## @tetsuo-ai\/mcp v0\.1\.0[\s\S]*Classification: Transitional private-kernel artifact; not a supported public extension target[\s\S]*Distribution policy: `docs\/PRIVATE_KERNEL_DISTRIBUTION\.md`/u,
  ],
  'runtime/README.md': [
    /^Private kernel package for AgenC\.$/mu,
    /not a supported public builder target/u,
    /PRIVATE_KERNEL_DISTRIBUTION\.md/u,
  ],
  'mcp/README.md': [
    /^Private kernel MCP server for AgenC\./mu,
    /not a supported public extension target/u,
    /PRIVATE_KERNEL_DISTRIBUTION\.md/u,
  ],
  'docs-mcp/README.md': [
    /^Private kernel documentation MCP server for AgenC\./mu,
    /not a supported public builder target/u,
    /PRIVATE_KERNEL_DISTRIBUTION\.md/u,
  ],
  'contracts/desktop-tool-contracts/README.md': [
    /This package is part of the private kernel boundary\./u,
    /not a supported public plugin or builder API/u,
    /PRIVATE_KERNEL_DISTRIBUTION\.md/u,
  ],
};

for (const [relPath, patterns] of Object.entries(requiredDocPatterns)) {
  requirePatterns(relPath, patterns);
}

const forbiddenInstallPatterns = [
  /npm install @tetsuo-ai\/runtime/u,
  /npm install @tetsuo-ai\/mcp/u,
  /npm install @tetsuo-ai\/docs-mcp/u,
  /npm install @tetsuo-ai\/desktop-tool-contracts/u,
];

for (const relPath of [
  'README.md',
  'docs/RUNTIME_API.md',
  'docs/VERSION_DOCS_MAP.md',
  'runtime/README.md',
  'mcp/README.md',
  'docs-mcp/README.md',
  'contracts/desktop-tool-contracts/README.md',
]) {
  forbidPatterns(relPath, forbiddenInstallPatterns);
}

if (failures.length > 0) {
  process.stderr.write(`private-kernel surface check failed:\n- ${failures.join('\n- ')}\n`);
  process.exit(1);
}

process.stdout.write('private-kernel surface check passed.\n');
