#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  umbrellaActiveContractFiles,
  umbrellaRequiredPaths,
} from './umbrella-contract-manifest.mjs';

const repoRoot = process.cwd();

function readJson(relPath) {
  return JSON.parse(readFileSync(path.join(repoRoot, relPath), 'utf8'));
}

function readText(relPath) {
  return readFileSync(path.join(repoRoot, relPath), 'utf8');
}

const failures = [];

const allowedWorkspaces = new Set([
  'examples/helius-webhook',
  'examples/risc0-proof-demo',
  'examples/simple-usage',
  'examples/tetsuo-integration',
]);

const forbiddenScripts = new Set([
  'build',
  'build:private-kernel',
  'build:runtime',
  'build:mcp',
  'check:private-kernel-surface',
  'check:private-kernel-distribution',
  'check:private-kernel-distribution:local',
  'check:proof-harness-boundary',
  'stage:private-kernel-distribution',
  'stage:private-kernel-distribution:local',
  'dry-run:private-kernel-distribution',
  'dry-run:private-kernel-distribution:local',
  'private-registry:up',
  'private-registry:down',
  'private-registry:logs',
  'private-registry:status',
  'private-registry:health',
  'private-registry:reset',
  'private-registry:bootstrap',
  'private-registry:rehearse',
  'pack:smoke',
  'pack:smoke:skip-build',
  'test:private-registry-scripts',
  'test',
  'test:fast',
  'typecheck',
  'example:autonomous-agent',
  'example:dispute-arbiter',
  'example:event-dashboard',
  'example:llm-agent',
  'example:memory-agent',
  'example:skill-jupiter',
  'localnet:social:bootstrap',
  'localnet:social:smoke',
  'benchmark:private:e2e',
]);

const forbiddenPaths = [
  '.github/workflows/package-pack-smoke.yml',
  '.github/workflows/private-kernel-cloudsmith.yml',
  '.github/workflows/private-kernel-registry.yml',
  '.github/workflows/private-proof-benchmark-pages.yml',
  '.github/workflows/proof-harness-boundary.yml',
  '.mcp.json',
  '.trivyignore',
  'Anchor.toml',
  'benchmarks',
  'config',
  'containers',
  'contracts',
  'demo-app',
  'docs-mcp',
  'docs/AUTONOMY_RUNTIME_ROLLOUT.md',
  'docs/AUTONOMY_USER_TEST_PROGRAM.md',
  'docs/DEPLOYMENT.md',
  'docs/DEPLOYMENT_CHECKLIST.md',
  'docs/DEPLOYMENT_PLAN.md',
  'docs/DEVNET_VALIDATION.md',
  'docs/EMERGENCY_RESPONSE_MATRIX.md',
  'docs/EVENTS_OBSERVABILITY.md',
  'docs/FUZZ_TESTING.md',
  'docs/INCIDENT_REPLAY_RUNBOOK.md',
  'docs/MAINNET_DEPLOYMENT.md',
  'docs/MAINNET_MIGRATION.md',
  'docs/PRIVACY_README.md',
  'docs/PRIVATE_KERNEL_DISTRIBUTION.md',
  'docs/PRIVATE_KERNEL_SUPPORT_POLICY.md',
  'docs/PRIVATE_REGISTRY_SETUP.md',
  'docs/RUNTIME_API.md',
  'docs/RUNTIME_PIPELINE_DEBUG_BUNDLE.md',
  'docs/RUNTIME_PRE_AUDIT_CHECKLIST.md',
  'docs/SECURITY_AUDIT_DEVNET.md',
  'docs/SECURITY_AUDIT_MAINNET.md',
  'docs/SECURITY_SCOPE_MATRIX.md',
  'docs/SMOKE_TESTS.md',
  'docs/STATIC_ANALYSIS.md',
  'docs/UPGRADE_GUIDE.md',
  'docs/api-baseline',
  'docs/architecture',
  'docs/architecture.md',
  'docs/architecture.svg',
  'docs/audit',
  'docs/autonomy-runtime-rollout.manifest.json',
  'docs/benchmark.svg',
  'docs/design',
  'docs/devnet-h200-benchmark-plan.md',
  'docs/devnet-program-data.md',
  'docs/security',
  'docs/whitepaper',
  'examples/autonomous-agent',
  'examples/dispute-arbiter',
  'examples/event-dashboard',
  'examples/llm-agent',
  'examples/memory-agent',
  'examples/skill-jupiter',
  'knip.json',
  'mcp',
  'migrations',
  'mobile',
  'programs',
  'runtime',
  'test-fixtures',
  'tests',
  'tools',
  'tsconfig.json',
  'web',
  'zkvm',
];

const rootPkg = readJson('package.json');
const workspaces = Array.isArray(rootPkg.workspaces) ? rootPkg.workspaces : [];
for (const workspace of workspaces) {
  if (!allowedWorkspaces.has(workspace)) {
    failures.push(`root workspace ${workspace} is not allowed in the public umbrella`);
  }
}

for (const name of Object.keys(rootPkg.scripts ?? {})) {
  if (forbiddenScripts.has(name)) {
    failures.push(`root script ${name} must not exist in the public umbrella`);
  }
}

for (const relPath of umbrellaRequiredPaths) {
  if (!existsSync(path.join(repoRoot, relPath))) {
    failures.push(`required umbrella path is missing: ${relPath}`);
  }
}

for (const relPath of forbiddenPaths) {
  if (existsSync(path.join(repoRoot, relPath))) {
    failures.push(`forbidden path still exists: ${relPath}`);
  }
}

const forbiddenReferencePatterns = [
  /agenc-apps/u,
  /optional later split/u,
  /request access to `agenc-core`/iu,
  /agenc-core`, which is private/u,
  /private access required/u,
  /final AgenC repository layout/u,
];

for (const relPath of umbrellaActiveContractFiles) {
  if (!existsSync(path.join(repoRoot, relPath))) {
    failures.push(`active umbrella contract file is missing: ${relPath}`);
    continue;
  }
  const text = readText(relPath);
  for (const pattern of forbiddenReferencePatterns) {
    if (pattern.test(text)) {
      failures.push(`${relPath} still references deleted umbrella-internal surface ${pattern}`);
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(`umbrella boundary check failed:\n- ${failures.join('\n- ')}\n`);
  process.exit(1);
}

process.stdout.write('umbrella boundary check passed.\n');
